import { UserInputError } from './errors.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, RESTORE_SESSION_TIMEOUT_MS, TEMP_DIR } from './config.js';
import { cleanupFiles, downloadMessageMedia } from './media.js';
import { atomicJson } from './storage.js';
import { extractZipBuffer } from './zip.js';
import { randomUUID } from 'node:crypto';

export class RestoreSessions {
  constructor() {
    this.sessions = new Map();
  }

  async start(jid, actorJid = jid, { mode = 'full' } = {}) {
    const old = this.end(jid);
    if (old) await this.cleanup(old);
    const tempDir = await fs.mkdtemp(path.join(TEMP_DIR, 'restore-'));
    const session = {
      jid,
      actorJid,
      mode,
      phase: 'upload',
      selectedIds: new Set(),
      page: 0,
      tempDir,
      files: [],
      startedAt: Date.now(),
      timer: setTimeout(() => {
        const expired = this.end(jid);
        this.cleanup(expired).catch(() => {});
      }, RESTORE_SESSION_TIMEOUT_MS)
    };
    this.sessions.set(jid, session);
    return session;
  }

  isActor(jid, actorJid) {
    const session = this.sessions.get(jid);
    return !session || !actorJid || session.actorJid === actorJid;
  }

  has(jid) {
    return this.sessions.has(jid);
  }

  count() {
    return this.sessions.size;
  }

  end(jid, actorJid = null) {
    const session = this.sessions.get(jid);
    if (!session) return null;
    if (actorJid && session.actorJid !== actorJid) return null;
    clearTimeout(session.timer);
    this.sessions.delete(jid);
    return session;
  }

  async cancel(jid, actorJid = null) {
    const session = this.end(jid, actorJid);
    if (!session) return false;
    await this.cleanup(session);
    return true;
  }

  async add(sock, message) {
    const session = this.sessions.get(message.key.remoteJid);
    if (!session) return null;
    const media = await downloadMessageMedia(sock, message, 'restore-part');
    if (!media) return null;
    if (!/\.zip$/i.test(media.fileName || media.path)) {
      await cleanupFiles([media.path]);
      throw new Error('Restore hanya menerima dokumen .zip.');
    }
    const dest = path.join(session.tempDir, `${String(session.files.length + 1).padStart(3, '0')}-${safeFileName(media.fileName || 'restore.zip')}`);
    await fs.copyFile(media.path, dest);
    await cleanupFiles([media.path]);
    const item = {
      path: dest,
      fileName: media.fileName || path.basename(dest),
      receivedAt: Date.now()
    };
    session.files.push(item);
    return item;
  }

  async restore(session) {
    if (!session?.files?.length) throw new UserInputError('Belum ada file zip untuk restore.');
    const ordered = orderRestoreParts(session.files);
    const zipBuffer = Buffer.concat(await Promise.all(ordered.map((file) => fs.readFile(file.path))));
    const extractDir = await fs.mkdtemp(path.join(TEMP_DIR, 'restore-extract-'));
    try {
      const extracted = await extractZipBuffer(zipBuffer, extractDir);
      if (!extracted) throw new Error('ZIP restore kosong.');
      const sourceDir = await resolveDataSourceDir(extractDir);
      await overwriteDataDir(sourceDir);
      return { extracted, parts: ordered.length };
    } finally {
      await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
      await this.cleanup(session);
    }
  }

