import fs from 'node:fs/promises';
import path from 'node:path';
import { STATUS_SAVE_FILE } from './config.js';
import { renumberCollection } from './namedStore.js';
import { displayPhoneFromJid, normalizePhoneToJid, sameJid, tryNormalizeJid } from './phone.js';

const DEFAULT_STORE = {
  nextId: 1,
  items: [],
  updatedAt: null
};

export class StatusSaveStore {
  constructor(filePath = STATUS_SAVE_FILE) {
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
      items: this.list(),
      count: this.store.items.length,
      updatedAt: this.store.updatedAt
    };
  }

  list() {
    return this.store.items.map((item) => ({ ...item }));
  }

  isWatched(jid) {
    return Boolean(jid && this.store.items.some((item) => sameJid(item.jid, jid)));
  }

  async add(input, addedBy = null) {
    const jid = normalizePhoneToJid(input);
    const existing = this.store.items.find((item) => sameJid(item.jid, jid));
    if (existing) throw new Error(`Nomor ${existing.title} sudah tersimpan sebagai #${existing.id}.`);
    const item = {
      id: this.store.nextId++,
      title: displayPhoneFromJid(jid),
      jid,
      createdAt: new Date().toISOString(),
      addedBy
    };
    this.store.items.push(item);
    renumberCollection(this.store);
    await this.save();
    return { ...item };
  }

  async delete(query) {
    const item = findStatusItem(this.store.items, query);
    if (!item) throw new Error(`Statussave "${query}" tidak ditemukan.`);
    this.store.items = this.store.items.filter((candidate) => candidate.id !== item.id);
    renumberCollection(this.store);
    await this.save();
    return { ...item };
  }

  async save() {
    this.store.updatedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(normalizeStore(this.store), null, 2)}\n`);
  }
}

function normalizeStore(value) {
  const items = [];
  const seen = new Set();
  for (const raw of Array.isArray(value?.items) ? value.items : []) {
    const jid = normalizeStatusJid(raw?.jid || raw);
    if (!jid || seen.has(jid)) continue;
    seen.add(jid);
    items.push({
      id: Number.isInteger(raw?.id) && raw.id > 0 ? raw.id : items.length + 1,
      title: String(raw?.title || displayPhoneFromJid(jid)).trim() || displayPhoneFromJid(jid),
      jid,
      createdAt: raw?.createdAt || null,
      addedBy: raw?.addedBy || null
    });
  }
  const store = {
    nextId: Number.isInteger(value?.nextId) && value.nextId > 0 ? value.nextId : items.length + 1,
    items,
    updatedAt: value?.updatedAt || null
  };
  renumberCollection(store);
  return store;
}

function findStatusItem(items, query) {
  const text = String(query || '').trim();
  if (!text) return null;
  const id = Number(text);
  if (/^\d{1,6}$/.test(text) && Number.isInteger(id)) return items.find((item) => item.id === id) || null;
  const jid = normalizeStatusJid(text);
  if (!jid) return null;
  return items.find((item) => sameJid(item.jid, jid)) || null;
}

function normalizeStatusJid(input) {
  try {
    return normalizePhoneToJid(input);
  } catch {
    return tryNormalizeJid(input);
  }
}
