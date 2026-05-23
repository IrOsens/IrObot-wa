import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
  areJidsSameUser,
  DisconnectReason,
  fetchLatestBaileysVersion,
  getKeyAuthor,
  jidNormalizedUser,
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
  NOTES_FILE,
  PDF_DEFAULT_FILE_NAME,
  PRIMARY_TARGET_NAME,
  REMINDERS_FILE,
  ROOT_DIR,
  TASKS_FILE,
  TELEGRAM_CLIENT_ID,
  TELEGRAM_PART_SIZE_BYTES,
  LINUX_SUDO_PASSWORD,
  UPDATE_BRANCH,
  UPDATE_REMOTE,
  UPDATE_RESTART_MODE,
  UPDATE_SYSTEMD_SERVICE,
  WOL_FILE,
  YOUTUBE_EXTRACTOR_ARGS,
  YOUTUBE_COOKIE_FILE,
  YOUTUBE_PO_TOKEN,
  cleanupStartupTemp,
  ensureRuntimeDirs
} from './config.js';
import { cleanupOldLogs, logger } from './logger.js';
import { detectTools, formatBytes, formatDuration, getDiskInfo, getLoadAverageText, runTool, runToolWithInput } from './tools.js';
import { getMessageText, parseCommand } from './text.js';
import {
  cleanupFiles,
  downloadMessageMedia,
  downloadQuotedOrOwnMedia,
  downloadUrlMedia,
  isViewOnceMediaMessage,
  mediaNode,
  quotedMediaNode
} from './media.js';
import { makeSmemeSticker, makeSticker, parseSmemeArgs, parseStickerMeta, reverseSticker } from './sticker.js';
import { TaskScheduler, createTask, formatTaskList, formatWib, listTasks, updateTaskState } from './tasks.js';
import { PdfSessions, parsePdfOrderText, parsePdfStartArgs } from './pdf.js';
import { downloadYoutube } from './youtube.js';
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
import { DailyBackupScheduler, sendDataBackupToTelegram } from './backup.js';
import { RestoreSessions } from './restore.js';
import { PendingConfirmStore, parseSecretMediaTriggerText } from './confirm.js';
import { CommandAccessStore, PUBLIC_COMMANDS, parseAllowArgs } from './commandAccess.js';
import { BotStateStore } from './botState.js';
import { ReactionActionStore, reactionIntent } from './reactionActions.js';
import {
  displayPhoneFromJid,
  normalizePhoneToJid as normalizePhoneToWhatsAppJid,
  sameJid,
  tryNormalizePhoneToJid as tryNormalizePhoneToWhatsAppJid
} from './phone.js';
import {
  hasYoutubeCookies,
  isYoutubeCookieNeededError,
  saveYoutubeCookies,
  youtubeCookieWarnings,
  youtubeCookiePrompt
} from './youtubeCookies.js';
import { AnticallStore, formatAnticallStatus } from './anticall.js';

class ChatDirectory {
  constructor() {
    this.byName = new Map();
    this.byJid = new Map();
  }

  remember(jid, name) {
    if (!jid) return;
    const cleanJid = String(jid).trim();
    this.byJid.set(cleanJid, cleanJid);
    if (!name) return;
    const cleanName = normalizeLookupText(name);
    if (cleanName) this.byName.set(cleanName, cleanJid);
  }

