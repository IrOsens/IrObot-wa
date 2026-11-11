import fs from 'node:fs/promises';
import path from 'node:path';
import { UserInputError } from './errors.js';
import { cleanupFiles } from './media.js';
import { persistRecordedEntries, recordMessageEntry } from './recordedMessages.js';

export class CintaRecorder {
  constructor() {
    this.sessions = new Map();
  }

  async start(jid, actorJid) {
    await this.cancel(jid);
    this.sessions.set(jid, { jid, actorJid, entries: [], tempFiles: [], startedAt: Date.now() });
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
    const recorded = await recordMessageEntry(sock, message, 'cinta-item');
    if (!recorded) return null;
    if (recorded.tempFile) session.tempFiles.push(recorded.tempFile);
    session.entries.push(recorded.entry);
    return { type: recorded.type, count: session.entries.length };
  }

  async finish(jid, actorJid, mediaDir) {
    const session = this.sessions.get(jid);
    if (!session) return null;
    if (actorJid && session.actorJid !== actorJid) return null;
    if (!session.entries.length) throw new UserInputError('Belum ada isi pesan yang direkam.');
    let entries;
    try {
      entries = await persistRecordedEntries(session.entries, mediaDir);
    } catch (error) {
      await fs.rm(mediaDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    this.sessions.delete(jid);
    await cleanupFiles(session.tempFiles);
    return entries;
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

// Media paths are stored relative to the worker data folder so they stay valid after the folder is archived.
export function relativeEntries(entries, dataDir) {
  return entries.map((entry) => (entry.kind === 'media' ? { ...entry, path: path.relative(dataDir, entry.path) } : entry));
}

export function absoluteEntries(entries, dataDir) {
  return entries.map((entry) => (entry.kind === 'media' ? { ...entry, path: path.resolve(dataDir, entry.path) } : entry));
}

export async function removeStoredMedia(entries, dataDir) {
  const cintaDir = path.join(dataDir, 'cinta');
  const dirs = new Set(entries.filter((entry) => entry.kind === 'media').map((entry) => path.dirname(path.resolve(dataDir, entry.path))));
  for (const dir of dirs) {
    if (dir.startsWith(`${cintaDir}${path.sep}`)) await fs.rm(dir, { recursive: true, force: true });
  }
}
