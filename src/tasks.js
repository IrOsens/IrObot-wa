import { UserInputError } from './errors.js';
import { atomicJson } from './storage.js';
import { parseDurationMs } from './reminders.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TASKS_FILE, TASK_MEDIA_DIR, TASK_TARGET_NAMES } from './config.js';
import { cleanupFiles, downloadQuotedOrOwnMedia } from './media.js';
import { renumberCollection } from './namedStore.js';
import {
  cleanupRecordedTempEntries,
  persistRecordedEntries,
  recordMessageEntry,
  sendRecordedEntries,
  visibleRecordedEntries
} from './recordedMessages.js';

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const TIME_NUMBER = /^\d{1,2}$/;
const HH_MM = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const FULL_DATE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
const TASK_FORMAT = [
  'Format task:',
  ',task list',
  ',task add <teks> at <HH:MM>',
  ',task add <teks> at <HH:MM> <DD/MM/YYYY>',
  ',task loop <teks> at <HH:MM>',
  ',task repeat <jumlah> <teks> at <HH:MM>',
  ',task record [loop|repeat <jumlah>] <nomor|nama kontak|nama grup> at <HH:MM> [DD/MM/YYYY]',
  ',task pause|stop <id>',
  ',task resume <id>',
  ',task del <id>'
].join('\n');

function emptyStore() {
  return { nextId: 1, tasks: [] };
}

