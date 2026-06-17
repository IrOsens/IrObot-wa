import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, makeTempPath } from './config.js';
import { isViewOnceMediaMessage, mediaNode } from './media.js';
import { renumberCollection, titleKey } from './namedStore.js';
import { displayPhoneFromJid, normalizePhoneToJid, sameJid, tryNormalizeJid } from './phone.js';
import { getMessageText } from './text.js';
import { messageTypeName, timestampMs, truncateText } from './changedMessages.js';

export const WORKER_LOG_ROOT = path.join(DATA_DIR, 'worker-logs');
export const WORKER_LOG_MODES = new Set(['off', 'dm', 'all', 'selected']);

const DEFAULT_CONFIG = {
  mode: 'dm',
  nextId: 1,
  targets: [],
  updatedAt: null
};

export class WorkerLogStore {
  constructor(rootDir = WORKER_LOG_ROOT) {
    this.rootDir = rootDir;
  }

  async loadConfig(workerId) {
    return normalizeConfig(await readJson(this.configFile(workerId), DEFAULT_CONFIG));
  }

  async saveConfig(workerId, config) {
    const normalized = normalizeConfig(config);
    normalized.updatedAt = new Date().toISOString();
    await fs.mkdir(this.workerDir(workerId), { recursive: true });
    await fs.writeFile(this.configFile(workerId), `${JSON.stringify(normalized, null, 2)}\n`);
    return normalized;
  }

  async setMode(workerId, modeRaw) {
    const mode = normalizeMode(modeRaw);
    const config = await this.loadConfig(workerId);
    config.mode = mode;
    return this.saveConfig(workerId, config);
  }

  async addTarget(workerId, target) {
    const jid = normalizeTargetJid(target?.jid || target);
    const config = await this.loadConfig(workerId);
    const existing = config.targets.find((item) => sameJid(item.jid, jid));
    if (existing) throw new Error(`Target "${existing.title}" sudah ada sebagai #${existing.id}.`);
    const item = {
      id: config.nextId++,
      jid,
      title: String(target?.title || target?.savedName || target?.name || displayPhoneFromJid(jid)).trim() || jid,
      type: String(target?.type || (jid.endsWith('@g.us') ? 'group' : 'user')),
      createdAt: new Date().toISOString()
    };
    config.targets.push(item);
    config.mode = 'selected';
    renumberCollection(config, 'targets');
    await this.saveConfig(workerId, config);
    return { ...item };
  }

  async deleteTarget(workerId, query) {
    const config = await this.loadConfig(workerId);
    const item = findTarget(config.targets, query);
    if (!item) throw new Error(`Target log "${query}" tidak ditemukan.`);
    config.targets = config.targets.filter((target) => target.id !== item.id);
    renumberCollection(config, 'targets');
    await this.saveConfig(workerId, config);
    return { ...item };
  }

  async shouldLog(workerId, message) {
    const config = await this.loadConfig(workerId);
    return shouldLogMessage(config, message);
  }

  async append(workerId, entry) {
    await fs.mkdir(this.workerDir(workerId), { recursive: true });
    const normalized = normalizeLogEntry(workerId, entry);
    await fs.appendFile(this.messagesFile(workerId), `${JSON.stringify(normalized)}\n`);
    return normalized;
  }

  async exportText(workerId, targetJid, options = {}) {
    const jid = normalizeTargetJid(targetJid);
    const entries = await this.readEntries(workerId);
    const filtered = entries.filter((entry) => sameJid(entry.remoteJid, jid) || sameJid(entry.actorJid, jid));
    if (!filtered.length) throw new Error('Belum ada pesan tersimpan untuk target itu sejak worker aktif.');
    const title = options.title || displayPhoneFromJid(jid) || jid;
    const filePath = makeTempPath(`worker-${workerId}-extract`, '.txt');
    const lines = [
      `Extract worker #${workerId}`,
      `Target: ${title} (${jid})`,
      `Generated: ${new Date().toLocaleString()}`,
      '',
      ...filtered.flatMap(formatExtractEntry)
    ];
    await fs.writeFile(filePath, lines.join('\n'), 'utf8');
    return filePath;
  }

