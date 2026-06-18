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
import { isAnimatedMedia, makeSmemeSticker, makeSticker, parseSmemeArgs, parseStickerMeta, reverseSticker } from './sticker.js';
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
import { StatusSaveStore } from './statusSave.js';
import {
  displayPhoneFromJid,
  normalizePhoneToJid as normalizePhoneToWhatsAppJid,
  sameJid,
  tryNormalizeJid,
  tryNormalizePhoneToJid as tryNormalizePhoneToWhatsAppJid
} from './phone.js';
import { AnticallStore, formatAnticallStatus } from './anticall.js';

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
  statusSave: null,
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

function ownUserJid() {
  const raw = state.sock?.user?.id || state.sock?.authState?.creds?.me?.id || '';
  return raw ? jidNormalizedUser(raw) : 'me';
}

function messageActorJid(message) {
  if (message?.key?.fromMe) return ownUserJid();
  const raw = getKeyAuthor(message?.key, ownUserJid());
  return raw ? jidNormalizedUser(raw) : '';
}

function reactionActorJid(update) {
  const raw = getKeyAuthor(update?.reaction?.key, ownUserJid());
  return raw ? jidNormalizedUser(raw) : '';
}

function sameActor(left, right) {
  if (!left || !right) return false;
  return left === right || areJidsSameUser(left, right) || sameJid(left, right);
}

function commandContext(message) {
  const actorJid = messageActorJid(message);
  const isOwner = Boolean(message.key?.fromMe);
  const isAdmin = !isOwner && state.commandAccess?.isAdmin(actorJid);
  return {
    actorJid,
    isOwner,
    isAdmin,
    publicOpen: state.commandAccess?.isOpen(message.key.remoteJid) || false
  };
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
  const sent = await state.sock.sendMessage(jid, content, options);
  rememberOwnOutput(sent);
  return sent;
}

function rememberOwnOutput(message) {
  const id = message?.key?.id;
  if (!id) return;
  state.ignoredOwnMessageIds.add(id);
  setTimeout(() => state.ignoredOwnMessageIds.delete(id), 5 * 60 * 1000).unref?.();
}

function botSender() {
  return {
    sendMessage: (jid, content, options) => sendBotMessage(jid, content, options)
  };
}

