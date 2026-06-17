import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
  areJidsSameUser,
  DisconnectReason,
  fetchLatestBaileysVersion,
  getKeyAuthor,
  generateWAMessageFromContent,
  jidNormalizedUser,
  proto,
  WAMessageStubType,
  useMultiFileAuthState
} from 'baileys';
import {
  AUTH_DIR,
  ANTICALL_FILE,
  BOT_STATE_FILE,
  BOT_NAME,
  COMMAND_PREFIX,
  DEFAULT_STICKER_AUTHOR,
  DEFAULT_STICKER_TITLE,
  LINKS_FILE,
  LOG_DIR,
  NOTES_FILE,
  PDF_DEFAULT_FILE_NAME,
  PRIMARY_TARGET_NAME,
  REMINDERS_FILE,
  ROOT_DIR,
  TASKS_FILE,
  LINUX_SUDO_PASSWORD,
  UPDATE_BRANCH,
  UPDATE_REMOTE,
  UPDATE_RESTART_MODE,
  UPDATE_SYSTEMD_SERVICE,
  WORKER_LOG_DIR,
  WOL_FILE,
  cleanupStartupTemp,
  ensureRuntimeDirs
} from './config.js';
import { cleanupOldLogs, logger } from './logger.js';
import { detectTools, fileExists, formatBytes, formatDuration, getDiskInfo, getLoadAverageText, runTool, runToolWithInput } from './tools.js';
import { getMessageText, parseCommand } from './text.js';
import {
  cleanupFiles,
  downloadMessageMedia,
  downloadQuotedOrOwnMedia,
  downloadUrlMedia,
  isPdfFile,
  isViewOnceMediaMessage,
  mediaNode,
  quotedMediaNode
} from './media.js';
import { makeSmemeSticker, makeSticker, parseSmemeArgs, parseStickerMeta, reverseSticker } from './sticker.js';
import { TaskScheduler, createTask, formatTaskList, formatWib, listTasks, updateTaskState } from './tasks.js';
import { PdfSessions, parsePdfOrderText, parsePdfStartArgs } from './pdf.js';
import { pdfToImages } from './pdfImages.js';
import {
  SaveRecorder,
  assertSavedTitleAvailable,
  deleteSaved,
  formatSavedList,
  getSaved,
  listSaved,
  parseSaveStart,
  renameSaved,
  sendSaved
} from './saved.js';
import { handleLinkCommand, handleNoteCommand, listLinks, listNotes } from './notes.js';
import { ReminderScheduler, createReminder, formatCountdown, listReminders } from './reminders.js';
import { handleWolCommand, listWol } from './wol.js';
import { DailyBackupScheduler, sendDataBackupToWhatsApp } from './backup.js';
import { RestoreSessions } from './restore.js';
import { PendingConfirmStore, parseSecretMediaTriggerText } from './confirm.js';
import { CommandAccessStore, PUBLIC_COMMANDS, parseAllowArgs } from './commandAccess.js';
import { BotStateStore } from './botState.js';
import { ReactionActionStore, reactionIntent } from './reactionActions.js';
import { RuntimeConfigStore, configKeyList, formatConfigValue } from './runtimeConfig.js';
import {
  ChangedMessageStore,
  messageIndexKey,
  messageTypeName,
  summarizeMessage,
  timestampMs,
  truncateText
} from './changedMessages.js';
import {
  displayPhoneFromJid,
  normalizePhoneToJid as normalizePhoneToWhatsAppJid,
  sameJid,
  tryNormalizeJid,
  tryNormalizePhoneToJid as tryNormalizePhoneToWhatsAppJid
} from './phone.js';
import { AnticallStore, formatAnticallStatus } from './anticall.js';
import { MultiAccountStore, accountAuthPath, accountWaLink } from './multiAccount.js';
import {
  WorkerLogStore,
  createWorkerLogEntry,
  formatWorkerConfig,
  formatWorkerLogHeader,
  waLink as workerWaLink
} from './workerLogs.js';

class ChatDirectory {
  constructor() {
    this.byName = new Map();
    this.byJid = new Map();
  }

  remember(jid, name) {
    if (!jid) return;
    const cleanJid = String(jid).trim();
    const old = this.byJid.get(cleanJid);
    const cleanName = String(name || old?.name || '').trim();
    if (name && old?.name && normalizeLookupText(old.name) !== normalizeLookupText(name)) {
      this.byName.get(normalizeLookupText(old.name))?.delete(cleanJid);
    }
    this.byJid.set(cleanJid, {
      jid: cleanJid,
      name: cleanName,
      updatedAt: new Date().toISOString()
    });
    if (!name) return;
    const nameKey = normalizeLookupText(name);
    if (!nameKey) return;
    if (!this.byName.has(nameKey)) this.byName.set(nameKey, new Set());
    this.byName.get(nameKey).add(cleanJid);
  }

  findByName(name) {
    return this.resolveOne(name)?.jid || null;
  }

  resolveOne(query) {
    const result = this.resolve(query);
    return result.ok ? result.item : null;
  }

  resolve(query) {
    const text = String(query || '').trim();
    if (!text) return { ok: false, reason: 'empty', candidates: [] };
    if (this.byJid.has(text)) return { ok: true, item: this.describe(text, text) };
    const normalizedJid = tryNormalizeJid(text);
    if (normalizedJid && this.byJid.has(normalizedJid)) return { ok: true, item: this.describe(normalizedJid, text) };
    if (normalizedJid && (normalizedJid.endsWith('@g.us') || normalizedJid.endsWith('@s.whatsapp.net'))) {
      return { ok: true, item: this.describe(normalizedJid, text) };
    }
    const phoneJid = tryNormalizePhoneToJid(text);
    if (phoneJid) return { ok: true, item: this.describe(phoneJid, text) };

    const normalized = normalizeLookupText(text);
    const exact = [...(this.byName.get(normalized) || [])];
    if (exact.length === 1) return { ok: true, item: this.describe(exact[0], text) };
    if (exact.length > 1) return { ok: false, reason: 'ambiguous', candidates: exact.map((jid) => this.describe(jid, text)) };
    const matches = [...this.byName.entries()]
      .filter(([key]) => key.includes(normalized))
      .flatMap(([, jids]) => [...jids]);
    const unique = [...new Set(matches)];
    if (unique.length === 1) return { ok: true, item: this.describe(unique[0], text) };
    if (unique.length > 1) return { ok: false, reason: 'ambiguous', candidates: unique.map((jid) => this.describe(jid, text)) };
    return { ok: false, reason: 'not_found', candidates: [] };
  }

  describe(jid, input = '') {
    const cleanJid = String(jid || '').trim();
    const item = this.byJid.get(cleanJid) || {};
    return {
      jid: cleanJid,
      savedName: item.name || input || cleanJid,
      currentName: item.name || '',
      input,
      type: cleanJid.endsWith('@g.us') ? 'group' : 'user'
    };
  }

  nameFor(jid) {
    return this.byJid.get(String(jid || '').trim())?.name || '';
  }

  groupDuplicates() {
    return [...this.byName.entries()]
      .map(([key, jids]) => ({
        key,
        jids: [...jids].filter((jid) => jid.endsWith('@g.us'))
      }))
      .filter((item) => item.jids.length > 1)
      .map((item) => ({
        name: this.byJid.get(item.jids[0])?.name || item.key,
        jids: item.jids
      }));
  }

  hasJid(jid) {
    return this.byJid.has(String(jid || '').trim());
  }
}

class ViewOnceCache {
  constructor({ maxPerTarget = 20, ttlMs = 24 * 60 * 60 * 1000 } = {}) {
    this.maxPerTarget = maxPerTarget;
    this.ttlMs = ttlMs;
    this.byTarget = new Map();
  }

  remember(message) {
    if (!isViewOnceMediaMessage(message)) return;
    const now = Date.now();
    const targets = [message.key?.remoteJid, message.key?.participant].filter(Boolean);
    for (const target of targets) {
      const entries = this.pruned(target, now);
      entries.unshift({ message, seenAt: now });
      this.byTarget.set(target, entries.slice(0, this.maxPerTarget));
    }
  }

  latest(target) {
    return this.pruned(target, Date.now())[0]?.message || null;
  }

  pruned(target, now) {
    const entries = this.byTarget.get(target) || [];
    const fresh = entries.filter((entry) => now - entry.seenAt <= this.ttlMs);
    if (fresh.length) this.byTarget.set(target, fresh);
    else this.byTarget.delete(target);
    return fresh;
  }
}

const state = {
  sock: null,
  tools: null,
  chatDirectory: new ChatDirectory(),
  viewOnceCache: new ViewOnceCache(),
  scheduler: null,
  reminderScheduler: null,
  pdfSessions: null,
  restoreSessions: null,
  saveRecorder: null,
  backupScheduler: null,
  confirmStore: new PendingConfirmStore(),
  reactionActions: new ReactionActionStore(),
  runtimeConfig: null,
  changedMessages: null,
  multiAccount: null,
  workerLogs: null,
  accountRuntimes: new Map(),
  controlSessions: new Map(),
  activePairing: null,
  commandOutputMode: null,
  commandAccess: null,
  botState: null,
  anticall: null,
  rejectedCallIds: new Set(),
  ignoredOwnMessageIds: new Set(),
  reconnecting: false
};

function normalizeLookupText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function shouldReconnect(lastDisconnect) {
  const statusCode = lastDisconnect?.error?.output?.statusCode;
  return statusCode !== DisconnectReason.loggedOut;
}

function ownUserJid(runtime = primaryRuntime()) {
  const sock = runtime?.sock || state.sock;
  const raw = sock?.user?.id || sock?.authState?.creds?.me?.id || runtime?.account?.jid || '';
  return raw ? jidNormalizedUser(raw) : 'me';
}

function messageActorJid(message) {
  const runtime = messageRuntime(message);
  if (message?.key?.fromMe) return ownUserJid(runtime);
  const raw = getKeyAuthor(message?.key, ownUserJid(runtime));
  return raw ? jidNormalizedUser(raw) : '';
}

function reactionActorJid(update, runtime = primaryRuntime()) {
  const raw = getKeyAuthor(update?.reaction?.key, ownUserJid(runtime));
  return raw ? jidNormalizedUser(raw) : '';
}

function sameActor(left, right) {
  if (!left || !right) return false;
  return left === right || areJidsSameUser(left, right) || sameJid(left, right);
}

function commandContext(message) {
  const actorJid = messageActorJid(message);
  const isOwner = isSuperAdminContext(message, actorJid);
  const isAdmin = !isOwner && state.commandAccess?.isAdmin(actorJid);
  return {
    actorJid,
    isOwner,
    isAdmin,
    publicOpen: state.commandAccess?.isOpen(message.key.remoteJid) || false
  };
}

function isSuperAdminContext(message, actorJid = messageActorJid(message)) {
  if (state.multiAccount?.isMulti?.()) return state.multiAccount.isSuperAdmin(actorJid);
  return Boolean(message?.key?.fromMe);
}

function primaryRuntime() {
  return state.accountRuntimes.get(1) || null;
}

function trustRuntime() {
  const trust = state.multiAccount?.getTrust?.();
  if (!trust) return null;
  const runtime = state.accountRuntimes.get(trust.id);
  return runtime?.status === 'connected' && runtime.sock ? runtime : null;
}

function messageRuntime(message) {
  return message?.__runtime || primaryRuntime();
}

function messageSock(message) {
  return messageRuntime(message)?.sock || state.sock;
}

function attachRuntime(message, runtime) {
  if (message && runtime) {
    Object.defineProperty(message, '__runtime', {
      value: runtime,
      enumerable: false,
      configurable: true
    });
  }
  return message;
}

function isBotEnabled() {
  return state.botState?.isEnabled?.() !== false;
}

function applyBotRuntimeState() {
  if (!isBotEnabled()) {
    state.scheduler?.stop();
    state.reminderScheduler?.stop();
    state.backupScheduler?.stop();
    return;
  }
  if (state.sock) {
    state.scheduler?.start();
    state.reminderScheduler?.start();
  }
  state.backupScheduler?.start();
}

async function sendText(jid, text) {
  return sendBotMessage(jid, { text });
}

async function editText(jid, messageKey, text) {
  if (!messageKey) return sendText(jid, text);
  return sendBotMessage(jid, { text, edit: messageKey });
}

async function sendBotMessage(jid, content, options) {
  const runtime = selectOutputRuntime(content, options);
  const sent = await runtime.sock.sendMessage(jid, content, options);
  rememberOwnOutput(sent, runtime);
  return sent;
}

function selectOutputRuntime(content = {}, options = {}) {
  if (options?.forcePrimary || content?.edit) return primaryRuntime() || { sock: state.sock, ignoredOwnMessageIds: state.ignoredOwnMessageIds };
  if (state.commandOutputMode === 'trust') {
    const trust = trustRuntime();
    if (trust) return trust;
  }
  return primaryRuntime() || { sock: state.sock, ignoredOwnMessageIds: state.ignoredOwnMessageIds };
}

function rememberOwnOutput(message, runtime = primaryRuntime()) {
  const id = message?.key?.id;
  if (!id) return;
  const ignored = runtime?.ignoredOwnMessageIds || state.ignoredOwnMessageIds;
  ignored.add(id);
  setTimeout(() => ignored.delete(id), 5 * 60 * 1000).unref?.();
}

function botSender() {
  return {
    sendMessage: (jid, content, options) => sendBotMessage(jid, content, options)
  };
}

function primaryBotSender() {
  return {
    sendMessage: (jid, content, options = {}) => sendBotMessage(jid, content, { ...options, forcePrimary: true })
  };
}

function isIgnoredOwnOutput(message, runtime = primaryRuntime()) {
  const id = message?.key?.id;
  const ignored = runtime?.ignoredOwnMessageIds || state.ignoredOwnMessageIds;
  if (!id || !ignored.has(id)) return false;
  ignored.delete(id);
  return true;
}

const HELP_SECTIONS = [
  {
    title: 'Media',
    items: [
      { name: 's', text: ',s        Buat stiker dari gambar/video' },
      { name: 'smeme', text: ',smeme    Buat stiker meme dari gambar' },
      { name: 'resend', text: ',resend   Kirim ulang media/view-once' },
      { name: 'topdf', text: ',topdf    Gabung gambar/dokumen jadi PDF' },
      { name: 'toimg', text: ',toimg    Ubah PDF jadi gambar' }
    ]
  },
  {
    title: 'Catatan',
    items: [
      { name: 'note', text: ',note     Kelola note' },
      { name: 'link', text: ',link     Kelola link' },
      { name: 'save', text: ',save     Simpan pesan/media' },
      { name: 'load', text: ',load     Kirim ulang save' }
    ]
  },
  {
    title: 'Reminder',
    items: [
      { name: 'remindme', text: ',remindme Reminder cepat' },
      { name: 'task', text: ',task     Kelola task terjadwal' }
    ]
  },
  {
    title: 'Server',
    items: [
      { name: 'status', text: ',status   Status server' },
      { name: 'net', text: ',net      Cek koneksi' },
      { name: 'log', text: ',log      Lihat log terbaru' },
      { name: 'wol', text: ',wol      Wake-on-LAN' },
      { name: 'health', text: ',health   Status teknis bot' },
      { name: 'info', text: ',info     Cek info WhatsApp' }
    ]
  },
  {
    title: 'Admin',
    items: [
      { name: 'bot', text: ',bot      On/off bot' },
      { name: 'allow', text: ',allow    Atur akses chat' },
      { name: 'admin', text: ',admin    Atur admin' },
      { name: 'config', text: ',config   Atur config' },
      { name: 'backup', text: ',backup   Backup data' },
      { name: 'restore', text: ',restore  Restore data' },
      { name: 'update', text: ',update   Update bot' },
      { name: 'restartbot', text: ',restartbot Restart bot' },
      { name: 'jadibot', text: ',jadibot  Kelola multi akun' },
      { name: 'anticall', text: ',anticall Kelola anti-call' },
      { name: 'changedmsg', text: ',changedmsg Pantau pesan edit/hapus' },
      { name: 'clear', text: ',clear    Bersihkan temp' },
      { name: 'button', text: ',button   Tes tombol command' }
    ]
  },
  {
    title: 'Session',
    items: [
      { name: 'end', text: ',end      Selesai sesi aktif' },
      { name: 'cancel', text: ',cancel   Batalkan sesi' },
      { name: 'confirm', text: ',confirm  Konfirmasi aksi' }
    ]
  }
];

const HELP_ALIASES = {
  rs: 'resend',
  won: 'wol',
  ltask: 'task'
};