async function readStore() {
  try {
    return JSON.parse(await fs.readFile(TASKS_FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return emptyStore();
  }
}

async function writeStore(store) {
  await fs.mkdir(path.dirname(TASKS_FILE), { recursive: true });
  await atomicJson(TASKS_FILE, store);
}

let storeQueue = Promise.resolve();
function withStoreLock(fn) {
  const task = storeQueue.then(fn);
  storeQueue = task.catch(() => {});
  return task;
}

function toWibParts(date = new Date()) {
  const shifted = new Date(date.getTime() + WIB_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds()
  };
}

function wibDateToUtc(year, month, day, hour, minute, second) {
  return new Date(Date.UTC(year, month, day, hour, minute, second, 0) - WIB_OFFSET_MS);
}

function addDaysWib(iso, days, hour, minute, second) {
  const parts = toWibParts(new Date(iso));
  return wibDateToUtc(parts.year, parts.month, parts.day + days, hour === 24 ? 0 : hour, minute, second).toISOString();
}

function parseDateToken(token, now = new Date()) {
  if (!token) return null;
  const parts = String(token).split('/').map((part) => Number(part));
  if (parts.some((part) => !Number.isInteger(part))) throw new UserInputError('Format tanggal harus DD atau DD/MM/YYYY.');
  if (parts.length === 1) {
    const day = parts[0];
    if (day < 1 || day > 31) throw new UserInputError('Tanggal harus 1-31.');
    const nowWib = toWibParts(now);
    const year = nowWib.year;
    let month = nowWib.month;
    const candidate = wibDateToUtc(year, month, day, 0, 0, 0);
    const today = wibDateToUtc(nowWib.year, nowWib.month, nowWib.day, 0, 0, 0);
    if (candidate < today) month += 1;
    return { year: month > 11 ? year + 1 : year, month: month % 12, day };
  }
  if (parts.length === 3) {
    const [day, month, year] = parts;
    if (day < 1 || day > 31 || month < 1 || month > 12 || year < 1970) {
      throw new UserInputError('Tanggal harus valid, contoh 12/12/2026.');
    }
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) throw new UserInputError('Tanggal kalender tidak valid.');
    return { year, month: month - 1, day };
  }
  throw new UserInputError('Format tanggal harus DD atau DD/MM/YYYY.');
}

function nextRunAt(hour, minute, second, dateToken) {
  const now = new Date();
  const parsedDate = parseDateToken(dateToken, now);
  let run;
  if (parsedDate) {
    run = wibDateToUtc(parsedDate.year, parsedDate.month, parsedDate.day, hour === 24 ? 0 : hour, minute, second);
    if (hour === 24) run = wibDateToUtc(parsedDate.year, parsedDate.month, parsedDate.day + 1, 0, minute, second);
  } else {
    const nowWib = toWibParts(now);
    run = wibDateToUtc(nowWib.year, nowWib.month, nowWib.day, hour === 24 ? 0 : hour, minute, second);
    if (hour === 24 || run <= now) {
      run = wibDateToUtc(nowWib.year, nowWib.month, nowWib.day + 1, hour === 24 ? 0 : hour, minute, second);
    }
  }
  if (parsedDate && run <= now) throw new UserInputError('Waktu mulai harus di masa depan.');
  return run.toISOString();
}

function nextDailyRun(previousIso, hour, minute, second) {
  return addDaysWib(previousIso, 1, hour, minute, second);
}

export function formatWib(iso) {
  const parts = toWibParts(new Date(iso));
  const date = `${String(parts.day).padStart(2, '0')}/${String(parts.month + 1).padStart(2, '0')}/${parts.year}`;
  const time = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')}`;
  return `${date} ${time} WIB`;
}

export function parseTaskArgs(args) {
  const first = String(args[0] || '').toLowerCase();
  if (['add', 'loop', 'repeat'].includes(first)) return parseNaturalTaskArgs(args);
  return parseLegacyTaskArgs(args);
}

export function parseTaskRecordingArgs(args) {
  const values = [...args];
  if (String(values.shift() || '').toLowerCase() !== 'record') {
    throw new UserInputError('Format rekam task: ,task record [loop|repeat <jumlah>] <nomor> at <HH:MM> [DD/MM/YYYY]');
  }
  const everyIndex = values.findIndex((value) => value.toLowerCase() === 'every');
  if (everyIndex >= 1) {
    const targetInput = values.slice(0, everyIndex).join(' ');
    const rest = values.slice(everyIndex + 1);
    const intervalMs = parseDurationMs(rest.shift());
    const mode = rest.shift()?.toLowerCase();
    let count = null;
    if (mode === 'count') count = Number(rest.shift());
    else if (mode !== 'forever') throw new UserInputError('Gunakan every <durasi> count <jumlah> atau every <durasi> forever.');
    if (mode === 'count' && (!Number.isSafeInteger(count) || count < 1)) throw new UserInputError('Jumlah pengiriman harus integer positif.');
    let clock = {};
    if (rest.length) {
      if (rest.shift()?.toLowerCase() !== 'at') throw new UserInputError('Gunakan at <HH:MM> [DD/MM/YYYY].');
      clock = parseClockToken(rest.shift());
      clock.dateToken = rest.shift() || null;
      if (rest.length || (clock.dateToken && !FULL_DATE.test(clock.dateToken))) throw new UserInputError('Tanggal harus DD/MM/YYYY.');
    }
    return { targetInput, intervalMs, count, loop: mode === 'forever', ...clock };
  }
  let loop = false;
  let count = 1;
  if (String(values[0] || '').toLowerCase() === 'loop') {
    loop = true;
    count = null;
    values.shift();
  } else if (String(values[0] || '').toLowerCase() === 'repeat') {
    values.shift();
    count = Number(values.shift());
    if (!Number.isInteger(count) || count < 1) {
      throw new UserInputError('Format rekam task: ,task record repeat <jumlah> <nomor> at <HH:MM> [DD/MM/YYYY]');
    }
  }
  const atIndex = values.findIndex((value) => String(value).toLowerCase() === 'at');
  if (atIndex < 1) {
    throw new UserInputError('Format rekam task: ,task record [loop|repeat <jumlah>] <nomor|nama kontak|nama grup> at <HH:MM> [DD/MM/YYYY]');
  }
  const targetInput = values.slice(0, atIndex).join(' ').trim();
  const timeToken = values[atIndex + 1];
  const dateToken = values[atIndex + 2] || null;
  if (!targetInput || !timeToken || values.length > atIndex + 3 || (dateToken && !FULL_DATE.test(dateToken))) {
    throw new UserInputError('Format rekam task: ,task record [loop|repeat <jumlah>] <nomor|nama kontak|nama grup> at <HH:MM> [DD/MM/YYYY]');
  }
  return { loop, count, targetInput, ...parseClockToken(timeToken), dateToken };
}

function parseNaturalTaskArgs(args) {
  const action = String(args[0] || '').toLowerCase();
  let loop = action === 'loop';
  let count = 1;
  let startIndex = 1;

  if (action === 'repeat') {
    count = Number(args[1]);
    if (!Number.isInteger(count) || count < 1) throw new UserInputError(TASK_FORMAT);
    startIndex = 2;
  }

  const atIndex = args.findIndex((arg, index) => index >= startIndex && String(arg).toLowerCase() === 'at');
  if (atIndex < 0) throw new UserInputError(TASK_FORMAT);

  const text = args.slice(startIndex, atIndex).join(' ').trim();
  const timeToken = args[atIndex + 1];
  const dateToken = args[atIndex + 2] || null;
  if (!text || !timeToken || args.length > atIndex + 3) throw new UserInputError(TASK_FORMAT);
  if (dateToken && !FULL_DATE.test(dateToken)) throw new UserInputError('Tanggal harus DD/MM/YYYY. Contoh: 12/12/2026.');

  const time = parseClockToken(timeToken);
  return { loop, count: loop ? null : count, text, ...time, dateToken };
}

function parseClockToken(token) {
  const match = String(token || '').match(HH_MM);
  if (!match) throw new UserInputError('Format jam harus HH:MM. Contoh: ,task add "cek bot" at 20:30');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] == null ? 0 : Number(match[3]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new UserInputError('Jam harus 00-23.');
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new UserInputError('Menit harus 00-59.');
  if (!Number.isInteger(second) || second < 0 || second > 59) throw new UserInputError('Detik harus 00-59.');
  return { hour, minute, second };
}

function parseLegacyTaskArgs(args) {
  if (args.length < 2) {
    throw new UserInputError(TASK_FORMAT);
  }
  let startIndex = 0;
  let loop = false;
  let count = 1;
  const mode = args[0].toLowerCase();
  if (mode === 'loop') {
    loop = true;
    count = null;
    startIndex = 1;
  } else if (/^\d+$/.test(mode)) {
    count = Number(mode);
    if (!Number.isInteger(count) || count < 1) throw new UserInputError('Jumlah pengulangan harus angka positif.');
    startIndex = 1;
  }

  const tail = [...args.slice(startIndex)];
  let dateToken = null;

  if (FULL_DATE.test(tail.at(-1) || '')) {
    dateToken = tail.pop();
  }

  const numbers = [];
  while (tail.length && TIME_NUMBER.test(tail.at(-1))) {
    numbers.unshift(Number(tail.pop()));
  }
  if (!dateToken && numbers.length >= 4) dateToken = String(numbers.pop());
  if (numbers.length < 1 || numbers.length > 3) {
    throw new UserInputError(`${TASK_FORMAT}\n\nLegacy: ,task [count|loop] "<teks>" <jam> [menit] [detik] [tanggal]`);
  }

  const [hour, minute = 0, second = 0] = numbers;
  if (!Number.isInteger(hour) || hour < 0 || hour > 24) throw new UserInputError('Jam harus 00-23, atau 24 untuk format legacy.');
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new UserInputError('Menit harus 0-59.');
  if (!Number.isInteger(second) || second < 0 || second > 59) throw new UserInputError('Detik harus 0-59.');

  const text = tail.join(' ').trim();
  if (!text) throw new UserInputError('Teks task wajib diisi.');
  return { loop, count, text, hour, minute, second, dateToken };
}

export function createTask(sock, message, args) { return withStoreLock(() => createTaskUnlocked(sock, message, args)); }
async function createTaskUnlocked(sock, message, args) {
  const parsed = parseTaskArgs(args);
  const store = await readStore();
  const id = store.nextId++;
  let media = null;
  const downloaded = await downloadQuotedOrOwnMedia(sock, message, `task-${id}`).catch(() => null);
  if (downloaded) {
    const ext = path.extname(downloaded.path) || '.bin';
    const dest = path.join(TASK_MEDIA_DIR, `task-${id}${ext}`);
    await fs.copyFile(downloaded.path, dest);
    await cleanupFiles([downloaded.path]);
    media = {
      path: dest,
      mimetype: downloaded.mimetype,
      fileName: downloaded.fileName || `task-${id}${ext}`,
      type: downloaded.type
    };
  }

  const task = {
    id,
    text: parsed.text,
    loop: parsed.loop,
    remaining: parsed.loop ? null : parsed.count,
    hour: parsed.hour,
    minute: parsed.minute,
    second: parsed.second,
    dateToken: parsed.dateToken,
    nextRunAt: nextRunAt(parsed.hour, parsed.minute, parsed.second, parsed.dateToken),
    paused: false,
    media,
    createdAt: new Date().toISOString()
  };
  store.tasks.push(task);
  await writeStore(store);
  return task;
}

export class TaskRecorder {
  constructor() {
    this.sessions = new Map();
  }

  start(jid, schedule, actorJid = jid, target = null) {
    if (!schedule?.targetInput || !target?.jid) throw new UserInputError('Target task tidak valid.');
    const session = {
      jid,
      actorJid,
      schedule: {
        ...schedule,
        targetJid: target.jid,
        targetName: target.currentName || target.savedName || schedule.targetInput
      },
      entries: [],
      tempFiles: []
    };
    this.sessions.set(jid, session);
    return session;
  }

  has(jid) {
    return this.sessions.has(jid);
  }

  isActor(jid, actorJid) {
    const session = this.sessions.get(jid);
    return !session || !actorJid || session.actorJid === actorJid;
  }

  async record(sock, message) {
    const session = this.sessions.get(message.key.remoteJid);
    if (!session) return null;
    const recorded = await recordMessageEntry(sock, message, 'task-record-item');
    if (!recorded) return null;
    if (recorded.tempFile) session.tempFiles.push(recorded.tempFile);
    session.entries.push(recorded.entry);
    return { type: recorded.type, count: visibleRecordedEntries(session.entries).length };
  }

  finish(jid, actorJid = null) { return withStoreLock(() => this.finishUnlocked(jid, actorJid)); }

  async finishUnlocked(jid, actorJid = null) {
    const session = this.sessions.get(jid);
    if (!session || (actorJid && session.actorJid !== actorJid)) return null;
    if (!visibleRecordedEntries(session.entries).length) throw new UserInputError('Belum ada pesan yang direkam.');
    const store = await readStore();
    const id = store.nextId++;
    const dir = path.join(TASK_MEDIA_DIR, `task-${id}`);
    const entries = await persistRecordedEntries(session.entries, dir);
    const task = {
      id,
      text: `Rekaman ${visibleRecordedEntries(entries).length} pesan`,
      entries,
      targetJid: session.schedule.targetJid,
      targetName: session.schedule.targetName,
      loop: session.schedule.loop,
      remaining: session.schedule.loop ? null : session.schedule.count,
      hour: session.schedule.hour,
      minute: session.schedule.minute,
      second: session.schedule.second,
      dateToken: session.schedule.dateToken,
      intervalMs: session.schedule.intervalMs || null,
      nextRunAt: session.schedule.hour == null
        ? new Date(Date.now() + session.schedule.intervalMs).toISOString()
        : nextRunAt(session.schedule.hour, session.schedule.minute, session.schedule.second, session.schedule.dateToken),
      paused: false,
      media: null,
      createdAt: new Date().toISOString()
    };
    store.tasks.push(task);
    await writeStore(store);
    this.sessions.delete(jid);
    await cleanupRecordedTempEntries(session.entries);
    return task;
  }

  async cancel(jid, actorJid = null) {
    const session = this.sessions.get(jid);
    if (!session || (actorJid && session.actorJid !== actorJid)) return false;
    this.sessions.delete(jid);
    await cleanupRecordedTempEntries(session.entries);
    return true;
  }
}

export async function listTasks() {
  const store = await readStore();
  return store.tasks;
}

export function updateTaskState(action, id) { return withStoreLock(() => updateTaskStateUnlocked(action, id)); }
async function updateTaskStateUnlocked(action, id) {
  const store = await readStore();
  const task = store.tasks.find((item) => item.id === id);
  if (!task) throw new UserInputError(`Task ID ${id} tidak ditemukan.`);
  if (action === 'del') {
    store.tasks = store.tasks.filter((item) => item.id !== id);

    await writeStore(store);
    await cleanupTaskFiles(task);
    return { deleted: true, task };
  }
  if (action === 'resume' || action === 'true') { task.paused = false; task.deliveryState = null; task.failure = null; }
  else if (action === 'pause' || action === 'false') task.paused = true;
  else throw new UserInputError('Format: ,task pause|resume|del <id>. Legacy ,ltask true|false|del <id> tetap didukung.');
  await writeStore(store);
  return { deleted: false, task };
}

async function cleanupTaskFiles(task) {
  if (task.media?.path) await cleanupFiles([task.media.path]);
  const entryPaths = (task.entries || []).filter((entry) => entry.kind === 'media').map((entry) => entry.path);
  if (entryPaths.length) {
    await cleanupFiles(entryPaths);
    await fs.rm(path.dirname(entryPaths[0]), { recursive: true, force: true }).catch(() => {});
  }
}

function taskMessage(task) {
  const left = task.loop ? 'loop' : `${task.remaining}x tersisa`;
  const state = task.paused ? 'paused' : 'aktif';
  const next = formatWib(task.nextRunAt);
  const target = task.targetJid ? `\nTarget: ${task.targetName || task.targetJid.split('@')[0]}` : '';
  const interval = task.intervalMs ? `\nInterval: ${task.intervalMs / 1000} detik` : '';
  const failure = task.failure ? '\nPengiriman perlu diperiksa; resume melanjutkan item yang belum terkonfirmasi.' : '';
  const count = task.entries ? ` (${visibleRecordedEntries(task.entries).length} pesan)` : '';
  return `#${task.id} [${state}] ${task.text}${count}${target}\n${left}, berikutnya: ${next}${interval}${failure}`;
}

export function formatTaskList(tasks) {
  if (!tasks.length) return 'Belum ada task.';
  return tasks.map(taskMessage).join('\n\n');
}

async function sendTask(sock, jid, task) {
  if (task.entries) {
    await sendRecordedEntries(sock, jid, task.entries);
    return;
  }
  if (task.media?.path) {
    const buffer = await fs.readFile(task.media.path);
    if (task.media.type === 'imageMessage') {
      await sock.sendMessage(jid, { image: buffer, caption: task.text });
      return;
    }
    if (task.media.type === 'videoMessage') {
      await sock.sendMessage(jid, { video: buffer, caption: task.text, mimetype: task.media.mimetype });
      return;
    }
    await sock.sendMessage(jid, {
      document: buffer,
      mimetype: task.media.mimetype || 'application/octet-stream',
      fileName: task.media.fileName || `task-${task.id}`,
      caption: task.text
    });
    return;
  }
  await sock.sendMessage(jid, { text: `Reminder: ${task.text}` });
}

export class TaskScheduler {
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
      this.logger.error('Task scheduler error', { error: error.message });
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
    try { await withStoreLock(async () => {
      const store = await readStore();
      for (const task of [...store.tasks]) {
        if (task.paused) continue;
        if (task.deliveryState === 'sending') {
          task.paused = true;
          task.failure = 'Hasil pengiriman sebelum restart belum pasti.';
          await writeStore(store);
          await this.logger.error('Task delivery uncertain after restart', { taskId: task.id, error: task.failure });
          continue;
        }
        if (new Date(task.nextRunAt).getTime() > Date.now()) continue;
        const targets = task.targetJid ? [task.targetJid] : TASK_TARGET_NAMES.map((name) => this.chatDirectory.findByName(name)).filter(Boolean);
        if (!targets.length) {
          task.paused = true; task.failure = 'Tujuan task belum tersedia.';
          await writeStore(store);
          await this.logger.error('Task target unavailable', { taskId: task.id, error: task.failure });
          continue;
        }
        try {
          // Persist a checkpoint before every outgoing item. Ambiguous failures pause for review.
          const entries = task.entries ? visibleRecordedEntries(task.entries) : [null];
          const total = targets.length * entries.length;
          for (let cursor = task.deliveryCursor || 0; cursor < total; cursor++) {
            task.deliveryState = 'sending'; task.deliveryCursor = cursor;
            await writeStore(store);
            const jid = targets[Math.floor(cursor / entries.length)];
            if (task.entries) await sendRecordedEntries(this.sock, jid, [entries[cursor % entries.length]]);
            else await sendTask(this.sock, jid, task);
            task.deliveryCursor = cursor + 1; task.deliveryState = 'ready';
            await writeStore(store);
          }
          if (!task.loop) task.remaining -= 1;
          task.deliveryCursor = 0; task.deliveryState = null; task.failure = null;
          if (!task.loop && task.remaining <= 0) {
            store.tasks = store.tasks.filter((item) => item.id !== task.id);
            await writeStore(store);
            await cleanupTaskFiles(task);
          } else {
            if (task.intervalMs) task.nextRunAt = new Date(Date.now() + task.intervalMs).toISOString();
            else {
              do { task.nextRunAt = nextDailyRun(task.nextRunAt, task.hour, task.minute, task.second ?? 0); }
              while (new Date(task.nextRunAt).getTime() <= Date.now());
            }
            await writeStore(store);
          }
        } catch (error) {
          task.paused = true; task.failure = error.message;
          await writeStore(store);
          await this.logger.error('Task delivery paused', { taskId: task.id, error: error.message });
        }
      }
    }); } finally { this.running = false; }
  }
}