  async prepareSaved(session) {
    if (session?.mode !== 'save' || !session.files.length) throw new UserInputError('Belum ada ZIP backup untuk restore save.');
    const ordered = orderRestoreParts(session.files);
    const numbered = ordered.map((file) => String(file.fileName || '').match(/^PART(\d+)-(.+)\.zip$/i));
    if (numbered.some(Boolean) && (numbered.some((match) => !match)
      || numbered.some((match, index) => Number(match[1]) !== index + 1 || match[2] !== numbered[0][2]))) {
      throw new UserInputError('Part backup harus lengkap dan berasal dari backup yang sama.');
    }
    const zipBuffer = Buffer.concat(await Promise.all(ordered.map((file) => fs.readFile(file.path))));
    if (zipBuffer.length < 22 || zipBuffer.readUInt32LE(zipBuffer.length - 22) !== 0x06054b50) {
      throw new UserInputError('ZIP backup belum lengkap atau rusak. Periksa semua part.');
    }
    const extractDir = path.join(session.tempDir, 'extracted');
    await fs.rm(extractDir, { recursive: true, force: true });
    await fs.mkdir(extractDir, { recursive: true });
    const extracted = await extractZipBuffer(zipBuffer, extractDir);
    if (!extracted) throw new UserInputError('ZIP backup kosong.');
    const sourceDir = await resolveDataSourceDir(extractDir);
    let saved;
    try {
      saved = JSON.parse(await fs.readFile(path.join(sourceDir, 'saved-messages.json'), 'utf8'));
    } catch {
      throw new UserInputError('Backup tidak berisi saved-messages.json yang valid.');
    }
    if (!Array.isArray(saved.items) || !saved.items.length) throw new UserInputError('Backup tidak berisi save yang dapat dipulihkan.');
    const ids = new Set();
    const titles = new Set();
    for (const item of saved.items) {
      const title = String(item?.title || '').trim();
      if (!Number.isSafeInteger(item?.id) || item.id < 1 || !title || !Array.isArray(item.entries)
        || item.entries.some((entry) => !entry || typeof entry !== 'object' || typeof entry.kind !== 'string')
        || ids.has(item.id) || titles.has(title.toLowerCase())) throw new UserInputError('Daftar save dalam backup tidak valid.');
      ids.add(item.id);
      titles.add(title.toLowerCase());
    }
    session.sourceDir = sourceDir;
    session.savedItems = saved.items;
    session.savedNextId = Number(saved.nextId) || 1;
    session.phase = 'scope';
    session.selectedIds.clear();
    return { count: saved.items.length, parts: ordered.length };
  }

