import fs from 'node:fs/promises';
import path from 'node:path';
import { LOG_DIR, todayKey } from './config.js';

let activeDay = todayKey();
let activeFile = path.join(LOG_DIR, `bot-${activeDay}.log`);

function line(level, message, meta) {
  const payload = {
    time: new Date().toISOString(),
    level,
    message,
    ...(meta ? { meta } : {})
  };
  return `${JSON.stringify(payload)}\n`;
}

async function rotateIfNeeded() {
  const current = todayKey();
  if (current === activeDay) return;
  activeDay = current;
  activeFile = path.join(LOG_DIR, `bot-${activeDay}.log`);
  await cleanupOldLogs();
}

export async function cleanupOldLogs() {
  await fs.mkdir(LOG_DIR, { recursive: true });
  const keep = `bot-${todayKey()}.log`;
  const entries = await fs.readdir(LOG_DIR, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.startsWith('bot-') && entry.name.endsWith('.log') && entry.name !== keep)
    .map((entry) => fs.rm(path.join(LOG_DIR, entry.name), { force: true })));
}

export async function log(level, message, meta) {
  try {
    await rotateIfNeeded();
    await fs.appendFile(activeFile, line(level, message, meta));
  } catch {
    // Logging must never crash the bot.
  }
}

export const logger = {
  info: (message, meta) => log('info', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  error: (message, meta) => log('error', message, meta)
};

