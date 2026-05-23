import fs from 'node:fs/promises';
import path from 'node:path';
import { jidNormalizedUser } from 'baileys';
import { CHANGED_MESSAGES_FILE } from './config.js';
import { renumberCollection, titleKey } from './namedStore.js';
import { sameJid, tryNormalizeJid } from './phone.js';
import { getMessageText, unwrapMessage } from './text.js';

const DEFAULT_STORE = {
  allowedChats: [],
  nextAllowedId: 1,
  index: [],
  updatedAt: null
};

export class ChangedMessageStore {
  constructor(filePath = CHANGED_MESSAGES_FILE) {
    this.filePath = filePath;
    this.store = structuredClone(DEFAULT_STORE);
  }

  async load() {
    try {
      this.store = normalizeStore(JSON.parse(await fs.readFile(this.filePath, 'utf8')));
    } catch {
      this.store = structuredClone(DEFAULT_STORE);
      await this.save();
    }
    return this.snapshot();
  }

  snapshot() {
    return {
      allowedChats: this.listAllowed(),
      allowedCount: this.store.allowedChats.length,
      indexCount: this.store.index.length,
      updatedAt: this.store.updatedAt
    };
  }

  listAllowed() {
    return this.store.allowedChats.map((item) => ({ ...item }));
  }

  async addAllowed(destination) {
    const jid = normalizeChatJid(destination?.jid);
    const existing = this.store.allowedChats.find((item) => sameJid(item.jid, jid));
    if (existing) throw new Error(`Chat "${existing.savedName}" sudah ada sebagai #${existing.id}.`);
    const item = {
      id: this.store.nextAllowedId++,
      jid,
      savedName: String(destination?.savedName || destination?.title || destination?.input || jid).trim() || jid,
      input: String(destination?.input || '').trim() || undefined,
      addedAt: new Date().toISOString(),
      addedBy: destination?.addedBy || null
    };
    this.store.allowedChats.push(item);
    renumberAllowed(this.store);
    await this.save();
    return { ...item };
  }

  async deleteAllowed(query) {
    const item = findAllowed(this.store.allowedChats, query);
    if (!item) throw new Error(`Allowlist changedmsg "${query}" tidak ditemukan.`);
    this.store.allowedChats = this.store.allowedChats.filter((candidate) => candidate.id !== item.id);
    renumberAllowed(this.store);
    await this.save();
    return { ...item };
  }

  isAllowedGroup(jid) {
    return Boolean(jid && this.store.allowedChats.some((item) => sameJid(item.jid, jid)));
  }

  shouldWatchChat(jid) {
    if (!jid || jid === 'status@broadcast') return false;
    if (jid.endsWith('@g.us')) return this.isAllowedGroup(jid);
    return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
  }

  findByKey(messageKey) {
    const key = messageIndexKey(messageKey);
    const id = messageKey?.id;
    const remoteJid = normalizeLooseJid(messageKey?.remoteJid);
    return this.store.index.find((item) => item.key === key)
      || this.store.index.find((item) => item.id === id && sameJid(item.remoteJid, remoteJid))
      || null;
  }

  async upsertIndex(entry, maxItems = 1000) {
    const normalized = normalizeIndexEntry(entry);
    const existingIndex = this.store.index.findIndex((item) => item.key === normalized.key);
    if (existingIndex >= 0) {
      this.store.index[existingIndex] = {
        ...this.store.index[existingIndex],
        ...normalized,
        updatedAt: new Date().toISOString()
      };
    } else {
      this.store.index.push(normalized);
    }
    this.trimIndex(maxItems);
    await this.save();
    return { ...normalized };
  }

  async markDeleted(messageKey, patch = {}) {
    const item = this.findByKey(messageKey);
    if (!item) return null;
    Object.assign(item, patch, {
      deletedAt: new Date().toISOString(),
      changedAt: new Date().toISOString()
    });
    await this.save();
    return { ...item };
  }

  async markEdited(messageKey, patch = {}) {
    const item = this.findByKey(messageKey);
    if (!item) return null;
    Object.assign(item, patch, {
      editCount: (Number(item.editCount) || 0) + 1,
      editedAt: new Date().toISOString(),
      changedAt: new Date().toISOString()
    });
    await this.save();
    return { ...item };
  }

  trimIndex(maxItems = 1000) {
    const safeMax = Math.max(1, Math.floor(Number(maxItems) || 1000));
    this.store.index = [...this.store.index]
      .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
      .slice(-safeMax);
  }

