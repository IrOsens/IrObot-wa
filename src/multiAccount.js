import fs from 'node:fs/promises';
import path from 'node:path';
import { AUTH_DIR, MULTI_ACCOUNT_FILE } from './config.js';
import { displayPhoneFromJid, normalizePhoneToJid, sameJid, tryNormalizeJid } from './phone.js';

export const ACCOUNT_ROLES = new Set(['primary', 'trust', 'worker']);
export const ACCOUNT_STATUSES = new Set(['connected', 'connecting', 'qr', 'disconnected', 'logged_out']);

const DEFAULT_STORE = {
  mode: 'single',
  superAdminJid: null,
  nextId: 2,
  accounts: []
};

export class MultiAccountStore {
  constructor(filePath = MULTI_ACCOUNT_FILE, authRoot = AUTH_DIR) {
    this.filePath = filePath;
    this.authRoot = authRoot;
    this.data = normalizeStore(DEFAULT_STORE, authRoot);
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      this.data = normalizeStore(parsed, this.authRoot);
    } catch {
      this.data = normalizeStore(DEFAULT_STORE, this.authRoot);
      await this.save();
    }
    return this.snapshot();
  }

  snapshot() {
    return structuredClone(this.data);
  }

  isMulti() {
    return this.data.mode === 'multi';
  }

  isSingle() {
    return !this.isMulti();
  }

  superAdminJid() {
    return this.data.superAdminJid || null;
  }

  isSuperAdmin(jid) {
    if (!this.data.superAdminJid) return false;
    try {
      const normalized = normalizeNullableJid(jid);
      return Boolean(normalized && sameJid(this.data.superAdminJid, normalized));
    } catch {
      return false;
    }
  }

  listAccounts() {
    return this.data.accounts.map((account) => ({ ...account }));
  }

  getAccount(id) {
    const accountId = normalizeId(id);
    return this.data.accounts.find((account) => account.id === accountId) || null;
  }

  getPrimary() {
    return this.getAccount(1);
  }

  getTrust() {
    return this.data.accounts.find((account) => account.role === 'trust') || null;
  }

  async configureInitialMode(modeRaw, superAdminInput = '') {
    const mode = normalizeMode(modeRaw);
    if (mode === 'multi' && !superAdminInput) throw new Error('Nomor super admin wajib diisi untuk mode multi akun.');
    const superAdminJid = superAdminInput ? normalizePhoneToJid(superAdminInput) : null;

    if (this.data.superAdminJid && superAdminJid && !sameJid(this.data.superAdminJid, superAdminJid)) {
      throw new Error('Super admin sudah ditetapkan permanen dan tidak bisa diganti.');
    }
    if (this.data.mode === 'multi' && mode === 'single') {
      throw new Error('Mode multi akun sudah aktif; ubah manual hanya jika benar-benar ingin migrasi.');
    }

    this.data.mode = mode;
    if (superAdminJid && !this.data.superAdminJid) this.data.superAdminJid = superAdminJid;
    await this.save();
    return this.snapshot();
  }

  async addWorker() {
    const id = Math.max(2, this.data.nextId || 2);
    const item = normalizeAccount({
      id,
      role: 'worker',
      authDir: secondaryAuthDir(id),
      status: 'connecting',
      createdAt: new Date().toISOString()
    }, this.authRoot);
    this.data.accounts.push(item);
    this.data.nextId = id + 1;
    await this.save();
    return { ...item };
  }

  async setRole(id, roleRaw) {
    const idNumber = normalizeId(id);
    const role = normalizeSecondaryRole(roleRaw);
    if (idNumber === 1) throw new Error('Akun primary tidak bisa diubah role-nya.');
    const account = this.getAccount(idNumber);
    if (!account) throw new Error(`Akun #${idNumber} tidak ditemukan.`);

    if (role === 'trust') {
      for (const candidate of this.data.accounts) {
        if (candidate.id !== idNumber && candidate.role === 'trust') {
          candidate.role = 'worker';
          candidate.updatedAt = new Date().toISOString();
        }
      }
    }
    account.role = role;
    account.updatedAt = new Date().toISOString();
    await this.save();
    return { ...account };
  }

  async updateAccount(id, patch = {}) {
    const idNumber = normalizeId(id);
    const account = this.getAccount(idNumber);
    if (!account) throw new Error(`Akun #${idNumber} tidak ditemukan.`);
    const normalized = normalizeAccount({ ...account, ...patch, id: idNumber }, this.authRoot);
    Object.assign(account, normalized, { updatedAt: new Date().toISOString() });
    await this.save();
    return { ...account };
  }

  async deleteAccount(id) {
    const idNumber = normalizeId(id);
    if (idNumber === 1) throw new Error('Akun primary tidak bisa dihapus.');
    const account = this.getAccount(idNumber);
    if (!account) throw new Error(`Akun #${idNumber} tidak ditemukan.`);
    this.data.accounts = this.data.accounts.filter((item) => item.id !== idNumber);
    await this.save();
    return { ...account };
  }

  async save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(normalizeStore(this.data, this.authRoot), null, 2)}\n`);
  }
}

export function createInitialMultiAccountData(modeRaw = 'single', superAdminInput = '', authRoot = AUTH_DIR) {
  const mode = normalizeMode(modeRaw);
  const superAdminJid = superAdminInput ? normalizePhoneToJid(superAdminInput) : null;
  if (mode === 'multi' && !superAdminJid) throw new Error('Nomor super admin wajib diisi untuk mode multi akun.');
  return normalizeStore({
    ...DEFAULT_STORE,
    mode,
    superAdminJid
  }, authRoot);
}

export function accountAuthPath(account, rootDir = process.cwd()) {
  const authDir = String(account?.authDir || '').trim() || (account?.id === 1 ? 'auth' : secondaryAuthDir(account?.id));
  return path.isAbsolute(authDir) ? authDir : path.join(rootDir, authDir);
}

export function secondaryAuthDir(id) {
  return `auth/accounts/${normalizeId(id)}`;
}

export function accountWaLink(accountOrJid) {
  const jid = typeof accountOrJid === 'string' ? accountOrJid : accountOrJid?.jid;
  const phone = displayPhoneFromJid(jid || '');
  return phone ? `wa.me/${phone}` : '-';
}

function normalizeStore(value, authRoot) {
  const mode = normalizeMode(value?.mode || 'single');
  const superAdminJid = normalizeNullableJid(value?.superAdminJid);
  const accounts = [];
  const seen = new Set();
  for (const raw of Array.isArray(value?.accounts) ? value.accounts : []) {
    const account = normalizeAccount(raw, authRoot);
    if (!account.id || seen.has(account.id)) continue;
    if (account.id === 1) account.role = 'primary';
    seen.add(account.id);
    accounts.push(account);
  }
  if (!seen.has(1)) {
    accounts.unshift(normalizeAccount({
      id: 1,
      role: 'primary',
      authDir: 'auth',
      status: 'disconnected',
      createdAt: null
    }, authRoot));
  }
  let trustSeen = false;
  const normalizedAccounts = accounts
    .sort((a, b) => a.id - b.id)
    .map((account) => {
      if (account.id === 1) return { ...account, role: 'primary', authDir: 'auth' };
      if (account.role === 'trust') {
        if (trustSeen) return { ...account, role: 'worker' };
        trustSeen = true;
      }
      return account;
    });
  return {
    mode,
    superAdminJid,
    nextId: Math.max(Number(value?.nextId) || 2, ...normalizedAccounts.map((account) => account.id + 1), 2),
    accounts: normalizedAccounts
  };
}

function normalizeAccount(raw, authRoot) {
  const id = normalizeId(raw?.id || 1);
  const role = id === 1 ? 'primary' : normalizeSecondaryRole(raw?.role || 'worker');
  const jid = normalizeNullableJid(raw?.jid);
  const phone = String(raw?.phone || (jid ? displayPhoneFromJid(jid) : '')).trim() || null;
  const statusRaw = String(raw?.status || 'disconnected').trim();
  const authDir = normalizeAuthDir(raw?.authDir, id, authRoot);
  return {
    id,
    role,
    authDir,
    jid,
    phone,
    name: String(raw?.name || '').trim() || null,
    status: ACCOUNT_STATUSES.has(statusRaw) ? statusRaw : 'disconnected',
    createdAt: raw?.createdAt || null,
    updatedAt: raw?.updatedAt || null,
    lastConnectedAt: raw?.lastConnectedAt || null,
    lastQrAt: raw?.lastQrAt || null,
    lastError: raw?.lastError || null
  };
}

function normalizeMode(modeRaw) {
  const mode = String(modeRaw || '').trim().toLowerCase();
  if (mode === 'single' || mode === 'multi') return mode;
  throw new Error('Mode akun harus single atau multi.');
}

function normalizeSecondaryRole(roleRaw) {
  const role = String(roleRaw || '').trim().toLowerCase();
  if (role === 'trust' || role === 'worker') return role;
  throw new Error('Role akun harus trust atau worker.');
}

function normalizeId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new Error('ID akun tidak valid.');
  return id;
}

function normalizeNullableJid(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const phoneJid = text.match(/^([^@]+)@s\.whatsapp\.net$/i);
  if (phoneJid) {
    const digits = phoneJid[1].replace(/[^\d]/g, '');
    if (digits) return `${digits}@s.whatsapp.net`;
  }
  return tryNormalizeJid(text) || normalizePhoneToJid(text);
}

function normalizeAuthDir(value, id, authRoot) {
  const fallback = id === 1 ? 'auth' : secondaryAuthDir(id);
  const clean = String(value || fallback).replace(/\\/g, '/').trim();
  if (!clean) return fallback;
  if (path.isAbsolute(clean)) {
    const relative = path.relative(path.dirname(authRoot), clean).replace(/\\/g, '/');
    return relative && !relative.startsWith('..') ? relative : clean;
  }
  return clean;
}