const HELP_DETAILS = {
  help: ['Format: ,help [page|command]', 'Contoh: ,help 1, ,help 2, ,help s, ,help task.'],
  s: ['Format: ,s', 'Format: ,s <title>', 'Format: ,s <title>,<author>', 'Kirim/reply media atau sertakan URL media.'],
  smeme: ['Format: ,smeme up <teks>', 'Format: ,smeme down <teks>', 'Advanced: tambah kualitas 1-99 di akhir.'],
  resend: ['Format: ,resend', 'Legacy: ,rs', 'Reply media/view-once. Sticker statis dikirim sebagai PNG, sticker bergerak sebagai GIF.'],
  status: ['Format: ,status atau ,status bot', ',status menampilkan server ringkas. ,status bot menampilkan destination, scheduler, changedmsg, multi akun, dan warning nama grup duplikat.'],
  topdf: ['Format: ,topdf', 'Format: ,topdf <nama>', 'Format: ,topdf split <nama>', 'Format: ,topdf <nama> max <size>', 'Format: ,topdf split <nama> max <size>', 'Legacy: ,topdf nama,1MB tetap didukung.', 'Kirim/reply media setelah sesi dimulai. Selesai pakai ,end. Batal pakai ,cancel.'],
  toimg: ['Format: ,toimg', 'Reply/kirim dokumen PDF, lalu bot mengirim tiap halaman sebagai gambar.'],
  note: ['Format: ,note list', 'Format: ,note add <judul> <teks>', 'Format: ,note get <id|judul>', 'Format: ,note del <id|judul>', 'Format: ,note rename <id|judul> <judul-baru>', 'Legacy: ,note <judul> <teks> dan ,note change tetap didukung.'],
  link: ['Format: ,link list', 'Format: ,link add <nama> <https://link>', 'Format: ,link get <id|nama>', 'Format: ,link del <id|nama>', 'Format: ,link rename <id|nama> <nama-baru>', 'Legacy: ,link <nama> <url> dan ,link change tetap didukung.'],
  save: ['Format: ,save <judul> [teks awal]', 'Mulai rekam teks/media sampai ,end atau ,cancel.'],
  load: ['Format: ,load', 'Format: ,load <id|judul>', 'Format: ,load del <id|judul>', 'Format: ,load change <id|judul> <judul-baru>'],
  remindme: ['Format: ,remindme <teks> <durasi>', 'Unit: s = detik, m = menit, h = jam, d = hari.', 'Contoh: ,remindme cek server 1h30m'],
  task: ['Format: ,task list', 'Format: ,task add <teks> at <HH:MM>', 'Format: ,task add <teks> at <HH:MM> <DD/MM/YYYY>', 'Format: ,task loop <teks> at <HH:MM>', 'Format: ,task repeat <jumlah> <teks> at <HH:MM>', 'Format: ,task pause <id>', 'Format: ,task resume <id>', 'Format: ,task del <id>', 'Legacy: ,ltask true|false|del <id> tetap didukung.'],
  wol: ['Format: ,wol list', 'Format: ,wol add <mac>', 'Format: ,wol wake <id|mac>', 'Format: ,wol del <id|mac>', 'Legacy: ,won, ,won save <mac>, ,won <id|mac>, dan ,won del <id|mac> tetap didukung.'],
  log: ['Format: ,log [baris]', 'Default 30 baris, maksimal 80 baris.'],
  net: ['Format: ,net', 'Cek IP publik, DNS, HTTP latency, IP lokal, dan estimasi download kecil.'],
  health: ['Format: ,health', 'Status teknis proses, tool, data count, scheduler, dan runtime file.'],
  info: ['Format: ,info <nomor>', 'Contoh: ,info 08123431212'],
  changedmsg: ['Format: ,changedmsg list|allow|del <id|nama-grup|jid>', 'DM dipantau default. Grup harus di-allow. Nama grup duplikat ditolak; pakai JID agar aman.'],
  config: ['Format: ,config, ,config get <key>, ,config set <key> <value>', 'Destination key menerima nama grup, JID, atau nomor. Grup disimpan sebagai JID + nama.'],
  backup: ['Format: ,backup', 'Backup data/ dikirim sebagai dokumen WhatsApp ke dest.backup. Ubah tujuan dengan ,config set dest.backup <group|nomor>.'],
  restore: ['Format: ,restore', 'Mulai sesi restore ZIP lewat WhatsApp. Kirim part ZIP, lalu ,end dan ,confirm.'],
  anticall: ['Format: ,anticall', 'Format: ,anticall new|on|off', 'Format: ,anticall except list|add|del <nomor|id>'],
  jadibot: ['Format: ,jadibot', 'Format: ,jadibot new', 'Format: ,jadibot del <ID>', 'Format: ,jadibot set <ID> trust|worker', 'Format: ,jadibot control <ID>'],
  allow: ['Format: ,allow here on|off', 'Format: ,allow all on|off', 'Legacy true|false tetap didukung.'],
  admin: ['Format: ,admin list', 'Format: ,admin add <nomor>', 'Format: ,admin del <nomor|id>'],
  bot: ['Format: ,bot, ,bot on, ,bot off', ',bot off mem-pause command, session, scheduler, backup otomatis, changedmsg, worker log, dan anticall.'],
  update: ['Format: ,update', 'Menjalankan git pull dan restart service dengan konfirmasi.'],
  restartbot: ['Format: ,restartbot', 'Keluar dari proses bot dengan konfirmasi agar supervisor bisa menyalakan ulang.'],
  clear: ['Format: ,clear', 'Membersihkan temp/ dengan konfirmasi.'],
  button: ['Format: ,button <pesan>', 'Tes tombol interaktif.'],
  end: ['Format: ,end', 'Selesaikan sesi aktif seperti save, PDF, anticall, atau restore.'],
  cancel: ['Format: ,cancel', 'Batalkan sesi aktif atau konfirmasi pending.'],
  confirm: ['Format: ,confirm', 'Jalankan aksi yang sedang menunggu konfirmasi.']
};

async function handleHelp(jid, command, context) {
  let query = command?.rawArgs?.trim() || '';
  if (query.startsWith(COMMAND_PREFIX)) query = query.slice(COMMAND_PREFIX.length).trim();
  query = query.toLowerCase();
  if (query) {
    if (/^\d+$/.test(query)) {
      await sendHelpPage(jid, context, Number(query));
      return;
    }
    await handleHelpDetail(jid, query, context);
    return;
  }
  await sendHelpPage(jid, context, 1);
}

async function sendHelpPage(jid, context, pageNumber = 1) {
  const pages = buildHelpPages(jid, context);
  const total = Math.max(1, pages.length);
  const page = Math.min(Math.max(1, Math.floor(pageNumber) || 1), total);
  const sections = pages[page - 1] || [];
  const lines = [
    `${BOT_NAME} Help ${page}/${total}`,
    '',
    'Pakai:',
    `${COMMAND_PREFIX}help <page|command>`,
    `Contoh: ${COMMAND_PREFIX}help 2 atau ${COMMAND_PREFIX}help task`
  ];
  for (const section of sections) {
    const items = section.items;
    lines.push('', `${section.title}:`, ...items.map((item) => item.text));
  }
  const detailExamples = ['note', 'task', 'topdf'].filter((name) => canShowHelpItem(name, jid, context));
  if (detailExamples.length && page === 1) lines.push('', 'Detail:', ...detailExamples.map((name) => `${COMMAND_PREFIX}help ${name}`));
  if (total > 1) lines.push('', 'React accept untuk next, negative untuk previous.');
  const sent = await sendText(jid, lines.join('\n'));
  if (total > 1) registerHelpPrompt(sent.key, jid, context, page, total);
}

function buildHelpPages(jid, context) {
  const visible = HELP_SECTIONS
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => canShowHelpItem(item.name, jid, context))
    }))
    .filter((section) => section.items.length);
  const admin = visible.filter((section) => section.title === 'Admin');
  const others = visible.filter((section) => section.title !== 'Admin');
  const pages = [];
  for (let index = 0; index < others.length; index += 2) pages.push(others.slice(index, index + 2));
  if (admin.length) pages.push(admin);
  return pages.length ? pages : [[{ title: 'Command', items: [{ name: 'help', text: ',help     Tampilkan bantuan' }] }]];
}

function registerHelpPrompt(messageKey, jid, context, page, total) {
  const actorJid = context?.actorJid;
  const contextSnapshot = {
    actorJid,
    isOwner: Boolean(context?.isOwner),
    isAdmin: Boolean(context?.isAdmin),
    publicOpen: Boolean(context?.publicOpen)
  };
  state.reactionActions.register(messageKey, {
    actorJid,
    scope: `help:${jid}:${actorJid}`,
    ttlMs: 5 * 60 * 1000,
    onConfirm: async () => sendHelpPage(jid, contextSnapshot, page >= total ? 1 : page + 1),
    onCancel: async () => sendHelpPage(jid, contextSnapshot, page <= 1 ? total : page - 1)
  });
}

async function handleHelpDetail(jid, query, context) {
  const allNames = [...new Set([
    ...HELP_SECTIONS.flatMap((section) => section.items.map((item) => item.name)),
    ...Object.keys(HELP_DETAILS),
    ...Object.keys(HELP_ALIASES)
  ])];
  const normalizedQuery = HELP_ALIASES[query] || query;
  const exact = allNames.map((name) => HELP_ALIASES[name] || name).find((name) => name === normalizedQuery);
  if (exact) {
    if (!canShowHelpItem(exact, jid, context)) {
      await sendText(jid, `Command ${COMMAND_PREFIX}${exact} tidak tersedia untuk akses kamu.`);
      return;
    }
    const brief = HELP_SECTIONS.flatMap((section) => section.items).filter((item) => item.name === exact).map((item) => item.text);
    const detail = HELP_DETAILS[exact] || brief;
    await sendText(jid, [`Help ${COMMAND_PREFIX}${exact}:`, ...brief, '', ...detail].join('\n'));
    return;
  }
  const matches = allNames
    .map((name) => HELP_ALIASES[name] || name)
    .filter((name) => name.startsWith(normalizedQuery) && canShowHelpItem(name, jid, context))
    .filter((name, index, names) => names.indexOf(name) === index)
    .sort();
  if (!matches.length) {
    await sendText(jid, `Tidak ada help yang cocok untuk "${query}".`);
    return;
  }
  await sendText(jid, [
    `Help cocok untuk "${query}":`,
    ...matches.map((name) => `- ${COMMAND_PREFIX}${name}`)
  ].join('\n'));
}

function canShowHelpItem(commandName, jid, context) {
  return Boolean(state.commandAccess?.canUseAs(commandName, jid, context?.actorJid, { owner: context?.isOwner }));
}

async function handleStatus(jid) {
  const mem = process.memoryUsage();
  const disk = await getDiskInfo(ROOT_DIR);
  const diskText = disk
    ? `${formatBytes(disk.used)} used / ${formatBytes(disk.size)} (${formatBytes(disk.free)} free) on ${disk.source}`
    : 'unavailable';
  await sendText(jid, [
    'Status server:',
    `Bot: ${isBotEnabled() ? 'on' : 'off'}`,
    `Platform: ${process.platform} ${process.arch}`,
    `Hostname: ${os.hostname()}`,
    `Uptime OS: ${formatDuration(os.uptime())}`,
    `Uptime bot: ${formatDuration(process.uptime())}`,
    `Load: ${getLoadAverageText()}`,
    `RAM: ${formatBytes(os.totalmem() - os.freemem())} used / ${formatBytes(os.totalmem())}`,
    `Disk: ${diskText}`,
    `Node: ${process.version}`,
    `Process RAM: RSS ${formatBytes(mem.rss)}, heap ${formatBytes(mem.heapUsed)}/${formatBytes(mem.heapTotal)}`,
    `Time: ${new Date().toLocaleString()}`
  ].join('\n'));
}

async function handleStatusBot(jid) {
  const botState = state.botState?.snapshot() || { enabled: true };
  const access = state.commandAccess?.snapshot() || { all: false, chatCount: 0, adminCount: 0 };
  const changed = state.changedMessages?.snapshot() || { allowedCount: 0, indexCount: 0 };
  const changedSettings = state.runtimeConfig?.changedmsgSettings?.() || { enabled: true };
  const multi = state.multiAccount?.snapshot?.() || { mode: 'single', accounts: [] };
  const warnings = await botStatusWarnings();
  await sendText(jid, [
    `${BOT_NAME} bot status:`,
    `Bot: ${botState.enabled ? 'on' : 'off'}`,
    `Mode akun: ${multi.mode}, akun=${multi.accounts?.length || 1}, trust=${state.multiAccount?.getTrust?.()?.id || '-'}`,
    `Public access: all=${Boolean(access.all)}, chats=${access.chatCount || 0}, admins=${access.adminCount || 0}`,
    `Schedulers: task=${state.scheduler?.isRunning?.() ? 'running' : 'stopped'}, remind=${state.reminderScheduler?.isRunning?.() ? 'running' : 'stopped'}, backup=${state.backupScheduler?.isRunning?.() ? 'running' : 'stopped'}`,
    `Dest logs: ${formatDestinationLine('logs')}`,
    `Dest changedmsg: ${formatDestinationLine('changedmsg')}`,
    `Dest saved: ${formatDestinationLine('saved')}`,
    `Dest backup: ${formatDestinationLine('backup')}`,
    `Dest workerDev: ${formatDestinationLine('workerDev')}`,
    `Dest workerLogs: ${formatDestinationLine('workerLogs')}`,
    `Changedmsg: ${changedSettings.enabled ? 'aktif' : 'nonaktif'}, group allowlist=${changed.allowedCount || 0}, index=${changed.indexCount || 0}`,
    warnings.length ? '' : null,
    warnings.length ? 'Warning:' : null,
    ...warnings.map((warning) => `- ${warning}`)
  ].filter((line) => line != null).join('\n'));
}

async function botStatusWarnings() {
  const warnings = [];
  for (const duplicate of state.chatDirectory.groupDuplicates()) {
    warnings.push(`Nama grup "${duplicate.name}" duplikat: ${duplicate.jids.map(shortJid).join(', ')}`);
  }

  for (const name of ['logs', 'changedmsg', 'saved', 'backup', 'workerDev', 'workerLogs']) {
    try {
      const destination = resolveConfiguredDestination(name);
      if (destination.jid.endsWith('@g.us') && !state.chatDirectory.hasJid(destination.jid)) {
        warnings.push(`Destination ${name} belum ada di cache grup: ${shortJid(destination.jid)}`);
      }
      const currentName = state.chatDirectory.nameFor(destination.jid);
      if (currentName && destination.savedName && currentName !== destination.savedName) {
        warnings.push(`Destination ${name} tersimpan sebagai "${destination.savedName}", nama sekarang "${currentName}".`);
      }
    } catch (error) {
      warnings.push(`Destination ${name} belum valid: ${error.message}`);
    }
  }

  const changedSettings = state.runtimeConfig?.changedmsgSettings?.() || { enabled: false };
  if (changedSettings.enabled) {
    for (const name of ['logs', 'changedmsg']) {
      try {
        resolveConfiguredDestination(name);
      } catch {
        warnings.push(`Changedmsg aktif tapi dest.${name} belum valid.`);
      }
    }
  }
  return [...new Set(warnings)];
}

function activeSessionType(jid) {
  if (state.saveRecorder?.has(jid)) return 'save';
  if (state.anticall?.has(jid)) return 'anticall';
  if (state.pdfSessions?.has(jid)) return 'PDF';
  if (state.restoreSessions?.has(jid)) return 'restore';
  return null;
}

function activeSessionActorMatches(jid, actorJid) {
  if (state.saveRecorder?.has(jid)) return state.saveRecorder.isActor(jid, actorJid);
  if (state.anticall?.has(jid)) return state.anticall.isActor(jid, actorJid);
  if (state.pdfSessions?.has(jid)) return state.pdfSessions.isActor(jid, actorJid);
  if (state.restoreSessions?.has(jid)) return state.restoreSessions.isActor(jid, actorJid);
  return true;
}

function assertNoActiveSession(jid) {
  const active = activeSessionType(jid);
  if (active) throw new Error(`Masih ada sesi ${active} aktif. Selesaikan dengan ,end atau batalkan dengan ,cancel.`);
}

function hasAnyTempSession() {
  return Boolean(
    state.saveRecorder?.sessions?.size
    || state.anticall?.sessions?.size
    || state.pdfSessions?.count()
    || state.restoreSessions?.count()
  );
}

async function requestConfirmation(jid, actorOrAction, maybeAction = null) {
  const actorJid = maybeAction ? actorOrAction : jid;
  const action = maybeAction || actorOrAction;
  state.confirmStore.set(jid, actorJid, action);
  const sent = await sendText(jid, [
    `Konfirmasi diperlukan: ${action.title}`,
    action.description,
    '',
    'Ketik ,confirm untuk lanjut atau ,cancel untuk batal. Bisa juga reaction ✅/👍/❤️ untuk confirm atau ❌/👎/❎ untuk cancel.'
  ].filter(Boolean).join('\n'));
  registerConfirmationPrompt(sent.key, jid, actorJid);
}

function registerConfirmationPrompt(messageKey, jid, actorJid) {
  state.reactionActions.register(messageKey, {
    actorJid,
    scope: `confirm:${jid}:${actorJid}`,
    onConfirm: async () => handleConfirm(jid, actorJid),
    onCancel: async () => {
      if (state.confirmStore.cancel(jid, actorJid)) await sendText(jid, 'Konfirmasi dibatalkan.');
    }
  });
}

async function handleConfirm(jid, actorJid = jid) {
  const action = state.confirmStore.take(jid, actorJid);
  if (!action) {
    await sendText(jid, 'Tidak ada aksi yang menunggu konfirmasi, atau waktunya sudah habis.');
    return;
  }
  await sendText(jid, `Menjalankan: ${action.title}`);
  await action.execute();
}

function registerSessionPrompt(messageKey, jid, actorJid) {
  state.reactionActions.register(messageKey, {
    actorJid,
    scope: `session:${jid}:${actorJid}`,
    onConfirm: async () => handleEndSession(jid, actorJid),
    onCancel: async () => handleCancelByJid(jid, actorJid)
  });
}

function listScope(kind) {
  return `list:${kind}`;
}

function invalidateListKind(kind) {
  state.reactionActions.clearScope(listScope(kind));
}

async function sendReactionList(jid, actorJid, kind, items, options) {
  invalidateListKind(kind);
  if (!items.length) {
    await sendText(jid, options.emptyText);
    return;
  }
  for (const item of items) {
    const sent = await sendText(jid, `${options.formatItem(item)}\nReact ❌/👎/❎ untuk hapus.`);
    state.reactionActions.register(sent.key, {
      actorJid,
      scope: listScope(kind),
      onCancel: async () => requestConfirmation(jid, actorJid, {
        title: options.deleteTitle(item),
        description: options.deleteDescription || 'Item ini akan dihapus permanen.',
        execute: async () => {
          const text = await options.deleteItem(item);
          invalidateListKind(kind);
          await sendText(jid, text);
        }
      })
    });
  }
}

