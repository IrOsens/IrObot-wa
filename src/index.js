import os from 'node:os';
import fs from 'node:fs/promises';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from 'baileys';
import {
  AUTH_DIR,
  COMMAND_PREFIX,
  DEFAULT_STICKER_AUTHOR,
  DEFAULT_STICKER_TITLE,
  ROOT_DIR,
  cleanupStartupTemp,
  ensureRuntimeDirs
} from './config.js';
import { cleanupOldLogs, logger } from './logger.js';
import { detectTools, formatBytes, formatDuration, getDiskInfo, getLoadAverageText } from './tools.js';
import { getMessageText, parseCommand } from './text.js';
import { cleanupFiles, downloadQuotedOrOwnMedia, downloadUrlMedia, mediaNode, quotedMediaNode } from './media.js';
import { makeSticker, parseStickerMeta, reverseSticker } from './sticker.js';
import { TaskScheduler, createTask, formatTaskList, formatWib, listTasks, updateTaskState } from './tasks.js';
import { PdfSessions } from './pdf.js';
import { downloadYoutube } from './youtube.js';
import {
  SaveRecorder,
  deleteSaved,
  formatSavedList,
  getSaved,
  listSaved,
  parseSaveStart,
  sendSaved
} from './saved.js';

class ChatDirectory {
  constructor() {
    this.byName = new Map();
  }

  remember(jid, name) {
    if (!jid || !name) return;
    this.byName.set(String(name).trim(), jid);
  }

  findByName(name) {
    return this.byName.get(name) || null;
  }
}

const state = {
  sock: null,
  tools: null,
  chatDirectory: new ChatDirectory(),
  scheduler: null,
  pdfSessions: null,
  saveRecorder: null,
  ignoredOwnMessageIds: new Set(),
  reconnecting: false
};

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
    'IrOBot Help',
    '',
    'Sticker & Media',
    ',s [author] [title] - buat sticker dari attach/reply/URL media',
    ',rs - reverse sticker jadi PNG/GIF atau keluarkan ulang media/view-once',
    ',topdf [urutan] - mulai sesi PDF; bisa reply media langsung',
    '',
    'Downloader',
    ',yt <link> <mp3|mp4> [360|480|720|1080]',
    '',
    'Reminder',
    ',task [count|loop] "<teks>" <jam> [menit] [detik] [tanggal]',
    'Contoh: ,task "test" 12 49 02 07/12/2026',
    ',ltask - lihat task',
    ',ltask true|false|del <id> - resume/pause/hapus task',
    '',
    'Saved Message',
    ',save <judul> [teks awal] - mulai rekam',
    ',load - lihat semua save',
    ',load <id|judul> - kirim ulang save',
    ',load del <id|judul> - hapus save',
    '',
    'Utility',
    ',info <nomor> - cek info WhatsApp dan foto profil',
    ',status - status server',
    '',
    'Session',
    ',end - selesai sesi save/PDF',
    ',cancel - batalkan rekaman save'
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

