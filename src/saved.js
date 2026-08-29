import fs from 'node:fs/promises';
import path from 'node:path';
import { SAVED_MESSAGES_DIR, SAVED_MESSAGES_FILE } from './config.js';
import { cleanupFiles } from './media.js';
import { assertUniqueTitle } from './namedStore.js';
import {
  persistRecordedEntries,
  recordMessageEntry,
  sendRecordedEntries,
  visibleRecordedEntries
} from './recordedMessages.js';

function emptyStore() {
  return { nextId: 1, items: [] };
}

async function readStore(file = SAVED_MESSAGES_FILE) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const maxId = items.reduce((highest, item) => Math.max(highest, Number(item.id) || 0), 0);
    return {
      nextId: Math.max(Number(parsed.nextId) || 1, maxId + 1),
      items
    };
  } catch {
    return emptyStore();
  }
}

async function writeStore(store, file = SAVED_MESSAGES_FILE) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(store, null, 2)}\n`);
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

function visibleEntries(item) {
  return visibleRecordedEntries(item.entries);
}

export function parseSaveStart(command) {
  if (!command.args.length) throw new Error('Format: ,save <judul> [teks awal]');
  const title = command.args[0];
  const firstText = command.args.slice(1).join(' ').trim();
  return { title, firstText };
}

export function parseSaveUpdate(command) {
  if ((command.args[0] || '').toLowerCase() !== 'update') return null;
  const query = command.args[1];
  const newTitle = command.args.slice(2).join(' ').trim();
  if (!query) throw new Error('Format: ,save update <id|"judul lama"> ["judul baru"]');
  return { query, newTitle };
}

export class SaveRecorder {
  constructor({ file = SAVED_MESSAGES_FILE, mediaDir = SAVED_MESSAGES_DIR } = {}) {
    this.sessions = new Map();
    this.file = file;
    this.mediaDir = mediaDir;
  }

  start(jid, title, firstText = '', actorJid = jid, options = {}) {
    this.cancel(jid);
    const session = {
      jid,
      actorJid,
      title,
      entries: [],
      tempFiles: [],
      replaceId: options.replaceId || null,
      startedAt: Date.now()
    };
    if (firstText) session.entries.push({ kind: 'text', text: firstText });
    this.sessions.set(jid, session);
    return session;
  }

  startUpdate(jid, saved, title = saved?.title, actorJid = jid) {
    if (!saved?.id) throw new Error('Save yang akan diupdate tidak valid.');
    return this.start(jid, title, '', actorJid, { replaceId: saved.id });
  }

  has(jid) {
    return this.sessions.has(jid);
  }

  isActor(jid, actorJid) {
    const session = this.sessions.get(jid);
    return !session || !actorJid || session.actorJid === actorJid;
  }

  async record(sock, message) {
    const session = this.sessions.get(message.key.remoteJid);
    if (!session) return null;
    const recorded = await recordMessageEntry(sock, message, 'save-item');
    if (!recorded) return null;
    if (recorded.tempFile) session.tempFiles.push(recorded.tempFile);
    session.entries.push(recorded.entry);
    return { type: recorded.type, count: session.entries.length };
  }

  async finish(jid, actorJid = null) {
    const session = this.sessions.get(jid);
    if (!session) return null;
    if (actorJid && session.actorJid !== actorJid) return null;
    if (!session.entries.length) throw new Error('Belum ada isi yang direkam.');
    const store = await readStore(this.file);
    const replaced = session.replaceId ? findSaved(store, session.replaceId) : null;
    if (session.replaceId && !replaced) throw new Error(`Save #${session.replaceId} yang akan diupdate sudah tidak ditemukan.`);
    assertUniqueTitle(store, session.title, replaced?.id || null);
    const id = store.nextId++;
    const dir = path.join(this.mediaDir, `${id}-${slug(session.title)}`);
    await fs.mkdir(dir, { recursive: true });
    let result;
    try {
      const entries = await persistRecordedEntries(session.entries, dir);
      const now = new Date().toISOString();
      const item = {
        id,
        title: session.title,
        entries,
        createdAt: now,
        ...(replaced ? { updatedAt: now } : {})
      };
      if (replaced) store.items = store.items.filter((saved) => saved.id !== replaced.id);
      store.items.push(item);
      await writeStore(store, this.file);
      result = replaced ? { ...item, replacedId: replaced.id } : item;
    } catch (error) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    await this.cancel(jid);
    if (replaced) await cleanupSavedMedia(replaced).catch(() => {});
    return result;
  }

  async cancel(jid, actorJid = null) {
    const session = this.sessions.get(jid);
    if (!session) return false;
    if (actorJid && session.actorJid !== actorJid) return false;
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

export async function prepareSavedUpdate(query, newTitle = '') {
  const store = await readStore();
  const item = findSaved(store, query);
  if (!item) throw new Error(`Save "${query}" tidak ditemukan.`);
  const title = String(newTitle || item.title).trim();
  assertUniqueTitle(store, title, item.id);
  return { item, title };
}

export function formatSavedList(items) {
  if (!items.length) return 'Belum ada pesan tersimpan.';
  return items.map((item) => `#${item.id} - ${item.title} (${visibleEntries(item).length} item)`).join('\n');
}

export async function deleteSaved(query, { file = SAVED_MESSAGES_FILE } = {}) {
  const store = await readStore(file);
  const item = findSaved(store, query);
  if (!item) throw new Error(`Save "${query}" tidak ditemukan.`);
  store.items = store.items.filter((saved) => saved.id !== item.id);
  await writeStore(store, file);
  await cleanupSavedMedia(item);
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

export async function sendSaved(sock, jid, item) {
  await sendRecordedEntries(sock, jid, visibleEntries(item));
}

async function cleanupSavedMedia(item) {
  const dirs = new Set((item.entries || []).filter((entry) => entry.path).map((entry) => path.dirname(entry.path)));
  await Promise.all([...dirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
}