  findByName(name) {
    const query = String(name || '').trim();
    if (!query) return null;
    if (this.byJid.has(query)) return query;
    const phoneJid = tryNormalizePhoneToJid(query);
    if (phoneJid) return phoneJid;

    const normalized = normalizeLookupText(query);
    if (this.byName.has(normalized)) return this.byName.get(normalized);
    const matches = [...this.byName.entries()].filter(([key]) => key.includes(normalized));
    return matches.length === 1 ? matches[0][1] : null;
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
  commandAccess: null,
  botState: null,
  anticall: null,
  rejectedCallIds: new Set(),
  youtubeCookieSessions: new Map(),
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
      { name: 'help', text: '- ,help - tampilkan command yang bisa kamu pakai .' },
      { name: 's', text: '- ,s [title][,author] - buat sticker dari attach, reply, atau URL media .' },
      { name: 'smeme', text: '- ,smeme up/down <teks> [1-99] - buat sticker meme dari reply media .' },
      { name: 'rs', text: '- ,rs - kirim ulang media atau view-once reply ke chat ini .' },
      { name: 'topdf', text: '- ,topdf [nama][,1MB] - mulai sesi PDF, lalu tutup dengan ,end .' }
    ]
  },
  {
    title: 'Reminder dan task',
    items: [
      { name: 'task', text: '- ,task [count|loop] "<teks>" <jam> [menit] [detik] [tanggal] - buat task terjadwal .' },
      { name: 'ltask', text: '- ,ltask - lihat semua task .' },
      { name: 'ltask', text: '- ,ltask true|false|del <id> - aktifkan, pause, atau hapus task .' },
      { name: 'remindme', text: '- ,remindme <teks> <durasi> - reminder cepat, contoh 10m atau 1h30m .' }
    ]
  },
  {
    title: 'Save, note, dan link',
    items: [
      { name: 'save', text: '- ,save <judul> [teks awal] - mulai rekam save .' },
      { name: 'load', text: '- ,load [id|judul] - list atau kirim ulang save .' },
      { name: 'load', text: '- ,load del <id|judul> - hapus save dengan konfirmasi .' },
      { name: 'load', text: '- ,load change <id|judul> <judul-baru> - ganti judul save .' },
      { name: 'note', text: '- ,note | ,note <judul> <teks> | ,note <id|judul> | ,note del <id|judul> | ,note change <id|judul> <judul-baru> .' },
      { name: 'link', text: '- ,link | ,link <nama> <https://link> | ,link <id|nama> | ,link del <id|nama> | ,link change <id|nama> <nama-baru> .' }
    ]
  },
  {
    title: 'Utility',
    items: [
      { name: 'info', text: '- ,info <nomor> - cek info WhatsApp .' },
      { name: 'status', text: '- ,status - status ringkas server .' },
      { name: 'health', text: '- ,health - status teknis bot .' },
      { name: 'won', text: '- ,won | ,won <mac|id> | ,won save <mac> | ,won del <id|mac> - Wake-on-LAN .' },
      { name: 'backup', text: '- ,backup - kirim zip data/ ke Telegram .' },
      { name: 'restore', text: '- ,restore - mulai restore zip WhatsApp, finalnya perlu ,confirm .' },
      { name: 'anticall', text: '- ,anticall | ,anticall new|on|off | ,anticall except list|add|del <nomor|id> .' },
      { name: 'clear', text: '- ,clear - hapus temp dengan konfirmasi .' },
      { name: 'update', text: '- ,update - git pull dan restart service dengan konfirmasi .' },
      { name: 'restartbot', text: '- ,restartbot - restart aman dengan konfirmasi .' },
      { name: 'allow', text: '- ,allow here|all true|false - buka/tutup akses publik .' },
      { name: 'admin', text: '- ,admin list|add|del <nomor|id> - kelola admin tambahan .' },
      { name: 'bot', text: '- ,bot | ,bot on|off - cek atau ubah status layanan bot .' }
    ]
  },
  {
    title: 'Session dan konfirmasi',
    items: [
      { name: 'end', text: '- ,end - selesai save, PDF, atau restore .' },
      { name: 'cancel', text: '- ,cancel - batalkan sesi aktif atau pending confirm .' },
      { name: 'confirm', text: '- ,confirm - jalankan aksi yang sedang menunggu konfirmasi .' }
    ]
  }
];

