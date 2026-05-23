import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_FILE, DEFAULT_APP_CONFIG } from './config.js';

export const CONFIG_KEY_DEFS = {
  'dest.logs': { type: 'destination', label: 'Tujuan mirror logs' },
  'dest.changedmsg': { type: 'destination', label: 'Tujuan pesan terhapus/diedit' },
  'dest.saved': { type: 'destination', label: 'Tujuan save status WhatsApp' },
  'dest.backup': { type: 'destination', label: 'Tujuan backup data' },
  'backup.autoDaily': { type: 'boolean', label: 'Backup otomatis harian' },
  'backup.dailyTimeWib': { type: 'time', label: 'Jam backup otomatis WIB' },
  'backup.partSizeMb': { type: 'positiveNumber', label: 'Ukuran part backup MB' },
  'changedmsg.enabled': { type: 'boolean', label: 'Changed-message logging' },
  'changedmsg.indexMaxItems': { type: 'positiveInteger', label: 'Jumlah index changedmsg' },
  'changedmsg.maxMediaMb': { type: 'positiveNumber', label: 'Batas media changedmsg MB' },
  'statussave.enabled': { type: 'boolean', label: 'Auto-save status WhatsApp' },
  'statussave.maxMediaMb': { type: 'positiveNumber', label: 'Batas media statussave MB' }
};

const DESTINATION_ALIASES = {
  'dest.logs': ['destinations', 'logs'],
  'dest.changedmsg': ['destinations', 'changedmsg'],
  'dest.saved': ['destinations', 'saved'],
  'dest.backup': ['destinations', 'backup']
};

export class RuntimeConfigStore {
  constructor(filePath = CONFIG_FILE) {
    this.filePath = filePath;
    this.data = structuredClone(DEFAULT_APP_CONFIG);
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      this.data = deepMerge(DEFAULT_APP_CONFIG, parsed);
    } catch {
      this.data = structuredClone(DEFAULT_APP_CONFIG);
      await this.save();
    }
    return this.snapshot();
  }

  snapshot() {
    return structuredClone(this.data);
  }

  get(key) {
    assertKnownKey(key);
    return getPath(this.data, keyPath(key));
  }

  async set(key, rawValue) {
    const def = assertKnownKey(key);
    const value = normalizeConfigValue(def, rawValue);
    setPath(this.data, keyPath(key), value);
    await this.save();
    return value;
  }

  async setDestination(key, destination) {
    const def = assertKnownKey(key);
    if (def.type !== 'destination') throw new Error(`${key} bukan config destination.`);
    const value = normalizeDestinationConfig(destination);
    setPath(this.data, keyPath(key), value);
    await this.save();
    return value;
  }

  destination(name) {
    return getPath(this.data, ['destinations', name]);
  }

  backupPartSizeBytes() {
    return Math.max(1024 * 1024, Math.floor(numberOr(this.data.backup?.partSizeMb, 45) * 1024 * 1024));
  }

  isBackupAutoDaily() {
    return this.data.backup?.autoDaily !== false;
  }

  dailyBackupTimeWib() {
    return String(this.data.backup?.dailyTimeWib || '00:00');
  }

  changedmsgSettings() {
    return {
      enabled: this.data.changedmsg?.enabled !== false,
      indexMaxItems: Math.max(1, Math.floor(numberOr(this.data.changedmsg?.indexMaxItems, 1000))),
      maxMediaBytes: Math.max(1, Math.floor(numberOr(this.data.changedmsg?.maxMediaMb, 25) * 1024 * 1024))
    };
  }

  statussaveSettings() {
    return {
      enabled: this.data.statussave?.enabled !== false,
      maxMediaBytes: Math.max(1, Math.floor(numberOr(this.data.statussave?.maxMediaMb, 25) * 1024 * 1024))
    };
  }

  async save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`);
  }
}

export function configKeyList() {
  return Object.entries(CONFIG_KEY_DEFS).map(([key, def]) => ({ key, ...def }));
}

export function formatConfigValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.jid) return `${value.savedName || value.title || value.input || value.jid} (${shortJid(value.jid)})`;
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value ?? '-');
}

export function normalizeDestinationConfig(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) throw new Error('Destination wajib diisi.');
    return text;
  }
  if (!value || typeof value !== 'object') throw new Error('Destination tidak valid.');
  const jid = String(value.jid || '').trim();
  if (!jid) throw new Error('Destination JID wajib diisi.');
  return {
    jid,
    savedName: String(value.savedName || value.title || value.input || jid).trim() || jid,
    input: String(value.input || '').trim() || undefined,
    type: String(value.type || (jid.endsWith('@g.us') ? 'group' : 'user')),
    updatedAt: value.updatedAt || new Date().toISOString(),
    updatedBy: value.updatedBy || null
  };
}

function assertKnownKey(key) {
  const clean = String(key || '').trim();
  const def = CONFIG_KEY_DEFS[clean];
  if (!def) throw new Error(`Config "${key}" tidak bisa diubah. Ketik ,config untuk daftar key.`);
  return def;
}

function keyPath(key) {
  if (DESTINATION_ALIASES[key]) return DESTINATION_ALIASES[key];
  return String(key).split('.');
}

function normalizeConfigValue(def, rawValue) {
  if (def.type === 'destination') return normalizeDestinationConfig(rawValue);
  if (def.type === 'boolean') return parseBoolean(rawValue);
  if (def.type === 'time') return parseTime(rawValue);
  if (def.type === 'positiveInteger') return parsePositiveInteger(rawValue);
  if (def.type === 'positiveNumber') return parsePositiveNumber(rawValue);
  return rawValue;
}

function parseBoolean(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (['true', 'on', 'yes', '1', 'aktif'].includes(text)) return true;
  if (['false', 'off', 'no', '0', 'nonaktif'].includes(text)) return false;
  throw new Error('Nilai boolean harus true/false atau on/off.');
}

function parseTime(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error('Format jam harus HH:mm, contoh 00:00.');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error('Jam WIB tidak valid.');
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parsePositiveInteger(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error('Nilai harus integer positif.');
  return number;
}

function parsePositiveNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error('Nilai harus angka positif.');
  return number;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function getPath(source, pathParts) {
  let cursor = source;
  for (const part of pathParts) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function setPath(source, pathParts, value) {
  let cursor = source;
  for (const part of pathParts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[pathParts[pathParts.length - 1]] = value;
}

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return structuredClone(base);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function shortJid(jid) {
  const text = String(jid || '');
  if (text.length <= 22) return text;
  return `${text.slice(0, 12)}...${text.slice(-8)}`;
}