function resolveDestinationInput(input, actorJid = null, options = {}) {
  const result = state.chatDirectory.resolve(input);
  if (!result.ok) {
    if (result.reason === 'ambiguous') {
      throw new Error([
        `Nama "${input}" cocok ke lebih dari satu chat. Pakai JID salah satu target:`,
        ...result.candidates.map((item) => `- ${item.currentName || item.savedName} (${item.jid})`)
      ].join('\n'));
    }
    throw new Error(`Target "${input}" tidak ditemukan di cache chat bot. Kirim pesan di chat target dulu atau pakai JID/nomor.`);
  }
  if (options.requireGroup && !result.item.jid.endsWith('@g.us')) {
    throw new Error('Target harus grup. Pakai nama grup atau JID grup.');
  }
  return {
    jid: result.item.jid,
    savedName: result.item.currentName || result.item.savedName || input,
    input: String(input || '').trim(),
    type: result.item.type,
    updatedAt: new Date().toISOString(),
    updatedBy: actorJid || null,
    addedBy: actorJid || null
  };
}

function resolveConfiguredDestination(name) {
  const value = state.runtimeConfig?.destination(name);
  if (!value) throw new Error(`Destination ${name} belum diset. Gunakan ,config set dest.${name} <group|nomor>.`);
  if (typeof value === 'object' && value.jid) return value;
  return resolveDestinationInput(String(value || name), null);
}

function destinationJid(name) {
  return resolveConfiguredDestination(name).jid;
}

function formatDestinationLine(name) {
  try {
    const destination = resolveConfiguredDestination(name);
    const currentName = state.chatDirectory.nameFor(destination.jid);
    const renameWarning = currentName && destination.savedName && currentName !== destination.savedName
      ? `, sekarang "${currentName}"`
      : '';
    const knownText = destination.jid.endsWith('@g.us') && !state.chatDirectory.hasJid(destination.jid)
      ? ', warning: JID belum ada di cache'
      : '';
    return `${name}: ${destination.savedName || currentName || destination.jid} (${shortJid(destination.jid)}${renameWarning}${knownText})`;
  } catch (error) {
    return `${name}: belum valid (${error.message})`;
  }
}

function shortJid(jid) {
  const text = String(jid || '');
  if (text.length <= 24) return text;
  return `${text.slice(0, 13)}...${text.slice(-8)}`;
}

function formatStoredChatItem(item) {
  const currentName = state.chatDirectory.nameFor(item.jid);
  const warnings = [];
  if (currentName && item.savedName && currentName !== item.savedName) warnings.push(`nama sekarang "${currentName}"`);
  const duplicate = state.chatDirectory.groupDuplicates()
    .find((group) => group.jids.some((jid) => sameJid(jid, item.jid)));
  if (duplicate) warnings.push('nama grup duplikat');
  return `#${item.id} - ${item.savedName} (${shortJid(item.jid)})${warnings.length ? ` [warning: ${warnings.join(', ')}]` : ''}`;
}

async function hydrateConfiguredDestinations() {
  if (!state.runtimeConfig) return;
  for (const key of ['dest.logs', 'dest.changedmsg', 'dest.saved', 'dest.backup', 'dest.workerDev', 'dest.workerLogs']) {
    const current = state.runtimeConfig.get(key);
    if (!current || typeof current !== 'string') continue;
    const result = state.chatDirectory.resolve(current);
    if (!result.ok) {
      await logger.warn('Destination hydration skipped', {
        key,
        value: current,
        reason: result.reason,
        candidates: result.candidates?.map((item) => item.jid)
      });
      continue;
    }
    await state.runtimeConfig.setDestination(key, {
      ...result.item,
      input: current,
      updatedBy: 'auto'
    });
  }
}

async function handleHealth(jid) {
  const mem = process.memoryUsage();
  const disk = await getDiskInfo(ROOT_DIR);
  const diskText = disk
    ? `${formatBytes(disk.used)} / ${formatBytes(disk.size)} used, ${formatBytes(disk.free)} free (${disk.source})`
    : 'unavailable';
  const [saved, notes, links, reminders, tasks, wolItems] = await Promise.all([
    listSaved(),
    listNotes(),
    listLinks(),
    listReminders(),
    listTasks(),
    listWol()
  ]);
  const targetJid = state.chatDirectory.findByName(PRIMARY_TARGET_NAME);
  const anticall = state.anticall?.snapshot() || { enabled: false, entryCount: 0, hasMessage: false };
  const botState = state.botState?.snapshot() || { enabled: true };
  const access = state.commandAccess?.snapshot() || { all: false, chatCount: 0, adminCount: 0 };
  await sendText(jid, [
    `${BOT_NAME} health`,
    `Bot: ${botState.enabled ? 'on' : 'off'}`,
    `PID: ${process.pid}`,
    `Platform: ${process.platform} ${process.arch}`,
    `Node: ${process.version}`,
    `Uptime bot: ${formatDuration(process.uptime())}`,
    `Uptime OS: ${formatDuration(os.uptime())}`,
    `Load: ${getLoadAverageText()}`,
    `Memory RSS: ${formatBytes(mem.rss)}`,
    `Memory heap: ${formatBytes(mem.heapUsed)} / ${formatBytes(mem.heapTotal)}`,
    `External: ${formatBytes(mem.external)}`,
    `Disk: ${diskText}`,
    `Tools: ffmpeg=${Boolean(state.tools.ffmpeg)}, ffprobe=${Boolean(state.tools.ffprobe)}, office=${Boolean(state.tools.office)}, pdftoppm=${Boolean(state.tools.pdftoppm)}, magick=${Boolean(state.tools.magick)}`,
    `Data counts: save=${saved.length}, note=${notes.length}, link=${links.length}, task=${tasks.length}, remind=${reminders.length}, wol=${wolItems.length}`,
    `Sessions: save=${state.saveRecorder?.sessions?.size || 0}, anticall=${state.anticall?.sessions?.size || 0}, pdf=${state.pdfSessions?.count() || 0}, restore=${state.restoreSessions?.count() || 0}, confirm=${state.confirmStore.count()}`,
    `Anticall: ${anticall.enabled ? 'aktif' : 'nonaktif'}, pesan=${anticall.hasMessage ? `${anticall.entryCount} item` : 'belum ada'}, exception=${anticall.exceptionCount || 0}`,
    `Public command access: all=${Boolean(access.all)}, chats=${access.chatCount || 0}, admins=${access.adminCount || 0}`,
    `Schedulers: task=${state.scheduler?.isRunning?.() ? 'running' : 'stopped'}, remind=${state.reminderScheduler?.isRunning?.() ? 'running' : 'stopped'}, backup=${state.backupScheduler?.isRunning?.() ? 'running' : 'stopped'}`,
    `Target ${PRIMARY_TARGET_NAME}: ${targetJid || 'not found'}`,
    `Backup part size: ${formatBytes(state.runtimeConfig?.backupPartSizeBytes?.() || 0)}`,
    `Runtime files: ${[TASKS_FILE, NOTES_FILE, LINKS_FILE, REMINDERS_FILE, WOL_FILE, ANTICALL_FILE, BOT_STATE_FILE].map((file) => path.basename(file)).join(', ')}`,
    `Time: ${new Date().toLocaleString()}`
  ].join('\n'));
}

