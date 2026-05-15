import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from 'baileys';
import {
  AUTH_DIR,
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
  UPDATE_BRANCH,
  UPDATE_REMOTE,
  UPDATE_RESTART_MODE,
  UPDATE_SYSTEMD_SERVICE,
  WOL_FILE,
  YOUTUBE_COOKIE_FILE,
  cleanupStartupTemp,
  ensureRuntimeDirs
} from './config.js';
import { cleanupOldLogs, logger } from './logger.js';
import { detectTools, formatBytes, formatDuration, getDiskInfo, getLoadAverageText, runTool } from './tools.js';
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
import { makeSticker, parseStickerMeta, reverseSticker } from './sticker.js';
import { TaskScheduler, createTask, formatTaskList, formatWib, listTasks, updateTaskState } from './tasks.js';
import { PdfSessions, parsePdfOrderText } from './pdf.js';
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
import {
  hasYoutubeCookies,
  isYoutubeCookieNeededError,
  saveYoutubeCookies,
  youtubeCookiePrompt
} from './youtubeCookies.js';

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

function isIgnoredOwnOutput(message) {
  const id = message?.key?.id;
  if (!id || !state.ignoredOwnMessageIds.has(id)) return false;
  state.ignoredOwnMessageIds.delete(id);
  return true;
}

async function handleHelp(jid) {
  await sendText(jid, [
    `✨ ${BOT_NAME} Help .`,
    '',
    '🎬 Media .',
    '• ,s [author] [title] - buat sticker dari attach, reply, atau URL media .',
    '• ,rs - kirim ulang media atau view-once reply ke chat ini .',
    '• ,topdf [nama] - mulai sesi PDF, lalu tutup dengan ,end .',
    '',
    '📥 Download .',
    '• ,yt <link> <mp3|mp4> [360|480|720|1080] [00:00-01:00] - download YouTube .',
    '',
    '⏰ Reminder dan task .',
    '• ,task [count|loop] "<teks>" <jam> [menit] [detik] [tanggal] - buat task terjadwal .',
    '• ,ltask - lihat semua task .',
    '• ,ltask true|false|del <id> - aktifkan, pause, atau hapus task .',
    '• ,remindme <teks> <durasi> - reminder cepat, contoh 10m atau 1h30m .',
    '',
    '💾 Save, note, dan link .',
    '• ,save <judul> [teks awal] - mulai rekam save .',
    '• ,load [id|judul] - list atau kirim ulang save .',
    '• ,load del <id|judul> - hapus save dengan konfirmasi .',
    '• ,load change <id|judul> <judul-baru> - ganti judul save .',
    '• ,note | ,note <judul> <teks> | ,note <id|judul> | ,note del <id|judul> .',
    '• ,link | ,link <nama> <https://link> | ,link <id|nama> | ,link del <id|nama> .',
    '',
    '🛠️ Utility .',
    '• ,info <nomor> - cek info WhatsApp .',
    '• ,status - status ringkas server .',
    '• ,health - status teknis bot .',
    '• ,won | ,won <mac|id> | ,won save <mac> | ,won del <id|mac> - Wake-on-LAN .',
    '• ,backup - kirim zip data/ ke Telegram .',
    '• ,restore - mulai restore zip WhatsApp, finalnya perlu ,confirm .',
    '• ,clear - hapus temp dengan konfirmasi .',
    '• ,update - git pull dan restart service dengan konfirmasi .',
    '• ,restartbot - restart aman dengan konfirmasi .',
    '',
    '✅ Session dan konfirmasi .',
    '• ,end - selesai save, PDF, atau restore .',
    '• ,cancel - batalkan sesi aktif atau pending confirm .',
    '• ,confirm - jalankan aksi yang sedang menunggu konfirmasi .',
    '',
    `🕵️ Rahasia: reply media lalu akhiri teks dengan spasi titik untuk kirim ke ${PRIMARY_TARGET_NAME}, contoh halo .`
  ].join('\n'));
}

