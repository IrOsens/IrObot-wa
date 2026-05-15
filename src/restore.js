import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, RESTORE_SESSION_TIMEOUT_MS, TEMP_DIR } from './config.js';
import { cleanupFiles, downloadMessageMedia } from './media.js';
import { extractZipBuffer } from './zip.js';

export class RestoreSessions {
  constructor() {
    this.sessions = new Map();
  }

  async start(jid) {
    const old = this.end(jid);
    if (old) await this.cleanup(old);
    const tempDir = await fs.mkdtemp(path.join(TEMP_DIR, 'restore-'));
    const session = {
      jid,
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

  has(jid) {
    return this.sessions.has(jid);
  }

  count() {
    return this.sessions.size;
  }

  end(jid) {
    const session = this.sessions.get(jid);
    if (!session) return null;
    clearTimeout(session.timer);
    this.sessions.delete(jid);
    return session;
  }

  async cancel(jid) {
    const session = this.end(jid);
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
    if (!session?.files?.length) throw new Error('Belum ada file zip untuk restore.');
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

  async cleanup(session) {
    if (!session) return;
    await fs.rm(session.tempDir, { recursive: true, force: true }).catch(() => {});
  }
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