async function handleSticker(message, command) {
  const jid = message.key.remoteJid;
  const metaText = command.args.filter((arg) => !/^https?:\/\//i.test(arg)).join(' ');
  const meta = parseStickerMeta(metaText, {
    defaultAuthor: DEFAULT_STICKER_AUTHOR,
    defaultTitle: DEFAULT_STICKER_TITLE
  });
  let media = null;
  try {
    media = await downloadQuotedOrOwnMedia(messageSock(message), message, 'sticker-source');
    if (!media) media = await downloadUrlMedia(command.rawArgs, 'sticker-url');
    if (!media) throw new Error('Kirim/reply media atau sertakan URL media yang valid.');
    const sticker = await makeSticker(media, { author: meta.author, title: meta.title, tools: state.tools });
    await sendBotMessage(jid, { sticker });
  } finally {
    await cleanupFiles([media?.path]);
  }
}

async function handleSmeme(message, command) {
  const jid = message.key.remoteJid;
  const smeme = parseSmemeArgs(command.args);
  let media = null;
  try {
    media = await downloadQuotedOrOwnMedia(messageSock(message), message, 'smeme-source');
    if (!media) throw new Error('Reply image, GIF, video, atau sticker untuk memakai ,smeme.');
    const supportedDocument = media.type === 'documentMessage' && /^(image|video)\//i.test(media.mimetype || '');
    if (!['imageMessage', 'videoMessage', 'stickerMessage'].includes(media.type) && !supportedDocument) {
      throw new Error('Smeme hanya mendukung image, GIF, video, atau sticker.');
    }
    const sticker = await makeSmemeSticker(media, {
      author: DEFAULT_STICKER_AUTHOR,
      title: DEFAULT_STICKER_TITLE,
      tools: state.tools,
      smeme
    });
    await sendBotMessage(jid, { sticker });
  } finally {
    await cleanupFiles([media?.path]);
  }
}

async function handleReverseSticker(message, command) {
  const jid = message.key.remoteJid;
  let media = null;
  try {
    if (command.rawArgs.trim()) throw new Error('Format: reply media/view-once lalu ketik ,resend tanpa parameter. Legacy ,rs tetap didukung.');
    media = await downloadQuotedOrOwnMedia(messageSock(message), message, 'reverse-source');
    if (!media) throw new Error('Reply media/view-once untuk memakai ,resend. Legacy ,rs tetap didukung.');
    if (media.type === 'stickerMessage') {
      await sendReversedSticker(jid, media);
      return;
    }
    await sendDownloadedMedia(jid, media);
  } finally {
    await cleanupFiles([media?.path]);
  }
}

async function handleToImg(message) {
  const jid = message.key.remoteJid;
  let media = null;
  let images = [];
  try {
    media = await downloadQuotedOrOwnMedia(messageSock(message), message, 'toimg-source');
    if (!media) throw new Error('Kirim/reply dokumen PDF untuk memakai ,toimg.');
    if (!isPdfFile(media.path, media.mimetype) && !isPdfFile(media.fileName, media.mimetype)) {
      throw new Error('Untuk sekarang ,toimg hanya mendukung file PDF.');
    }
    await sendText(jid, 'Mengubah PDF menjadi image...');
    images = await pdfToImages(media.path, state.tools);
    if (!images.length) throw new Error('Tidak ada halaman PDF yang berhasil diubah menjadi image.');
    for (const image of images) {
      const buffer = await fs.readFile(image.path);
      await sendBotMessage(jid, {
        image: buffer,
        mimetype: image.mimetype,
        caption: `Halaman ${image.page}`
      });
    }
  } finally {
    const cleanup = new Set([media?.path, ...images.flatMap((image) => image.cleanupPaths || [image.path])].filter(Boolean));
    await cleanupFiles([...cleanup]);
  }
}

async function sendReversedSticker(jid, media) {
  const converted = await reverseSticker(media, state.tools);
  if (converted.mimetype === 'image/png') {
    await sendBotMessage(jid, { image: converted.buffer, mimetype: converted.mimetype });
    return;
  }
  if (converted.gifPlayback) {
    await sendBotMessage(jid, {
      video: converted.buffer,
      mimetype: converted.mimetype,
      gifPlayback: true
    });
    return;
  }
  await sendBotMessage(jid, {
    document: converted.buffer,
    mimetype: converted.mimetype,
    fileName: converted.fileName
  });
}

async function maybeHandleSecretMediaTrigger(message, text) {
  const trigger = parseSecretMediaTriggerText(text);
  if (!trigger) return false;
  const destinationJid = state.chatDirectory.findByName(PRIMARY_TARGET_NAME);
  if (!destinationJid) throw new Error(`Grup target "${PRIMARY_TARGET_NAME}" tidak ditemukan di cache chat bot.`);

  let media = null;
  try {
    media = await downloadQuotedOrOwnMedia(messageSock(message), message, 'secret-media');
    if (!media) return false;
    await sendDownloadedMedia(destinationJid, media, { caption: trigger.caption });
    return true;
  } finally {
    await cleanupFiles([media?.path]);
  }
}

async function sendLatestViewOnce(destinationJid, targetQuery) {
  const targetJid = state.chatDirectory.findByName(targetQuery);
  if (!targetJid) throw new Error(`Target "${targetQuery}" tidak ditemukan di cache chat/kontak bot.`);
  const source = state.viewOnceCache.latest(targetJid);
  if (!source) throw new Error(`Belum ada view-once terbaru dari "${targetQuery}" selama bot aktif.`);

  let media = null;
  try {
    media = await downloadMessageMedia(messageSock(source), source, 'view-once');
    if (!media) throw new Error('View-once ditemukan, tapi medianya tidak bisa dibaca.');
    await sendDownloadedMedia(destinationJid, media);
  } finally {
    await cleanupFiles([media?.path]);
  }
}

async function sendDownloadedMedia(jid, media, options = {}) {
  return sendDownloadedMediaWithSender({
    sendMessage: (targetJid, content, sendOptions) => sendBotMessage(targetJid, content, sendOptions)
  }, jid, media, options);
}

async function sendDownloadedMediaWithSender(sender, jid, media, options = {}) {
  const buffer = await fs.readFile(media.path);
  const caption = options.caption || media.node?.caption || undefined;
  if (media.type === 'imageMessage') {
    return sender.sendMessage(jid, { image: buffer, mimetype: media.mimetype, caption });
  } else if (media.type === 'videoMessage') {
    return sender.sendMessage(jid, { video: buffer, mimetype: media.mimetype, caption });
  } else if (media.type === 'audioMessage') {
    return sender.sendMessage(jid, { audio: buffer, mimetype: media.mimetype });
  } else if (media.type === 'stickerMessage') {
    return sender.sendMessage(jid, { sticker: buffer, isAnimated: media.node?.isAnimated || undefined });
  } else {
    return sender.sendMessage(jid, {
      document: buffer,
      mimetype: media.mimetype || 'application/octet-stream',
      fileName: media.fileName || `view-once-${Date.now()}`,
      caption
    });
  }
}

async function maybeMirrorChangedMessage(message) {
  if (!state.runtimeConfig?.changedmsgSettings?.().enabled) return false;
  if (message.key?.fromMe) return false;
  const jid = message.key?.remoteJid;
  if (!state.changedMessages?.shouldWatchChat(jid)) return false;
  if (isDestinationChat(jid)) return false;

  const logsJid = safeDestinationJid('logs');
  if (!logsJid) return false;
  const summary = summarizeMessage(message);
  const actorJid = messageActorJid(message);
  const metaText = changedMessageMetaText('LOG', message, {
    actorJid,
    type: summary.type,
    text: summary.text
  });

  let logContentMessage = null;
  let media = null;
  try {
    await sendText(logsJid, metaText);
    if (isViewOnceMediaMessage(message)) {
      media = await downloadMessageMedia(messageSock(message), message, 'changed-viewonce');
      if (media) {
        const stat = await fs.stat(media.path).catch(() => null);
        const maxBytes = state.runtimeConfig.changedmsgSettings().maxMediaBytes;
        if (stat?.size && stat.size > maxBytes) {
          await sendText(logsJid, `Media view-once dilewati karena ${formatBytes(stat.size)} melebihi batas ${formatBytes(maxBytes)}.`);
        } else {
          logContentMessage = await sendDownloadedMedia(logsJid, media, { caption: media.node?.caption });
        }
      }
    } else {
      logContentMessage = await sendBotMessage(logsJid, { forward: message, force: true });
    }
  } catch (error) {
    await logger.warn('Changedmsg mirror failed', { jid, messageId: message.key?.id, error: error.message });
  } finally {
    await cleanupFiles([media?.path]);
  }

  await state.changedMessages.upsertIndex({
    key: messageIndexKey(message.key),
    messageKey: message.key,
    id: message.key?.id,
    remoteJid: jid,
    participant: message.key?.participant,
    actorJid,
    pushName: message.pushName || '',
    chatName: state.chatDirectory.nameFor(jid) || (jid?.endsWith('@g.us') ? jid : displayPhoneFromJid(jid)),
    type: summary.type,
    text: summary.text,
    latestText: summary.text,
    logJid: logsJid,
    logMessageId: logContentMessage?.key?.id || '',
    timestamp: summary.timestamp
  }, state.runtimeConfig.changedmsgSettings().indexMaxItems);
  return true;
}

async function handleChangedDelete(messageKey) {
  if (!state.runtimeConfig?.changedmsgSettings?.().enabled) return;
  const existing = state.changedMessages.findByKey(messageKey);
  if (!existing && !state.changedMessages.shouldWatchChat(messageKey?.remoteJid)) return;
  if (existing?.deletedAt) return;
  const item = existing ? await state.changedMessages.markDeleted(messageKey) : null;
  const changedJid = safeDestinationJid('changedmsg');
  if (!changedJid) return;
  const lines = [
    'Pesan dihapus:',
    ...formatChangedIndexLines(item, messageKey),
    item?.logMessageId ? `Referensi logs: ${shortJid(item.logJid)} / ${item.logMessageId}` : 'Referensi logs: tidak tersedia'
  ];
  await sendText(changedJid, lines.join('\n'));
}

async function handleChangedEdit(update) {
  if (!state.runtimeConfig?.changedmsgSettings?.().enabled) return;
  const edited = update?.update?.message?.editedMessage?.message;
  if (!edited) return;
  const fakeMessage = {
    key: update.key,
    message: edited,
    messageTimestamp: update.update?.messageTimestamp
  };
  const summary = summarizeMessage(fakeMessage);
  const old = state.changedMessages.findByKey(update.key);
  if (!old && !state.changedMessages.shouldWatchChat(update.key?.remoteJid)) return;
  const beforeText = old?.latestText || old?.text || '';
  const item = await state.changedMessages.markEdited(update.key, {
    latestText: summary.text,
    type: summary.type
  });
  const changedJid = safeDestinationJid('changedmsg');
  if (!changedJid) return;
  const lines = [
    'Pesan diedit:',
    ...formatChangedIndexLines(item || old, update.key),
    '',
    'Sebelum:',
    beforeText || '(tidak tersedia)',
    '',
    'Sesudah:',
    summary.text || '(tidak tersedia)'
  ];
  await sendText(changedJid, lines.join('\n'));
}

function formatChangedIndexLines(item, messageKey) {
  if (!item) {
    return [
      `Chat: ${messageKey?.remoteJid || '-'}`,
      `Message ID: ${messageKey?.id || '-'}`,
      'Detail lama: tidak ada di index, kemungkinan pesan terjadi sebelum fitur aktif/restart/index terotasi.'
    ];
  }
  return [
    `Chat: ${item.chatName || item.remoteJid || '-'}`,
    `Chat JID: ${item.remoteJid || '-'}`,
    `Pengirim: ${item.pushName || displayPhoneFromJid(item.actorJid) || '-'}`,
    `Pengirim JID: ${item.actorJid || item.participant || '-'}`,
    `Waktu: ${new Date(item.timestamp || Date.now()).toLocaleString()}`,
    `Tipe: ${item.type || 'unknown'}`,
    `Message ID: ${item.id || '-'}`
  ];
}

function changedMessageMetaText(label, message, extra = {}) {
  const jid = message.key?.remoteJid || '';
  const actorJid = extra.actorJid || messageActorJid(message);
  const lines = [
    `[${label}] ${BOT_NAME}`,
    `Chat: ${state.chatDirectory.nameFor(jid) || jid}`,
    `Chat JID: ${jid}`,
    `Pengirim: ${message.pushName || displayPhoneFromJid(actorJid) || '-'}`,
    `Pengirim JID: ${actorJid}`,
    `Waktu: ${new Date(timestampMs(message)).toLocaleString()}`,
    `Tipe: ${extra.type || messageTypeName(message)}`,
    `Message ID: ${message.key?.id || '-'}`
  ];
  if (extra.text) lines.push('', truncateText(extra.text, 700));
  return lines.join('\n');
}

function safeDestinationJid(name) {
  try {
    return destinationJid(name);
  } catch (error) {
    logger.warn('Destination unavailable', { name, error: error.message });
    return null;
  }
}

function isDestinationChat(jid) {
  for (const name of ['logs', 'changedmsg', 'saved', 'backup', 'workerDev', 'workerLogs']) {
    try {
      if (sameJid(jid, destinationJid(name))) return true;
    } catch {
      // Destination may not be resolvable yet; ignore here.
    }
  }
  return false;
}

function normalizePhoneToJid(input) {
  try {
    return normalizePhoneToWhatsAppJid(input);
  } catch {
    throw new Error('Format: ,info <nomor telepon>');
  }
}

function tryNormalizePhoneToJid(input) {
  return tryNormalizePhoneToWhatsAppJid(input);
}

async function handleInfo(message, command) {
  const jid = message.key.remoteJid;
  const target = normalizePhoneToJid(command.rawArgs);
  const [exists] = await state.sock.onWhatsApp(target).catch(() => []);
  const status = await state.sock.fetchStatus(target).catch(() => null);
  const pictureUrl = await state.sock.profilePictureUrl(target, 'image').catch(() => null);
  const caption = [
    'Info WhatsApp:',
    `Nomor: +${target.split('@')[0]}`,
    `JID: ${target}`,
    `Terdaftar: ${exists?.exists ? 'ya' : 'tidak / tidak terdeteksi'}`,
    `Status: ${status?.status || '-'}`,
    `Status set: ${status?.setAt ? new Date(status.setAt).toLocaleString() : '-'}`,
    `Foto profil: ${pictureUrl ? 'ada' : 'tidak tersedia'}`
  ].join('\n');

  if (pictureUrl) {
    await sendBotMessage(jid, { image: { url: pictureUrl }, caption });
  } else {
    await sendText(jid, caption);
  }
}

async function handleTask(message, command, actorJid = messageActorJid(message)) {
  const jid = message.key.remoteJid;
  const action = (command.args[0] || 'list').toLowerCase();
  if (!command.args.length || action === 'list') {
    await sendTaskList(jid, actorJid);
    return;
  }
  if (isTaskStateAction(action)) {
    await handleTaskStateChange(jid, actorJid, action, command.args[1], ',task pause|resume|del <id>');
    return;
  }
  const task = await createTask(messageSock(message), message, command.args);
  await sendText(jid, `Task #${task.id} dibuat.\nBerikutnya: ${formatWib(task.nextRunAt)}`);
}

async function handleListTask(jid, command, actorJid) {
  if (!command.args.length) {
    await sendTaskList(jid, actorJid);
    return;
  }
  const [action, idRaw] = command.args;
  await handleTaskStateChange(jid, actorJid, action, idRaw, ',task pause|resume|del <id>. Legacy: ,ltask true|false|del <id>');
}

function isTaskStateAction(action) {
  return ['pause', 'resume', 'del', 'true', 'false'].includes(String(action || '').toLowerCase());
}

function normalizeTaskStateAction(action) {
  const text = String(action || '').toLowerCase();
  if (text === 'pause' || text === 'false') return 'pause';
  if (text === 'resume' || text === 'true') return 'resume';
  if (text === 'del') return 'del';
  return null;
}

async function handleTaskStateChange(jid, actorJid, actionRaw, idRaw, formatHint) {
  const action = normalizeTaskStateAction(actionRaw);
  const id = Number(idRaw);
  if (!action || !Number.isInteger(id)) throw new Error(`Format: ${formatHint}`);
  if (action === 'del') {
    await requestConfirmation(jid, actorJid, {
      title: `Hapus task #${id}`,
      description: `Task #${id} akan dihapus permanen.`,
      execute: async () => {
        const result = await updateTaskState('del', id);
        invalidateListKind('tasks');
        await sendText(jid, `Task #${id} dihapus.`);
        return result;
      }
    });
    return;
  }
  const result = await updateTaskState(action, id);
  await sendText(jid, result.deleted ? `Task #${id} dihapus.` : `Task #${id} ${result.task.paused ? 'dipause' : 'aktif'}.`);
}

async function sendTaskList(jid, actorJid) {
  const tasks = await listTasks();
  await sendReactionList(jid, actorJid, 'tasks', tasks, {
    emptyText: 'Belum ada task.',
    formatItem: (task) => formatTaskList([task]),
    deleteTitle: (task) => `Hapus task #${task.id}`,
    deleteDescription: 'Task ini akan dihapus permanen.',
    deleteItem: async (task) => {
      await updateTaskState('del', task.id);
      return `Task #${task.id} dihapus.`;
    }
  });
}

async function handleTopdf(message, command, actorJid) {
  const jid = message.key.remoteJid;
  assertNoActiveSession(jid);
  const pdfArgs = parsePdfStartArgs(command.rawArgs);
  const session = state.pdfSessions.start(jid, { ...pdfArgs, actorJid });
  const hasInitialMedia = mediaNode(message) || quotedMediaNode(message);
  if (hasInitialMedia) {
    const item = await state.pdfSessions.addAny(messageSock(message), message, null);
    const sent = await updatePdfProgressMessage(jid, session, item);
    registerSessionPrompt(sent.key, jid, actorJid);
    return;
  }
  const sent = await updatePdfProgressMessage(jid, session, null);
  registerSessionPrompt(sent.key, jid, actorJid);
}

async function updatePdfProgressMessage(jid, session, latestItem = null) {
  if (!session) return sendText(jid, 'Sesi PDF tidak ditemukan.');
  if (latestItem?.skipped) {
    session.skippedItems = [...(session.skippedItems || []), latestItem].slice(-10);
  }
  session.latestItem = latestItem || session.latestItem || null;
  const text = formatPdfProgressMessage(session);
  if (session.progressKey) {
    await editText(jid, session.progressKey, text);
    return { key: session.progressKey };
  }
  const sent = await sendText(jid, text);
  session.progressKey = sent.key;
  return sent;
}

function formatPdfProgressMessage(session) {
  const lines = [
    `Sesi PDF "${session.fileName}" ${session.split ? '(split)' : ''}`.trim()
  ];
  if (session.maxSizeBytes) lines.push(`Maksimal ukuran: ${formatBytes(session.maxSizeBytes)}.`);
  if (session.split) lines.push('Mode split: setiap media akan dibuat menjadi PDF terpisah.');
  if (session.latestItem) {
    lines.push(
      session.latestItem.skipped
        ? `Terbaru dilewati: ${session.latestItem.fileName} - ${session.latestItem.reason}`
        : `Terbaru ditambahkan: ${session.latestItem.fileName} (#${session.latestItem.order})`
    );
  }
  lines.push(`Total ditambahkan: ${session.files.length}`);
  if (session.files.length) {
    lines.push('', 'File:');
    for (const item of [...session.files].sort((a, b) => a.order - b.order || a.addedAt - b.addedAt)) {
      lines.push(`${item.order}. ${item.fileName}`);
    }
  }
  if (session.skippedItems?.length) {
    lines.push('', 'Dilewati:');
    for (const item of session.skippedItems) lines.push(`- ${item.fileName}: ${item.reason}`);
  }
  lines.push('', 'Kirim/reply media atau dokumen. Caption/teks angka dipakai sebagai urutan halaman.');
  lines.push('Selesai: ,end atau reaction ✅/👍/❤️. Batal: ,cancel atau reaction ❌/👎/❎.');
  return lines.join('\n');
}

async function handleEndPdf(message, actorJid = messageActorJid(message)) {
  return handleEndPdfByJid(message.key.remoteJid, actorJid);
}

async function handleEndPdfByJid(jid, actorJid) {
  const session = state.pdfSessions.end(jid, actorJid);
  if (!session) {
    await sendText(jid, 'Tidak ada sesi PDF aktif.');
    return false;
  }
  try {
    if (session.split) {
      const pdfs = await state.pdfSessions.buildSplit(session);
      for (const file of pdfs) {
        await sendBotMessage(jid, {
          document: file.buffer,
          mimetype: 'application/pdf',
          fileName: file.fileName
        });
      }
    } else {
      const pdf = await state.pdfSessions.build(session);
      await sendBotMessage(jid, {
        document: pdf,
        mimetype: 'application/pdf',
        fileName: session.fileName || `${PDF_DEFAULT_FILE_NAME}-${Date.now()}.pdf`
      });
    }
  } finally {
    await state.pdfSessions.cleanup(session);
  }
  return true;
}

async function handleSave(message, command, actorJid) {
  const { title, firstText } = parseSaveStart(command);
  assertNoActiveSession(message.key.remoteJid);
  await assertSavedTitleAvailable(title);
  const session = state.saveRecorder.start(message.key.remoteJid, title, firstText, actorJid);
  const sent = await sendText(message.key.remoteJid, `Mulai rekam save "${session.title}". Kirim teks, media, lokasi, kontak, poll, atau event lalu ,end untuk simpan atau ,cancel untuk batal.`);
  registerSessionPrompt(sent.key, message.key.remoteJid, actorJid);
}

async function handleAnticall(message, command, actorJid) {
  const jid = message.key.remoteJid;
  const action = (command.args[0] || '').toLowerCase();
  if (!action) {
    await sendText(jid, formatAnticallStatus(state.anticall.snapshot()));
    return;
  }

  if (action === 'new') {
    assertNoActiveSession(jid);
    if (state.anticall.hasMessage()) {
      await requestConfirmation(jid, actorJid, {
        title: 'Ganti pesan anticall',
        description: 'Pesan anticall lama tetap dipakai sampai rekaman baru selesai disimpan dengan ,end.',
        execute: async () => startAnticallRecording(jid, actorJid)
      });
      return;
    }
    await startAnticallRecording(jid, actorJid);
    return;
  }

  if (action === 'except') {
    await handleAnticallException(jid, command, actorJid);
    return;
  }

  if (action === 'on' || action === 'off') {
    const snapshot = await state.anticall.setEnabled(action === 'on');
    await sendText(jid, `Anticall ${snapshot.enabled ? 'aktif' : 'nonaktif'}. Pesan: ${snapshot.hasMessage ? `${snapshot.entryCount} item` : 'belum ada'}.`);
    return;
  }

  throw new Error('Format: ,anticall [new|on|off|except]');
}

async function startAnticallRecording(jid, actorJid) {
  assertNoActiveSession(jid);
  await state.anticall.start(jid, actorJid);
  const sent = await sendText(jid, 'Mulai rekam pesan anticall. Kirim teks, media, lokasi, kontak, poll, atau event lalu ,end untuk simpan atau ,cancel untuk batal.');
  registerSessionPrompt(sent.key, jid, actorJid);
}

async function handleAnticallException(jid, command, actorJid) {
  const subaction = (command.args[1] || 'list').toLowerCase();
  if (subaction === 'list') {
    await sendAnticallExceptionList(jid, actorJid);
    return;
  }
  if (subaction === 'add') {
    const input = command.args.slice(2).join(' ').trim();
    if (!input) throw new Error('Format: ,anticall except add <nomor>');
    const item = await state.anticall.addException(input);
    invalidateListKind('anticall-exceptions');
    await sendText(jid, `Exception anticall #${item.id} ${item.title} ditambahkan.`);
    return;
  }
  if (subaction === 'del') {
    const query = command.args.slice(2).join(' ').trim();
    if (!query) throw new Error('Format: ,anticall except del <nomor|id>');
    const item = await state.anticall.deleteException(query);
    invalidateListKind('anticall-exceptions');
    await sendText(jid, `Exception anticall #${item.id} ${item.title} dihapus.`);
    return;
  }
  throw new Error('Format: ,anticall except list|add|del <nomor|id>');
}

async function sendAnticallExceptionList(jid, actorJid) {
  await sendReactionList(jid, actorJid, 'anticall-exceptions', state.anticall.listExceptions(), {
    emptyText: 'Belum ada exception anticall.',
    formatItem: (item) => `#${item.id} - ${item.title}`,
    deleteTitle: (item) => `Hapus exception anticall #${item.id}`,
    deleteDescription: 'Nomor ini akan kembali ditolak saat anticall aktif.',
    deleteItem: async (item) => {
      const deleted = await state.anticall.deleteException(item.id);
      return `Exception anticall #${deleted.id} ${deleted.title} dihapus.`;
    }
  });
}

async function handleLoad(message, command, actorJid) {
  const jid = message.key.remoteJid;
  if (!command.args.length) {
    await sendSavedList(jid, actorJid);
    return;
  }
  if (command.args[0].toLowerCase() === 'change') {
    const query = command.args[1];
    const newTitle = command.args.slice(2).join(' ').trim();
    if (!query || !newTitle) throw new Error('Format: ,load change <id|judul-lama> <judul-baru>');
    const item = await renameSaved(query, newTitle);
    invalidateListKind('saved');
    await sendText(jid, `Save #${item.id} diganti judul menjadi "${item.title}".`);
    return;
  }
  if (command.args[0].toLowerCase() === 'del') {
    const query = command.args.slice(1).join(' ').trim();
    if (!query) throw new Error('Format: ,load del <id|judul>');
    await requestConfirmation(jid, actorJid, {
      title: `Hapus save "${query}"`,
      description: 'Save ini akan dihapus permanen.',
      execute: async () => {
        const item = await deleteSaved(query);
        invalidateListKind('saved');
        await sendText(jid, `Save #${item.id} "${item.title}" dihapus.`);
      }
    });
    return;
  }
  const query = command.rawArgs.trim();
  const item = await getSaved(query);
  if (!item) throw new Error(`Save "${query}" tidak ditemukan.`);
  await sendSaved(botSender(), jid, item);
}

async function sendSavedList(jid, actorJid) {
  await sendReactionList(jid, actorJid, 'saved', await listSaved(), {
    emptyText: 'Belum ada pesan tersimpan.',
    formatItem: (item) => formatSavedList([item]),
    deleteTitle: (item) => `Hapus save #${item.id}`,
    deleteDescription: 'Save ini akan dihapus permanen.',
    deleteItem: async (item) => {
      const deleted = await deleteSaved(item.id);
      return `Save #${deleted.id} "${deleted.title}" dihapus.`;
    }
  });
}

async function sendNoteList(jid, actorJid) {
  await sendReactionList(jid, actorJid, 'notes', await listNotes(), {
    emptyText: 'Belum ada note.',
    formatItem: (item) => `#${item.id} - ${item.title}`,
    deleteTitle: (item) => `Hapus note #${item.id}`,
    deleteDescription: 'Note ini akan dihapus permanen.',
    deleteItem: async (item) => handleNoteCommand({ args: ['del', String(item.id)], rawArgs: `del ${item.id}` })
  });
}

async function sendLinkList(jid, actorJid) {
  await sendReactionList(jid, actorJid, 'links', await listLinks(), {
    emptyText: 'Belum ada link.',
    formatItem: (item) => `#${item.id} - ${item.title}`,
    deleteTitle: (item) => `Hapus link #${item.id}`,
    deleteDescription: 'Link ini akan dihapus permanen.',
    deleteItem: async (item) => handleLinkCommand({ args: ['del', String(item.id)], rawArgs: `del ${item.id}` })
  });
}

async function sendWolList(jid, actorJid) {
  await sendReactionList(jid, actorJid, 'wol', await listWol(), {
    emptyText: 'Belum ada MAC WOL tersimpan.',
    formatItem: (item) => `#${item.id} - ${item.mac}`,
    deleteTitle: (item) => `Hapus WOL #${item.id}`,
    deleteDescription: 'Entry Wake-on-LAN ini akan dihapus permanen.',
    deleteItem: async (item) => handleWolCommand({ args: ['del', String(item.id)], rawArgs: `del ${item.id}` })
  });
}

async function finishSave(message, actorJid = messageActorJid(message)) {
  return finishSaveByJid(message.key.remoteJid, actorJid);
}

async function finishSaveByJid(jid, actorJid) {
  const item = await state.saveRecorder.finish(jid, actorJid);
  if (!item) return false;
  invalidateListKind('saved');
  await sendText(jid, `Save #${item.id} "${item.title}" tersimpan (${item.entries.length} item).`);
  return true;
}

async function finishAnticall(message, actorJid = messageActorJid(message)) {
  return finishAnticallByJid(message.key.remoteJid, actorJid);
}

async function finishAnticallByJid(jid, actorJid) {
  const snapshot = await state.anticall.finish(jid, actorJid);
  if (!snapshot) return false;
  await sendText(
    jid,
    `Pesan anticall tersimpan (${snapshot.entryCount} item). Status: ${snapshot.enabled ? 'aktif' : 'nonaktif'}.`
  );
  return true;
}

async function cancelSave(message, actorJid = messageActorJid(message)) {
  const cancelled = await state.saveRecorder.cancel(message.key.remoteJid, actorJid);
  if (cancelled) await sendText(message.key.remoteJid, 'Rekaman save dibatalkan.');
  return cancelled;
}

async function cancelAnticall(message, actorJid = messageActorJid(message)) {
  const cancelled = await state.anticall.cancel(message.key.remoteJid, actorJid);
  if (cancelled) await sendText(message.key.remoteJid, 'Rekaman anticall dibatalkan.');
  return cancelled;
}

async function cancelActiveSession(message, actorJid = messageActorJid(message)) {
  return cancelActiveSessionByJid(message.key.remoteJid, actorJid);
}

async function cancelActiveSessionByJid(jid, actorJid) {
  if (await state.saveRecorder.cancel(jid, actorJid)) {
    await sendText(jid, 'Rekaman save dibatalkan.');
    return true;
  }
  if (await state.anticall.cancel(jid, actorJid)) {
    await sendText(jid, 'Rekaman anticall dibatalkan.');
    return true;
  }

  const pdfSession = state.pdfSessions.end(jid, actorJid);
  if (pdfSession) {
    await state.pdfSessions.cleanup(pdfSession);
    await sendText(jid, 'Sesi PDF dibatalkan.');
    return true;
  }

  if (await state.restoreSessions.cancel(jid, actorJid)) {
    await sendText(jid, 'Sesi restore dibatalkan.');
    return true;
  }

  return false;
}

async function handleCancelByJid(jid, actorJid) {
  let cancelled = false;
  if (state.confirmStore.cancel(jid, actorJid)) {
    cancelled = true;
    await sendText(jid, 'Konfirmasi dibatalkan.');
  }
  if (await cancelActiveSessionByJid(jid, actorJid)) cancelled = true;
  if (!cancelled) await sendText(jid, 'Tidak ada sesi aktif atau konfirmasi pending.');
  return cancelled;
}

async function handleEndSession(jid, actorJid) {
  if (await finishSaveByJid(jid, actorJid)) return true;
  if (await finishAnticallByJid(jid, actorJid)) return true;
  if (state.restoreSessions.has(jid)) {
    if (!activeSessionActorMatches(jid, actorJid)) return false;
    await requestConfirmation(jid, actorJid, {
      title: 'Restore data',
      description: 'Folder data/ akan ditimpa dari file restore yang sudah dikirim.',
      execute: async () => finishRestoreByJid(jid, actorJid)
    });
    return true;
  }
  return handleEndPdfByJid(jid, actorJid);
}

async function finishRestore(message, actorJid = messageActorJid(message)) {
  return finishRestoreByJid(message.key.remoteJid, actorJid);
}

async function finishRestoreByJid(jid, actorJid) {
  const session = state.restoreSessions.end(jid, actorJid);
  if (!session) return false;
  state.scheduler?.stop();
  state.reminderScheduler?.stop();
  try {
    const result = await state.restoreSessions.restore(session);
    await sendText(jid, `Restore selesai. ${result.parts} part diproses, ${result.extracted} file diekstrak ke data/.`);
  } finally {
    if (isBotEnabled()) {
      state.scheduler?.start();
      state.reminderScheduler?.start();
    }
  }
  return true;
}

async function maybeCollectRestorePart(message) {
  if (!state.restoreSessions.has(message.key.remoteJid)) return false;
  const item = await state.restoreSessions.add(messageSock(message), message);
  if (item) {
    await sendText(message.key.remoteJid, `Restore part diterima: ${item.fileName}`);
    return true;
  }
  await sendText(message.key.remoteJid, 'Kirim dokumen .zip untuk restore, atau ketik ,end jika semua part sudah dikirim.');
  return true;
}

async function maybeCollectPdfItem(message, text) {
  if (!state.pdfSessions.has(message.key.remoteJid)) return false;
  if (!mediaNode(message) && !quotedMediaNode(message)) return false;
  const order = parsePdfOrderText(text);
  const item = await state.pdfSessions.addAny(messageSock(message), message, order);
  if (item) await updatePdfProgressMessage(message.key.remoteJid, state.pdfSessions.get(message.key.remoteJid), item);
  return Boolean(item);
}

async function handleReminder(message, command) {
  const reminder = await createReminder(command.args);
  await sendText(message.key.remoteJid, `Reminder #${reminder.id} dibuat. Terkirim dalam ${formatCountdown(new Date(reminder.dueAt).getTime() - Date.now())} ke ${PRIMARY_TARGET_NAME}.`);
}

async function handleClear(jid) {
  if (hasAnyTempSession()) throw new Error('Tidak bisa clear temp saat ada sesi save/anticall/PDF/restore aktif.');
  await cleanupStartupTemp();
  await sendText(jid, 'Temp dibersihkan.');
}

async function handleBackup(jid) {
  await sendText(jid, 'Membuat backup data/ dan mengirim ke destination backup WhatsApp...');
  const destination = destinationJid('backup');
  const files = await sendDataBackupToWhatsApp(primaryBotSender(), destination, {
    partSizeBytes: state.runtimeConfig.backupPartSizeBytes()
  });
  await sendText(jid, `Backup terkirim ke ${formatDestinationLine('backup')}:\n${files.join('\n')}`);
}

async function handleLog(jid, command) {
  const lines = Number(command.args[0] || 30);
  const limit = Number.isInteger(lines) && lines > 0 ? Math.min(lines, 80) : 30;
  const entries = await fs.readdir(LOG_DIR).catch(() => []);
  const files = entries
    .filter((name) => /^bot-\d{4}-\d{2}-\d{2}\.log$/.test(name))
    .sort()
    .reverse();
  if (!files.length) {
    await sendText(jid, 'Belum ada file log.');
    return;
  }
  const content = await fs.readFile(path.join(LOG_DIR, files[0]), 'utf8');
  const tail = content.trim().split(/\r?\n/).slice(-limit).map(formatLogLine).join('\n');
  await sendText(jid, tail || 'Log kosong.');
}

function formatLogLine(line) {
  try {
    const item = JSON.parse(line);
    const meta = item.meta ? ` ${JSON.stringify(item.meta).slice(0, 300)}` : '';
    return `[${item.time}] ${item.level}: ${item.message}${meta}`;
  } catch {
    return line;
  }
}

async function handleNet(jid) {
  const started = Date.now();
  const [publicIp, trace, dnsInfo, latency, download] = await Promise.all([
    fetchText('https://api.ipify.org?format=text', 5000).catch((error) => `gagal: ${error.message}`),
    fetchText('https://www.cloudflare.com/cdn-cgi/trace', 5000).catch(() => ''),
    getDnsInfo(),
    measureHttpLatency('https://www.cloudflare.com/cdn-cgi/trace'),
    measureDownloadSpeed('https://speed.cloudflare.com/__down?bytes=1048576')
  ]);
  const traceMap = parseCloudflareTrace(trace);
  const nets = Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && !item.internal)
    .map((item) => `${item.family} ${item.address}`)
    .slice(0, 8);
  await sendText(jid, [
    'Network info:',
    `Public IP: ${publicIp}`,
    traceMap.loc ? `Lokasi CF: ${traceMap.loc}` : null,
    traceMap.colo ? `Cloudflare colo: ${traceMap.colo}` : null,
    `DNS lookup: ${dnsInfo}`,
    `HTTP latency: ${latency}`,
    `Download test: ${download}`,
    `Local IP: ${nets.join(', ') || 'unavailable'}`,
    `Selesai dalam ${Date.now() - started}ms`
  ].filter(Boolean).join('\n'));
}

