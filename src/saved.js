import fs from 'node:fs/promises';
import path from 'node:path';
import { getContentType } from 'baileys';
import { SAVED_MESSAGES_DIR, SAVED_MESSAGES_FILE } from './config.js';
import { cleanupFiles, downloadMessageMedia } from './media.js';
import { assertUniqueTitle } from './namedStore.js';
import { getMessageText, unwrapMessage } from './text.js';

function emptyStore() {
  return { nextId: 1, items: [] };
}

async function readStore() {
  try {
    return JSON.parse(await fs.readFile(SAVED_MESSAGES_FILE, 'utf8'));
  } catch {
    return emptyStore();
  }
}

async function writeStore(store) {
  await fs.mkdir(path.dirname(SAVED_MESSAGES_FILE), { recursive: true });
  await fs.writeFile(SAVED_MESSAGES_FILE, `${JSON.stringify(store, null, 2)}\n`);
}

function slug(value) {
  return String(value || 'save')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'save';
}

function findSaved(store, query) {
  const text = String(query || '').trim();
  if (!text) return null;
  const id = Number(text);
  if (Number.isInteger(id)) return store.items.find((item) => item.id === id) || null;
  return store.items.find((item) => item.title.toLowerCase() === text.toLowerCase()) || null;
}

function isRecorderNotice(entry) {
  return entry.kind === 'text' && /^Direkam \(\d+ item\)\.$/.test(String(entry.text || '').trim());
}

function visibleEntries(item) {
  return item.entries.filter((entry) => !isRecorderNotice(entry));
}

function serializeValue(value) {
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { __type: 'Buffer', data: Buffer.from(value).toString('base64') };
  }
  if (Array.isArray(value)) return value.map(serializeValue);
  if (typeof value.toJSON === 'function' && value.constructor?.name !== 'Object') return serializeValue(value.toJSON());
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined && typeof item !== 'function')
        .map(([key, item]) => [key, serializeValue(item)])
    );
  }
  return String(value);
}

function reviveValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (value.__type === 'Buffer' && typeof value.data === 'string') return Buffer.from(value.data, 'base64');
  if (Array.isArray(value)) return value.map(reviveValue);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reviveValue(item)]));
}

function numberLike(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  if (typeof value.toNumber === 'function') return value.toNumber();
  if (typeof value.low === 'number') return value.low;
  return Number(value);
}

function pollContent(node) {
  const values = (node.options || [])
    .map((option) => option.optionName || option.name)
    .filter(Boolean);
  if (!node.name || !values.length) return null;
  return {
    name: node.name,
    values,
    selectableCount: numberLike(node.selectableOptionsCount || node.selectableCount) || 1
  };
}

function eventContent(node) {
  const start = numberLike(node.startTime);
  if (!node.name || !start) return null;
  const end = numberLike(node.endTime);
  return {
    name: node.name,
    description: node.description || undefined,
    startTime: start,
    endTime: end || undefined,
    location: node.location ? serializeValue(node.location) : undefined,
    call: node.joinLink?.includes('video') ? 'video' : undefined,
    isCancelled: node.isCanceled ?? undefined,
    isScheduleCall: node.isScheduleCall ?? undefined,
    extraGuestsAllowed: node.extraGuestsAllowed ?? undefined
  };
}

function fallbackEntry(messageType, node, text) {
  return {
    kind: 'unsupported',
    messageType: messageType || 'unknown',
    text: text || '',
    data: serializeValue(node || {})
  };
}

