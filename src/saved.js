import fs from 'node:fs/promises';
import path from 'node:path';
import { SAVED_MESSAGES_DIR, SAVED_MESSAGES_FILE } from './config.js';
import { cleanupFiles } from './media.js';
import { assertUniqueTitle, renumberCollection } from './namedStore.js';
import {
  persistRecordedEntries,
  recordMessageEntry,
  sendRecordedEntries,
  visibleRecordedEntries
} from './recordedMessages.js';

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

function visibleEntries(item) {
  return visibleRecordedEntries(item.entries);
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

  start(jid, title, firstText = '', actorJid = jid) {
    this.cancel(jid);
    const session = {
      jid,
      actorJid,
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
    const store = await readStore();
    assertUniqueTitle(store, session.title);
    const id = store.nextId++;
    const dir = path.join(SAVED_MESSAGES_DIR, `${id}-${slug(session.title)}`);
    await fs.mkdir(dir, { recursive: true });

    const entries = await persistRecordedEntries(session.entries, dir);

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

export function formatSavedList(items) {
  if (!items.length) return 'Belum ada pesan tersimpan.';
  return items.map((item) => `#${item.id} - ${item.title} (${visibleEntries(item).length} item)`).join('\n');
}

export async function deleteSaved(query) {
  const store = await readStore();
  const item = findSaved(store, query);
  if (!item) throw new Error(`Save "${query}" tidak ditemukan.`);
  store.items = store.items.filter((saved) => saved.id !== item.id);
  renumberCollection(store);
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

export async function sendSaved(sock, jid, item) {
  await sendRecordedEntries(sock, jid, visibleEntries(item));
}