async function fetchText(url, timeoutMs = 5000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.text()).trim();
}

async function getDnsInfo() {
  const start = Date.now();
  try {
    const addresses = await dns.resolve4('cloudflare.com');
    return `${Date.now() - start}ms (${addresses.slice(0, 3).join(', ')})`;
  } catch (error) {
    return `gagal: ${error.message}`;
  }
}

async function measureHttpLatency(url) {
  const start = Date.now();
  try {
    const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000), cache: 'no-store' });
    return `${Date.now() - start}ms (HTTP ${response.status})`;
  } catch (error) {
    return `gagal: ${error.message}`;
  }
}

async function measureDownloadSpeed(url) {
  const start = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(12000), cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const seconds = Math.max(0.001, (Date.now() - start) / 1000);
    const mbps = (buffer.length * 8) / seconds / 1_000_000;
    return `${formatBytes(buffer.length)} in ${seconds.toFixed(2)}s (${mbps.toFixed(2)} Mbps)`;
  } catch (error) {
    return `gagal: ${error.message}`;
  }
}

function parseCloudflareTrace(text) {
  const result = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const [key, ...rest] = line.split('=');
    if (key) result[key] = rest.join('=');
  }
  return result;
}

async function handleButton(message, command) {
  const jid = message.key.remoteJid;
  const text = command.rawArgs.trim();
  if (!text) throw new Error('Format: ,button <pesan>');
  const buttonId = text.startsWith(COMMAND_PREFIX) ? text : `${COMMAND_PREFIX}${text}`;
  const content = proto.Message.fromObject({
    buttonsMessage: {
      contentText: text,
      footerText: BOT_NAME,
      buttons: [
        {
          buttonId,
          buttonText: { displayText: text },
          type: 1
        }
      ],
      headerType: 1
    }
  });
  const waMessage = generateWAMessageFromContent(jid, content, {
    userJid: ownUserJid()
  });
  await state.sock.relayMessage(jid, waMessage.message, { messageId: waMessage.key.id });
}

async function handleAllow(message, command) {
  const jid = message.key.remoteJid;
  const { scope, enabled } = parseAllowArgs(command.args);
  const commands = ['help', 's', 'smeme', 'resend']
    .filter((name) => PUBLIC_COMMANDS.has(name))
    .map((name) => `${COMMAND_PREFIX}${name}`)
    .join(', ');
  if (scope === 'all') {
    const snapshot = await state.commandAccess.setAll(enabled);
    await sendText(jid, [
      `Akses publik semua chat: ${snapshot.all ? 'aktif' : 'nonaktif'}.`,
      `Command publik: ${commands}.`,
      enabled ? null : 'Semua izin here juga dihapus.'
    ].filter(Boolean).join('\n'));
    return;
  }

  const snapshot = await state.commandAccess.setHere(jid, enabled);
  await sendText(jid, [
    `Akses publik chat ini: ${snapshot.chats[jid] ? 'aktif' : 'nonaktif'}.`,
    `Command publik: ${commands}.`,
    snapshot.all ? 'Catatan: akses all sedang aktif, jadi semua chat tetap diizinkan.' : null
  ].filter(Boolean).join('\n'));
}

async function handleBotCommand(message, command, context) {
  if (!context.isOwner) throw new Error('Command ,bot hanya bisa dipakai nomor yang terhubung ke session bot.');
  const jid = message.key.remoteJid;
  const action = (command.args[0] || '').toLowerCase();
  if (!action) {
    const snapshot = state.botState.snapshot();
    await sendText(jid, `Bot: ${snapshot.enabled ? 'on' : 'off'}.`);
    return;
  }
  if (!['on', 'off'].includes(action)) throw new Error('Format: ,bot [on|off]');
  const snapshot = await state.botState.setEnabled(action === 'on');
  applyBotRuntimeState();
  await sendText(jid, `Bot sekarang ${snapshot.enabled ? 'on' : 'off'}.`);
}

async function handleAdminCommand(message, command, context) {
  if (!context.isOwner) throw new Error('Command ,admin hanya bisa dipakai nomor yang terhubung ke session bot.');
  const jid = message.key.remoteJid;
  const action = (command.args[0] || 'list').toLowerCase();
  if (action === 'list') {
    await sendAdminList(jid, context.actorJid);
    return;
  }
  if (action === 'add') {
    const input = command.args.slice(1).join(' ').trim();
    if (!input) throw new Error('Format: ,admin add <nomor>');
    const adminJid = normalizePhoneToWhatsAppJid(input);
    await requestConfirmation(jid, context.actorJid, {
      title: `Tambah admin ${displayPhoneFromJid(adminJid)}`,
      description: 'Admin tambahan bisa memakai command non-server saat akses publik aktif.',
      execute: async () => {
        const item = await state.commandAccess.addAdmin(adminJid);
        invalidateListKind('admins');
        await sendText(jid, `Admin #${item.id} ${item.title} ditambahkan.`);
      }
    });
    return;
  }
  if (action === 'del') {
    const query = command.args.slice(1).join(' ').trim();
    if (!query) throw new Error('Format: ,admin del <nomor|id>');
    await requestConfirmation(jid, context.actorJid, {
      title: `Hapus admin "${query}"`,
      description: 'Nomor ini tidak lagi bisa memakai akses admin tambahan.',
      execute: async () => {
        const item = await state.commandAccess.deleteAdmin(query);
        invalidateListKind('admins');
        await sendText(jid, `Admin #${item.id} ${item.title} dihapus.`);
      }
    });
    return;
  }
  throw new Error('Format: ,admin list|add|del <nomor|id>');
}

async function sendAdminList(jid, actorJid) {
  await sendReactionList(jid, actorJid, 'admins', state.commandAccess.listAdmins(), {
    emptyText: 'Belum ada admin tambahan.',
    formatItem: (item) => `#${item.id} - ${item.title}`,
    deleteTitle: (item) => `Hapus admin #${item.id}`,
    deleteDescription: 'Nomor ini tidak lagi bisa memakai akses admin tambahan.',
    deleteItem: async (item) => {
      const deleted = await state.commandAccess.deleteAdmin(item.id);
      return `Admin #${deleted.id} ${deleted.title} dihapus.`;
    }
  });
}

async function handleConfigCommand(message, command, context) {
  if (!context.isOwner) throw new Error('Command ,config hanya bisa dipakai nomor yang terhubung ke session bot.');
  const jid = message.key.remoteJid;
  const action = (command.args[0] || '').toLowerCase();
  if (!action) {
    const lines = ['Config yang bisa diubah:'];
    for (const item of configKeyList()) {
      lines.push(`- ${item.key}: ${item.label} = ${formatConfigValue(state.runtimeConfig.get(item.key))}`);
    }
    lines.push('', 'Format: ,config get <key> atau ,config set <key> <value>');
    await sendText(jid, lines.join('\n'));
    return;
  }
  if (action === 'get') {
    const key = command.args[1];
    if (!key) throw new Error('Format: ,config get <key>');
    await sendText(jid, `${key} = ${formatConfigValue(state.runtimeConfig.get(key))}`);
    return;
  }
  if (action === 'set') {
    const key = command.args[1];
    const value = command.args.slice(2).join(' ').trim();
    if (!key || !value) throw new Error('Format: ,config set <key> <value>');
    const def = configKeyList().find((item) => item.key === key);
    if (!def) throw new Error(`Config "${key}" tidak bisa diubah. Ketik ,config untuk daftar key.`);
    let saved;
    if (def.type === 'destination') {
      saved = await state.runtimeConfig.setDestination(key, resolveDestinationInput(value, context.actorJid));
    } else {
      saved = await state.runtimeConfig.set(key, value);
    }
    if (key.startsWith('backup.')) applyBotRuntimeState();
    await sendText(jid, `Config ${key} disimpan: ${formatConfigValue(saved)}`);
    return;
  }
  throw new Error('Format: ,config [get|set] <key> <value>');
}

async function handleChangedMsgCommand(message, command, context) {
  if (!context.isOwner) throw new Error('Command ,changedmsg hanya bisa dipakai nomor yang terhubung ke session bot.');
  const jid = message.key.remoteJid;
  const action = (command.args[0] || 'list').toLowerCase();
  if (action === 'list') {
    await sendChangedMsgAllowList(jid, context.actorJid);
    return;
  }
  if (action === 'allow' || action === 'add') {
    const input = command.args.slice(1).join(' ').trim();
    if (!input) throw new Error('Format: ,changedmsg allow <nama-grup|jid>');
    const destination = resolveDestinationInput(input, context.actorJid, { requireGroup: true });
    const item = await state.changedMessages.addAllowed(destination);
    invalidateListKind('changedmsg-allow');
    await sendText(jid, `Changedmsg allowlist #${item.id} ditambahkan: ${item.savedName} (${shortJid(item.jid)}).`);
    return;
  }
  if (action === 'del' || action === 'delete') {
    const query = command.args.slice(1).join(' ').trim();
    if (!query) throw new Error('Format: ,changedmsg del <id|nama-grup|jid>');
    await requestConfirmation(jid, context.actorJid, {
      title: `Hapus allowlist changedmsg "${query}"`,
      description: 'Grup ini tidak lagi dipantau untuk logs/changedmsg.',
      execute: async () => {
        const item = await state.changedMessages.deleteAllowed(query);
        invalidateListKind('changedmsg-allow');
        await sendText(jid, `Changedmsg allowlist #${item.id} ${item.savedName} dihapus.`);
      }
    });
    return;
  }
  throw new Error('Format: ,changedmsg list|allow|del <group|id>');
}

async function sendChangedMsgAllowList(jid, actorJid) {
  await sendReactionList(jid, actorJid, 'changedmsg-allow', state.changedMessages.listAllowed(), {
    emptyText: 'Belum ada grup allowlist changedmsg. Direct message tetap dipantau default.',
    formatItem: (item) => formatStoredChatItem(item),
    deleteTitle: (item) => `Hapus changedmsg allowlist #${item.id}`,
    deleteDescription: 'Grup ini tidak lagi dipantau untuk logs/changedmsg.',
    deleteItem: async (item) => {
      const deleted = await state.changedMessages.deleteAllowed(item.id);
      return `Changedmsg allowlist #${deleted.id} ${deleted.savedName} dihapus.`;
    }
  });
}