function isIgnoredOwnOutput(message) {
  const id = message?.key?.id;
  if (!id || !state.ignoredOwnMessageIds.has(id)) return false;
  state.ignoredOwnMessageIds.delete(id);
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
      { name: 'anticall', text: ',anticall Kelola anti-call' },
      { name: 'changedmsg', text: ',changedmsg Pantau pesan edit/hapus' },
      { name: 'statussave', text: ',statussave Simpan status WA' },
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
  help: ['Format: ,help <command>', 'Contoh: ,help s, ,help task.'],
  s: ['Format: ,s', 'Format: ,s <title>', 'Format: ,s <title>,<author>', 'Kirim/reply media atau sertakan URL media.'],
  smeme: ['Format: ,smeme up <teks>', 'Format: ,smeme down <teks>', 'Advanced: tambah kualitas 1-99 di akhir.'],
  resend: ['Format: ,resend', 'Legacy: ,rs', 'Reply media/view-once. Sticker statis dikirim sebagai PNG, sticker bergerak sebagai GIF.'],
  status: ['Format: ,status atau ,status bot', ',status menampilkan server ringkas. ,status bot menampilkan destination, scheduler, changedmsg, statussave, dan warning nama grup duplikat.'],
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
  statussave: ['Format: ,statussave list|add|del <nomor|id>', 'Nomor menerima 081..., +62 123-1234-1234, atau +6212312341234. Status teks dan media dikirim ke dest.saved.'],
  backup: ['Format: ,backup', 'Backup data/ dikirim sebagai dokumen WhatsApp ke dest.backup. Ubah tujuan dengan ,config set dest.backup <group|nomor>.'],
  restore: ['Format: ,restore', 'Mulai sesi restore ZIP lewat WhatsApp. Kirim part ZIP, lalu ,end dan ,confirm.'],
  anticall: ['Format: ,anticall', 'Format: ,anticall new|on|off', 'Format: ,anticall except list|add|del <nomor|id>'],
  allow: ['Format: ,allow here on|off', 'Format: ,allow all on|off', 'Legacy true|false tetap didukung.'],
  admin: ['Format: ,admin list', 'Format: ,admin add <nomor>', 'Format: ,admin del <nomor|id>'],
  bot: ['Format: ,bot, ,bot on, ,bot off', ',bot off mem-pause command, session, scheduler, backup otomatis, changedmsg, statussave, dan anticall.'],
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
    await handleHelpDetail(jid, query, context);
    return;
  }
  const lines = [
    `${BOT_NAME} Help`,
    '',
    'Pakai:',
    `${COMMAND_PREFIX}help <command>`,
    `Contoh: ${COMMAND_PREFIX}help s`
  ];
  for (const section of HELP_SECTIONS) {
    const items = section.items.filter((item) => canShowHelpItem(item.name, jid, context));
    if (!items.length) continue;
    lines.push('', `${section.title}:`, ...items.map((item) => item.text));
  }
  const detailExamples = ['note', 'task', 'topdf'].filter((name) => canShowHelpItem(name, jid, context));
  if (detailExamples.length) lines.push('', 'Detail:', ...detailExamples.map((name) => `${COMMAND_PREFIX}help ${name}`));
  await sendText(jid, lines.join('\n'));
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
  const statusSave = state.statusSave?.snapshot() || { count: 0 };
  const changedSettings = state.runtimeConfig?.changedmsgSettings?.() || { enabled: true };
  const statusSettings = state.runtimeConfig?.statussaveSettings?.() || { enabled: true };
  const warnings = await botStatusWarnings();
  await sendText(jid, [
    `${BOT_NAME} bot status:`,
    `Bot: ${botState.enabled ? 'on' : 'off'}`,
    `Public access: all=${Boolean(access.all)}, chats=${access.chatCount || 0}, admins=${access.adminCount || 0}`,
    `Schedulers: task=${state.scheduler?.isRunning?.() ? 'running' : 'stopped'}, remind=${state.reminderScheduler?.isRunning?.() ? 'running' : 'stopped'}, backup=${state.backupScheduler?.isRunning?.() ? 'running' : 'stopped'}`,
    `Dest logs: ${formatDestinationLine('logs')}`,
    `Dest changedmsg: ${formatDestinationLine('changedmsg')}`,
    `Dest saved: ${formatDestinationLine('saved')}`,
    `Dest backup: ${formatDestinationLine('backup')}`,
    `Changedmsg: ${changedSettings.enabled ? 'aktif' : 'nonaktif'}, group allowlist=${changed.allowedCount || 0}, index=${changed.indexCount || 0}`,
    `Statussave: ${statusSettings.enabled ? 'aktif' : 'nonaktif'}, nomor=${statusSave.count || 0}`,
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

  for (const name of ['logs', 'changedmsg', 'saved', 'backup']) {
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
  const statusSettings = state.runtimeConfig?.statussaveSettings?.() || { enabled: false };
  if (changedSettings.enabled) {
    for (const name of ['logs', 'changedmsg']) {
      try {
        resolveConfiguredDestination(name);
      } catch {
        warnings.push(`Changedmsg aktif tapi dest.${name} belum valid.`);
      }
    }
  }
  if (statusSettings.enabled) {
    try {
      resolveConfiguredDestination('saved');
    } catch {
      warnings.push('Statussave aktif tapi dest.saved belum valid.');
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
  for (const key of ['dest.logs', 'dest.changedmsg', 'dest.saved', 'dest.backup']) {
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
    media = await downloadQuotedOrOwnMedia(state.sock, message, 'sticker-source');
    if (!media) media = await downloadUrlMedia(command.rawArgs, 'sticker-url');
    if (!media) throw new Error('Kirim/reply media atau sertakan URL media yang valid.');
    const animated = await isAnimatedMedia(media);
    const sticker = await makeSticker(media, { author: meta.author, title: meta.title, tools: state.tools });
    await sendBotMessage(jid, { sticker, mimetype: 'image/webp', isAnimated: animated || undefined });
    if (message.key?.fromMe && media.url) await sendStickerFileCopy(jid, sticker);
  } finally {
    await cleanupFiles([media?.path]);
  }
}

async function sendStickerFileCopy(jid, sticker) {
  await sendBotMessage(jid, {
    document: sticker,
    mimetype: 'image/webp',
    fileName: `${BOT_NAME}-sticker.webp`,
    caption: 'Salinan file sticker untuk akun utama jika WhatsApp gagal copy/load sticker dari linked device.'
  });
}

async function handleSmeme(message, command) {
  const jid = message.key.remoteJid;
  const smeme = parseSmemeArgs(command.args);
  let media = null;
  try {
    media = await downloadQuotedOrOwnMedia(state.sock, message, 'smeme-source');
    if (!media) throw new Error('Reply image, GIF, video, atau sticker untuk memakai ,smeme.');
    const supportedDocument = media.type === 'documentMessage' && /^(image|video)\//i.test(media.mimetype || '');
    if (!['imageMessage', 'videoMessage', 'stickerMessage'].includes(media.type) && !supportedDocument) {
      throw new Error('Smeme hanya mendukung image, GIF, video, atau sticker.');
    }
    const animated = await isAnimatedMedia(media);
    const sticker = await makeSmemeSticker(media, {
      author: DEFAULT_STICKER_AUTHOR,
      title: DEFAULT_STICKER_TITLE,
      tools: state.tools,
      smeme
    });
    await sendBotMessage(jid, { sticker, mimetype: 'image/webp', isAnimated: animated || undefined });
  } finally {
    await cleanupFiles([media?.path]);
  }
}

async function handleReverseSticker(message, command) {
  const jid = message.key.remoteJid;
  let media = null;
  try {
    if (command.rawArgs.trim()) throw new Error('Format: reply media/view-once lalu ketik ,resend tanpa parameter. Legacy ,rs tetap didukung.');
    media = await downloadQuotedOrOwnMedia(state.sock, message, 'reverse-source');
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
    media = await downloadQuotedOrOwnMedia(state.sock, message, 'toimg-source');
    if (!media) throw new Error('Kirim/reply dokumen PDF untuk memakai ,toimg.');
    if (!isPdfFile(media.path, media.mimetype) && !isPdfFile(media.fileName, media.mimetype)) {
      throw new Error('Untuk sekarang ,toimg hanya mendukung file PDF.');
    }
    await sendText(jid, 'Mengubah PDF menjadi image...');
    images = await pdfToImages(media.path, state.tools);
    if (!images.length) throw new Error('Tidak ada halaman PDF yang berhasil diubah menjadi image.');
    for (const image of images) {
      const buffer = await fs.readFile(image.path);
      await state.sock.sendMessage(jid, {
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
    await state.sock.sendMessage(jid, { image: converted.buffer, mimetype: converted.mimetype });
    return;
  }
  if (converted.gifPlayback) {
    await state.sock.sendMessage(jid, {
      video: converted.buffer,
      mimetype: converted.mimetype,
      gifPlayback: true
    });
    return;
  }
  await state.sock.sendMessage(jid, {
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
    media = await downloadQuotedOrOwnMedia(state.sock, message, 'secret-media');
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
    media = await downloadMessageMedia(state.sock, source, 'view-once');
    if (!media) throw new Error('View-once ditemukan, tapi medianya tidak bisa dibaca.');
    await sendDownloadedMedia(destinationJid, media);
  } finally {
    await cleanupFiles([media?.path]);
  }
}

async function sendDownloadedMedia(jid, media, options = {}) {
  const buffer = await fs.readFile(media.path);
  const caption = options.caption || media.node?.caption || undefined;
  if (media.type === 'imageMessage') {
    return sendBotMessage(jid, { image: buffer, mimetype: media.mimetype, caption });
  } else if (media.type === 'videoMessage') {
    return sendBotMessage(jid, { video: buffer, mimetype: media.mimetype, caption });
  } else if (media.type === 'audioMessage') {
    return sendBotMessage(jid, { audio: buffer, mimetype: media.mimetype });
  } else if (media.type === 'stickerMessage') {
    return sendBotMessage(jid, { sticker: buffer, isAnimated: media.node?.isAnimated || undefined });
  } else {
    return sendBotMessage(jid, {
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
      media = await downloadMessageMedia(state.sock, message, 'changed-viewonce');
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

async function maybeSaveStatusMessage(message) {
  if (message.key?.remoteJid !== 'status@broadcast') return false;
  if (!state.runtimeConfig?.statussaveSettings?.().enabled) return true;
  const actorJid = statusAuthorJid(message);
  if (!state.statusSave?.isWatched(actorJid)) return true;
  const savedJid = safeDestinationJid('saved');
  if (!savedJid) return true;
  const summary = summarizeMessage(message);
  const caption = [
    'Status WhatsApp tersimpan:',
    `Nomor: ${displayPhoneFromJid(actorJid)}`,
    `JID: ${actorJid}`,
    `Waktu: ${new Date(summary.timestamp).toLocaleString()}`,
    `Tipe: ${summary.type}`,
    summary.text ? `Teks: ${summary.text}` : null
  ].filter(Boolean).join('\n');

  let media = null;
  try {
    if (mediaNode(message)) {
      media = await downloadMessageMedia(state.sock, message, 'status-save');
      const stat = await fs.stat(media.path).catch(() => null);
      const maxBytes = state.runtimeConfig.statussaveSettings().maxMediaBytes;
      if (stat?.size && stat.size > maxBytes) {
        await sendText(savedJid, `${caption}\n\nMedia dilewati karena ${formatBytes(stat.size)} melebihi batas ${formatBytes(maxBytes)}.`);
      } else {
        await sendDownloadedMedia(savedJid, media, { caption });
      }
    } else {
      await sendText(savedJid, caption);
    }
  } catch (error) {
    await logger.warn('Status save failed', { actorJid, error: error.message });
  } finally {
    await cleanupFiles([media?.path]);
  }
  return true;
}

function statusAuthorJid(message) {
  const raw = message.key?.participant || message.participant || message.key?.remoteJid || '';
  return raw ? jidNormalizedUser(raw) : '';
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
  for (const name of ['logs', 'changedmsg', 'saved', 'backup']) {
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
    await state.sock.sendMessage(jid, { image: { url: pictureUrl }, caption });
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
  const task = await createTask(state.sock, message, command.args);
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
    const item = await state.pdfSessions.addAny(state.sock, message, null);
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
        await state.sock.sendMessage(jid, {
          document: file.buffer,
          mimetype: 'application/pdf',
          fileName: file.fileName
        });
      }
    } else {
      const pdf = await state.pdfSessions.build(session);
      await state.sock.sendMessage(jid, {
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
  const item = await state.restoreSessions.add(state.sock, message);
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
  const item = await state.pdfSessions.addAny(state.sock, message, order);
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
  const files = await sendDataBackupToWhatsApp(botSender(), destination, {
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

async function handleStatusSaveCommand(message, command, context) {
  if (!context.isOwner) throw new Error('Command ,statussave hanya bisa dipakai nomor yang terhubung ke session bot.');
  const jid = message.key.remoteJid;
  const action = (command.args[0] || 'list').toLowerCase();
  if (action === 'list') {
    await sendStatusSaveList(jid, context.actorJid);
    return;
  }
  if (action === 'add') {
    const input = command.args.slice(1).join(' ').trim();
    if (!input) throw new Error('Format: ,statussave add <nomor>');
    const item = await state.statusSave.add(input, context.actorJid);
    invalidateListKind('statussave');
    await sendText(jid, `Statussave #${item.id} ${item.title} ditambahkan.`);
    return;
  }
  if (action === 'del' || action === 'delete') {
    const query = command.args.slice(1).join(' ').trim();
    if (!query) throw new Error('Format: ,statussave del <nomor|id>');
    await requestConfirmation(jid, context.actorJid, {
      title: `Hapus statussave "${query}"`,
      description: 'Status WhatsApp dari nomor ini tidak lagi disimpan otomatis.',
      execute: async () => {
        const item = await state.statusSave.delete(query);
        invalidateListKind('statussave');
        await sendText(jid, `Statussave #${item.id} ${item.title} dihapus.`);
      }
    });
    return;
  }
  throw new Error('Format: ,statussave list|add|del <nomor|id>');
}

async function sendStatusSaveList(jid, actorJid) {
  await sendReactionList(jid, actorJid, 'statussave', state.statusSave.list(), {
    emptyText: 'Belum ada nomor statussave.',
    formatItem: (item) => `#${item.id} - ${item.title} (${shortJid(item.jid)})`,
    deleteTitle: (item) => `Hapus statussave #${item.id}`,
    deleteDescription: 'Status WhatsApp dari nomor ini tidak lagi disimpan otomatis.',
    deleteItem: async (item) => {
      const deleted = await state.statusSave.delete(item.id);
      return `Statussave #${deleted.id} ${deleted.title} dihapus.`;
    }
  });
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
    case 'statussave':
      await handleStatusSaveCommand(message, command, context);
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
}

async function onMessageUpsert(event) {
  for (const message of event.messages || []) {
    if (!message.message || !message.key?.remoteJid) continue;
    if (message.key.remoteJid === 'status@broadcast') {
      if (isBotEnabled()) await maybeSaveStatusMessage(message);
      continue;
    }
    const jid = message.key.remoteJid;
    const isOwner = Boolean(message.key?.fromMe);
    if (isOwner && isIgnoredOwnOutput(message)) continue;
    const text = getMessageText(message);
    const command = parseCommand(text);
    const context = commandContext(message);
    try {
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
        await state.saveRecorder.record(state.sock, message);
        continue;
      }
      if (sessionActorMatches && state.anticall.has(jid) && (!command || !['end', 'cancel'].includes(command.name))) {
        await state.anticall.record(state.sock, message);
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

async function onMessagesReaction(updates) {
  if (!isBotEnabled()) return;
  for (const update of updates || []) {
    const intent = reactionIntent(update?.reaction?.text);
    if (!intent) continue;
    const actorJid = reactionActorJid(update);
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
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    auth: authState,
    version,
    emitOwnEvents: true,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    logger: pino({ level: 'silent' }),
    browser: ['IrOBot', 'Chrome', '1.0.0']
  });

  state.sock = sock;
  state.scheduler?.stop();
  state.scheduler = new TaskScheduler(sock, state.chatDirectory, logger);
  state.reminderScheduler?.stop();
  state.reminderScheduler = new ReminderScheduler(sock, state.chatDirectory, logger);

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('messages.upsert', onMessageUpsert);
  sock.ev.on('messages.update', onMessagesUpdate);
  sock.ev.on('messages.delete', onMessagesDelete);
  sock.ev.on('messages.reaction', onMessagesReaction);
  sock.ev.on('call', onCallUpdate);
  sock.ev.on('chats.upsert', (chats) => {
    for (const chat of chats || []) state.chatDirectory.remember(chat.id, chat.name || chat.subject);
  });
  sock.ev.on('chats.update', (chats) => {
    for (const chat of chats || []) state.chatDirectory.remember(chat.id, chat.name || chat.subject);
  });
  sock.ev.on('groups.update', (groups) => {
    for (const group of groups || []) state.chatDirectory.remember(group.id, group.subject);
  });
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log(await QRCode.toString(qr, { type: 'terminal', small: true }));
    }
    if (connection === 'open') {
      console.log('WhatsApp connected.');
      await logger.info('WhatsApp connected');
      await loadGroups(sock);
      await hydrateConfiguredDestinations();
      applyBotRuntimeState();
    }
    if (connection === 'close') {
      state.scheduler?.stop();
      state.reminderScheduler?.stop();
      state.backupScheduler?.stop();
      await logger.warn('Connection closed', { error: lastDisconnect?.error?.message });
      if (shouldReconnect(lastDisconnect) && !state.reconnecting) {
        state.reconnecting = true;
        setTimeout(() => {
          state.reconnecting = false;
          connect().catch((error) => logger.error('Reconnect failed', { error: error.message }));
        }, 3000);
      } else if (!shouldReconnect(lastDisconnect)) {
        console.log('Logged out. Hapus folder auth lalu scan ulang jika ingin login lagi.');
      }
    }
  });
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
  state.statusSave = new StatusSaveStore();
  await state.statusSave.load();
  state.tools = await detectTools();
  state.pdfSessions = new PdfSessions(state.tools);
  state.restoreSessions = new RestoreSessions();
  state.saveRecorder = new SaveRecorder();
  state.anticall = new AnticallStore();
  await state.anticall.load();
  state.backupScheduler = new DailyBackupScheduler(
    logger,
    async () => sendDataBackupToWhatsApp(botSender(), destinationJid('backup'), {
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
