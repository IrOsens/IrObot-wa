import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { wibDay } from './storage.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MEDIA_ID_RE = /^(\d{4}-\d{2}-\d{2})_([a-f0-9]{24})$/;
const AVATAR_ID_RE = /^[a-f0-9]{40}$/;
const DAY_CACHE_LIMIT = 21;

// AES-256-GCM with a master key kept on the bot's own disk (not next to the data),
// so the files on the storage disk cannot be read on their own.
export class ImportantVault {
  constructor(file) {
    this.file = file;
    this.key = null;
  }

  async load() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const key = Buffer.from(saved.key || '', 'base64');
      if (key.length !== 32) throw new Error('Kunci enkripsi important rusak.');
      this.key = key;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.key = crypto.randomBytes(32);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, `${JSON.stringify({ key: this.key.toString('base64'), createdAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: 'wx' });
    }
    return this;
  }

  encrypt(buffer) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(buffer), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  decrypt(buffer) {
    const iv = buffer.subarray(0, 12);
    const tag = buffer.subarray(12, 28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]);
  }

  encryptJson(value) { return this.encrypt(Buffer.from(JSON.stringify(value))); }
  decryptJson(buffer) { return JSON.parse(this.decrypt(buffer).toString('utf8')); }
}

const workerKey = (workerId) => {
  const id = Number(workerId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Worker id tidak valid.');
  return String(id);
};

export const avatarIdFor = (jid) => crypto.createHash('sha1').update(String(jid)).digest('hex');

// Per worker folder:
//   messages/<YYYY-MM-DD>.log  one encrypted JSON event per line (base64)
//   media/<YYYY-MM-DD>/<id>.bin encrypted media
//   avatars/<sha1>.bin          encrypted profile pictures
//   chats.enc                   encrypted chat + contact index
export class ImportantStore extends EventEmitter {
  constructor(root, vault) {
    super();
    this.root = root;
    this.vault = vault;
    this.workers = new Map();
    this.queues = new Map();
  }

  dir(workerId, ...parts) {
    return path.join(this.root, workerKey(workerId), ...parts);
  }

  // Writes for one worker run one at a time so the day files never interleave.
  serial(workerId, task) {
    const key = workerKey(workerId);
    const run = (this.queues.get(key) || Promise.resolve()).then(task);
    this.queues.set(key, run.catch(() => {}));
    return run;
  }

  async state(workerId) {
    const key = workerKey(workerId);
    if (this.workers.has(key)) return this.workers.get(key);
    const value = { chats: {}, contacts: {}, days: new Map(), saveTimer: null };
    try {
      const saved = this.vault.decryptJson(await fs.readFile(this.dir(workerId, 'chats.enc')));
      value.chats = saved.chats || {};
      value.contacts = saved.contacts || {};
    } catch (error) {
      if (error.code !== 'ENOENT') this.emit('warn', { workerId, error: error.message });
    }
    this.workers.set(key, value);
    return value;
  }

  async saveIndex(workerId) {
    const value = await this.state(workerId);
    clearTimeout(value.saveTimer);
    value.saveTimer = null;
    const file = this.dir(workerId, 'chats.enc');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, this.vault.encryptJson({ chats: value.chats, contacts: value.contacts }));
    await fs.rename(temp, file);
  }

  scheduleIndexSave(workerId, value) {
    if (value.saveTimer) return;
    value.saveTimer = setTimeout(() => {
      value.saveTimer = null;
      this.serial(workerId, () => this.saveIndex(workerId)).catch((error) => this.emit('warn', { workerId, error: error.message }));
    }, 3000);
    value.saveTimer.unref?.();
  }

  async flush() {
    await Promise.all([...this.workers.keys()].map((key) => this.serial(key, () => this.saveIndex(key)).catch(() => {})));
  }

  async readDay(workerId, day) {
    const value = await this.state(workerId);
    if (value.days.has(day)) {
      const cached = value.days.get(day);
      value.days.delete(day);
      value.days.set(day, cached);
      return cached;
    }
    let events = [];
    try {
      const text = await fs.readFile(this.dir(workerId, 'messages', `${day}.log`), 'utf8');
      for (const row of text.split('\n')) {
        if (!row) continue;
        try { events.push(this.vault.decryptJson(Buffer.from(row, 'base64'))); } catch { /* skip a damaged line */ }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      events = [];
    }
    value.days.set(day, events);
    while (value.days.size > DAY_CACHE_LIMIT) value.days.delete(value.days.keys().next().value);
    return events;
  }

  async listDays(workerId) {
    try {
      const names = await fs.readdir(this.dir(workerId, 'messages'));
      return names.map((name) => name.replace(/\.log$/, '')).filter((day) => DAY_RE.test(day)).sort();
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  // event: { t: 'msg'|'edit'|'del'|'react', id, chat, ts, ... }
  append(workerId, event) {
    return this.serial(workerId, async () => {
      const value = await this.state(workerId);
      const day = wibDay(event.ts);
      const file = this.dir(workerId, 'messages', `${day}.log`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, `${this.vault.encryptJson(event).toString('base64')}\n`);
      if (value.days.has(day)) value.days.get(day).push(event);
      this.touchChat(value, event);
      this.scheduleIndexSave(workerId, value);
      this.emit('event', { workerId: Number(workerId), event, chat: value.chats[event.chat] || null });
      return event;
    });
  }

  touchChat(value, event) {
    const chat = value.chats[event.chat] || (value.chats[event.chat] = { jid: event.chat, isGroup: event.chat.endsWith('@g.us'), lastTs: 0 });
    if (event.t === 'msg') {
      if (event.ts >= (chat.lastTs || 0)) {
        chat.lastTs = event.ts;
        chat.lastPreview = previewOf(event);
        chat.lastFromMe = Boolean(event.fromMe);
      }
      chat.count = (chat.count || 0) + 1;
      if (!chat.isGroup && !event.fromMe && event.pushName && !chat.name) chat.pushName = event.pushName;
    }
    if (event.chatName) chat.name = event.chatName;
  }

  async updateChat(workerId, jid, patch) {
    const value = await this.state(workerId);
    const chat = value.chats[jid] || (value.chats[jid] = { jid, isGroup: jid.endsWith('@g.us'), lastTs: 0 });
    Object.assign(chat, patch);
    this.scheduleIndexSave(workerId, value);
    return chat;
  }

  async setContact(workerId, jid, name) {
    if (!jid || !name) return;
    const value = await this.state(workerId);
    if (value.contacts[jid] === name) return;
    value.contacts[jid] = name;
    this.scheduleIndexSave(workerId, value);
  }

  async chat(workerId, jid) {
    return (await this.state(workerId)).chats[jid] || null;
  }

  async chats(workerId) {
    const value = await this.state(workerId);
    return Object.values(value.chats)
      .filter((chat) => chat.lastTs)
      .map((chat) => ({ ...chat, displayName: chat.name || value.contacts[chat.jid] || chat.pushName || '' }))
      .sort((a, b) => b.lastTs - a.lastTs);
  }

  async contacts(workerId) {
    return { ...(await this.state(workerId)).contacts };
  }

  // Newest-first walk over the day files; edits, deletes and reactions come after their
  // message in time, so they are collected first and folded in when the message shows up.
  async messages(workerId, chatJid, { before = Infinity, limit = 60 } = {}) {
    const days = (await this.listDays(workerId)).reverse();
    const mods = new Map();
    const found = [];
    const ids = new Set();
    for (const day of days) {
      const events = await this.readDay(workerId, day);
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.chat !== chatJid) continue;
        if (event.t !== 'msg') {
          const list = mods.get(event.id) || [];
          list.push(event);
          mods.set(event.id, list);
          continue;
        }
        if (event.ts >= before) continue;
        if (ids.has(event.id)) continue;
        ids.add(event.id);
        found.push(applyMods(event, mods.get(event.id)));
      }
      if (found.length >= limit) break;
    }
    found.sort((a, b) => a.ts - b.ts);
    return found.slice(-limit);
  }

  // Per chat on/off switch for recording. Off = nothing new is stored for that chat.
  async setLogging(workerId, jid, enabled) {
    return this.updateChat(workerId, jid, { paused: enabled ? undefined : true });
  }

  async isPaused(workerId, jid) {
    return Boolean((await this.state(workerId)).chats[jid]?.paused);
  }

  // Whole chat as plain text: "[26/11/2026 14:05] Nama : pesan", media as [stiker], [video], ...
  async exportText(workerId, jid, { meName = '' } = {}) {
    const value = await this.state(workerId);
    const chat = value.chats[jid] || { jid };
    const list = await this.messages(workerId, jid, { limit: Infinity });
    const nameOf = (message) => {
      if (message.fromMe) return meName || 'Saya';
      const named = value.contacts[message.sender] || message.pushName || value.contacts[message.senderAlt];
      if (named) return named;
      if (!chat.isGroup) return chat.name || value.contacts[jid] || chat.pushName || phoneOf(chat.phone || jid);
      return phoneOf(message.senderAlt || message.sender);
    };
    const title = chat.name || value.contacts[jid] || chat.pushName || phoneOf(chat.phone || jid);
    const rows = [`Chat: ${title}`, `Diekspor: ${exportTime(Date.now())} WIB · ${list.length} pesan`, ''];
    for (const message of list) rows.push(`[${exportTime(message.ts)}] ${nameOf(message)} : ${exportBody(message)}`);
    return { title, text: `${rows.join('\n')}\n` };
  }

  async saveMedia(workerId, ts, buffer) {
    const day = wibDay(ts);
    const id = `${day}_${crypto.randomBytes(12).toString('hex')}`;
    const file = this.dir(workerId, 'media', day, `${id}.bin`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, this.vault.encrypt(buffer));
    return id;
  }

  async readMedia(workerId, mediaId) {
    const match = String(mediaId || '').match(MEDIA_ID_RE);
    if (!match) return null;
    try {
      return this.vault.decrypt(await fs.readFile(this.dir(workerId, 'media', match[1], `${mediaId}.bin`)));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async saveAvatar(workerId, jid, buffer) {
    const id = avatarIdFor(jid);
    const file = this.dir(workerId, 'avatars', `${id}.bin`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, this.vault.encrypt(buffer));
    return id;
  }

  async readAvatar(workerId, avatarId) {
    if (!AVATAR_ID_RE.test(String(avatarId || ''))) return null;
    try {
      return this.vault.decrypt(await fs.readFile(this.dir(workerId, 'avatars', `${avatarId}.bin`)));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  purgeAll(workerId) {
    return this.serial(workerId, async () => {
      const value = await this.state(workerId);
      clearTimeout(value.saveTimer);
      this.workers.delete(workerKey(workerId));
      await fs.rm(this.dir(workerId), { recursive: true, force: true, maxRetries: 3 });
      this.emit('purge', { workerId: Number(workerId) });
    });
  }

  // Removes day files and media older than `days` days, plus chats with nothing left.
  purgeOlderThan(workerId, days, now = Date.now()) {
    return this.serial(workerId, async () => {
      const cutoffDay = wibDay(now - days * 86_400_000);
      const cutoffTs = Date.parse(`${cutoffDay}T00:00:00+07:00`);
      let removed = 0;
      for (const day of await this.listDays(workerId)) {
        if (day >= cutoffDay) continue;
        await fs.rm(this.dir(workerId, 'messages', `${day}.log`), { force: true });
        removed += 1;
      }
      try {
        for (const day of await fs.readdir(this.dir(workerId, 'media'))) {
          if (DAY_RE.test(day) && day < cutoffDay) await fs.rm(this.dir(workerId, 'media', day), { recursive: true, force: true });
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const value = await this.state(workerId);
      for (const day of [...value.days.keys()]) if (day < cutoffDay) value.days.delete(day);
      for (const [jid, chat] of Object.entries(value.chats)) {
        if ((chat.lastTs || 0) >= cutoffTs) continue;
        delete value.chats[jid];
        await fs.rm(this.dir(workerId, 'avatars', `${avatarIdFor(jid)}.bin`), { force: true });
      }
      await this.saveIndex(workerId);
      if (removed) this.emit('purge', { workerId: Number(workerId) });
      return removed;
    });
  }

  async usage(workerId) {
    return folderSize(this.dir(workerId));
  }
}

function applyMods(event, mods = []) {
  if (!mods.length) return event;
  const result = { ...event, reactions: { ...(event.reactions || {}) } };
  // mods were collected newest first; apply oldest first.
  for (const mod of [...mods].reverse()) {
    if (mod.t === 'edit') {
      result.history = [...(result.history || []), { text: result.text, ts: result.edited || result.ts }];
      result.text = mod.text;
      result.edited = mod.ts;
    }
    if (mod.t === 'del') result.deleted = mod.ts;
    if (mod.t === 'react') {
      if (mod.emoji) result.reactions[mod.sender || 'unknown'] = mod.emoji;
      else delete result.reactions[mod.sender || 'unknown'];
    }
  }
  return result;
}

const KIND_PREVIEW = {
  image: '📷 Foto', video: '🎥 Video', audio: '🎵 Audio', voice: '🎤 Pesan suara', sticker: '🏷️ Stiker',
  document: '📄 Dokumen', location: '📍 Lokasi', contact: '👤 Kontak', poll: '📊 Polling', other: 'Pesan'
};

export function previewOf(event) {
  const text = String(event.text || '').replace(/\s+/g, ' ').trim();
  if (event.kind === 'text') return text.slice(0, 120);
  const label = `${KIND_PREVIEW[event.kind] || KIND_PREVIEW.other}${event.media?.sound ? ' 🔊' : ''}`;
  return text ? `${label} · ${text}`.slice(0, 120) : label;
}

const EXPORT_LABEL = {
  image: 'gambar', video: 'video', gif: 'gif', audio: 'audio', voice: 'voice note', sticker: 'stiker',
  document: 'dokumen', location: 'lokasi', contact: 'kontak', poll: 'polling', other: 'pesan lain'
};
const exportFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
});
const exportTime = (ts) => exportFormat.format(new Date(ts)).replace(',', '');
const phoneOf = (jid) => {
  const digits = String(jid || '').split('@')[0].split(':')[0];
  return /^\d{8,15}$/.test(digits) && !String(jid).endsWith('@lid') ? `+${digits}` : digits;
};

function exportBody(message) {
  const text = String(message.text || '').replace(/\r?\n/g, '\n  ').trim();
  let body = text;
  if (message.kind !== 'text') {
    const label = message.kind === 'document' && message.media?.fileName ? `dokumen: ${message.media.fileName}` : EXPORT_LABEL[message.kind] || 'pesan lain';
    const own = ['contact', 'poll', 'other'].includes(message.kind) ? '' : text;
    body = `[${label}]${own ? ` ${own}` : ''}`;
    if (message.kind === 'poll' && text) body = `[polling] ${text}`;
    if (message.kind === 'contact' && text) body = `[kontak] ${text}`;
  }
  if (message.deleted) body += ' (dihapus)';
  else if (message.edited) body += ' (diedit)';
  return body;
}

async function folderSize(dir) {
  let total = 0;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await folderSize(target);
    else total += (await fs.stat(target).catch(() => ({ size: 0 }))).size;
  }
  return total;
}