async function handleJadibotCommand(message, command, context) {
  if (!context.isOwner) throw new Error('Command ,jadibot hanya untuk super admin.');
  if (!state.multiAccount?.isMulti?.()) throw new Error('Mode multi akun belum aktif. Jalankan setup mode multi terlebih dahulu.');
  const jid = message.key.remoteJid;
  const action = (command.args[0] || 'list').toLowerCase();
  if (action === 'list') {
    await sendJadibotList(jid);
    return;
  }
  if (action === 'new') {
    await requestConfirmation(jid, context.actorJid, {
      title: 'Tambah akun worker baru',
      description: 'Bot akan membuat session baru dan mengirim QR ke chat ini. QR digenerate ulang maksimal 5 kali.',
      execute: async () => {
        if (state.activePairing) throw new Error('Masih ada sesi QR jadibot aktif. Kirim input lain atau tunggu selesai untuk membatalkan.');
        const account = await state.multiAccount.addWorker();
        await state.workerLogs.setMode(account.id, state.runtimeConfig?.workerLogsSettings?.().defaultMode || 'dm');
        await sendText(jid, `Membuat bot worker #${account.id}. QR akan dikirim saat tersedia.`);
        await connectAccount(account, {
          pairing: {
            chatJid: jid,
            actorJid: context.actorJid,
            qrLimit: 5
          }
        });
      }
    });
    return;
  }
  if (action === 'del') {
    const id = Number(command.args[1]);
    if (!Number.isInteger(id)) throw new Error('Format: ,jadibot del <ID>');
    if (id === 1) throw new Error('Akun primary tidak bisa dihapus.');
    const account = state.multiAccount.getAccount(id);
    if (!account) throw new Error(`Akun #${id} tidak ditemukan.`);
    await requestConfirmation(jid, context.actorJid, {
      title: `Hapus bot #${id}`,
      description: `Session ${accountWaLink(account)} akan dihapus permanen dari server.`,
      execute: async () => {
        const runtime = state.accountRuntimes.get(id);
        runtime?.sock?.end?.(new Error('jadibot deleted'));
        state.accountRuntimes.delete(id);
        await state.multiAccount.deleteAccount(id);
        await state.workerLogs.deleteWorkerData(id);
        await fs.rm(accountAuthPath(account, ROOT_DIR), { recursive: true, force: true });
        if (state.activePairing?.accountId === id) state.activePairing = null;
        await sendText(jid, `Bot #${id} ${accountWaLink(account)} dihapus permanen.`);
      }
    });
    return;
  }
  if (action === 'set') {
    const id = Number(command.args[1]);
    const role = String(command.args[2] || '').toLowerCase();
    if (!Number.isInteger(id) || !['trust', 'worker'].includes(role)) throw new Error('Format: ,jadibot set <ID> trust|worker');
    if (id === 1) throw new Error('Akun primary tidak bisa diubah role-nya.');
    const account = state.multiAccount.getAccount(id);
    if (!account) throw new Error(`Akun #${id} tidak ditemukan.`);
    await requestConfirmation(jid, context.actorJid, {
      title: `Ubah bot #${id} menjadi ${role}`,
      description: role === 'trust'
        ? 'Akun trust lama, jika ada, akan otomatis menjadi worker. Trust hanya satu akun.'
        : 'Akun ini akan menjadi worker pasif.',
      execute: async () => {
        const updated = await state.multiAccount.setRole(id, role);
        const runtime = state.accountRuntimes.get(id);
        if (runtime) runtime.account = updated;
        refreshAllRuntimeAccounts();
        refreshSchedulerSock();
        await sendText(jid, `Bot #${id} sekarang role ${role}.`);
      }
    });
    return;
  }
  if (action === 'control') {
    const id = Number(command.args[1]);
    if (!Number.isInteger(id)) throw new Error('Format: ,jadibot control <ID>');
    await startWorkerControlSession(jid, context.actorJid, id);
    return;
  }
  throw new Error('Format: ,jadibot [new|del|set|control]');
}

async function sendJadibotList(jid) {
  const lines = ['Daftar akun bot:'];
  for (const account of state.multiAccount.listAccounts()) {
    const runtime = state.accountRuntimes.get(account.id);
    const status = runtime?.status || account.status || 'disconnected';
    lines.push([
      `#${account.id}`,
      `role=${account.role}`,
      accountWaLink(account),
      account.name ? `nama=${account.name}` : null,
      `status=${status}`,
      `auth=${account.authDir}`
    ].filter(Boolean).join(' | '));
  }
  await sendText(jid, lines.join('\n'));
}

function refreshAllRuntimeAccounts() {
  for (const account of state.multiAccount.listAccounts()) {
    const runtime = state.accountRuntimes.get(account.id);
    if (runtime) runtime.account = account;
  }
}

function controlKey(jid, actorJid) {
  return `${jid}:${actorJid}`;
}

async function startWorkerControlSession(jid, actorJid, workerId) {
  const account = state.multiAccount.getAccount(workerId);
  if (!account || account.role !== 'worker') throw new Error(`Bot #${workerId} bukan worker.`);
  const runtime = state.accountRuntimes.get(workerId);
  if (!runtime?.sock || runtime.status !== 'connected') throw new Error(`Worker #${workerId} belum connected.`);
  const session = {
    jid,
    actorJid,
    workerId,
    compose: null,
    timer: null,
    updatedAt: Date.now()
  };
  state.controlSessions.set(controlKey(jid, actorJid), session);
  touchWorkerControlSession(session);
  await sendControlText(jid, [
    `Masuk sesi control worker #${workerId} ${accountWaLink(account)}.`,
    'Ketik ,help untuk command worker, atau ,exit untuk keluar.'
  ].join('\n'));
}

function touchWorkerControlSession(session) {
  if (!session) return;
  session.updatedAt = Date.now();
  if (session.timer) clearTimeout(session.timer);
  const timeoutMs = state.runtimeConfig?.workerControlTimeoutMs?.() || 10 * 60 * 1000;
  session.timer = setTimeout(() => {
    state.controlSessions.delete(controlKey(session.jid, session.actorJid));
    sendControlText(session.jid, `Sesi control worker #${session.workerId} otomatis keluar karena tidak ada aktivitas.`).catch(() => {});
  }, timeoutMs);
  session.timer.unref?.();
}

function endWorkerControlSession(session) {
  if (!session) return false;
  if (session.timer) clearTimeout(session.timer);
  state.controlSessions.delete(controlKey(session.jid, session.actorJid));
  return true;
}

async function maybeHandleWorkerControlInput(message, text, command, context) {
  if (!context?.isOwner) return false;
  const session = state.controlSessions.get(controlKey(message.key.remoteJid, context.actorJid));
  if (!session) return false;
  touchWorkerControlSession(session);
  if (command?.name === 'exit') {
    endWorkerControlSession(session);
    await sendControlText(message.key.remoteJid, `Keluar dari sesi control worker #${session.workerId}.`);
    return true;
  }
  if (session.compose && !command) {
    await sendWorkerComposeMessage(session, message, text);
    return true;
  }
  if (!command) return true;
  await handleWorkerControlCommand(session, message, command, context);
  return true;
}

async function handleWorkerControlCommand(session, message, command) {
  const jid = message.key.remoteJid;
  const runtime = state.accountRuntimes.get(session.workerId);
  if (!runtime?.sock) throw new Error(`Worker #${session.workerId} tidak aktif.`);
  const action = command.name;
  if (action === 'help') {
    await sendControlText(jid, workerControlHelp(session.workerId));
    return;
  }
  if (action === 'contacts' || action === 'kontak') {
    await sendControlText(jid, formatWorkerContacts(runtime));
    return;
  }
  if (action === 'groups' || action === 'grup') {
    await sendControlText(jid, formatWorkerGroups(runtime));
    return;
  }
  if (action === 'logs') {
    await handleWorkerLogsCommand(session, runtime, message, command);
    return;
  }
  if (action === 'extract') {
    const query = command.rawArgs.trim();
    if (!query) throw new Error('Format: ,extract <nomor|wa.me|nama group>');
    const target = resolveWorkerTarget(runtime, query);
    const filePath = await state.workerLogs.exportText(session.workerId, target.jid, { title: target.title });
    try {
      await sendControlMessage(jid, {
        document: await fs.readFile(filePath),
        mimetype: 'text/plain',
        fileName: `worker-${session.workerId}-${safeFileName(target.title)}.txt`,
        caption: `Extract worker #${session.workerId}: ${target.title}`
      });
    } finally {
      await cleanupFiles([filePath]);
    }
    return;
  }
  if (action === 'send') {
    const { targetText, bodyText } = parseWorkerSendArgs(command.rawArgs);
    if (!targetText) throw new Error('Format: ,send <nomor|kontak|group> [teks]');
    const target = resolveWorkerTarget(runtime, targetText);
    if (bodyText) {
      await runtime.sock.sendMessage(target.jid, { text: bodyText });
      await sendControlText(jid, `Worker #${session.workerId} mengirim pesan ke ${target.title}.`);
      return;
    }
    session.compose = { target };
    await sendControlText(jid, `Compose worker #${session.workerId} ke ${target.title}. Kirim teks/media berikutnya untuk diteruskan.`);
    return;
  }
  await sendControlText(jid, `Command worker tidak dikenal: ${COMMAND_PREFIX}${action}\nKetik ,help.`);
}

async function handleWorkerLogsCommand(session, runtime, message, command) {
  const jid = message.key.remoteJid;
  const sub = (command.args[0] || 'status').toLowerCase();
  if (sub === 'status') {
    await sendControlText(jid, formatWorkerConfig(await state.workerLogs.loadConfig(session.workerId)));
    return;
  }
  if (['off', 'dm', 'all'].includes(sub)) {
    const config = await state.workerLogs.setMode(session.workerId, sub);
    await sendControlText(jid, formatWorkerConfig(config));
    return;
  }
  if (sub === 'list') {
    await sendControlText(jid, formatWorkerConfig(await state.workerLogs.loadConfig(session.workerId)));
    return;
  }
  if (sub === 'add') {
    const query = command.args.slice(1).join(' ').trim();
    if (!query) throw new Error('Format: ,logs add <nomor|group>');
    const target = resolveWorkerTarget(runtime, query);
    const item = await state.workerLogs.addTarget(session.workerId, target);
    await sendControlText(jid, `Target log #${item.id} ditambahkan: ${item.title} (${item.jid}).`);
    return;
  }
  if (sub === 'del') {
    const query = command.args.slice(1).join(' ').trim();
    if (!query) throw new Error('Format: ,logs del <id|target>');
    const item = await state.workerLogs.deleteTarget(session.workerId, query);
    await sendControlText(jid, `Target log #${item.id} ${item.title} dihapus.`);
    return;
  }
  throw new Error('Format: ,logs status|off|dm|all|list|add <target>|del <target>');
}

async function sendWorkerComposeMessage(session, message, text) {
  const runtime = state.accountRuntimes.get(session.workerId);
  if (!runtime?.sock) throw new Error(`Worker #${session.workerId} tidak aktif.`);
  const target = session.compose.target;
  let media = null;
  try {
    media = await downloadQuotedOrOwnMedia(messageSock(message), message, `worker-${session.workerId}-compose`).catch(() => null);
    if (media) {
      await sendDownloadedMediaWithSender(runtime.sock, target.jid, media, { caption: getMessageText(message).trim() });
    } else {
      const body = String(text || '').trim();
      if (!body) throw new Error('Kirim teks atau media untuk compose worker.');
      await runtime.sock.sendMessage(target.jid, { text: body });
    }
    session.compose = null;
    await sendControlText(session.jid, `Worker #${session.workerId} mengirim pesan ke ${target.title}.`);
  } finally {
    await cleanupFiles([media?.path]);
  }
}

async function sendControlText(jid, text) {
  return sendControlMessage(jid, { text });
}

async function sendControlMessage(jid, content, options) {
  const previous = state.commandOutputMode;
  state.commandOutputMode = 'trust';
  try {
    return await sendBotMessage(jid, content, options);
  } finally {
    state.commandOutputMode = previous;
  }
}

function workerControlHelp(workerId) {
  return [
    `Help control worker #${workerId}`,
    `${COMMAND_PREFIX}contacts / ${COMMAND_PREFIX}kontak`,
    `${COMMAND_PREFIX}groups / ${COMMAND_PREFIX}grup`,
    `${COMMAND_PREFIX}logs status|off|dm|all|list|add <target>|del <target>`,
    `${COMMAND_PREFIX}extract <nomor|wa.me|nama group>`,
    `${COMMAND_PREFIX}send <target> [teks]`,
    `${COMMAND_PREFIX}exit`
  ].join('\n');
}

function formatWorkerContacts(runtime) {
  const contacts = [...runtime.contacts.values()]
    .filter((item) => item.jid.endsWith('@s.whatsapp.net') || /^\d+@/.test(item.jid))
    .sort((a, b) => (a.name || a.jid).localeCompare(b.name || b.jid));
  if (!contacts.length) return 'Kontak worker belum tersedia di cache.';
  return ['Kontak worker:', ...contacts.map((item, index) => `${index + 1}. ${item.name || '-'} - ${workerWaLink(item.jid)}`)].join('\n');
}

function formatWorkerGroups(runtime) {
  const groups = [...runtime.groups.values()].sort((a, b) => a.subject.localeCompare(b.subject));
  if (!groups.length) return 'Group worker belum tersedia di cache.';
  return ['Group worker:', ...groups.map((item, index) => `${index + 1}. ${item.subject} - ${item.jid}`)].join('\n');
}

function parseWorkerSendArgs(rawArgs) {
  const text = String(rawArgs || '').trim();
  if (!text) return { targetText: '', bodyText: '' };
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0];
    let escaped = false;
    for (let index = 1; index < text.length; index += 1) {
      const char = text[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) {
        return {
          targetText: text.slice(1, index),
          bodyText: text.slice(index + 1).trim()
        };
      }
    }
  }
  const [targetText, ...body] = text.split(/\s+/);
  return { targetText, bodyText: body.join(' ').trim() };
}

function resolveWorkerTarget(runtime, input) {
  const text = String(input || '').trim();
  if (!text) throw new Error('Target wajib diisi.');
  const waMe = text.match(/wa\.me\/(\d+)/i)?.[1];
  if (waMe) {
    const jid = normalizePhoneToWhatsAppJid(waMe);
    return { jid, title: workerWaLink(jid), type: 'user' };
  }
  const normalizedJid = tryNormalizeJid(text);
  if (normalizedJid) return describeWorkerTarget(runtime, normalizedJid, text);
  const phoneJid = tryNormalizePhoneToWhatsAppJid(text);
  if (phoneJid) return { jid: phoneJid, title: workerWaLink(phoneJid), type: 'user' };
  const key = normalizeLookupText(text);
  const contactMatches = [...runtime.contacts.values()].filter((item) => normalizeLookupText(item.name) === key);
  if (contactMatches.length === 1) return describeWorkerTarget(runtime, contactMatches[0].jid, text);
  const groupMatches = [...runtime.groups.values()].filter((item) => normalizeLookupText(item.subject) === key);
  if (groupMatches.length === 1) return describeWorkerTarget(runtime, groupMatches[0].jid, text);
  const fuzzyGroups = [...runtime.groups.values()].filter((item) => normalizeLookupText(item.subject).includes(key));
  if (fuzzyGroups.length === 1) return describeWorkerTarget(runtime, fuzzyGroups[0].jid, text);
  const resolved = runtime.chatDirectory.resolve(text);
  if (resolved.ok) return { jid: resolved.item.jid, title: resolved.item.currentName || resolved.item.savedName, type: resolved.item.type };
  throw new Error(`Target worker "${text}" tidak ditemukan di cache kontak/group worker.`);
}

function describeWorkerTarget(runtime, jid, input) {
  const group = runtime.groups.get(jid);
  if (group) return { jid, title: group.subject || input || jid, type: 'group' };
  const contact = runtime.contacts.get(jid);
  return { jid, title: contact?.name || input || workerWaLink(jid), type: jid.endsWith('@g.us') ? 'group' : 'user' };
}

function safeFileName(value) {
  return String(value || 'target').replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-').slice(0, 80) || 'target';
}

async function handleRestoreStart(message, actorJid) {
  const jid = message.key.remoteJid;
  assertNoActiveSession(jid);
  await state.restoreSessions.start(jid, actorJid);
  const sent = await sendText(jid, 'Sesi restore dimulai. Kirim file .zip/PART zip sebagai dokumen WhatsApp, lalu ketik ,end dan ,confirm untuk overwrite folder data/. Ketik ,cancel untuk batal.');
  registerSessionPrompt(sent.key, jid, actorJid);
}

async function handleRestartBot(jid) {
  await sendText(jid, 'Restart bot dimulai. Proses akan keluar dengan aman; pastikan supervisor menjalankan ulang bot.');
  await logger.info('restartbot requested', { jid });
  state.scheduler?.stop();
  state.reminderScheduler?.stop();
  state.backupScheduler?.stop();
  state.sock?.end?.(new Error('restartbot'));
  setTimeout(() => process.exit(0), 700).unref?.();
}

async function handleUpdateBot(jid) {
  await sendText(jid, `Menjalankan git pull ${UPDATE_REMOTE} ${UPDATE_BRANCH}...`);
  const pull = await runTool('git', ['pull', UPDATE_REMOTE, UPDATE_BRANCH], { cwd: ROOT_DIR });
  const pullText = formatCommandOutput(pull) || 'git pull selesai tanpa output.';

  if (UPDATE_RESTART_MODE === 'systemctl') {
    await sendText(jid, [
      'Update repo berhasil.',
      pullText,
      '',
      `Restart service ${UPDATE_SYSTEMD_SERVICE} dimulai.`
    ].join('\n'));
    await logger.info('update requested systemctl restart', { jid, service: UPDATE_SYSTEMD_SERVICE });
    try {
      await runTool('systemctl', ['--no-block', 'restart', UPDATE_SYSTEMD_SERVICE]);
    } catch (error) {
      if (!isSystemctlAuthError(error)) throw error;
      await restartSystemctlWithAuthFallback(jid, error);
    }
    return;
  }

  await sendText(jid, [
    'Update repo berhasil.',
    pullText,
    '',
    'Restart mode bukan systemctl, bot akan melakukan graceful exit.'
  ].join('\n'));
  await handleRestartBot(jid);
}

