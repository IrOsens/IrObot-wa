import fs from 'node:fs/promises';
import path from 'node:path';
import { COMMAND_ACCESS_FILE } from './config.js';
import { displayPhoneFromJid, normalizePhoneToJid, sameJid, tryNormalizeJid } from './phone.js';

export const PUBLIC_COMMANDS = new Set(['help', 's', 'smeme', 'rs']);
export const ADMIN_RESTRICTED_COMMANDS = new Set([
  'allow',
  'admin',
  'bot',
  'changedmsg',
  'config',
  'status',
  'statussave',
  'health',
  'backup',
  'restore',
  'clear',
  'update',
  'restartbot'
]);

const DEFAULT_ACCESS = {
  all: false,
  chats: {},
  admins: [],
  nextAdminId: 1
};

export class CommandAccessStore {
  constructor(filePath = COMMAND_ACCESS_FILE) {
    this.filePath = filePath;
    this.data = { ...DEFAULT_ACCESS, chats: {} };
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      this.data = normalizeAccess(parsed);
    } catch {
      this.data = { ...DEFAULT_ACCESS, chats: {} };
      await this.save();
    }
    return this.data;
  }

  canUse(commandName, jid) {
    const command = String(commandName || '').toLowerCase();
    if (!this.isOpen(jid)) return false;
    if (PUBLIC_COMMANDS.has(command)) return true;
    return false;
  }

  canUseAs(commandName, jid, actorJid, { owner = false } = {}) {
    if (owner) return true;
    const command = String(commandName || '').toLowerCase();
    if (!this.isOpen(jid)) return false;
    if (this.isAdmin(actorJid) && !ADMIN_RESTRICTED_COMMANDS.has(command)) return true;
    return PUBLIC_COMMANDS.has(command);
  }

  isOpen(jid) {
    if (this.data.all) return true;
    return Boolean(jid && this.data.chats?.[jid]);
  }

  isAdmin(actorJid) {
    return Boolean(findAdmin(this.data.admins, actorJid));
  }

  async setHere(jid, enabled) {
    if (!jid) throw new Error('Chat target tidak valid.');
    if (enabled) this.data.chats[jid] = true;
    else delete this.data.chats[jid];
    await this.save();
    return this.snapshot();
  }

  async setAll(enabled) {
    this.data.all = Boolean(enabled);
    if (!enabled) this.data.chats = {};
    await this.save();
    return this.snapshot();
  }

  snapshot() {
    return {
      all: Boolean(this.data.all),
      chats: { ...this.data.chats },
      chatCount: Object.keys(this.data.chats || {}).length,
      admins: this.listAdmins(),
      adminCount: this.data.admins.length
    };
  }

  listAdmins() {
    return this.data.admins.map((admin) => ({ ...admin }));
  }

  async addAdmin(input) {
    const jid = normalizePhoneToJid(input);
    const existing = findAdmin(this.data.admins, jid);
    if (existing) throw new Error(`Admin ${existing.title} sudah tersimpan sebagai #${existing.id}.`);
    const item = {
      id: this.data.nextAdminId++,
      title: displayPhoneFromJid(jid),
      jid,
      createdAt: new Date().toISOString()
    };
    this.data.admins.push(item);
    renumberAdmins(this.data);
    await this.save();
    return { ...item };
  }

  async deleteAdmin(query) {
    const item = findAdmin(this.data.admins, query);
    if (!item) throw new Error(`Admin "${query}" tidak ditemukan.`);
    this.data.admins = this.data.admins.filter((admin) => admin.id !== item.id);
    renumberAdmins(this.data);
    await this.save();
    return { ...item };
  }

  async save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(normalizeAccess(this.data), null, 2)}\n`);
  }
}

export function parseAllowArgs(args) {
  const [scopeRaw, enabledRaw] = args;
  const scope = String(scopeRaw || '').toLowerCase();
  if (!['here', 'all'].includes(scope)) throw new Error('Format: ,allow here|all true|false');
  const enabledText = String(enabledRaw || '').toLowerCase();
  if (!['true', 'false'].includes(enabledText)) throw new Error('Format: ,allow here|all true|false');
  return {
    scope,
    enabled: enabledText === 'true'
  };
}

function normalizeAccess(value) {
  const chats = {};
  if (value?.chats && typeof value.chats === 'object' && !Array.isArray(value.chats)) {
    for (const [jid, enabled] of Object.entries(value.chats)) {
      if (jid && enabled === true) chats[jid] = true;
    }
  }
  const admins = [];
  const seen = new Set();
  if (Array.isArray(value?.admins)) {
    for (const raw of value.admins) {
      const jid = tryNormalizeJid(raw?.jid) || (typeof raw === 'string' ? tryNormalizeJid(raw) : null);
      if (!jid || seen.has(jid)) continue;
      seen.add(jid);
      admins.push({
        id: Number.isInteger(raw?.id) && raw.id > 0 ? raw.id : admins.length + 1,
        title: String(raw?.title || displayPhoneFromJid(jid)).trim() || displayPhoneFromJid(jid),
        jid,
        createdAt: raw?.createdAt || null,
        updatedAt: raw?.updatedAt || null
      });
    }
  }
  admins.sort((a, b) => a.id - b.id);
  const normalized = {
    all: value?.all === true,
    chats,
    admins,
    nextAdminId: Number.isInteger(value?.nextAdminId) && value.nextAdminId > 0 ? value.nextAdminId : admins.length + 1
  };
  renumberAdmins(normalized);
  return normalized;
}

function findAdmin(admins, query) {
  const text = String(query || '').trim();
  if (!text) return null;
  const id = Number(text);
  if (/^\d{1,6}$/.test(text) && Number.isInteger(id)) return admins.find((admin) => admin.id === id) || null;
  const jid = normalizeAdminQuery(text);
  if (!jid) return null;
  return admins.find((admin) => sameJid(admin.jid, jid)) || null;
}

function normalizeAdminQuery(query) {
  return tryNormalizeJid(query) || (() => {
    try {
      return normalizePhoneToJid(query);
    } catch {
      return null;
    }
  })();
}

function renumberAdmins(data) {
  data.admins = [...(data.admins || [])].map((admin, index) => ({
    ...admin,
    id: index + 1
  }));
  data.nextAdminId = data.admins.length + 1;
}