function serializeNonMedia(message, text) {
  const content = unwrapMessage(message?.message);
  const type = getContentType(content || {});
  const node = type ? content[type] : null;

  if (!type) return null;
  if (type === 'conversation' || type === 'extendedTextMessage') {
    return text ? { kind: 'text', text } : null;
  }
  if (type === 'locationMessage' || type === 'liveLocationMessage') {
    return { kind: 'location', location: serializeValue(node), live: type === 'liveLocationMessage' };
  }
  if (type === 'contactMessage') {
    return {
      kind: 'contact',
      displayName: node.displayName || node.vcard || 'Contact',
      contact: serializeValue(node)
    };
  }
  if (type === 'contactsArrayMessage') {
    return {
      kind: 'contacts',
      displayName: node.displayName || 'Contacts',
      contacts: serializeValue(node.contacts || [])
    };
  }
  if (['pollCreationMessage', 'pollCreationMessageV2', 'pollCreationMessageV3', 'pollCreationMessageV5'].includes(type)) {
    const poll = pollContent(node);
    return poll ? { kind: 'poll', poll } : fallbackEntry(type, node, text);
  }
  if (type === 'eventMessage') {
    const event = eventContent(node);
    return event ? { kind: 'event', event } : fallbackEntry(type, node, text);
  }
  if (text) return { kind: 'text', text };
  return fallbackEntry(type, node, text);
}

export function parseSaveStart(command) {
  if (!command.args.length) throw new Error('Format: ,save <judul> [teks awal]');
  const title = command.args[0];
  const firstText = command.args.slice(1).join(' ').trim();
  return { title, firstText };
}

export class SaveRecorder {
  constructor() {
    this.sessions = new Map();
  }

  start(jid, title, firstText = '') {
    this.cancel(jid);
    const session = {
      jid,
      title,
      entries: [],
      tempFiles: [],
      startedAt: Date.now()
    };
    if (firstText) session.entries.push({ kind: 'text', text: firstText });
    this.sessions.set(jid, session);
    return session;
  }

  has(jid) {
    return this.sessions.has(jid);
  }

  async record(sock, message) {
    const session = this.sessions.get(message.key.remoteJid);
    if (!session) return null;
    const media = await downloadMessageMedia(sock, message, 'save-item');
    const text = getMessageText(message).trim();

    if (media) {
      session.tempFiles.push(media.path);
      session.entries.push({
        kind: 'media',
        tempPath: media.path,
        mimetype: media.mimetype,
        fileName: media.fileName || path.basename(media.path),
        messageType: media.type,
        caption: text,
        isAnimated: Boolean(media.node?.isAnimated)
      });
      return { type: 'media', count: session.entries.length };
    }

    const entry = serializeNonMedia(message, text);
    if (!entry) return null;
    session.entries.push(entry);
    return { type: entry.kind, count: session.entries.length };
  }

  async finish(jid) {
    const session = this.sessions.get(jid);
    if (!session) return null;
    if (!session.entries.length) throw new Error('Belum ada isi yang direkam.');
    const store = await readStore();
    assertUniqueTitle(store, session.title);
    const id = store.nextId++;
    const dir = path.join(SAVED_MESSAGES_DIR, `${id}-${slug(session.title)}`);
    await fs.mkdir(dir, { recursive: true });

    const entries = [];
    for (const [index, entry] of session.entries.entries()) {
      if (entry.kind !== 'media') {
        entries.push(entry);
        continue;
      }
      const ext = path.extname(entry.tempPath) || path.extname(entry.fileName) || '.bin';
      const dest = path.join(dir, `${String(index + 1).padStart(3, '0')}${ext}`);
      await fs.copyFile(entry.tempPath, dest);
      entries.push({
        kind: 'media',
        path: dest,
        mimetype: entry.mimetype,
        fileName: entry.fileName,
        messageType: entry.messageType,
        caption: entry.caption,
        isAnimated: entry.isAnimated
      });
    }

    const item = {
      id,
      title: session.title,
      entries,
      createdAt: new Date().toISOString()
    };
    store.items.push(item);
    await writeStore(store);
    await this.cancel(jid);
    return item;
  }

  async cancel(jid) {
    const session = this.sessions.get(jid);
    if (!session) return false;
    this.sessions.delete(jid);
    await cleanupFiles(session.tempFiles);
    return true;
  }
}

export async function listSaved() {
  const store = await readStore();
  return store.items;
}

export async function assertSavedTitleAvailable(title) {
  const store = await readStore();
  assertUniqueTitle(store, title);
}

export function formatSavedList(items) {
  if (!items.length) return 'Belum ada pesan tersimpan.';
  return items.map((item) => `#${item.id} - ${item.title} (${visibleEntries(item).length} item)`).join('\n');
}