async function handleHelp(jid, context) {
  const lines = [`${BOT_NAME} Help .`];
  for (const section of HELP_SECTIONS) {
    const items = section.items.filter((item) => canShowHelpItem(item.name, jid, context));
    if (!items.length) continue;
    lines.push('', `${section.title} .`, ...items.map((item) => item.text));
  }
  await sendText(jid, lines.join('\n'));
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

function activeSessionType(jid) {
  if (state.saveRecorder?.has(jid)) return 'save';
  if (state.anticall?.has(jid)) return 'anticall';
  if (state.pdfSessions?.has(jid)) return 'PDF';
  if (state.restoreSessions?.has(jid)) return 'restore';
  if (state.youtubeCookieSessions.has(jid)) return 'YouTube cookies';
  return null;
}

function activeSessionActorMatches(jid, actorJid) {
  if (state.saveRecorder?.has(jid)) return state.saveRecorder.isActor(jid, actorJid);
  if (state.anticall?.has(jid)) return state.anticall.isActor(jid, actorJid);
  if (state.pdfSessions?.has(jid)) return state.pdfSessions.isActor(jid, actorJid);
  if (state.restoreSessions?.has(jid)) return state.restoreSessions.isActor(jid, actorJid);
  const cookieSession = state.youtubeCookieSessions.get(jid);
  if (cookieSession) return sameActor(cookieSession.actorJid, actorJid);
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
    || state.youtubeCookieSessions.size
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
    `Tools: ffmpeg=${Boolean(state.tools.ffmpeg)}, ffprobe=${Boolean(state.tools.ffprobe)}, yt-dlp=${Boolean(state.tools.ytDlp)}, office=${Boolean(state.tools.office)}`,
    `Data counts: save=${saved.length}, note=${notes.length}, link=${links.length}, task=${tasks.length}, remind=${reminders.length}, wol=${wolItems.length}`,
    `Sessions: save=${state.saveRecorder?.sessions?.size || 0}, anticall=${state.anticall?.sessions?.size || 0}, pdf=${state.pdfSessions?.count() || 0}, restore=${state.restoreSessions?.count() || 0}, ytCookies=${state.youtubeCookieSessions.size}, confirm=${state.confirmStore.count()}`,
    `Anticall: ${anticall.enabled ? 'aktif' : 'nonaktif'}, pesan=${anticall.hasMessage ? `${anticall.entryCount} item` : 'belum ada'}, exception=${anticall.exceptionCount || 0}`,
    `Public command access: all=${Boolean(access.all)}, chats=${access.chatCount || 0}, admins=${access.adminCount || 0}`,
    `Schedulers: task=${state.scheduler?.isRunning?.() ? 'running' : 'stopped'}, remind=${state.reminderScheduler?.isRunning?.() ? 'running' : 'stopped'}, backup=${state.backupScheduler?.isRunning?.() ? 'running' : 'stopped'}`,
    `Target ${PRIMARY_TARGET_NAME}: ${targetJid || 'not found'}`,
    `Telegram client id: ${TELEGRAM_CLIENT_ID ? 'configured' : 'missing'}`,
    `Telegram part size: ${formatBytes(TELEGRAM_PART_SIZE_BYTES)}`,
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
    const sticker = await makeSticker(media, { author: meta.author, title: meta.title, tools: state.tools });
    await state.sock.sendMessage(jid, { sticker });
  } finally {
    await cleanupFiles([media?.path]);
  }
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
    const sticker = await makeSmemeSticker(media, {
      author: DEFAULT_STICKER_AUTHOR,
      title: DEFAULT_STICKER_TITLE,
      tools: state.tools,
      smeme
    });
    await state.sock.sendMessage(jid, { sticker });
  } finally {
    await cleanupFiles([media?.path]);
  }
}

async function handleReverseSticker(message, command) {
  const jid = message.key.remoteJid;
  let media = null;
  try {
    if (command.rawArgs.trim()) throw new Error('Format baru: reply media/view-once lalu ketik ,rs tanpa parameter.');
    media = await downloadQuotedOrOwnMedia(state.sock, message, 'reverse-source');
    if (!media) throw new Error('Reply media/view-once untuk memakai ,rs.');
    if (media.type === 'stickerMessage') {
      await sendReversedSticker(jid, media);
      return;
    }
    await sendDownloadedMedia(jid, media);
  } finally {
    await cleanupFiles([media?.path]);
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
    await state.sock.sendMessage(jid, { image: buffer, mimetype: media.mimetype, caption });
  } else if (media.type === 'videoMessage') {
    await state.sock.sendMessage(jid, { video: buffer, mimetype: media.mimetype, caption });
  } else if (media.type === 'audioMessage') {
    await state.sock.sendMessage(jid, { audio: buffer, mimetype: media.mimetype });
  } else if (media.type === 'stickerMessage') {
    await state.sock.sendMessage(jid, { sticker: buffer, isAnimated: media.node?.isAnimated || undefined });
  } else {
    await state.sock.sendMessage(jid, {
      document: buffer,
      mimetype: media.mimetype || 'application/octet-stream',
      fileName: media.fileName || `view-once-${Date.now()}`,
      caption
    });
  }
}

async function handleYoutube(message, command, actorJid = messageActorJid(message)) {
  const jid = message.key.remoteJid;
  try {
    await sendText(jid, 'Mulai download YouTube...');
    await sendYoutubeResult(jid, command.args);
  } catch (error) {
    if (!isYoutubeCookieNeededError(error)) throw error;
    startYoutubeCookieSession(jid, command.args, actorJid);
    await sendText(jid, `${error.message}\n\n${youtubeCookiePrompt()}`);
  }
}

async function sendYoutubeResult(jid, args) {
  let result = null;
  try {
    const cookieFile = await hasYoutubeCookies(YOUTUBE_COOKIE_FILE) ? YOUTUBE_COOKIE_FILE : null;
    result = await downloadYoutube(args, state.tools, {
      cookieFile,
      extractorArgs: YOUTUBE_EXTRACTOR_ARGS,
      poToken: YOUTUBE_PO_TOKEN
    });
    const buffer = await fs.readFile(result.path);
    if (result.type === 'mp3') {
      await state.sock.sendMessage(jid, {
        audio: buffer,
        mimetype: result.mimetype,
        fileName: result.fileName
      });
    } else {
      await state.sock.sendMessage(jid, {
        video: buffer,
        mimetype: result.mimetype,
        fileName: result.fileName,
        caption: `YouTube ${result.quality}p`
      });
    }
  } finally {
    await cleanupFiles([result?.path]);
  }
}

