import fs from 'node:fs/promises';
import path from 'node:path';
import { ANTICALL_FILE, ANTICALL_MEDIA_DIR } from './config.js';
import { cleanupFiles } from './media.js';
import { displayPhoneFromJid, normalizePhoneToJid, sameJid, tryNormalizeJid } from './phone.js';
import {
  persistRecordedEntries,
  recordMessageEntry,
  sendRecordedEntries,
  visibleRecordedEntries
} from './recordedMessages.js';

function defaultStore() {
  return { enabled: false, entries: [], exceptions: [], nextExceptionId: 1, createdAt: null, updatedAt: null };
}

function normalizeStore(value) {
  const store = value && typeof value === 'object' ? value : {};
  const normalized = {
    enabled: Boolean(store.enabled),
    entries: Array.isArray(store.entries) ? store.entries : [],
    exceptions: normalizeExceptions(store.exceptions),
    nextExceptionId: Number.isInteger(store.nextExceptionId) && store.nextExceptionId > 0 ? store.nextExceptionId : 1,
    createdAt: store.createdAt || null,
    updatedAt: store.updatedAt || null
  };
  renumberExceptions(normalized);
  return normalized;
}

function entryDirs(entries = []) {
  return new Set(
    entries
      .filter((entry) => entry.kind === 'media' && entry.path)
      .map((entry) => path.dirname(entry.path))
  );
}

async function removeEntryDirs(entries = []) {
  await Promise.all([...entryDirs(entries)].map((dir) => fs.rm(dir, { recursive: true, force: true })));
}

export function formatAnticallStatus(snapshot) {
  return [
    `Anticall: ${snapshot.enabled ? 'aktif' : 'nonaktif'}.`,
    `Pesan: ${snapshot.hasMessage ? `${snapshot.entryCount} item` : 'belum ada'}.`,
    `Exception: ${snapshot.exceptionCount || 0} nomor.`,
    snapshot.updatedAt ? `Update: ${new Date(snapshot.updatedAt).toLocaleString()}` : null,
    '',
    'Command: ,anticall new | ,anticall on | ,anticall off | ,anticall except list|add|del <nomor|id>'
  ].filter(Boolean).join('\n');
}

export class AnticallStore {
  constructor(file = ANTICALL_FILE, mediaDir = ANTICALL_MEDIA_DIR) {
    this.file = file;
    this.mediaDir = mediaDir;
    this.store = defaultStore();
    this.sessions = new Map();
  }

  async load() {
    try {
      this.store = normalizeStore(JSON.parse(await fs.readFile(this.file, 'utf8')));
    } catch {
      this.store = defaultStore();
      await this.save();
    }
    return this.snapshot();
  }

  snapshot() {
    const visible = visibleRecordedEntries(this.store.entries);
    return {
      enabled: Boolean(this.store.enabled),
      hasMessage: visible.length > 0,
      entryCount: visible.length,
      exceptionCount: this.store.exceptions.length,
      exceptions: this.listExceptions(),
      updatedAt: this.store.updatedAt,
      createdAt: this.store.createdAt
    };
  }

  has(jid) {
    return this.sessions.has(jid);
  }

  hasMessage() {
    return this.snapshot().hasMessage;
  }

  async start(jid, actorJid = jid) {
    await this.cancel(jid);
    const session = {
      jid,
      actorJid,
      entries: [],
      tempFiles: [],
      startedAt: Date.now()
    };
    this.sessions.set(jid, session);
    return session;
  }

  isActor(jid, actorJid) {
    const session = this.sessions.get(jid);
    return !session || !actorJid || session.actorJid === actorJid;
  }

  async record(sock, message) {
    const session = this.sessions.get(message.key.remoteJid);
    if (!session) return null;
    const recorded = await recordMessageEntry(sock, message, 'anticall-item');
    if (!recorded) return null;
    if (recorded.tempFile) session.tempFiles.push(recorded.tempFile);
    session.entries.push(recorded.entry);
    return { type: recorded.type, count: session.entries.length };
  }

