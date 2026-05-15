import { REMINDERS_FILE, REMINDER_TARGET_NAMES } from './config.js';
import { readCollection, writeCollection } from './namedStore.js';

const DURATION_RE = /(\d+)\s*([smhd])/gi;
const UNIT_MS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000
};

export function parseDurationMs(input) {
  const text = String(input || '').trim().toLowerCase();
  if (!text) throw new Error('Durasi wajib diisi, contoh 10s, 5m, 2h, 1d, 1h30m.');
  let total = 0;
  let consumed = '';
  for (const match of text.matchAll(DURATION_RE)) {
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (!Number.isInteger(value) || value <= 0) throw new Error('Durasi harus angka positif.');
    total += value * UNIT_MS[unit];
    consumed += match[0];
  }
  if (!total || consumed.replace(/\s+/g, '') !== text.replace(/\s+/g, '')) {
    throw new Error('Format durasi tidak valid. Contoh: 10s, 5m, 2h, 1d, 1h30m.');
  }
  return total;
}

export function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || !parts.length) parts.push(`${seconds}s`);
  return parts.join(' ');
}

export async function createReminder(args) {
  if (args.length < 2) throw new Error('Format: ,remindme <teks> <durasi>');
  const durationToken = args.at(-1);
  const delayMs = parseDurationMs(durationToken);
  const text = args.slice(0, -1).join(' ').trim();
  if (!text) throw new Error('Teks reminder wajib diisi.');

  const store = await readCollection(REMINDERS_FILE);
  const item = {
    id: store.nextId++,
    title: text.slice(0, 80),
    text,
    dueAt: new Date(Date.now() + delayMs).toISOString(),
    durationMs: delayMs,
    createdAt: new Date().toISOString()
  };
  store.items.push(item);
  await writeCollection(REMINDERS_FILE, store);
  return item;
}

export async function listReminders() {
  return (await readCollection(REMINDERS_FILE)).items;
}

export class ReminderScheduler {
  constructor(sock, chatDirectory, appLogger) {
    this.sock = sock;
    this.chatDirectory = chatDirectory;
    this.logger = appLogger;
    this.timer = null;
    this.running = false;
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this.tick().catch((error) => {
      this.logger.error('Reminder scheduler error', { error: error.message });
    }), 1000);
    this.tick().catch(() => {});
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isRunning() {
    return Boolean(this.timer);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const store = await readCollection(REMINDERS_FILE);
      const now = Date.now();
      let changed = false;
      for (const reminder of [...store.items]) {
        if (new Date(reminder.dueAt).getTime() > now) continue;
        const targets = REMINDER_TARGET_NAMES
          .map((name) => this.chatDirectory.findByName(name))
          .filter(Boolean);
        if (!targets.length) {
          await this.logger.warn('Reminder target chat not found', { reminderId: reminder.id, targets: REMINDER_TARGET_NAMES });
          continue;
        }
        for (const jid of targets) {
          await this.sock.sendMessage(jid, { text: `Reminder: ${reminder.text}` });
        }
        store.items = store.items.filter((item) => item.id !== reminder.id);
        changed = true;
      }
      if (changed) await writeCollection(REMINDERS_FILE, store);
    } finally {
      this.running = false;
    }
  }
}