async function handleStatus(jid) {
  const mem = process.memoryUsage();
  const disk = await getDiskInfo(ROOT_DIR);
  const diskText = disk
    ? `${formatBytes(disk.used)} used / ${formatBytes(disk.size)} (${formatBytes(disk.free)} free) on ${disk.source}`
    : 'unavailable';
  await sendText(jid, [
    'Status server:',
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
  if (state.pdfSessions?.has(jid)) return 'PDF';
  if (state.restoreSessions?.has(jid)) return 'restore';
  if (state.youtubeCookieSessions.has(jid)) return 'YouTube cookies';
  return null;
}

function assertNoActiveSession(jid) {
  const active = activeSessionType(jid);
  if (active) throw new Error(`Masih ada sesi ${active} aktif. Selesaikan dengan ,end atau batalkan dengan ,cancel.`);
}

function hasAnyTempSession() {
  return Boolean(
    state.saveRecorder?.sessions?.size
    || state.pdfSessions?.count()
    || state.restoreSessions?.count()
    || state.youtubeCookieSessions.size
  );
}

async function requestConfirmation(jid, action) {
  state.confirmStore.set(jid, action);
  await sendText(jid, [
    `Konfirmasi diperlukan: ${action.title}`,
    action.description,
    '',
    'Ketik ,confirm untuk lanjut atau ,cancel untuk batal.'
  ].filter(Boolean).join('\n'));
}

async function handleConfirm(jid) {
  const action = state.confirmStore.take(jid);
  if (!action) {
    await sendText(jid, 'Tidak ada aksi yang menunggu konfirmasi, atau waktunya sudah habis.');
    return;
  }
  await sendText(jid, `Menjalankan: ${action.title}`);
  await action.execute();
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
  await sendText(jid, [
    `${BOT_NAME} health`,
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
    `Sessions: save=${state.saveRecorder?.sessions?.size || 0}, pdf=${state.pdfSessions?.count() || 0}, restore=${state.restoreSessions?.count() || 0}, ytCookies=${state.youtubeCookieSessions.size}, confirm=${state.confirmStore.count()}`,
    `Schedulers: task=${state.scheduler?.isRunning?.() ? 'running' : 'stopped'}, remind=${state.reminderScheduler?.isRunning?.() ? 'running' : 'stopped'}, backup=${state.backupScheduler?.isRunning?.() ? 'running' : 'stopped'}`,
    `Target ${PRIMARY_TARGET_NAME}: ${targetJid || 'not found'}`,
    `Telegram client id: ${TELEGRAM_CLIENT_ID ? 'configured' : 'missing'}`,
    `Telegram part size: ${formatBytes(TELEGRAM_PART_SIZE_BYTES)}`,
    `Runtime files: ${[TASKS_FILE, NOTES_FILE, LINKS_FILE, REMINDERS_FILE, WOL_FILE].map((file) => path.basename(file)).join(', ')}`,
    `Time: ${new Date().toLocaleString()}`
  ].join('\n'));
}

async function handleSticker(message, command) {
  const jid = message.key.remoteJid;
  const meta = parseStickerMeta(command.args.filter((arg) => !/^https?:\/\//i.test(arg)));
  const author = meta.author || DEFAULT_STICKER_AUTHOR;
  const title = meta.title || DEFAULT_STICKER_TITLE;
  let media = null;
  try {
    media = await downloadQuotedOrOwnMedia(state.sock, message, 'sticker-source');
    if (!media) media = await downloadUrlMedia(command.rawArgs, 'sticker-url');
    if (!media) throw new Error('Kirim/reply media atau sertakan URL media yang valid.');
    const sticker = await makeSticker(media, { author, title, tools: state.tools });
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
    await sendDownloadedMedia(jid, media);
    await sendText(jid, 'Media terkirim di chat ini.');
  } finally {
    await cleanupFiles([media?.path]);
  }
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
    await sendText(message.key.remoteJid, `Media rahasia terkirim ke ${PRIMARY_TARGET_NAME}.`);
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

async function handleYoutube(message, command) {
  const jid = message.key.remoteJid;
  try {
    await sendText(jid, 'Mulai download YouTube...');
    await sendYoutubeResult(jid, command.args);
  } catch (error) {
    if (!isYoutubeCookieNeededError(error)) throw error;
    startYoutubeCookieSession(jid, command.args);
    await sendText(jid, `${error.message}\n\n${youtubeCookiePrompt()}`);
  }
}

async function sendYoutubeResult(jid, args) {
  let result = null;
  try {
    const cookieFile = await hasYoutubeCookies(YOUTUBE_COOKIE_FILE) ? YOUTUBE_COOKIE_FILE : null;
    result = await downloadYoutube(args, state.tools, { cookieFile });
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

function startYoutubeCookieSession(jid, args) {
  const active = activeSessionType(jid);
  if (active && active !== 'YouTube cookies') {
    throw new Error(`Tidak bisa meminta cookies saat sesi ${active} aktif. Selesaikan dengan ,end atau batalkan dengan ,cancel.`);
  }
  const old = state.youtubeCookieSessions.get(jid);
  if (old?.timer) clearTimeout(old.timer);
  state.youtubeCookieSessions.set(jid, {
    jid,
    args: [...args],
    startedAt: Date.now()
  });
}

async function finishYoutubeCookieInput(message, text) {
  const jid = message.key.remoteJid;
  const session = state.youtubeCookieSessions.get(jid);
  if (!session) return false;
  if (session.timer) clearTimeout(session.timer);
  state.youtubeCookieSessions.delete(jid);
  await saveYoutubeCookies(text, YOUTUBE_COOKIE_FILE);
  await sendText(jid, 'Cookies YouTube tersimpan. Mencoba download ulang...');
  await sendYoutubeResult(jid, session.args);
  return true;
}

function normalizePhoneToJid(input) {
  const digits = String(input || '').replace(/[^\d]/g, '');
  if (!digits) throw new Error('Format: ,info <nomor telepon>');
  let phone = digits;
  if (phone.startsWith('0')) phone = `62${phone.slice(1)}`;
  else if (phone.startsWith('8')) phone = `62${phone}`;
  return `${phone}@s.whatsapp.net`;
}

function tryNormalizePhoneToJid(input) {
  const digits = String(input || '').replace(/[^\d]/g, '');
  if (digits.length < 8) return null;
  return normalizePhoneToJid(digits);
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

async function handleListTask(jid, command) {
  if (!command.args.length) {
    await sendText(jid, formatTaskList(await listTasks()));
    return;
  }
  const [action, idRaw] = command.args;
  const id = Number(idRaw);
  if (!Number.isInteger(id)) throw new Error('Format: ,ltask true|false|del <id>');
  if (action.toLowerCase() === 'del') {
    await requestConfirmation(jid, {
      title: `Hapus task #${id}`,
      description: `Task #${id} akan dihapus permanen.`,
      execute: async () => {
        const result = await updateTaskState('del', id);
        await sendText(jid, `Task #${id} dihapus.`);
        return result;
      }
    });
    return;
  }
  const result = await updateTaskState(action.toLowerCase(), id);
  await sendText(jid, result.deleted ? `Task #${id} dihapus.` : `Task #${id} ${result.task.paused ? 'dipause' : 'aktif'}.`);
}

async function handleTopdf(message, command) {
  const jid = message.key.remoteJid;
  assertNoActiveSession(jid);
  const session = state.pdfSessions.start(jid, command.rawArgs.trim());
  const hasInitialMedia = mediaNode(message) || quotedMediaNode(message);
  if (hasInitialMedia) {
    const item = await state.pdfSessions.addAny(state.sock, message, null);
    await sendText(jid, `Sesi PDF "${session.fileName}" dimulai dan file pertama ditambahkan: ${item.fileName} (#${item.order}). Kirim media lain lalu ketik ,end.`);
    return;
  }
  await sendText(jid, `Sesi PDF "${session.fileName}" dimulai. Kirim/reply media atau dokumen. Caption/teks angka dipakai sebagai urutan halaman. Ketik ,end untuk selesai.`);
}

async function handleEndPdf(message) {
  const jid = message.key.remoteJid;
  const session = state.pdfSessions.end(jid);
  if (!session) {
    await sendText(jid, 'Tidak ada sesi PDF aktif.');
    return;
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
}

async function handleSave(message, command) {
  const { title, firstText } = parseSaveStart(command);
  assertNoActiveSession(message.key.remoteJid);
  await assertSavedTitleAvailable(title);
  const session = state.saveRecorder.start(message.key.remoteJid, title, firstText);
  await sendText(message.key.remoteJid, `Mulai rekam save "${session.title}". Kirim teks, media, lokasi, kontak, poll, atau event lalu ,end untuk simpan atau ,cancel untuk batal.`);
}

async function handleLoad(message, command) {
  const jid = message.key.remoteJid;
  if (!command.args.length) {
    await sendText(jid, formatSavedList(await listSaved()));
    return;
  }
  if (command.args[0].toLowerCase() === 'change') {
    const query = command.args[1];
    const newTitle = command.args.slice(2).join(' ').trim();
    if (!query || !newTitle) throw new Error('Format: ,load change <id|judul-lama> <judul-baru>');
    const item = await renameSaved(query, newTitle);
    await sendText(jid, `Save #${item.id} diganti judul menjadi "${item.title}".`);
    return;
  }
  if (command.args[0].toLowerCase() === 'del') {
    const query = command.args.slice(1).join(' ').trim();
    if (!query) throw new Error('Format: ,load del <id|judul>');
    await requestConfirmation(jid, {
      title: `Hapus save "${query}"`,
      description: 'Save ini akan dihapus permanen.',
      execute: async () => {
        const item = await deleteSaved(query);
        await sendText(jid, `Save #${item.id} "${item.title}" dihapus.`);
      }
    });
    return;
  }
  const query = command.rawArgs.trim();
  const item = await getSaved(query);
  if (!item) throw new Error(`Save "${query}" tidak ditemukan.`);
  await sendSaved(state.sock, jid, item);
}

async function finishSave(message) {
  const item = await state.saveRecorder.finish(message.key.remoteJid);
  if (!item) return false;
  await sendText(message.key.remoteJid, `Save #${item.id} "${item.title}" tersimpan (${item.entries.length} item).`);
  return true;
}

async function cancelSave(message) {
  const cancelled = await state.saveRecorder.cancel(message.key.remoteJid);
  if (cancelled) await sendText(message.key.remoteJid, 'Rekaman save dibatalkan.');
  return cancelled;
}

async function cancelActiveSession(message) {
  const jid = message.key.remoteJid;
  if (await cancelSave(message)) return true;

  const pdfSession = state.pdfSessions.end(jid);
  if (pdfSession) {
    await state.pdfSessions.cleanup(pdfSession);
    await sendText(jid, 'Sesi PDF dibatalkan.');
    return true;
  }

  if (await state.restoreSessions.cancel(jid)) {
    await sendText(jid, 'Sesi restore dibatalkan.');
    return true;
  }

  const cookieSession = state.youtubeCookieSessions.get(jid);
  if (cookieSession) {
    if (cookieSession.timer) clearTimeout(cookieSession.timer);
    state.youtubeCookieSessions.delete(jid);
    await sendText(jid, 'Input cookies YouTube dibatalkan.');
    return true;
  }

  return false;
}

async function finishRestore(message) {
  const jid = message.key.remoteJid;
  const session = state.restoreSessions.end(jid);
  if (!session) return false;
  state.scheduler?.stop();
  state.reminderScheduler?.stop();
  try {
    const result = await state.restoreSessions.restore(session);
    await sendText(jid, `Restore selesai. ${result.parts} part diproses, ${result.extracted} file diekstrak ke data/.`);
  } finally {
    state.scheduler?.start();
    state.reminderScheduler?.start();
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
  if (item) await sendText(message.key.remoteJid, `Ditambahkan ke PDF: ${item.fileName} (#${item.order})`);
  return Boolean(item);
}

async function handleReminder(message, command) {
  const reminder = await createReminder(command.args);
  await sendText(message.key.remoteJid, `Reminder #${reminder.id} dibuat. Terkirim dalam ${formatCountdown(new Date(reminder.dueAt).getTime() - Date.now())} ke ${PRIMARY_TARGET_NAME}.`);
}

async function handleClear(jid) {
  if (hasAnyTempSession()) throw new Error('Tidak bisa clear temp saat ada sesi save/PDF/restore/cookies aktif.');
  await cleanupStartupTemp();
  await sendText(jid, 'Temp dibersihkan.');
}

async function handleBackup(jid) {
  await sendText(jid, 'Membuat backup data/ dan mengirim ke Telegram...');
  const files = await sendDataBackupToTelegram();
  await sendText(jid, `Backup terkirim ke Telegram:\n${files.join('\n')}`);
}

async function handleRestoreStart(message) {
  const jid = message.key.remoteJid;
  assertNoActiveSession(jid);
  await state.restoreSessions.start(jid);
  await sendText(jid, 'Sesi restore dimulai. Kirim file .zip/PART zip sebagai dokumen WhatsApp, lalu ketik ,end dan ,confirm untuk overwrite folder data/. Ketik ,cancel untuk batal.');
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
    await runTool('systemctl', ['--no-block', 'restart', UPDATE_SYSTEMD_SERVICE]);
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

function formatCommandOutput(result) {
  const text = [result?.stdout, result?.stderr]
    .filter(Boolean)
    .join('\n')
    .trim();
  if (!text) return '';
  const lines = text.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  return lines.slice(-12).join('\n').slice(0, 1500);
}

async function handleCommand(message, command) {
  const jid = message.key.remoteJid;
  switch (command.name) {
    case 'help':
      await handleHelp(jid);
      break;
    case 'status':
      await handleStatus(jid);
      break;
    case 'health':
      await handleHealth(jid);
      break;
    case 'yt':
      await handleYoutube(message, command);
      break;
    case 'info':
      await handleInfo(message, command);
      break;
    case 'save':
      await handleSave(message, command);
      break;
    case 'load':
      await handleLoad(message, command);
      break;
    case 'note':
      if (command.args[0]?.toLowerCase() === 'del') {
        const query = command.args.slice(1).join(' ').trim();
        if (!query) throw new Error('Format: ,note del <id|judul>');
        await requestConfirmation(jid, {
          title: `Hapus note "${query}"`,
          description: 'Note ini akan dihapus permanen.',
          execute: async () => sendText(jid, await handleNoteCommand(command))
        });
      } else {
        await sendText(jid, await handleNoteCommand(command));
      }
      break;
    case 'link':
      if (command.args[0]?.toLowerCase() === 'del') {
        const query = command.args.slice(1).join(' ').trim();
        if (!query) throw new Error('Format: ,link del <id|nama>');
        await requestConfirmation(jid, {
          title: `Hapus link "${query}"`,
          description: 'Link ini akan dihapus permanen.',
          execute: async () => sendText(jid, await handleLinkCommand(command))
        });
      } else {
        await sendText(jid, await handleLinkCommand(command));
      }
      break;
    case 'cancel':
      {
        let cancelled = false;
        if (state.confirmStore.cancel(jid)) {
          cancelled = true;
          await sendText(jid, 'Konfirmasi dibatalkan.');
        }
        if (await cancelActiveSession(message)) cancelled = true;
        if (!cancelled) await sendText(jid, 'Tidak ada sesi aktif atau konfirmasi pending.');
      }
      break;
    case 'confirm':
      await handleConfirm(jid);
      break;
    case 's':
      await handleSticker(message, command);
      break;
    case 'rs':
      await handleReverseSticker(message, command);
      break;
    case 'task':
      await handleTask(message, command);
      break;
    case 'ltask':
      await handleListTask(jid, command);
      break;
    case 'remindme':
      await handleReminder(message, command);
      break;
    case 'topdf':
      await handleTopdf(message, command);
      break;
    case 'won':
      if (command.args[0]?.toLowerCase() === 'del') {
        const query = command.args.slice(1).join(' ').trim();
        if (!query) throw new Error('Format: ,won del <id|mac>');
        await requestConfirmation(jid, {
          title: `Hapus WOL "${query}"`,
          description: 'Entry Wake-on-LAN ini akan dihapus permanen.',
          execute: async () => sendText(jid, await handleWolCommand(command))
        });
      } else {
        await sendText(jid, await handleWolCommand(command));
      }
      break;
    case 'backup':
      await handleBackup(jid);
      break;
    case 'restore':
      await handleRestoreStart(message);
      break;
    case 'clear':
      await requestConfirmation(jid, {
        title: 'Hapus temp',
        description: 'Semua file sementara di temp/ akan dibersihkan.',
        execute: async () => handleClear(jid)
      });
      break;
    case 'restartbot':
      await requestConfirmation(jid, {
        title: 'Restart bot',
        description: 'Proses bot akan keluar dan perlu dinyalakan ulang oleh supervisor.',
        execute: async () => handleRestartBot(jid)
      });
      break;
    case 'update':
      await requestConfirmation(jid, {
        title: 'Update repo dan restart service',
        description: `Akan menjalankan git pull ${UPDATE_REMOTE} ${UPDATE_BRANCH}, lalu restart ${UPDATE_SYSTEMD_SERVICE}.`,
        execute: async () => handleUpdateBot(jid)
      });
      break;
    case 'end':
      if (await finishSave(message)) break;
      if (state.restoreSessions.has(jid)) {
        await requestConfirmation(jid, {
          title: 'Restore data',
          description: 'Folder data/ akan ditimpa dari file restore yang sudah dikirim.',
          execute: async () => finishRestore(message)
        });
        break;
      }
      await handleEndPdf(message);
      break;
    default:
      await sendText(jid, `Command tidak dikenal: ${COMMAND_PREFIX}${command.name}\nKetik ,help`);
      break;
  }
}

async function onMessageUpsert(event) {
  for (const message of event.messages || []) {
    if (!message.message || !message.key?.remoteJid || message.key.remoteJid === 'status@broadcast') continue;
    rememberMessageDirectory(message);
    state.viewOnceCache.remember(message);
    if (!message.key?.fromMe) continue;
    if (isIgnoredOwnOutput(message)) continue;
    const jid = message.key.remoteJid;
    const text = getMessageText(message);
    const command = parseCommand(text);
    try {
      if (state.saveRecorder.has(jid) && (!command || !['end', 'cancel'].includes(command.name))) {
        await state.saveRecorder.record(state.sock, message);
        continue;
      }
      if (state.restoreSessions.has(jid) && (!command || !['end', 'cancel', 'confirm'].includes(command.name))) {
        await maybeCollectRestorePart(message);
        continue;
      }
      if (state.youtubeCookieSessions.has(jid) && !command) {
        await finishYoutubeCookieInput(message, text);
        continue;
      }
      if (!command && !state.pdfSessions.has(jid) && await maybeHandleSecretMediaTrigger(message, text)) {
        continue;
      }
      if (command) {
        await handleCommand(message, command);
      } else {
        await maybeCollectPdfItem(message, text);
      }
    } catch (error) {
      await logger.error('Command error', { jid, error: error.message, text });
      await sendText(jid, `Error: ${error.message}`);
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
      state.scheduler.start();
      state.reminderScheduler.start();
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
  state.tools = await detectTools();
  state.pdfSessions = new PdfSessions(state.tools);
  state.restoreSessions = new RestoreSessions();
  state.saveRecorder = new SaveRecorder();
  state.backupScheduler = new DailyBackupScheduler(logger);
  state.backupScheduler.start();
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