async function restartSystemctlWithAuthFallback(jid, systemctlError) {
  const originalError = commandErrorText(systemctlError);
  if (LINUX_SUDO_PASSWORD && process.platform !== 'win32') {
    await sendText(jid, 'Systemctl butuh authentication. Mencoba sudo dengan LINUX_SUDO_PASSWORD dari .env...');
    try {
      await runToolWithInput('sudo', ['-S', '-p', '', 'systemctl', '--no-block', 'restart', UPDATE_SYSTEMD_SERVICE], `${LINUX_SUDO_PASSWORD}\n`);
      await sendText(jid, `Restart service ${UPDATE_SYSTEMD_SERVICE} via sudo dimulai.`);
      return;
    } catch (sudoError) {
      await logger.error('sudo systemctl restart failed', {
        jid,
        service: UPDATE_SYSTEMD_SERVICE,
        error: sudoError.message,
        stderr: sudoError.stderr
      });
      await sendText(jid, [
        'Sudo restart gagal.',
        commandErrorText(sudoError),
        '',
        'Bot akan fallback ke graceful exit; pastikan supervisor menjalankan ulang proses.'
      ].join('\n'));
      await handleRestartBot(jid);
      return;
    }
  }

  await sendText(jid, [
    'Systemctl butuh authentication, tetapi LINUX_SUDO_PASSWORD belum diisi di .env.',
    originalError,
    '',
    'Bot akan fallback ke graceful exit; pastikan supervisor menjalankan ulang proses.'
  ].join('\n'));
  await handleRestartBot(jid);
}

function isSystemctlAuthError(error) {
  return /interactive authentication required|authentication required|authentication is required|polkit|permission denied/i.test(commandErrorText(error));
}

function commandErrorText(error) {
  const text = [error?.stdout, error?.stderr, error?.message]
    .filter(Boolean)
    .join('\n')
    .trim();
  return formatCommandOutput({ stdout: text }) || 'Error tidak diketahui.';
}

function formatCommandOutput(result) {
  const text = [result?.stdout, result?.stderr]
    .filter(Boolean)
    .join('\n')
    .trim();
  if (!text) return '';
  const lines = text.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  return lines.slice(-12).join('\n').slice(0, 1500);
}

function isNamedMutation(command) {
  const action = command.args[0]?.toLowerCase();
  if (['add', 'rename', 'change'].includes(action)) return true;
  if (['get', 'list'].includes(action)) return false;
  return command.args.length > 1;
}

async function handleCommand(message, command, context = commandContext(message)) {
  const jid = message.key.remoteJid;
  const previousOutputMode = state.commandOutputMode;
  state.commandOutputMode = shouldUseTrustForCommand(command.name, context) ? 'trust' : null;
  try {
    switch (command.name) {
    case 'help':
      await handleHelp(jid, command, context);
      break;
    case 'status':
      if ((command.args[0] || '').toLowerCase() === 'bot') await handleStatusBot(jid);
      else await handleStatus(jid);
      break;
    case 'health':
      await handleHealth(jid);
      break;
    case 'info':
      await handleInfo(message, command);
      break;
    case 'save':
      await handleSave(message, command, context.actorJid);
      break;
    case 'load':
      await handleLoad(message, command, context.actorJid);
      break;
    case 'anticall':
      await handleAnticall(message, command, context.actorJid);
      break;
    case 'note':
      if (!command.args.length || command.args[0]?.toLowerCase() === 'list') {
        await sendNoteList(jid, context.actorJid);
      } else if (command.args[0]?.toLowerCase() === 'del') {
        const query = command.args.slice(1).join(' ').trim();
        if (!query) throw new Error(HELP_DETAILS.note.join('\n'));
        await requestConfirmation(jid, context.actorJid, {
          title: `Hapus note "${query}"`,
          description: 'Note ini akan dihapus permanen.',
          execute: async () => {
            const text = await handleNoteCommand(command);
            invalidateListKind('notes');
            await sendText(jid, text);
          }
        });
      } else {
        const text = await handleNoteCommand(command);
        if (isNamedMutation(command)) invalidateListKind('notes');
        await sendText(jid, text);
      }
      break;
    case 'link':
      if (!command.args.length || command.args[0]?.toLowerCase() === 'list') {
        await sendLinkList(jid, context.actorJid);
      } else if (command.args[0]?.toLowerCase() === 'del') {
        const query = command.args.slice(1).join(' ').trim();
        if (!query) throw new Error(HELP_DETAILS.link.join('\n'));
        await requestConfirmation(jid, context.actorJid, {
          title: `Hapus link "${query}"`,
          description: 'Link ini akan dihapus permanen.',
          execute: async () => {
            const text = await handleLinkCommand(command);
            invalidateListKind('links');
            await sendText(jid, text);
          }
        });
      } else {
        const text = await handleLinkCommand(command);
        if (isNamedMutation(command)) invalidateListKind('links');
        await sendText(jid, text);
      }
      break;
    case 'cancel':
      await handleCancelByJid(jid, context.actorJid);
      break;
    case 'confirm':
      await handleConfirm(jid, context.actorJid);
      break;
    case 's':
      await handleSticker(message, command);
      break;
    case 'smeme':
      await handleSmeme(message, command);
      break;
    case 'rs':
    case 'resend':
      await handleReverseSticker(message, command);
      break;
    case 'task':
      await handleTask(message, command, context.actorJid);
      break;
    case 'ltask':
      await handleListTask(jid, command, context.actorJid);
      break;
    case 'remindme':
      await handleReminder(message, command);
      break;
    case 'topdf':
      await handleTopdf(message, command, context.actorJid);
      break;
    case 'toimg':
      await handleToImg(message);
      break;
    case 'wol':
    case 'won':
      if (!command.args.length || command.args[0]?.toLowerCase() === 'list') {
        await sendWolList(jid, context.actorJid);
      } else if (command.args[0]?.toLowerCase() === 'del') {
        const query = command.args.slice(1).join(' ').trim();
        if (!query) throw new Error(HELP_DETAILS.wol.join('\n'));
        await requestConfirmation(jid, context.actorJid, {
          title: `Hapus WOL "${query}"`,
          description: 'Entry Wake-on-LAN ini akan dihapus permanen.',
          execute: async () => {
            const text = await handleWolCommand(command);
            invalidateListKind('wol');
            await sendText(jid, text);
          }
        });
      } else {
        const text = await handleWolCommand(command);
        if (['add', 'save'].includes(command.args[0]?.toLowerCase())) invalidateListKind('wol');
        await sendText(jid, text);
      }
      break;
    case 'backup':
      await handleBackup(jid);
      break;
    case 'log':
      await handleLog(jid, command);
      break;
    case 'net':
      await handleNet(jid);
      break;
    case 'button':
      await handleButton(message, command);
      break;
    case 'config':
      await handleConfigCommand(message, command, context);
      break;
    case 'changedmsg':
      await handleChangedMsgCommand(message, command, context);
      break;
    case 'restore':
      await handleRestoreStart(message, context.actorJid);
      break;
    case 'clear':
      await requestConfirmation(jid, context.actorJid, {
        title: 'Hapus temp',
        description: 'Semua file sementara di temp/ akan dibersihkan.',
        execute: async () => handleClear(jid)
      });
      break;
    case 'restartbot':
      await requestConfirmation(jid, context.actorJid, {
        title: 'Restart bot',
        description: 'Proses bot akan keluar dan perlu dinyalakan ulang oleh supervisor.',
        execute: async () => handleRestartBot(jid)
      });
      break;
    case 'allow':
      await handleAllow(message, command);
      break;
    case 'admin':
      await handleAdminCommand(message, command, context);
      break;
    case 'bot':
      await handleBotCommand(message, command, context);
      break;
    case 'jadibot':
      await handleJadibotCommand(message, command, context);
      break;
    case 'update':
      await requestConfirmation(jid, context.actorJid, {
        title: 'Update repo dan restart service',
        description: `Akan menjalankan git pull ${UPDATE_REMOTE} ${UPDATE_BRANCH}, lalu restart ${UPDATE_SYSTEMD_SERVICE}.`,
        execute: async () => handleUpdateBot(jid)
      });
      break;
    case 'end':
      await handleEndSession(jid, context.actorJid);
      break;
    default:
      await sendText(jid, `Command tidak dikenal: ${COMMAND_PREFIX}${command.name}\nKetik ,help`);
      break;
    }
  } finally {
    state.commandOutputMode = previousOutputMode;
  }
}

function shouldUseTrustForCommand(commandName, context) {
  if (!context?.isOwner || !state.multiAccount?.isMulti?.()) return false;
  if (!trustRuntime()) return false;
  return !new Set([
    'admin',
    'allow',
    'anticall',
    'backup',
    'bot',
    'changedmsg',
    'clear',
    'config',
    'jadibot',
    'log',
    'restore',
    'restartbot',
    'update'
  ]).has(String(commandName || '').toLowerCase());
}

async function onMessageUpsert(event, runtime = primaryRuntime()) {
  for (const message of event.messages || []) {
    attachRuntime(message, runtime);
    if (!message.message || !message.key?.remoteJid) continue;
    if (message.key.remoteJid === 'status@broadcast') {
      continue;
    }
    const jid = message.key.remoteJid;
    const text = getMessageText(message);
    const command = parseCommand(text);
    const context = commandContext(message);
    const isOwner = Boolean(context.isOwner);
    if (message.key?.fromMe && isIgnoredOwnOutput(message, runtime)) continue;
    try {
      if (await maybeCancelActivePairingFromInput(context, text, command)) {
        // The input still continues through normal command handling after the QR session stops.
      }
      if (await maybeHandleWorkerControlInput(message, text, command, context)) continue;
      if (!isBotEnabled()) {
        if (context.isOwner && command?.name === 'bot') await handleCommand(message, command, context);
        continue;
      }

      rememberMessageDirectory(message);
      state.viewOnceCache.remember(message);
      if (!message.message?.protocolMessage) await maybeMirrorChangedMessage(message);

      const sessionActive = activeSessionType(jid);
      const sessionActorMatches = activeSessionActorMatches(jid, context.actorJid);
      if (sessionActive && !sessionActorMatches && (!command || ['end', 'cancel', 'confirm'].includes(command.name))) {
        continue;
      }

      if (sessionActorMatches && state.saveRecorder.has(jid) && (!command || !['end', 'cancel'].includes(command.name))) {
        await state.saveRecorder.record(messageSock(message), message);
        continue;
      }
      if (sessionActorMatches && state.anticall.has(jid) && (!command || !['end', 'cancel'].includes(command.name))) {
        await state.anticall.record(messageSock(message), message);
        continue;
      }
      if (sessionActorMatches && state.restoreSessions.has(jid) && (!command || !['end', 'cancel', 'confirm'].includes(command.name))) {
        await maybeCollectRestorePart(message);
        continue;
      }
      if (!command && !state.pdfSessions.has(jid) && context.isOwner && await maybeHandleSecretMediaTrigger(message, text)) {
        continue;
      }
      if (command) {
        if (!state.commandAccess?.canUseAs(command.name, jid, context.actorJid, { owner: context.isOwner })) continue;
        await handleCommand(message, command, context);
      } else {
        if (sessionActorMatches) await maybeCollectPdfItem(message, text);
      }
    } catch (error) {
      await logger.error('Command error', { jid, error: error.message, text });
      await sendText(jid, `Error: ${error.message}`);
    }
  }
}

async function onMessagesUpdate(updates) {
  if (!isBotEnabled()) return;
  for (const update of updates || []) {
    try {
      if (update?.update?.message?.editedMessage?.message) {
        await handleChangedEdit(update);
        continue;
      }
      if (update?.update?.messageStubType === WAMessageStubType.REVOKE || update?.update?.message === null) {
        await handleChangedDelete(update.key);
      }
    } catch (error) {
      await logger.error('Changed message update error', {
        jid: update?.key?.remoteJid,
        id: update?.key?.id,
        error: error.message
      });
    }
  }
}

async function onMessagesDelete(update) {
  if (!isBotEnabled()) return;
  try {
    if (update?.all) {
      await logger.info('Messages delete all event ignored', { jid: update.jid });
      return;
    }
    for (const key of update?.keys || []) await handleChangedDelete(key);
  } catch (error) {
    await logger.error('Messages delete error', { error: error.message });
  }
}

async function onMessagesReaction(updates, runtime = primaryRuntime()) {
  if (!isBotEnabled()) return;
  for (const update of updates || []) {
    const intent = reactionIntent(update?.reaction?.text);
    if (!intent) continue;
    const actorJid = reactionActorJid(update, runtime);
    const action = state.reactionActions.get(update.key, actorJid);
    if (!action) continue;
    try {
      const handler = intent === 'confirm' ? action.onConfirm : action.onCancel;
      if (!handler) continue;
      state.reactionActions.delete(update.key);
      await handler(update);
    } catch (error) {
      await logger.error('Reaction action error', {
        jid: update?.key?.remoteJid,
        actorJid,
        error: error.message
      });
      if (update?.key?.remoteJid) await sendText(update.key.remoteJid, `Error: ${error.message}`);
    }
  }
}

function rememberMessageDirectory(message) {
  const remoteJid = message.key?.remoteJid;
  if (!remoteJid) return;
  state.chatDirectory.remember(remoteJid);
  if (!remoteJid.endsWith('@g.us')) state.chatDirectory.remember(remoteJid, message.pushName);
  if (message.key?.participant) state.chatDirectory.remember(message.key.participant, message.pushName);
}

async function loadGroups(sock) {
  try {
    const groups = await sock.groupFetchAllParticipating();
    for (const group of Object.values(groups || {})) {
      state.chatDirectory.remember(group.id, group.subject);
    }
    await logger.info('Loaded groups', { count: Object.keys(groups || {}).length });
  } catch (error) {
    await logger.warn('Could not fetch groups', { error: error.message });
  }
}

async function loadGroupsForRuntime(runtime) {
  try {
    const groups = await runtime.sock.groupFetchAllParticipating();
    for (const group of Object.values(groups || {})) rememberRuntimeGroup(runtime, group);
    if (runtime.account.id === 1) {
      for (const group of Object.values(groups || {})) state.chatDirectory.remember(group.id, group.subject);
    }
    await logger.info('Loaded account groups', { accountId: runtime.account.id, count: Object.keys(groups || {}).length });
  } catch (error) {
    await logger.warn('Could not fetch account groups', { accountId: runtime.account.id, error: error.message });
  }
}

function createRuntime(account) {
  const existing = state.accountRuntimes.get(account.id);
  const runtime = existing || {
    account,
    sock: null,
    status: account.status || 'disconnected',
    ignoredOwnMessageIds: new Set(),
    chatDirectory: new ChatDirectory(),
    contacts: new Map(),
    groups: new Map(),
    reconnecting: false,
    stopReconnect: false,
    pairing: null
  };
  runtime.account = account;
  runtime.status = account.status || runtime.status || 'disconnected';
  state.accountRuntimes.set(account.id, runtime);
  return runtime;
}

function rememberRuntimeContact(runtime, contact = {}) {
  const jid = tryNormalizeJid(contact.id || contact.jid);
  if (!jid) return;
  const name = contact.name || contact.notify || contact.verifiedName || contact.pushName || contact.shortName || '';
  runtime.contacts.set(jid, {
    jid,
    name: String(name || '').trim(),
    updatedAt: new Date().toISOString()
  });
  runtime.chatDirectory.remember(jid, name);
}

function rememberRuntimeChat(runtime, chat = {}) {
  const jid = tryNormalizeJid(chat.id || chat.jid);
  if (!jid) return;
  const name = chat.name || chat.subject || chat.pushName || '';
  runtime.chatDirectory.remember(jid, name);
  if (jid.endsWith('@g.us')) {
    runtime.groups.set(jid, {
      jid,
      subject: String(name || '').trim() || jid,
      updatedAt: new Date().toISOString()
    });
  }
}

function rememberRuntimeGroup(runtime, group = {}) {
  const jid = tryNormalizeJid(group.id || group.jid);
  if (!jid) return;
  const subject = String(group.subject || group.name || jid).trim();
  runtime.groups.set(jid, {
    jid,
    subject,
    participants: Array.isArray(group.participants) ? group.participants.length : undefined,
    updatedAt: new Date().toISOString()
  });
  runtime.chatDirectory.remember(jid, subject);
}

function rememberRuntimeMessageDirectory(runtime, message) {
  const remoteJid = message.key?.remoteJid;
  if (!remoteJid) return;
  runtime.chatDirectory.remember(remoteJid);
  if (!remoteJid.endsWith('@g.us')) {
    runtime.chatDirectory.remember(remoteJid, message.pushName);
    if (message.pushName) {
      runtime.contacts.set(remoteJid, {
        jid: remoteJid,
        name: message.pushName,
        updatedAt: new Date().toISOString()
      });
    }
  }
  if (message.key?.participant) runtime.chatDirectory.remember(message.key.participant, message.pushName);
}

async function onSecondaryMessageUpsert(runtime, event) {
  for (const message of event.messages || []) {
    attachRuntime(message, runtime);
    if (!message.message || !message.key?.remoteJid || message.key.remoteJid === 'status@broadcast') continue;
    if (message.key?.fromMe && isIgnoredOwnOutput(message, runtime)) continue;

    rememberRuntimeMessageDirectory(runtime, message);
    if (runtime.account.role === 'trust') {
      await handleTrustMessage(runtime, message);
      continue;
    }
    if (runtime.account.role === 'worker') {
      await maybeLogWorkerMessage(runtime, message);
    }
  }
}