  async restoreSaved(session, { dataDir = DATA_DIR } = {}) {
    if (session?.mode !== 'save' || !session.savedItems?.length || !session.restoreMode || !session.selectedIds.size) {
      throw new UserInputError('Pilihan restore save belum lengkap.');
    }
    const selected = session.savedItems.filter((item) => session.selectedIds.has(item.id));
    if (selected.length !== session.selectedIds.size) throw new UserInputError('Pilihan save dari backup tidak valid.');
    const savedFile = path.join(dataDir, 'saved-messages.json');
    const mediaDir = path.join(dataDir, 'saved-messages');
    let current;
    try {
      current = JSON.parse(await fs.readFile(savedFile, 'utf8'));
      if (!Array.isArray(current.items)) throw new Error('items invalid');
    } catch (error) {
      if (error.code !== 'ENOENT') throw new UserInputError('Data save saat ini tidak dapat dibaca; restore dibatalkan.');
      current = { nextId: 1, items: [] };
    }
    const sourceMediaDir = path.join(session.sourceDir, 'saved-messages');
    const media = [];
    for (const item of selected) {
      for (const entry of item.entries) {
        if (entry?.kind !== 'media') continue;
        const relative = savedMediaRelativePath(entry.path);
        const source = path.resolve(sourceMediaDir, relative);
        if (!source.startsWith(`${path.resolve(sourceMediaDir)}${path.sep}`)) throw new UserInputError('Path media backup tidak aman.');
        try {
          if (!(await fs.stat(source)).isFile()) throw new Error('not a file');
        } catch {
          throw new UserInputError(`Media save #${item.id} tidak ada dalam backup: ${relative}`);
        }
        media.push({ entry, source });
      }
    }
    const mode = session.restoreMode;
    if (!['overwrite', 'merge'].includes(mode)) throw new UserInputError('Mode restore save tidak valid.');
    const occupiedTitles = new Set((mode === 'merge' ? current.items : []).map((item) => String(item.title).toLowerCase()));
    const nextIdStart = Math.max(Number(current.nextId) || 1, ...current.items.map((item) => Number(item.id) + 1 || 1));
    let nextId = mode === 'merge' ? nextIdStart : Math.max(session.savedNextId, nextIdStart, ...selected.map((item) => item.id + 1));
    const copiedDirs = [];
    const restored = [];
    try {
      for (const item of selected) {
        const id = mode === 'merge' ? nextId++ : item.id;
        let title = item.title;
        if (occupiedTitles.has(title.toLowerCase())) {
          let suffix = 1;
          do {
            title = `${item.title} (backup${suffix === 1 ? '' : ` ${suffix}`})`;
            suffix++;
          } while (occupiedTitles.has(title.toLowerCase()));
        }
        occupiedTitles.add(title.toLowerCase());
        const itemDir = path.join(mediaDir, `${id}-restore-${randomUUID()}`);
        const entries = [];
        for (const [index, entry] of item.entries.entries()) {
          if (entry?.kind !== 'media') { entries.push(structuredClone(entry)); continue; }
          const source = media.find((candidate) => candidate.entry === entry)?.source;
          const extension = path.extname(source).replace(/[^.a-z0-9]/gi, '') || '.bin';
          const target = path.join(itemDir, `${String(index + 1).padStart(3, '0')}${extension}`);
          await fs.mkdir(itemDir, { recursive: true });
          if (!copiedDirs.includes(itemDir)) copiedDirs.push(itemDir);
          await fs.copyFile(source, target);
          entries.push({ ...entry, path: target });
        }
        restored.push({ ...item, id, title, entries });
      }
      const items = mode === 'merge' ? [...current.items, ...restored] : restored;
      await atomicJson(savedFile, { nextId, items });
    } catch (error) {
      await Promise.all(copiedDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})));
      throw error;
    } finally {
      await this.cleanup(session);
    }
    if (mode === 'overwrite') {
      const retained = new Set(restored.flatMap((item) => item.entries.filter((entry) => entry.kind === 'media').map((entry) => path.dirname(entry.path))));
      const stale = new Set(current.items.flatMap((item) => (item.entries || []).filter((entry) => entry.kind === 'media' && entry.path)
        .map((entry) => path.dirname(entry.path))));
      for (const dir of stale) {
        if (dir.startsWith(`${path.resolve(mediaDir)}${path.sep}`) && !retained.has(dir)) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
    return { restored: restored.length, total: mode === 'merge' ? current.items.length + restored.length : restored.length, mode };
  }

  async cleanup(session) {
    if (!session) return;
    await fs.rm(session.tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function savedMediaRelativePath(value) {
  const normalized = String(value || '').replaceAll('\\', '/');
  const marker = '/saved-messages/';
  const at = normalized.lastIndexOf(marker);
  if (at < 0) throw new UserInputError('Path media save dalam backup tidak dikenali.');
  const relative = normalized.slice(at + marker.length);
  if (!relative || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new UserInputError('Path media save dalam backup tidak aman.');
  }
  return relative;
}

export function orderRestoreParts(files) {
  const withPartIndex = files.map((file, index) => ({
    file,
    index,
    part: partNumber(file.fileName)
  }));
  const hasNumberedParts = withPartIndex.every((item) => Number.isInteger(item.part));
  if (hasNumberedParts) {
    return withPartIndex.sort((a, b) => a.part - b.part).map((item) => item.file);
  }
  return [...files].sort((a, b) => a.receivedAt - b.receivedAt);
}

function partNumber(fileName) {
  const match = String(fileName || '').match(/^PART(\d+)-/i);
  return match ? Number(match[1]) : null;
}

function safeFileName(fileName) {
  return String(fileName || 'restore.zip').replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-').slice(0, 160) || 'restore.zip';
}

async function resolveDataSourceDir(extractDir) {
  const entries = await fs.readdir(extractDir, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory() && entries[0].name.toLowerCase() === 'data') {
    return path.join(extractDir, entries[0].name);
  }
  return extractDir;
}

async function overwriteDataDir(sourceDir) {
  const source = path.resolve(sourceDir);
  const target = path.resolve(DATA_DIR);
  if (source === target || target.startsWith(`${source}${path.sep}`)) {
    throw new Error('Source restore tidak aman.');
  }
  await fs.rm(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.cp(sourceDir, DATA_DIR, { recursive: true, force: true });
}