function startYoutubeCookieSession(jid, args, actorJid = jid) {
  const active = activeSessionType(jid);
  if (active && active !== 'YouTube cookies') {
    throw new Error(`Tidak bisa meminta cookies saat sesi ${active} aktif. Selesaikan dengan ,end atau batalkan dengan ,cancel.`);
  }
  const old = state.youtubeCookieSessions.get(jid);
  if (old?.timer) clearTimeout(old.timer);
  state.youtubeCookieSessions.set(jid, {
    jid,
    actorJid,
    args: [...args],
    startedAt: Date.now()
  });
}

async function finishYoutubeCookieInput(message, text) {
  const jid = message.key.remoteJid;
  const session = state.youtubeCookieSessions.get(jid);
  if (!session) return false;
  if (!activeSessionActorMatches(jid, messageActorJid(message))) return false;
  if (session.timer) clearTimeout(session.timer);
  state.youtubeCookieSessions.delete(jid);
  const cookieText = await readYoutubeCookieInput(message, text);
  await saveYoutubeCookies(cookieText, YOUTUBE_COOKIE_FILE);
  const warnings = youtubeCookieWarnings(cookieText);
  await sendText(jid, [
    'Cookies YouTube tersimpan. Mencoba download ulang...',
    ...warnings.map((warning) => `Warning: ${warning}`)
  ].join('\n'));
  await sendYoutubeResult(jid, session.args);
  return true;
}

