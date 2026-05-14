import fs from 'node:fs/promises';
import path from 'node:path';
import { SAVED_MESSAGES_DIR, SAVED_MESSAGES_FILE } from './config.js';
import { cleanupFiles, downloadMessageMedia } from './media.js';
import { getMessageText } from './text.js';

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
        caption: text
      });
      return { type: 'media', count: session.entries.length };
    }
    if (text) {
      session.entries.push({ kind: 'text', text });
      return { type: 'text', count: session.entries.length };
    }
    return null;
  }

  async finish(jid) {
    const session = this.sessions.get(jid);
    if (!session) return null;
    if (!session.entries.length) throw new Error('Belum ada isi yang direkam.');
    const store = await readStore();
    const id = store.nextId++;
    const dir = path.join(SAVED_MESSAGES_DIR, `${id}-${slug(session.title)}`);
    await fs.mkdir(dir, { recursive: true });

    const entries = [];
    for (const [index, entry] of session.entries.entries()) {
      if (entry.kind === 'text') {
        entries.push({ kind: 'text', text: entry.text });
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
        caption: entry.caption
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

export async function sendSaved(sock, jid, item) {
  for (const entry of visibleEntries(item)) {
    if (entry.kind === 'text') {
      await sock.sendMessage(jid, { text: entry.text });
      continue;
    }
    const buffer = await fs.readFile(entry.path);
    if (entry.messageType === 'imageMessage') {
      await sock.sendMessage(jid, { image: buffer, mimetype: entry.mimetype, caption: entry.caption || undefined });
    } else if (entry.messageType === 'videoMessage') {
      await sock.sendMessage(jid, { video: buffer, mimetype: entry.mimetype, caption: entry.caption || undefined });
    } else if (entry.messageType === 'audioMessage') {
      await sock.sendMessage(jid, { audio: buffer, mimetype: entry.mimetype });
    } else if (entry.messageType === 'stickerMessage') {
      await sock.sendMessage(jid, { sticker: buffer });
    } else {
      await sock.sendMessage(jid, {
        document: buffer,
        mimetype: entry.mimetype || 'application/octet-stream',
        fileName: entry.fileName || path.basename(entry.path),
        caption: entry.caption || undefined
      });
    }
  }
}