  async finish(jid, actorJid = null) {
    const session = this.sessions.get(jid);
    if (!session) return null;
    if (actorJid && session.actorJid !== actorJid) return null;
    if (!session.entries.length) throw new Error('Belum ada isi pesan anticall yang direkam.');

    const oldEntries = this.store.entries;
    const now = new Date().toISOString();
    const dir = path.join(this.mediaDir, `response-${Date.now()}`);
    let entries = null;
    try {
      entries = await persistRecordedEntries(session.entries, dir);
      this.store = {
        enabled: Boolean(this.store.enabled),
        entries,
        exceptions: this.store.exceptions,
        nextExceptionId: this.store.nextExceptionId,
        createdAt: this.store.createdAt || now,
        updatedAt: now
      };
      await this.save();
      this.sessions.delete(jid);
      await cleanupFiles(session.tempFiles);
      await removeEntryDirs(oldEntries);
      return this.snapshot();
    } catch (error) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async cancel(jid, actorJid = null) {
    const session = this.sessions.get(jid);
    if (!session) return false;
    if (actorJid && session.actorJid !== actorJid) return false;
    this.sessions.delete(jid);
    await cleanupFiles(session.tempFiles);
    return true;
  }

  async setEnabled(enabled) {
    if (enabled && !this.hasMessage()) throw new Error('Pesan anticall belum ada. Buat dulu dengan ,anticall new.');
    this.store.enabled = Boolean(enabled);
    await this.save();
    return this.snapshot();
  }

  async send(sock, jid) {
    if (!this.store.enabled || !this.hasMessage()) return false;
    await sendRecordedEntries(sock, jid, this.store.entries);
    return true;
  }

  listExceptions() {
    return this.store.exceptions.map((item) => ({ ...item }));
  }

  async addException(input) {
    const jid = normalizePhoneToJid(input);
    const existing = this.store.exceptions.find((item) => sameJid(item.jid, jid));
    if (existing) throw new Error(`Exception ${existing.title} sudah tersimpan sebagai #${existing.id}.`);
    const item = {
      id: this.store.nextExceptionId++,
      title: displayPhoneFromJid(jid),
      jid,
      createdAt: new Date().toISOString()
    };
    this.store.exceptions.push(item);
    renumberExceptions(this.store);
    await this.save();
    return { ...item };
  }

  async deleteException(query) {
    const item = findException(this.store.exceptions, query);
    if (!item) throw new Error(`Exception "${query}" tidak ditemukan.`);
    this.store.exceptions = this.store.exceptions.filter((candidate) => candidate.id !== item.id);
    renumberExceptions(this.store);
    await this.save();
    return { ...item };
  }

  isException(jid) {
    return Boolean(findException(this.store.exceptions, jid));
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.mkdir(this.mediaDir, { recursive: true });
    await fs.writeFile(this.file, `${JSON.stringify(this.store, null, 2)}\n`);
  }
}

function normalizeExceptions(value) {
  const exceptions = [];
  const seen = new Set();
  if (!Array.isArray(value)) return exceptions;
  for (const raw of value) {
    const jid = tryNormalizeJid(raw?.jid) || (typeof raw === 'string' ? tryNormalizeJid(raw) : null);
    if (!jid || seen.has(jid)) continue;
    seen.add(jid);
    exceptions.push({
      id: Number.isInteger(raw?.id) && raw.id > 0 ? raw.id : exceptions.length + 1,
      title: String(raw?.title || displayPhoneFromJid(jid)).trim() || displayPhoneFromJid(jid),
      jid,
      createdAt: raw?.createdAt || null,
      updatedAt: raw?.updatedAt || null
    });
  }
  return exceptions.sort((a, b) => a.id - b.id);
}

function findException(items, query) {
  const text = String(query || '').trim();
  if (!text) return null;
  const id = Number(text);
  if (/^\d{1,6}$/.test(text) && Number.isInteger(id)) return items.find((item) => item.id === id) || null;
  let jid = tryNormalizeJid(text);
  if (!jid) {
    try {
      jid = normalizePhoneToJid(text);
    } catch {
      return null;
    }
  }
  return items.find((item) => sameJid(item.jid, jid)) || null;
}

function renumberExceptions(store) {
  store.exceptions = [...(store.exceptions || [])].map((item, index) => ({ ...item, id: index + 1 }));
  store.nextExceptionId = store.exceptions.length + 1;
}
