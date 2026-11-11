import fs from 'node:fs/promises';
import path from 'node:path';
import { UserInputError } from './errors.js';
import { WORKERS_ARCHIVE_DIR, WORKERS_DIR, WORKERS_FILE } from './config.js';
import { atomicJson } from './storage.js';
import { displayPhoneFromJid, normalizePhoneNumber } from './phone.js';
import { formatWib } from './tasks.js';

const STATUS_LABELS = {
  online: 'online',
  offline: 'offline',
  logged_out: 'logout (arsip)'
};

export class WorkerStore {
  constructor({ file = WORKERS_FILE, rootDir = WORKERS_DIR, archiveDir = WORKERS_ARCHIVE_DIR } = {}) {
    this.file = file;
    this.rootDir = rootDir;
    this.archiveDir = archiveDir;
    this.data = { nextId: 1, workers: [] };
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.data = {
        nextId: Number.isInteger(parsed.nextId) ? parsed.nextId : 1,
        workers: Array.isArray(parsed.workers) ? parsed.workers : []
      };
    } catch {
      this.data = { nextId: 1, workers: [] };
      await this.save();
    }
    return this;
  }

  async save() {
    await atomicJson(this.file, this.data);
  }

  list() {
    return this.data.workers;
  }

  activeWorkers() {
    return this.data.workers.filter((worker) => worker.status !== 'logged_out');
  }

  get(id) {
    return this.data.workers.find((worker) => worker.id === Number(id)) || null;
  }

  findByPhone(phoneJid) {
    const phone = displayPhoneFromJid(phoneJid);
    return this.data.workers.find((worker) => worker.phone === phone) || null;
  }

  find(query) {
    const text = String(query || '').trim();
    if (!text) throw new UserInputError('Isi id atau nomor worker.');
    const digits = text.replace(/[^\d]/g, '');
    // Worker ids are short numbers, phone numbers have at least 8 digits.
    if (/^#?\d{1,6}$/.test(text)) {
      const worker = this.get(digits);
      if (!worker) throw new UserInputError(`Worker #${digits} tidak ditemukan.`);
      return worker;
    }
    const phone = normalizePhoneNumber(text);
    const worker = this.data.workers.find((item) => item.phone === phone);
    if (!worker) throw new UserInputError(`Worker dengan nomor ${phone} tidak ditemukan.`);
    return worker;
  }

  async create({ phoneJid, lidJid = null, name = '', requestedBy = null }) {
    const now = new Date().toISOString();
    const worker = {
      id: this.data.nextId++,
      phoneJid,
      phone: displayPhoneFromJid(phoneJid),
      lidJid,
      name,
      status: 'offline',
      service: null,
      allowDefaultCommands: false,
      serviceConfig: {},
      stats: { cintaReplies: 0 },
      hasProfilePicture: false,
      requestedBy,
      approvedAt: now,
      createdAt: now,
      connectedAt: null,
      lastSeenAt: null,
      loggedOutAt: null
    };
    this.data.workers.push(worker);
    await fs.mkdir(this.dataDir(worker), { recursive: true });
    await this.save();
    return worker;
  }

  async update(id, changes) {
    const worker = this.get(id);
    if (!worker) throw new UserInputError(`Worker #${id} tidak ditemukan.`);
    Object.assign(worker, changes);
    await this.save();
    return worker;
  }

  dirFor(worker) {
    if (worker.status === 'logged_out') return path.join(this.archiveDir, String(worker.id));
    return path.join(this.rootDir, String(worker.id));
  }

  authDir(worker) {
    return path.join(this.dirFor(worker), 'auth');
  }

  dataDir(worker) {
    return path.join(this.dirFor(worker), 'data');
  }

  profilePath(worker) {
    return path.join(this.dirFor(worker), 'profile.jpg');
  }

  async archive(id) {
    const worker = this.get(id);
    if (!worker || worker.status === 'logged_out') return worker;
    const activeDir = this.dirFor(worker);
    // The WhatsApp session is invalid after logout, so only the auth folder is removed.
    await fs.rm(path.join(activeDir, 'auth'), { recursive: true, force: true });
    const archivedDir = path.join(this.archiveDir, String(worker.id));
    await fs.mkdir(this.archiveDir, { recursive: true });
    await fs.rm(archivedDir, { recursive: true, force: true });
    await fs.rename(activeDir, archivedDir).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return this.update(id, { status: 'logged_out', loggedOutAt: new Date().toISOString() });
  }

  async restore(id) {
    const worker = this.get(id);
    if (!worker || worker.status !== 'logged_out') return worker;
    const archivedDir = this.dirFor(worker);
    const activeDir = path.join(this.rootDir, String(worker.id));
    await fs.rm(activeDir, { recursive: true, force: true });
    await fs.rename(archivedDir, activeDir).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return this.update(id, { status: 'offline', loggedOutAt: null });
  }
}

export function workerStatusLabel(worker) {
  return STATUS_LABELS[worker.status] || worker.status;
}

export function waLink(worker) {
  return `wa.me/${worker.phone}`;
}

export function formatWorkerList(workers) {
  if (!workers.length) return 'Belum ada worker. User bisa mendaftar dengan ,jadibot.';
  const lines = [`*Daftar worker* (${workers.length})`];
  for (const worker of workers) {
    lines.push(
      '',
      `#${worker.id} ${worker.name || worker.phone} - ${workerStatusLabel(worker)}`,
      waLink(worker),
      `Service: ${worker.service || 'default'}`
    );
  }
  lines.push('', 'Detail: ,worker info <id|nomor>');
  return lines.join('\n');
}

function formatRequester(jid) {
  if (!jid) return '-';
  if (String(jid).endsWith('@lid')) return `LID ${displayPhoneFromJid(jid)}`;
  return `+${displayPhoneFromJid(jid)}`;
}

export function formatWorkerInfo(worker, { folder, notesCount = 0, linksCount = 0, adminSession = false } = {}) {
  const formatTime = (value) => (value ? formatWib(value) : '-');
  const defaultCommands = worker.service ? (worker.allowDefaultCommands ? 'aktif' : 'nonaktif') : 'aktif';
  return [
    `*Worker #${worker.id}*`,
    `Nama: ${worker.name || '-'}`,
    `Nomor: +${worker.phone}`,
    `Link: ${waLink(worker)}`,
    `Status: ${workerStatusLabel(worker)}`,
    `Service: ${worker.service || 'default'}`,
    `Command default: ${defaultCommands}`,
    `Sesi admin: ${adminSession ? 'aktif' : 'tidak aktif'}`,
    '',
    `Pertama login: ${formatTime(worker.createdAt)}`,
    `Terhubung sejak: ${formatTime(worker.connectedAt)}`,
    `Terakhir aktif: ${formatTime(worker.lastSeenAt)}`,
    worker.loggedOutAt ? `Logout: ${formatTime(worker.loggedOutAt)}` : null,
    `Pemohon: ${formatRequester(worker.requestedBy)}`,
    '',
    `Folder: ${folder || '-'}`,
    `Note: ${notesCount}, link: ${linksCount}`,
    worker.service === 'cinta' ? `Balasan cinta terkirim: ${worker.stats?.cintaReplies || 0}` : null
  ].filter((line) => line !== null).join('\n');
}
