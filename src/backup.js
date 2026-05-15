import {
  AUTO_DAILY_BACKUP,
  DAILY_BACKUP_TIME_WIB,
  DATA_DIR,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CLIENT_ID,
  TELEGRAM_PART_SIZE_BYTES
} from './config.js';
import { splitBuffer, zipDirectory } from './zip.js';

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;

export async function sendDataBackupToTelegram() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CLIENT_ID) {
    throw new Error('Backup butuh TELEGRAM_BOT_TOKEN dan TELEGRAM_CLIENT_ID di .env.');
  }

  const stamp = backupStamp();
  const zipBuffer = await zipDirectory(DATA_DIR);
  const parts = splitBuffer(zipBuffer, TELEGRAM_PART_SIZE_BYTES);
  const files = parts.map((part, index) => ({
    buffer: part,
    fileName: parts.length === 1 ? `BACKUP-${stamp}.zip` : `PART${index + 1}-${stamp}.zip`
  }));

  for (const file of files) {
    await sendTelegramDocument(file.buffer, file.fileName);
  }

  return files.map((file) => file.fileName);
}

export class DailyBackupScheduler {
  constructor(appLogger) {
    this.logger = appLogger;
    this.timer = null;
    this.running = false;
  }

  start() {
    this.stop();
    if (!AUTO_DAILY_BACKUP) return;
    this.scheduleNext();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  isRunning() {
    return Boolean(this.timer);
  }

  scheduleNext(now = new Date()) {
    const next = nextDailyBackupAt(DAILY_BACKUP_TIME_WIB, now);
    const delay = Math.min(Math.max(1000, next.getTime() - now.getTime()), MAX_TIMEOUT_MS);
    this.timer = setTimeout(() => this.run().catch((error) => {
      this.logger?.error?.('Daily backup scheduler error', { error: error.message });
    }), delay);
    this.timer.unref?.();
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      const files = await sendDataBackupToTelegram();
      await this.logger?.info?.('Daily backup sent', { files });
    } catch (error) {
      await this.logger?.error?.('Daily backup failed', { error: error.message });
    } finally {
      this.running = false;
      this.scheduleNext();
    }
  }
}

export function nextDailyBackupAt(timeWib = '00:00', now = new Date()) {
  const match = String(timeWib || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  const hour = match ? Number(match[1]) : 0;
  const minute = match ? Number(match[2]) : 0;
  const safeHour = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 0;
  const safeMinute = Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : 0;
  const parts = toWibParts(now);
  let next = wibDateToUtc(parts.year, parts.month, parts.day, safeHour, safeMinute, 0);
  if (next <= now) next = wibDateToUtc(parts.year, parts.month, parts.day + 1, safeHour, safeMinute, 0);
  return next;
}

async function sendTelegramDocument(buffer, fileName) {
  const form = new FormData();
  form.append('chat_id', TELEGRAM_CLIENT_ID);
  form.append('document', new Blob([buffer], { type: 'application/zip' }), fileName);
  form.append('caption', `IrOBot data backup: ${fileName}`);

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, {
    method: 'POST',
    body: form
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Telegram backup gagal: HTTP ${response.status}${body ? ` - ${body.slice(0, 300)}` : ''}`);
  }
}

function backupStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('-') + '-' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('_');
}

function toWibParts(date = new Date()) {
  const shifted = new Date(date.getTime() + WIB_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate()
  };
}

function wibDateToUtc(year, month, day, hour, minute, second) {
  return new Date(Date.UTC(year, month, day, hour, minute, second, 0) - WIB_OFFSET_MS);
}