export async function deleteSaved(query) {
  const store = await readStore();
  const item = findSaved(store, query);
  if (!item) throw new Error(`Save "${query}" tidak ditemukan.`);
  store.items = store.items.filter((saved) => saved.id !== item.id);
  await writeStore(store);
  const dirs = new Set(item.entries.filter((entry) => entry.path).map((entry) => path.dirname(entry.path)));
  await Promise.all([...dirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
  return item;
}

export async function getSaved(query) {
  const store = await readStore();
  return findSaved(store, query);
}

export async function renameSaved(query, newTitle) {
  const store = await readStore();
  const item = findSaved(store, query);
  if (!item) throw new Error(`Save "${query}" tidak ditemukan.`);
  assertUniqueTitle(store, newTitle, item.id);
  item.title = String(newTitle || '').trim();
  item.updatedAt = new Date().toISOString();
  await writeStore(store);
  return item;
}

async function sendUnsupported(sock, jid, entry) {
  const body = JSON.stringify(entry.data || {}, null, 2);
  const summary = [
    `Pesan tersimpan bertipe ${entry.messageType}, belum bisa dikirim ulang native.`,
    entry.text ? `Teks: ${entry.text}` : '',
    body && body.length <= 2500 ? body : ''
  ].filter(Boolean).join('\n\n');
  if (body.length > 2500) {
    await sock.sendMessage(jid, {
      document: Buffer.from(body),
      mimetype: 'application/json',
      fileName: `saved-${entry.messageType}.json`,
      caption: summary || `Fallback JSON untuk ${entry.messageType}`
    });
    return;
  }
  await sock.sendMessage(jid, { text: summary || `Pesan bertipe ${entry.messageType} tersimpan sebagai fallback.` });
}

async function sendMediaEntry(sock, jid, entry) {
  const buffer = await fs.readFile(entry.path);
  if (entry.messageType === 'imageMessage') {
    await sock.sendMessage(jid, { image: buffer, mimetype: entry.mimetype, caption: entry.caption || undefined });
  } else if (entry.messageType === 'videoMessage') {
    await sock.sendMessage(jid, { video: buffer, mimetype: entry.mimetype, caption: entry.caption || undefined });
  } else if (entry.messageType === 'audioMessage') {
    await sock.sendMessage(jid, { audio: buffer, mimetype: entry.mimetype });
  } else if (entry.messageType === 'stickerMessage') {
    await sock.sendMessage(jid, { sticker: buffer, isAnimated: entry.isAnimated || undefined });
  } else {
    await sock.sendMessage(jid, {
      document: buffer,
      mimetype: entry.mimetype || 'application/octet-stream',
      fileName: entry.fileName || path.basename(entry.path),
      caption: entry.caption || undefined
    });
  }
}

export async function sendSaved(sock, jid, item) {
  for (const entry of visibleEntries(item)) {
    if (entry.kind === 'text') {
      await sock.sendMessage(jid, { text: entry.text });
    } else if (entry.kind === 'media') {
      await sendMediaEntry(sock, jid, entry);
    } else if (entry.kind === 'location') {
      await sock.sendMessage(jid, { location: reviveValue(entry.location) });
    } else if (entry.kind === 'contact') {
      await sock.sendMessage(jid, {
        contacts: { displayName: entry.displayName || 'Contact', contacts: [reviveValue(entry.contact)] }
      });
    } else if (entry.kind === 'contacts') {
      await sock.sendMessage(jid, {
        contacts: { displayName: entry.displayName || 'Contacts', contacts: reviveValue(entry.contacts || []) }
      });
    } else if (entry.kind === 'poll') {
      await sock.sendMessage(jid, { poll: entry.poll });
    } else if (entry.kind === 'event') {
      const event = {
        ...entry.event,
        startDate: new Date(entry.event.startTime * 1000),
        endDate: entry.event.endTime ? new Date(entry.event.endTime * 1000) : undefined,
        location: entry.event.location ? reviveValue(entry.event.location) : undefined
      };
      delete event.startTime;
      delete event.endTime;
      await sock.sendMessage(jid, { event });
    } else {
      await sendUnsupported(sock, jid, entry);
    }
  }
}
