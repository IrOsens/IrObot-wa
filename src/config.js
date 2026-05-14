import fs from 'node:fs/promises';
import path from 'node:path';

export const ROOT_DIR = process.cwd();
export const AUTH_DIR = path.join(ROOT_DIR, 'auth');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const TASK_MEDIA_DIR = path.join(DATA_DIR, 'task-media');
export const SAVED_MESSAGES_DIR = path.join(DATA_DIR, 'saved-messages');
export const SAVED_MESSAGES_FILE = path.join(DATA_DIR, 'saved-messages.json');
export const LOG_DIR = path.join(ROOT_DIR, 'logs');
export const TEMP_DIR = path.join(ROOT_DIR, 'temp');
export const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

export const COMMAND_PREFIX = ',';
export const TASK_TARGET_NAMES = ['dev', 'IrOBot'];
export const DEFAULT_STICKER_AUTHOR = 'IrO';
export const DEFAULT_STICKER_TITLE = ':3';
export const PDF_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

export async function ensureRuntimeDirs() {
  await Promise.all([
    fs.mkdir(AUTH_DIR, { recursive: true }),
    fs.mkdir(DATA_DIR, { recursive: true }),
    fs.mkdir(TASK_MEDIA_DIR, { recursive: true }),
    fs.mkdir(SAVED_MESSAGES_DIR, { recursive: true }),
    fs.mkdir(LOG_DIR, { recursive: true }),
    fs.mkdir(TEMP_DIR, { recursive: true })
  ]);
}

export async function cleanupStartupTemp() {
  await fs.mkdir(TEMP_DIR, { recursive: true });
  try {
    await fs.rm(TEMP_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    await fs.mkdir(TEMP_DIR, { recursive: true });
    return;
  } catch {
    // A Windows process can briefly lock a temp file. Cleanup is best-effort so startup never fails.
  }

  const entries = await fs.readdir(TEMP_DIR, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.map((entry) => {
    const target = path.join(TEMP_DIR, entry.name);
    return fs.rm(target, { recursive: entry.isDirectory(), force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
  }));
}

export function todayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function makeTempPath(prefix, ext = '') {
  const safeExt = ext ? (ext.startsWith('.') ? ext : `.${ext}`) : '';
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return path.join(TEMP_DIR, `${prefix}-${stamp}${safeExt}`);
}