  async save() {
    this.store.updatedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(normalizeStore(this.store), null, 2)}\n`);
  }
}

export function messageIndexKey(messageKey) {
  const remoteJid = normalizeLooseJid(messageKey?.remoteJid);
  const participant = normalizeLooseJid(messageKey?.participant);
  return [remoteJid, participant, messageKey?.id || ''].join('|');
}

export function summarizeMessage(message, maxTextLength = 1200) {
  const text = getMessageText(message).trim();
  const type = messageTypeName(message);
  return {
    type,
    text: text ? truncateText(text, maxTextLength) : '',
    hasText: Boolean(text),
    timestamp: timestampMs(message)
  };
}

export function messageTypeName(message) {
  const content = unwrapMessage(message?.message);
  const key = Object.keys(content || {}).find((name) => content?.[name]);
  return key || 'unknown';
}

export function timestampMs(message) {
  const raw = Number(message?.messageTimestamp || 0);
  if (!raw) return Date.now();
  return raw > 10_000_000_000 ? raw : raw * 1000;
}

export function truncateText(value, maxLength = 1200) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 20))}\n...[dipotong]`;
}

function normalizeStore(value) {
  const allowedChats = [];
  const seen = new Set();
  for (const raw of Array.isArray(value?.allowedChats) ? value.allowedChats : []) {
    const jid = normalizeChatJid(raw?.jid);
    if (!jid || seen.has(jid)) continue;
    seen.add(jid);
    allowedChats.push({
      id: Number.isInteger(raw?.id) && raw.id > 0 ? raw.id : allowedChats.length + 1,
      jid,
      savedName: String(raw?.savedName || raw?.title || raw?.input || jid).trim() || jid,
      input: raw?.input || undefined,
      addedAt: raw?.addedAt || null,
      addedBy: raw?.addedBy || null
    });
  }
  const store = {
    allowedChats,
    nextAllowedId: Number.isInteger(value?.nextAllowedId) && value.nextAllowedId > 0 ? value.nextAllowedId : allowedChats.length + 1,
    index: Array.isArray(value?.index) ? value.index.map(normalizeIndexEntry).filter((item) => item.key) : [],
    updatedAt: value?.updatedAt || null
  };
  renumberAllowed(store);
  return store;
}

function normalizeIndexEntry(raw) {
  const key = raw?.key || messageIndexKey(raw?.messageKey || raw);
  return {
    key,
    id: String(raw?.id || raw?.messageKey?.id || '').trim(),
    remoteJid: normalizeLooseJid(raw?.remoteJid || raw?.messageKey?.remoteJid),
    participant: normalizeLooseJid(raw?.participant || raw?.messageKey?.participant),
    actorJid: normalizeLooseJid(raw?.actorJid),
    pushName: String(raw?.pushName || '').trim(),
    chatName: String(raw?.chatName || '').trim(),
    type: String(raw?.type || 'unknown'),
    text: String(raw?.text || ''),
    latestText: raw?.latestText == null ? String(raw?.text || '') : String(raw.latestText),
    logJid: normalizeLooseJid(raw?.logJid),
    logMessageId: String(raw?.logMessageId || '').trim(),
    timestamp: Number(raw?.timestamp) || Date.now(),
    createdAt: raw?.createdAt || new Date().toISOString(),
    updatedAt: raw?.updatedAt || null,
    editedAt: raw?.editedAt || null,
    deletedAt: raw?.deletedAt || null,
    changedAt: raw?.changedAt || null,
    editCount: Number(raw?.editCount) || 0
  };
}

function findAllowed(items, query) {
  const text = String(query || '').trim();
  if (!text) return null;
  const id = Number(text);
  if (/^\d{1,6}$/.test(text) && Number.isInteger(id)) return items.find((item) => item.id === id) || null;
  const jid = normalizeLooseJid(text);
  if (jid) {
    const byJid = items.find((item) => sameJid(item.jid, jid));
    if (byJid) return byJid;
  }
  const key = titleKey(text);
  return items.find((item) => titleKey(item.savedName) === key) || null;
}

function renumberAllowed(store) {
  renumberCollection({ items: store.allowedChats, nextId: store.nextAllowedId });
  store.allowedChats = store.allowedChats.map((item, index) => ({ ...item, id: index + 1 }));
  store.nextAllowedId = store.allowedChats.length + 1;
}

function normalizeChatJid(input) {
  const jid = normalizeLooseJid(input);
  return jid || '';
}

function normalizeLooseJid(input) {
  const text = String(input || '').trim();
  if (!text) return '';
  try {
    return jidNormalizedUser(text);
  } catch {
    return tryNormalizeJid(text) || text;
  }
}