  async readEntries(workerId) {
    const file = this.messagesFile(workerId);
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return normalizeLogEntry(workerId, JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  async deleteWorkerData(workerId) {
    await fs.rm(this.workerDir(workerId), { recursive: true, force: true });
  }

  workerDir(workerId) {
    return path.join(this.rootDir, String(workerId));
  }

  configFile(workerId) {
    return path.join(this.workerDir(workerId), 'config.json');
  }

  messagesFile(workerId) {
    return path.join(this.workerDir(workerId), 'messages.jsonl');
  }
}

export function shouldLogMessage(configRaw, message) {
  const config = normalizeConfig(configRaw);
  if (config.mode === 'off') return false;
  const jid = message?.key?.remoteJid || '';
  if (!jid || jid === 'status@broadcast') return false;
  const isGroup = jid.endsWith('@g.us');
  if (config.mode === 'dm') return !isGroup;
  if (config.mode === 'all') return true;
  if (config.mode === 'selected') {
    return config.targets.some((target) => sameJid(target.jid, jid) || sameJid(target.jid, message?.key?.participant));
  }
  return false;
}

export function createWorkerLogEntry(worker, message, options = {}) {
  const remoteJid = message?.key?.remoteJid || '';
  const actorJid = options.actorJid || message?.key?.participant || (message?.key?.fromMe ? worker?.jid : remoteJid);
  const type = messageTypeName(message);
  const foundMedia = mediaNode(message);
  const text = getMessageText(message).trim();
  return normalizeLogEntry(worker?.id, {
    workerId: worker?.id,
    workerJid: worker?.jid || '',
    workerPhone: worker?.phone || displayPhoneFromJid(worker?.jid),
    direction: message?.key?.fromMe ? 'outgoing' : 'incoming',
    remoteJid,
    remoteName: options.remoteName || '',
    actorJid,
    actorName: options.actorName || message?.pushName || '',
    participantJid: message?.key?.participant || '',
    messageId: message?.key?.id || '',
    timestamp: timestampMs(message),
    type,
    text: truncateText(text, 4000),
    hasMedia: Boolean(foundMedia),
    media: foundMedia ? {
      messageType: foundMedia.type,
      mimetype: foundMedia.node?.mimetype || '',
      fileName: foundMedia.node?.fileName || '',
      caption: truncateText(foundMedia.node?.caption || text, 1200),
      isViewOnce: isViewOnceMediaMessage(message),
      isAnimated: Boolean(foundMedia.node?.isAnimated)
    } : null
  });
}

export function formatWorkerLogHeader(entry) {
  const location = entry.remoteJid.endsWith('@g.us')
    ? `${entry.remoteName || 'Group'} (${entry.remoteJid})`
    : `${entry.remoteName || displayPhoneFromJid(entry.remoteJid)} (${waLink(entry.remoteJid)})`;
  const actor = entry.actorJid
    ? `${entry.actorName || displayPhoneFromJid(entry.actorJid)} (${waLink(entry.actorJid)})`
    : '-';
  const lines = [
    `[WORKER LOG] #${entry.workerId} ${waLink(entry.workerJid)}`,
    `Arah: ${entry.direction}`,
    `Pengirim: ${actor}`,
    `Lokasi: ${location}`,
    `Waktu: ${new Date(entry.timestamp).toLocaleString()}`,
    `Tipe: ${entry.type}`,
    `Message ID: ${entry.messageId || '-'}`,
    entry.media?.isViewOnce ? 'View once: ya' : null,
    entry.media?.fileName ? `File: ${entry.media.fileName}` : null,
    entry.media?.mimetype ? `Mimetype: ${entry.media.mimetype}` : null,
    entry.media?.caption ? `Caption: ${entry.media.caption}` : null,
    entry.text && !entry.media?.caption ? `Isi: ${entry.text}` : null
  ];
  return lines.filter(Boolean).join('\n');
}

export function formatWorkerConfig(configRaw) {
  const config = normalizeConfig(configRaw);
  const lines = [
    `Worker logs: ${config.mode}`,
    `Target selected: ${config.targets.length}`
  ];
  if (config.targets.length) {
    lines.push('', ...config.targets.map((item) => `#${item.id} - ${item.title} (${item.jid})`));
  }
  return lines.join('\n');
}

export function waLink(jid) {
  const phone = displayPhoneFromJid(jid || '');
  return phone ? `wa.me/${phone}` : '-';
}

function normalizeConfig(value) {
  const mode = WORKER_LOG_MODES.has(String(value?.mode || '').trim()) ? String(value.mode).trim() : 'dm';
  const targets = [];
  const seen = new Set();
  for (const raw of Array.isArray(value?.targets) ? value.targets : []) {
    const jid = normalizeTargetJid(raw?.jid);
    if (!jid || seen.has(jid)) continue;
    seen.add(jid);
    targets.push({
      id: Number.isInteger(raw?.id) && raw.id > 0 ? raw.id : targets.length + 1,
      jid,
      title: String(raw?.title || raw?.savedName || displayPhoneFromJid(jid)).trim() || jid,
      type: String(raw?.type || (jid.endsWith('@g.us') ? 'group' : 'user')),
      createdAt: raw?.createdAt || null
    });
  }
  const config = {
    mode,
    nextId: Number.isInteger(value?.nextId) && value.nextId > 0 ? value.nextId : targets.length + 1,
    targets,
    updatedAt: value?.updatedAt || null
  };
  renumberCollection(config, 'targets');
  return config;
}

function normalizeMode(modeRaw) {
  const mode = String(modeRaw || '').trim().toLowerCase();
  if (!WORKER_LOG_MODES.has(mode)) throw new Error('Mode logs harus off, dm, all, atau selected.');
  return mode;
}

function normalizeTargetJid(input) {
  const text = String(input || '').trim();
  if (!text) return '';
  const waMe = text.match(/wa\.me\/(\d+)/i)?.[1];
  if (waMe) return normalizePhoneToJid(waMe);
  return tryNormalizeJid(text) || normalizePhoneToJid(text);
}

function findTarget(items, query) {
  const text = String(query || '').trim();
  if (!text) return null;
  const id = Number(text);
  if (/^\d{1,6}$/.test(text) && Number.isInteger(id)) return items.find((item) => item.id === id) || null;
  let jid = null;
  try {
    jid = normalizeTargetJid(text);
  } catch {
    jid = null;
  }
  if (jid) {
    const byJid = items.find((item) => sameJid(item.jid, jid));
    if (byJid) return byJid;
  }
  const key = titleKey(text);
  return items.find((item) => titleKey(item.title) === key) || null;
}

function normalizeLogEntry(workerId, raw) {
  return {
    workerId: Number(raw?.workerId || workerId) || 0,
    workerJid: String(raw?.workerJid || '').trim(),
    workerPhone: String(raw?.workerPhone || displayPhoneFromJid(raw?.workerJid)).trim(),
    direction: raw?.direction === 'outgoing' ? 'outgoing' : 'incoming',
    remoteJid: String(raw?.remoteJid || '').trim(),
    remoteName: String(raw?.remoteName || '').trim(),
    actorJid: String(raw?.actorJid || '').trim(),
    actorName: String(raw?.actorName || '').trim(),
    participantJid: String(raw?.participantJid || '').trim(),
    messageId: String(raw?.messageId || '').trim(),
    timestamp: Number(raw?.timestamp) || Date.now(),
    type: String(raw?.type || 'unknown'),
    text: String(raw?.text || ''),
    hasMedia: Boolean(raw?.hasMedia),
    media: raw?.media && typeof raw.media === 'object' ? {
      messageType: String(raw.media.messageType || ''),
      mimetype: String(raw.media.mimetype || ''),
      fileName: String(raw.media.fileName || ''),
      caption: String(raw.media.caption || ''),
      isViewOnce: Boolean(raw.media.isViewOnce),
      isAnimated: Boolean(raw.media.isAnimated)
    } : null
  };
}

function formatExtractEntry(entry) {
  return [
    '---',
    `Waktu: ${new Date(entry.timestamp).toLocaleString()}`,
    `Arah: ${entry.direction}`,
    `Chat: ${entry.remoteName || entry.remoteJid}`,
    `Chat JID: ${entry.remoteJid}`,
    `Pengirim: ${entry.actorName || displayPhoneFromJid(entry.actorJid) || '-'}`,
    `Pengirim: ${waLink(entry.actorJid)}`,
    `Tipe: ${entry.type}`,
    entry.media?.fileName ? `File: ${entry.media.fileName}` : null,
    entry.media?.mimetype ? `Mimetype: ${entry.media.mimetype}` : null,
    entry.media?.caption ? `Caption: ${entry.media.caption}` : null,
    entry.text ? `Isi:\n${entry.text}` : null,
    ''
  ].filter((line) => line != null);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return structuredClone(fallback);
  }
}
