import { UserInputError } from './errors.js';

export const WORKER_BASE_COMMANDS = new Set(['help', 'status', 'end', 'cancel', 'confirm']);
export const WORKER_DEFAULT_COMMANDS = new Set([
  's', 'stext', 'smeme', 'rs', 'resend', 'qr', 'topdf', 'tovideo', 'stimpa', 'toimg', 'note', 'link'
]);

export const WORKER_SERVICES = [
  {
    name: 'cinta',
    description: 'Balas otomatis gambar menu + caption saat pesan berisi trigger pemesanan.',
    commands: ['cinta']
  }
];

export const CINTA_REPLY_LIMIT = 2;
export const CINTA_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const CINTA_MAX_MESSAGE_AGE_MS = 5 * 60 * 1000;
export const CINTA_DELAY_MS = { min: 3000, max: 8000 };
export const WORKER_COMMAND_LIMIT = 2;
export const WORKER_COMMAND_WINDOW_MS = 60 * 1000;
export const WORKER_COMMAND_DELAY_MS = { min: 1000, max: 2500 };

export const DEFAULT_CINTA_TRIGGERS = ['Aku mau pesan kak', 'Aku mau pesan kak!'];
export const DEFAULT_CINTA_CAPTION = `🐙 *SELAMAT DATANG DI TAKO-WAE!* 🥢

Japanese Street Food 🇯🇵

Terima kasih sudah menghubungi *Tako-Wae!* Pesan kamu sudah kami terima dan akan segera dibalas oleh admin. Mohon tunggu sebentar, ya! 😊

📋 *DAFTAR MENU TAKO-WAE*

🐙 *TAKOYAKI*
• Original — Rp11.000
• Gurita — Rp13.000
• Sosis — Rp11.000
• Mentai — Rp13.000

🥞 *OKONOMIYAKI*
• Gurita — Rp11.000
• Sosis — Rp10.000
• Mentai — Rp11.000

📍 *AREA PEMESANAN*
Kota Malang dan sekitar Universitas Negeri Malang (UM).

🛒 *MAU PESAN?*
Silakan kirim format berikut:

*Nama:*
*Menu & Varian:*
*Jumlah:*
*Alamat/Lokasi:*
*Catatan (opsional):*

💬 Admin akan segera membalas untuk konfirmasi pesanan, ketersediaan menu, dan total pembayaran.

Terima kasih sudah memilih *Tako-Wae!* ❤️`;

export function findWorkerService(name) {
  const key = String(name || '').trim().toLowerCase();
  return WORKER_SERVICES.find((service) => service.name === key) || null;
}

export function formatWorkerServiceList() {
  return [
    '*Service worker*',
    ...WORKER_SERVICES.map((service) => `- ${service.name}: ${service.description}`),
    '',
    'Pasang: ,worker service <id|nomor> <nama>',
    'Lepas: ,worker service <id|nomor> off'
  ].join('\n');
}

export function workerCommandAllowed(worker, commandName) {
  const name = String(commandName || '').toLowerCase();
  if (WORKER_BASE_COMMANDS.has(name)) return true;
  const service = findWorkerService(worker?.service);
  if (!service) return WORKER_DEFAULT_COMMANDS.has(name);
  if (service.commands.includes(name)) return true;
  return Boolean(worker.allowDefaultCommands) && WORKER_DEFAULT_COMMANDS.has(name);
}

export function cintaConfig(worker) {
  const saved = worker?.serviceConfig?.cinta || {};
  return {
    triggers: Array.isArray(saved.triggers) && saved.triggers.length ? saved.triggers : DEFAULT_CINTA_TRIGGERS,
    entries: Array.isArray(saved.entries) ? saved.entries : [],
    reactionEmoji: saved.reactionEmoji || ''
  };
}

// A trigger only matches the full message: as written, all lowercase, or all uppercase.
export function matchCintaTrigger(text, triggers) {
  const message = String(text || '').trim();
  if (!message) return false;
  for (const trigger of triggers || []) {
    const variants = [trigger, trigger.toLowerCase(), trigger.toUpperCase()];
    if (variants.includes(message)) return true;
  }
  return false;
}

export function parseCintaTriggers(text) {
  const triggers = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!triggers.length) throw new UserInputError('Trigger tidak boleh kosong. Kirim satu trigger per baris.');
  if (triggers.length > 10) throw new UserInputError('Maksimal 10 trigger.');
  if (triggers.some((trigger) => trigger.length > 200)) throw new UserInputError('Satu trigger maksimal 200 karakter.');
  return [...new Set(triggers)];
}

export function parseReactionEmoji(text) {
  const value = String(text || '').trim();
  if (value === '-') return '';
  const isEmoji = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️)+$/u.test(value)
    && /\p{Extended_Pictographic}/u.test(value);
  if (!isEmoji || value.length > 16) throw new UserInputError('Kirim satu emoji saja, atau - untuk mematikan reaksi.');
  return value;
}

export class ReplyLimiter {
  constructor() {
    this.history = new Map();
  }

  allow(key, limit, windowMs, now = Date.now()) {
    const recent = (this.history.get(key) || []).filter((time) => now - time < windowMs);
    if (recent.length >= limit) {
      this.history.set(key, recent);
      return false;
    }
    recent.push(now);
    this.history.set(key, recent);
    return true;
  }

  cleanup(maxWindowMs, now = Date.now()) {
    for (const [key, times] of this.history) {
      const recent = times.filter((time) => now - time < maxWindowMs);
      if (recent.length) this.history.set(key, recent);
      else this.history.delete(key);
    }
  }
}

export function randomDelayMs({ min, max }) {
  return min + Math.floor(Math.random() * (max - min + 1));
}