async function handleSticker(message, command) {
  const jid = message.key.remoteJid;
  const meta = parseStickerMeta(command.args);
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

async function handleReverseSticker(message) {
  const jid = message.key.remoteJid;
  let media = null;
  try {
    media = await downloadQuotedOrOwnMedia(state.sock, message, 'reverse-source');
    if (!media) throw new Error('Reply atau attach sticker/media/view-once untuk memakai ,rs.');
    if (media.type === 'imageMessage') {
      await state.sock.sendMessage(jid, { image: await fs.readFile(media.path), mimetype: media.mimetype });
      return;
    }
    if (media.type === 'videoMessage') {
      await state.sock.sendMessage(jid, { video: await fs.readFile(media.path), mimetype: media.mimetype });
      return;
    }
    const result = await reverseSticker(media, state.tools);
    if (result.mimetype === 'image/png') {
      await state.sock.sendMessage(jid, { image: result.buffer, mimetype: result.mimetype });
    } else {
      await state.sock.sendMessage(jid, {
        document: result.buffer,
        mimetype: result.mimetype,
        fileName: result.fileName
      });
    }
  } finally {
    await cleanupFiles([media?.path]);
  }
}

async function handleYoutube(message, command) {
  const jid = message.key.remoteJid;
  let result = null;
  try {
    await sendText(jid, 'Mulai download YouTube...');
    result = await downloadYoutube(command.args, state.tools);
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

function normalizePhoneToJid(input) {
  const digits = String(input || '').replace(/[^\d]/g, '');
  if (!digits) throw new Error('Format: ,info <nomor telepon>');
  let phone = digits;
  if (phone.startsWith('0')) phone = `62${phone.slice(1)}`;
  else if (phone.startsWith('8')) phone = `62${phone}`;
  return `${phone}@s.whatsapp.net`;
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
  const result = await updateTaskState(action.toLowerCase(), id);
  await sendText(jid, result.deleted ? `Task #${id} dihapus.` : `Task #${id} ${result.task.paused ? 'dipause' : 'aktif'}.`);
}

async function handleTopdf(message) {
  const jid = message.key.remoteJid;
  state.pdfSessions.start(jid);
  const text = getMessageText(message);
  const order = /^\s*,topdf\s+\d+\s*$/i.test(text) ? Number(text.trim().split(/\s+/).at(-1)) : null;
  const hasInitialMedia = mediaNode(message) || quotedMediaNode(message);
  if (hasInitialMedia) {
    const item = await state.pdfSessions.addAny(state.sock, message, order);
    await sendText(jid, `Sesi PDF dimulai dan file pertama ditambahkan: ${item.fileName} (#${item.order}). Kirim media lain lalu ketik ,end.`);
    return;
  }
  await sendText(jid, 'Sesi PDF dimulai. Kirim media/dokumen, beri caption angka untuk urutan jika perlu, atau reply media dengan ,topdf <angka>. Ketik ,end untuk selesai.');
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
      fileName: `IrOBot-${Date.now()}.pdf`
    });
  } finally {
    await state.pdfSessions.cleanup(session);
  }
}

async function handleSave(message, command) {
  const { title, firstText } = parseSaveStart(command);
  const session = state.saveRecorder.start(message.key.remoteJid, title, firstText);
  await sendText(message.key.remoteJid, `Mulai rekam save "${session.title}". Kirim teks/media apa pun, lalu ,end untuk simpan atau ,cancel untuk batal.`);
}

async function handleLoad(message, command) {
  const jid = message.key.remoteJid;
  if (!command.args.length) {
    await sendText(jid, formatSavedList(await listSaved()));
    return;
  }
  if (command.args[0].toLowerCase() === 'del') {
    const query = command.args.slice(1).join(' ').trim();
    if (!query) throw new Error('Format: ,load del <id|judul>');
    const item = await deleteSaved(query);
    await sendText(jid, `Save #${item.id} "${item.title}" dihapus.`);
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

async function maybeCollectPdfItem(message, text) {
  if (!state.pdfSessions.has(message.key.remoteJid)) return false;
  if (!mediaNode(message)) return false;
  const order = /^\s*\d+\s*$/.test(text) ? Number(text.trim()) : null;
  const item = await state.pdfSessions.add(state.sock, message, order);
  if (item) await sendText(message.key.remoteJid, `Ditambahkan ke PDF: ${item.fileName} (#${item.order})`);
  return Boolean(item);
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
    case 'cancel':
      if (!(await cancelSave(message))) await sendText(jid, 'Tidak ada rekaman save aktif.');
      break;
    case 's':
      await handleSticker(message, command);
      break;
    case 'rs':
      await handleReverseSticker(message);
      break;
    case 'task':
      await handleTask(message, command);
      break;
    case 'ltask':
      await handleListTask(jid, command);
      break;
    case 'topdf':
      await handleTopdf(message);
      break;
    case 'end':
      if (!(await finishSave(message))) await handleEndPdf(message);
      break;
    default:
      await sendText(jid, `Command tidak dikenal: ${COMMAND_PREFIX}${command.name}\nKetik ,help`);
      break;
  }
}

async function onMessageUpsert(event) {
  for (const message of event.messages || []) {
    if (!message.message || !message.key?.fromMe || message.key.remoteJid === 'status@broadcast') continue;
    if (isIgnoredOwnOutput(message)) continue;
    const jid = message.key.remoteJid;
    const text = getMessageText(message);
    const command = parseCommand(text);
    try {
      if (state.saveRecorder.has(jid) && (!command || !['end', 'cancel'].includes(command.name))) {
        await state.saveRecorder.record(state.sock, message);
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
    }
    if (connection === 'close') {
      state.scheduler?.stop();
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
  state.saveRecorder = new SaveRecorder();
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