async function readYoutubeCookieInput(message, text) {
  const trimmed = String(text || '').trim();
  if (trimmed) return trimmed;
  let media = null;
  try {
    media = await downloadMessageMedia(state.sock, message, 'youtube-cookies');
    if (!media) throw new Error('Kirim cookies sebagai teks atau dokumen .json/.txt.');
    const ext = path.extname(media.fileName || media.path).toLowerCase();
    if (media.type !== 'documentMessage' || !['.json', '.txt', '.cookies'].includes(ext)) {
      throw new Error('Dokumen cookies harus file .json, .txt, atau .cookies.');
    }
    return await fs.readFile(media.path, 'utf8');
  } finally {
    await cleanupFiles([media?.path]);
  }
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

async function handleTask(message, command) {
  const task = await createTask(state.sock, message, command.args);
  await sendText(message.key.remoteJid, `Task #${task.id} dibuat.\nBerikutnya: ${formatWib(task.nextRunAt)}`);
}

async function handleListTask(jid, command, actorJid) {
  if (!command.args.length) {
    await sendTaskList(jid, actorJid);
    return;
  }
  const [action, idRaw] = command.args;
  const id = Number(idRaw);
  if (!Number.isInteger(id)) throw new Error('Format: ,ltask true|false|del <id>');
  if (action.toLowerCase() === 'del') {
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
  const result = await updateTaskState(action.toLowerCase(), id);
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
    const sent = item?.skipped
      ? await sendText(jid, `Sesi PDF "${session.fileName}" dimulai, tapi file pertama dilewati: ${item.fileName} - ${item.reason}\nKirim media lain lalu ketik ,end atau ,cancel.`)
      : await sendText(jid, `Sesi PDF "${session.fileName}" dimulai dan file pertama ditambahkan: ${item.fileName} (#${item.order}). Kirim media lain lalu ketik ,end.`);
    registerSessionPrompt(sent.key, jid, actorJid);
    return;
  }
  const sizeText = session.maxSizeBytes ? ` Maksimal ukuran: ${formatBytes(session.maxSizeBytes)}.` : '';
  const sent = await sendText(jid, `Sesi PDF "${session.fileName}" dimulai.${sizeText} Kirim/reply media atau dokumen. Caption/teks angka dipakai sebagai urutan halaman. Ketik ,end untuk selesai atau ,cancel untuk batal.`);
  registerSessionPrompt(sent.key, jid, actorJid);
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
    const pdf = await state.pdfSessions.build(session);
    await state.sock.sendMessage(jid, {
      document: pdf,
      mimetype: 'application/pdf',
      fileName: session.fileName || `${PDF_DEFAULT_FILE_NAME}-${Date.now()}.pdf`
    });
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

  const cookieSession = state.youtubeCookieSessions.get(jid);
  if (cookieSession && sameActor(cookieSession.actorJid, actorJid)) {
    if (cookieSession.timer) clearTimeout(cookieSession.timer);
    state.youtubeCookieSessions.delete(jid);
    await sendText(jid, 'Input cookies YouTube dibatalkan.');
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
  if (item?.skipped) {
    await sendText(message.key.remoteJid, `Dilewati untuk PDF: ${item.fileName} - ${item.reason}`);
    return true;
  }
  if (item) await sendText(message.key.remoteJid, `Ditambahkan ke PDF: ${item.fileName} (#${item.order})`);
  return Boolean(item);
}

async function handleReminder(message, command) {
  const reminder = await createReminder(command.args);
  await sendText(message.key.remoteJid, `Reminder #${reminder.id} dibuat. Terkirim dalam ${formatCountdown(new Date(reminder.dueAt).getTime() - Date.now())} ke ${PRIMARY_TARGET_NAME}.`);
}

async function handleClear(jid) {
  if (hasAnyTempSession()) throw new Error('Tidak bisa clear temp saat ada sesi save/anticall/PDF/restore/cookies aktif.');
  await cleanupStartupTemp();
  await sendText(jid, 'Temp dibersihkan.');
}

async function handleBackup(jid) {
  await sendText(jid, 'Membuat backup data/ dan mengirim ke Telegram...');
  const files = await sendDataBackupToTelegram();
  await sendText(jid, `Backup terkirim ke Telegram:\n${files.join('\n')}`);
}

async function handleAllow(message, command) {
  const jid = message.key.remoteJid;
  const { scope, enabled } = parseAllowArgs(command.args);
  const commands = [...PUBLIC_COMMANDS].map((name) => `${COMMAND_PREFIX}${name}`).join(', ');
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

async function handleCommand(message, command, context = commandContext(message)) {
  const jid = message.key.remoteJid;
  switch (command.name) {
    case 'help':
      await handleHelp(jid, context);
      break;
    case 'status':
      await handleStatus(jid);
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
      if (!command.args.length) {
        await sendNoteList(jid, context.actorJid);
      } else if (command.args[0]?.toLowerCase() === 'del') {
        const query = command.args.slice(1).join(' ').trim();
        if (!query) throw new Error('Format: ,note del <id|judul>');
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
        invalidateListKind('notes');
        await sendText(jid, text);
      }
      break;
    case 'link':
      if (!command.args.length) {
        await sendLinkList(jid, context.actorJid);
      } else if (command.args[0]?.toLowerCase() === 'del') {
        const query = command.args.slice(1).join(' ').trim();
        if (!query) throw new Error('Format: ,link del <id|nama>');
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
        invalidateListKind('links');
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
      await handleReverseSticker(message, command);
      break;
    case 'task':
      await handleTask(message, command);
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
    case 'won':
      if (!command.args.length) {
        await sendWolList(jid, context.actorJid);
      } else if (command.args[0]?.toLowerCase() === 'del') {
        const query = command.args.slice(1).join(' ').trim();
        if (!query) throw new Error('Format: ,won del <id|mac>');
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
        if (command.args[0]?.toLowerCase() === 'save') invalidateListKind('wol');
        await sendText(jid, text);
      }
      break;
    case 'backup':
      await handleBackup(jid);
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
    if (!message.message || !message.key?.remoteJid || message.key.remoteJid === 'status@broadcast') continue;
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
      if (sessionActorMatches && state.youtubeCookieSessions.has(jid) && !command) {
        await finishYoutubeCookieInput(message, text);
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
      applyBotRuntimeState();
    }
    if (connection === 'close') {
      state.scheduler?.stop();
      state.reminderScheduler?.stop();
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

async function main() {
  await ensureRuntimeDirs();
  await cleanupStartupTemp();
  await cleanupOldLogs();
  state.commandAccess = new CommandAccessStore();
  await state.commandAccess.load();
  state.botState = new BotStateStore();
  await state.botState.load();
  state.tools = await detectTools();
  state.pdfSessions = new PdfSessions(state.tools);
  state.restoreSessions = new RestoreSessions();
  state.saveRecorder = new SaveRecorder();
  state.anticall = new AnticallStore();
  await state.anticall.load();
  state.backupScheduler = new DailyBackupScheduler(logger);
  if (isBotEnabled()) state.backupScheduler.start();
  await logger.info('Detected tools', state.tools);
  console.log('Tool check:', {
    ffmpeg: Boolean(state.tools.ffmpeg),
    ffprobe: Boolean(state.tools.ffprobe),
    office: Boolean(state.tools.office),
    ytDlp: Boolean(state.tools.ytDlp)
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
