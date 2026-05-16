import fs from 'node:fs/promises';
import path from 'node:path';
import { ANTICALL_FILE, ANTICALL_MEDIA_DIR } from './config.js';
import { cleanupFiles } from './media.js';
import {
  persistRecordedEntries,
  recordMessageEntry,
  sendRecordedEntries,
  visibleRecordedEntries
} from './recordedMessages.js';

function defaultStore() {
  return { enabled: false, entries: [], createdAt: null, updatedAt: null };
}

function normalizeStore(value) {
  const store = value && typeof value === 'object' ? value : {};
  return {
    enabled: Boolean(store.enabled),
    entries: Array.isArray(store.entries) ? store.entries : [],
    createdAt: store.createdAt || null,
    updatedAt: store.updatedAt || null
  };
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
    snapshot.updatedAt ? `Update: ${new Date(snapshot.updatedAt).toLocaleString()}` : null,
    '',
    'Command: ,anticall new | ,anticall on | ,anticall off'
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

  async start(jid) {
    await this.cancel(jid);
    const session = {
      jid,
      entries: [],
      tempFiles: [],
      startedAt: Date.now()
    };
    this.sessions.set(jid, session);
    return session;
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

  async finish(jid) {
    const session = this.sessions.get(jid);
    if (!session) return null;
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

  async cancel(jid) {
    const session = this.sessions.get(jid);
    if (!session) return false;
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

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.mkdir(this.mediaDir, { recursive: true });
    await fs.writeFile(this.file, `${JSON.stringify(this.store, null, 2)}\n`);
  }
}