async function handleTrustMessage(runtime, message) {
  const text = getMessageText(message);
  const command = parseCommand(text);
  const context = commandContext(message);
  try {
    if (await maybeCancelActivePairingFromInput(context, text, command)) {
      // Continue handling the new input after stopping the QR session.
    }
    if (await maybeHandleWorkerControlInput(message, text, command, context)) return;
    if (!command || !context.isOwner) return;
    if (!isBotEnabled() && command.name !== 'bot') return;
    if (!state.commandAccess?.canUseAs(command.name, message.key.remoteJid, context.actorJid, { owner: context.isOwner })) return;
    await handleCommand(message, command, context);
  } catch (error) {
    await logger.error('Trust command error', { accountId: runtime.account.id, jid: message.key.remoteJid, error: error.message, text });
    await sendText(message.key.remoteJid, `Error: ${error.message}`);
  }
}

async function maybeLogWorkerMessage(runtime, message) {
  if (!state.workerLogs || !runtime?.sock) return false;
  if (isDestinationChat(message.key?.remoteJid)) return false;
  if (!await state.workerLogs.shouldLog(runtime.account.id, message)) return false;

  const actorJid = messageActorJid(message);
  const entry = await state.workerLogs.append(runtime.account.id, createWorkerLogEntry(runtime.account, message, {
    actorJid,
    actorName: runtime.chatDirectory.nameFor(actorJid) || message.pushName || '',
    remoteName: runtime.chatDirectory.nameFor(message.key.remoteJid) || runtime.groups.get(message.key.remoteJid)?.subject || ''
  }));
  const header = formatWorkerLogHeader(entry);
  const targets = [...new Set([safeDestinationJid('workerDev'), safeDestinationJid('workerLogs')].filter(Boolean))];
  if (!targets.length) return true;

  for (const target of targets) {
    try {
      const sentHeader = await runtime.sock.sendMessage(target, { text: header });
      rememberOwnOutput(sentHeader, runtime);
      if (mediaNode(message)) await forwardWorkerLogMedia(runtime, target, message);
    } catch (error) {
      await logger.warn('Worker log send failed', { accountId: runtime.account.id, target, error: error.message });
    }
  }
  return true;
}

async function forwardWorkerLogMedia(runtime, target, message) {
  let media = null;
  try {
    if (isViewOnceMediaMessage(message)) {
      media = await downloadMessageMedia(runtime.sock, message, `worker-${runtime.account.id}-viewonce`);
      if (!media) return;
      const stat = await fs.stat(media.path).catch(() => null);
      const maxBytes = state.runtimeConfig?.workerLogsSettings?.().maxMediaBytes || 25 * 1024 * 1024;
      if (stat?.size && stat.size > maxBytes) {
        const sent = await runtime.sock.sendMessage(target, { text: `Media dilewati karena ${formatBytes(stat.size)} melebihi batas ${formatBytes(maxBytes)}.` });
        rememberOwnOutput(sent, runtime);
        return;
      }
      const sent = await sendDownloadedMediaWithSender(runtime.sock, target, media, { caption: media.node?.caption });
      rememberOwnOutput(sent, runtime);
      return;
    }
    const sent = await runtime.sock.sendMessage(target, { forward: message, force: true });
    rememberOwnOutput(sent, runtime);
  } finally {
    await cleanupFiles([media?.path]);
  }
}

function rememberRejectedCall(id) {
  if (!id) return false;
  if (state.rejectedCallIds.has(id)) return true;
  state.rejectedCallIds.add(id);
  setTimeout(() => state.rejectedCallIds.delete(id), 10 * 60 * 1000).unref?.();
  return false;
}

async function onCallUpdate(calls) {
  for (const call of calls || []) {
    try {
      await maybeRejectCall(call);
    } catch (error) {
      await logger.error('Anticall error', {
        callId: call?.id,
        from: call?.from,
        chatId: call?.chatId,
        error: error.message
      });
    }
  }
}

async function maybeRejectCall(call) {
  if (!isBotEnabled()) return false;
  const snapshot = state.anticall?.snapshot();
  if (!snapshot?.enabled || !snapshot.hasMessage) return false;
  if (call?.status !== 'offer') return false;
  if (call.isGroup || call.chatId?.endsWith('@g.us') || call.from?.endsWith('@g.us')) return false;
  if (rememberRejectedCall(call.id)) return false;

  const caller = call.from || call.chatId;
  const chatJid = call.chatId || caller;
  if (!caller || !chatJid) return false;
  if (state.anticall.isException(caller) || state.anticall.isException(chatJid)) {
    await logger.info('Allowed call via anticall exception', { callId: call.id, caller, chatJid });
    return false;
  }
  await state.sock.rejectCall(call.id, caller);
  await state.anticall.send(botSender(), chatJid);
  await logger.info('Rejected call via anticall', { callId: call.id, caller, chatJid });
  return true;
}

async function connect() {
  await connectAccount(state.multiAccount.getPrimary());
  if (state.multiAccount.isMulti()) {
    for (const account of state.multiAccount.listAccounts().filter((item) => item.id !== 1)) {
      connectAccount(account).catch((error) => logger.error('Secondary connect failed', { accountId: account.id, error: error.message }));
    }
  }
}

async function connectAccount(account, options = {}) {
  const runtime = createRuntime(account);
  runtime.stopReconnect = false;
  if (options.pairing) {
    runtime.pairing = {
      ...options.pairing,
      qrCount: options.pairing.qrCount || 0,
      qrLimit: options.pairing.qrLimit || 5,
      expiresTimer: null,
      connected: false,
      cancelled: false
    };
    state.activePairing = {
      accountId: account.id,
      actorJid: options.pairing.actorJid,
      chatJid: options.pairing.chatJid
    };
  }

  const { state: authState, saveCreds } = await useMultiFileAuthState(accountAuthPath(account, ROOT_DIR));
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    auth: authState,
    version,
    emitOwnEvents: true,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    logger: pino({ level: 'silent' }),
    browser: [`IrOBot-${account.role}-${account.id}`, 'Chrome', '1.0.0']
  });

  runtime.sock = sock;
  runtime.status = 'connecting';
  runtime.account = await state.multiAccount.updateAccount(account.id, { status: 'connecting', lastError: null });

  if (account.id === 1) {
    state.sock = sock;
    state.scheduler?.stop();
    state.scheduler = new TaskScheduler(schedulerSock(), state.chatDirectory, logger);
    state.reminderScheduler?.stop();
    state.reminderScheduler = new ReminderScheduler(schedulerSock(), state.chatDirectory, logger);
  }

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('messages.upsert', (event) => {
    if (runtime.account.id === 1) onMessageUpsert(event, runtime);
    else onSecondaryMessageUpsert(runtime, event);
  });
  if (account.id === 1) {
    sock.ev.on('messages.update', onMessagesUpdate);
    sock.ev.on('messages.delete', onMessagesDelete);
    sock.ev.on('call', onCallUpdate);
  }
  sock.ev.on('messages.reaction', (updates) => onMessagesReaction(updates, runtime));
  sock.ev.on('contacts.upsert', (contacts) => {
    for (const contact of contacts || []) rememberRuntimeContact(runtime, contact);
  });
  sock.ev.on('contacts.update', (contacts) => {
    for (const contact of contacts || []) rememberRuntimeContact(runtime, contact);
  });
  sock.ev.on('chats.upsert', (chats) => {
    for (const chat of chats || []) {
      rememberRuntimeChat(runtime, chat);
      if (runtime.account.id === 1 || runtime.account.role === 'trust') state.chatDirectory.remember(chat.id, chat.name || chat.subject);
    }
  });
  sock.ev.on('chats.update', (chats) => {
    for (const chat of chats || []) {
      rememberRuntimeChat(runtime, chat);
      if (runtime.account.id === 1 || runtime.account.role === 'trust') state.chatDirectory.remember(chat.id, chat.name || chat.subject);
    }
  });
  sock.ev.on('groups.upsert', (groups) => {
    for (const group of groups || []) {
      rememberRuntimeGroup(runtime, group);
      if (runtime.account.id === 1 || runtime.account.role === 'trust') state.chatDirectory.remember(group.id, group.subject);
    }
  });
  sock.ev.on('groups.update', (groups) => {
    for (const group of groups || []) {
      rememberRuntimeGroup(runtime, group);
      if (runtime.account.id === 1 || runtime.account.role === 'trust') state.chatDirectory.remember(group.id, group.subject);
    }
  });
  sock.ev.on('connection.update', (update) => handleConnectionUpdate(runtime, update));
  return runtime;
}

function schedulerSock() {
  return trustRuntime()?.sock || state.sock;
}

function refreshSchedulerSock() {
  const sock = schedulerSock();
  if (state.scheduler) state.scheduler.sock = sock;
  if (state.reminderScheduler) state.reminderScheduler.sock = sock;
}

async function handleConnectionUpdate(runtime, update) {
  const { connection, lastDisconnect, qr } = update;
  if (qr) await handleAccountQr(runtime, qr);
  if (connection === 'open') await handleAccountOpen(runtime);
  if (connection === 'close') await handleAccountClose(runtime, lastDisconnect);
}

async function handleAccountQr(runtime, qr) {
  runtime.status = 'qr';
  runtime.account = await state.multiAccount.updateAccount(runtime.account.id, {
    status: 'qr',
    lastQrAt: new Date().toISOString(),
    lastError: null
  });
  if (runtime.account.id === 1) {
    console.log(await QRCode.toString(qr, { type: 'terminal', small: true }));
    return;
  }
  if (!runtime.pairing || runtime.pairing.cancelled) return;
  if (runtime.pairing.qrCount >= runtime.pairing.qrLimit) {
    await stopPairingRuntime(runtime, 'QR pairing melebihi batas 5 kali.');
    return;
  }
  runtime.pairing.qrCount += 1;
  if (runtime.pairing.expiresTimer) clearTimeout(runtime.pairing.expiresTimer);
  const buffer = await QRCode.toBuffer(qr, { type: 'png', margin: 1, width: 512 });
  await sendPrimaryMessage(runtime.pairing.chatJid, {
    image: buffer,
    caption: [
      `QR akun bot #${runtime.account.id}`,
      `Percobaan: ${runtime.pairing.qrCount}/${runtime.pairing.qrLimit}`,
      'Scan QR ini dari perangkat WhatsApp yang ingin dijadikan bot.'
    ].join('\n')
  });
  runtime.pairing.expiresTimer = setTimeout(() => {
    if (!runtime.pairing?.connected && runtime.pairing.qrCount >= runtime.pairing.qrLimit) {
      stopPairingRuntime(runtime, 'QR pairing kadaluarsa setelah 5 kali percobaan.').catch((error) => {
        logger.warn('Stop pairing failed', { accountId: runtime.account.id, error: error.message });
      });
    }
  }, 65_000);
  runtime.pairing.expiresTimer.unref?.();
}

async function handleAccountOpen(runtime) {
  runtime.status = 'connected';
  const jid = ownUserJid(runtime);
  runtime.account = await state.multiAccount.updateAccount(runtime.account.id, {
    status: 'connected',
    jid,
    phone: displayPhoneFromJid(jid),
    name: runtime.sock?.user?.name || runtime.sock?.user?.verifiedName || runtime.account.name,
    lastConnectedAt: new Date().toISOString(),
    lastError: null
  });
  console.log(`WhatsApp account #${runtime.account.id} connected.`);
  await logger.info('WhatsApp connected', { accountId: runtime.account.id, role: runtime.account.role, jid });
  await loadGroupsForRuntime(runtime);
  if (runtime.account.id === 1) {
    await hydrateConfiguredDestinations();
    applyBotRuntimeState();
  }
  if (runtime.account.role === 'trust') refreshSchedulerSock();
  if (runtime.pairing) {
    runtime.pairing.connected = true;
    if (runtime.pairing.expiresTimer) clearTimeout(runtime.pairing.expiresTimer);
    state.activePairing = null;
    await sendPrimaryMessage(runtime.pairing.chatJid, {
      text: `Bot #${runtime.account.id} ${runtime.account.name || accountWaLink(runtime.account)} telah aktif.`
    });
    runtime.pairing = null;
  }
}

async function handleAccountClose(runtime, lastDisconnect) {
  if (runtime.account.id === 1) {
    state.scheduler?.stop();
    state.reminderScheduler?.stop();
    state.backupScheduler?.stop();
  }
  const canReconnect = shouldReconnect(lastDisconnect);
  const reconnect = canReconnect && !runtime.stopReconnect;
  const status = canReconnect ? 'disconnected' : 'logged_out';
  runtime.status = status;
  runtime.account = await state.multiAccount.updateAccount(runtime.account.id, {
    status,
    lastError: lastDisconnect?.error?.message || null
  }).catch(() => runtime.account);
  await logger.warn('Connection closed', { accountId: runtime.account.id, error: lastDisconnect?.error?.message });
  if (runtime.account.role === 'trust') refreshSchedulerSock();

  if (runtime.pairing && runtime.pairing.qrCount >= runtime.pairing.qrLimit) {
    await stopPairingRuntime(runtime, 'QR pairing gagal tersambung setelah 5 kali percobaan.');
    return;
  }
  if (reconnect && !runtime.reconnecting) {
    runtime.reconnecting = true;
    setTimeout(() => {
      runtime.reconnecting = false;
      connectAccount(runtime.account, runtime.pairing ? { pairing: runtime.pairing } : {}).catch((error) => logger.error('Reconnect failed', {
        accountId: runtime.account.id,
        error: error.message
      }));
    }, 3000);
  } else if (!reconnect && runtime.account.id === 1) {
    console.log('Logged out. Hapus folder auth lalu scan ulang jika ingin login lagi.');
  }
}

async function sendPrimaryMessage(jid, content, options) {
  const runtime = primaryRuntime();
  if (!runtime?.sock) throw new Error('Akun primary belum siap.');
  const sent = await runtime.sock.sendMessage(jid, content, options);
  rememberOwnOutput(sent, runtime);
  return sent;
}

async function stopPairingRuntime(runtime, reason) {
  if (!runtime?.pairing) return false;
  runtime.pairing.cancelled = true;
  runtime.stopReconnect = true;
  if (runtime.pairing.expiresTimer) clearTimeout(runtime.pairing.expiresTimer);
  const chatJid = runtime.pairing.chatJid;
  state.activePairing = null;
  runtime.pairing = null;
  runtime.sock?.end?.(new Error(reason));
  runtime.account = await state.multiAccount.updateAccount(runtime.account.id, {
    status: 'disconnected',
    lastError: reason
  }).catch(() => runtime.account);
  if (chatJid) await sendPrimaryMessage(chatJid, { text: `Sesi QR bot #${runtime.account.id} berhenti: ${reason}` }).catch(() => {});
  return true;
}

async function maybeCancelActivePairingFromInput(context, text, command) {
  if (!state.activePairing || !context?.isOwner || !String(text || '').trim()) return false;
  const runtime = state.accountRuntimes.get(state.activePairing.accountId);
  if (!runtime?.pairing) return false;
  if (command?.name === 'confirm') return false;
  return stopPairingRuntime(runtime, 'super admin mengirim input lain.');
}

async function maybeLogSystemdTip() {
  if (process.platform !== 'linux' || process.env.INVOCATION_ID) return;
  const hasSystemctl = await fileExists('/bin/systemctl') || await fileExists('/usr/bin/systemctl');
  if (!hasSystemctl) return;
  const serviceName = UPDATE_SYSTEMD_SERVICE.endsWith('.service') ? UPDATE_SYSTEMD_SERVICE : `${UPDATE_SYSTEMD_SERVICE}.service`;
  const systemService = path.join('/etc/systemd/system', serviceName);
  const userService = path.join(os.homedir(), '.config', 'systemd', 'user', serviceName);
  if (await fileExists(systemService) || await fileExists(userService)) return;
  const tip = 'Tip: run npm run service:install agar bot auto-start setelah reboot/crash.';
  console.log(tip);
  await logger.info(tip);
}

async function main() {
  await ensureRuntimeDirs();
  await cleanupStartupTemp();
  await cleanupOldLogs();
  await maybeLogSystemdTip();
  state.commandAccess = new CommandAccessStore();
  await state.commandAccess.load();
  state.botState = new BotStateStore();
  await state.botState.load();
  state.runtimeConfig = new RuntimeConfigStore();
  await state.runtimeConfig.load();
  state.changedMessages = new ChangedMessageStore();
  await state.changedMessages.load();
  state.multiAccount = new MultiAccountStore();
  await state.multiAccount.load();
  state.workerLogs = new WorkerLogStore(WORKER_LOG_DIR);
  state.tools = await detectTools();
  state.pdfSessions = new PdfSessions(state.tools);
  state.restoreSessions = new RestoreSessions();
  state.saveRecorder = new SaveRecorder();
  state.anticall = new AnticallStore();
  await state.anticall.load();
  state.backupScheduler = new DailyBackupScheduler(
    logger,
    async () => sendDataBackupToWhatsApp(primaryBotSender(), destinationJid('backup'), {
      partSizeBytes: state.runtimeConfig.backupPartSizeBytes()
    }),
    {
      shouldRun: () => state.runtimeConfig.isBackupAutoDaily(),
      dailyTimeWib: () => state.runtimeConfig.dailyBackupTimeWib()
    }
  );
  if (isBotEnabled()) state.backupScheduler.start();
  await logger.info('Detected tools', state.tools);
  console.log('Tool check:', {
    ffmpeg: Boolean(state.tools.ffmpeg),
    ffprobe: Boolean(state.tools.ffprobe),
    office: Boolean(state.tools.office),
    pdftoppm: Boolean(state.tools.pdftoppm),
    magick: Boolean(state.tools.magick)
  });
  await connect();
}

process.on('SIGINT', async () => {
  await logger.info('SIGINT received');
  state.scheduler?.stop();
  state.reminderScheduler?.stop();
  state.backupScheduler?.stop();
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { error: reason?.message || String(reason) });
});

main().catch(async (error) => {
  await logger.error('Fatal startup error', { error: error.message });
  console.error(error);
  process.exit(1);
});
