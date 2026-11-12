import { presentStatus, statusCaption } from './statusViewer.js';
import { pathToFileURL } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { UserInputError, SetupRequiredError } from './errors.js';
import { LocalArchive, STORAGE_FEATURES, destinationAlias, atomicJson, prepareLocalPath } from './storage.js';
import { StatusInbox } from './statusInbox.js';
import { ErrorReporter } from './errorReporter.js';
import { reviveValue, sendRecordedEntries, visibleRecordedEntries } from './recordedMessages.js';
import { makeTextSticker, parseTextSticker } from './textSticker.js';
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
  generateMessageIDV2,
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
  WORKERS_PENDING_DIR,
  cleanupStartupTemp,
  ensureRuntimeDirs
} from './config.js';
import { cleanupOldLogs, logger, setErrorSink } from './logger.js';
import { detectTools, fileExists, formatBytes, formatDuration, getDiskInfo, getLoadAverageText, runTool, runToolWithInput } from './tools.js';
import { getMessageText, parseCommand, extractQuotedMessage, unwrapMessage } from './text.js';
import {
  cleanupFiles,
  downloadMessageMedia,
  downloadQuotedOrOwnMedia,
  downloadUrlMedia,
  extractQuotedViewOnceMessage,
  isPdfFile,
  isViewOnceMediaMessage,
  mediaNode,
  quotedMediaNode
} from './media.js';
import { isAnimatedMedia, makeSmemeSticker, makeSticker, parseSmemeArgs, parseStickerArgs, reverseSticker } from './sticker.js';
import { QrSessions, downloadQrIcon, makeQrCode, parseQrArgs } from './qr.js';
import { TaskRecorder, TaskScheduler, createTask, formatTaskList, formatWib, listTasks, parseTaskRecordingArgs, updateTaskState } from './tasks.js';
import { PdfSessions, parsePdfOrderText, parsePdfStartArgs } from './pdf.js';
import { ToVideoSessions, parseToVideoOptions, videoMediaKind } from './toVideo.js';
import { StimpaSessions } from './stimpa.js';
import { pdfToImages } from './pdfImages.js';
import {
  SaveRecorder,
  assertSavedTitleAvailable,
  deleteSaved,
  formatSavedList,
  getSaved,
  listSaved,
  parseSaveStart,
  parseSaveUpdate,
  prepareSavedUpdate,
  renameSaved,
  sendSaved,
  sendRecentSaved
} from './saved.js';
import { handleLinkCommand, handleNoteCommand, listLinks, listNotes } from './notes.js';
import { ReminderScheduler, parseDurationMs, createReminder, formatCountdown, listReminders } from './reminders.js';
import { handleWolCommand, listWol } from './wol.js';
import { DailyBackupScheduler, sendDataBackupToWhatsApp, createDataBackupFiles } from './backup.js';
import { RestoreSessions } from './restore.js';
import { PendingConfirmStore } from './confirm.js';
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
import { formatServices, listOpenServices } from './services.js';
import { TypingController } from './typing.js';
import { WorkerStore, formatWorkerInfo, formatWorkerList, waLink } from './workers.js';
import { WorkerConnection } from './workerConnection.js';
import { CintaRecorder, absoluteEntries, relativeEntries, removeStoredMedia } from './cintaRecorder.js';
import {
  CINTA_DELAY_MS,
  CINTA_MAX_MESSAGE_AGE_MS,
  CINTA_REPLY_LIMIT,
  CINTA_REPLY_WINDOW_MS,
  DEFAULT_CINTA_CAPTION,
  ReplyLimiter,
  WORKER_COMMAND_DELAY_MS,
  WORKER_COMMAND_LIMIT,
  WORKER_COMMAND_WINDOW_MS,
  cintaConfig,
  findWorkerService,
  formatWorkerServiceList,
  matchCintaTrigger,
  parseCintaTriggers,
  parseReactionEmoji,
  randomDelayMs,
  workerCommandAllowed
} from './workerServices.js';

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

  findByKey(key) {
    if (!key?.remoteJid || !key?.id) return null;
    return this.pruned(key.remoteJid, Date.now())
      .find(({ message }) => message.key?.id === key.id && message.key?.remoteJid === key.remoteJid
        && (!key.participant || !message.key?.participant || sameActor(message.key.participant, key.participant)))?.message || null;
  }

  pruned(target, now) {
    const entries = this.byTarget.get(target) || [];
    const fresh = entries.filter((entry) => now - entry.seenAt <= this.ttlMs);
    if (fresh.length) this.byTarget.set(target, fresh);
    else this.byTarget.delete(target);
    return fresh;
  }
}

const workerScope = new AsyncLocalStorage();

const ownerState = {
  sock: null,
  connected: false,
  groups: new Map(),
  contactNames: new Map(),
  setupNotices: new Set(),
  localArchive: new LocalArchive(),
  statusInbox: null,
  errorReporter: null,
  sessionPrompts: new Map(),
  tools: null,
  chatDirectory: new ChatDirectory(),
  viewOnceCache: new ViewOnceCache(),
  forwardedViewOnceReactions: new Set(),
  scheduler: null,
  reminderScheduler: null,
  pdfSessions: null,
  toVideoSessions: null,
  stimpaSessions: null,
  qrSessions: null,
  restoreSessions: null,
  saveRecorder: null,
  taskRecorder: null,
  backupScheduler: null,
  confirmStore: new PendingConfirmStore(),
  reactionActions: new ReactionActionStore(),
  runtimeConfig: null,
  changedMessages: null,
  statusSave: null,
  commandAccess: null,
  botState: null,
  anticall: null,
  typing: null,
  rejectedCallIds: new Set(),
  ignoredOwnMessageIds: new Set(),
  reconnecting: false,
  notesFile: NOTES_FILE,
  linksFile: LINKS_FILE,
  promptKeysFile: path.join(ROOT_DIR, 'data', 'prompt-keys.json'),
  workerStore: null
};

// While a worker message is handled, state.<key> reads the worker's own value
// (socket, sessions, data files) when the worker scope defines that key.
const state = new Proxy(ownerState, {
  get(target, key) {
    const scope = workerScope.getStore();
    if (scope && key in scope.state) return scope.state[key];
    return target[key];
  },
  set(target, key, value) {
    const scope = workerScope.getStore();
    if (scope && key in scope.state) scope.state[key] = value;
    else target[key] = value;
    return true;
  }
});

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

async function sendBotMessage(jid, content, options = {}) {
  const messageId = options.messageId || generateMessageIDV2(ownUserJid());
  rememberOwnOutput({ key: { id: messageId } });
  const sent = await state.sock.sendMessage(jid, content, { ...options, messageId });
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
  return true;
}

const HELP_SECTIONS = [
  {
    title: 'Media',
    items: [
      { name: 'stext', text: ',stext Stiker teks' },
      { name: 's', text: ',s        Buat stiker dari gambar/video' },
      { name: 'smeme', text: ',smeme    Buat stiker meme dari gambar' },
      { name: 'resend', text: ',resend   Kirim ulang media/view-once' },
      { name: 'qr', text: ',qr       Buat QR dari pesan' },
      { name: 'topdf', text: ',topdf    Gabung gambar/dokumen jadi PDF' },
      { name: 'tovideo', text: ',tovideo  Ubah gambar/video jadi MP4 atau GIF' },
      { name: 'stimpa', text: ',stimpa   Timpa stiker bergerak dengan gambar edit' },
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
      { name: 'serverinfo', text: ',serverinfo Spesifikasi lengkap server' },
      { name: 'net', text: ',net      Cek koneksi' },
      { name: 'services', text: ',services Daftar port/service terbuka' },
      { name: 'log', text: ',log      Lihat log terbaru' },
      { name: 'wol', text: ',wol      Wake-on-LAN' },
      { name: 'health', text: ',health   Status teknis bot' },
      { name: 'info', text: ',info     Cek info WhatsApp' }
    ]
  },
  {
    title: 'Pengelolaan',
    items: [
      { name: 'pause', text: ',pause    Pause bot' },
      { name: 'resume', text: ',resume   Aktifkan lagi bot' },
      { name: 'worker', text: ',worker   Kelola worker' },
      { name: 'allow', text: ',allow    Atur akses chat' },
      { name: 'admin', text: ',admin    Atur admin' },
      { name: 'setup', text: ',setup Tujuan grup/server' },
      { name: 'config', text: ',config   Atur config' },
      { name: 'backup', text: ',backup   Backup data' },
      { name: 'restore', text: ',restore  Restore data' },
      { name: 'update', text: ',update   Update bot' },
      { name: 'pull', text: ',pull     Git pull branch aktif' },
      { name: 'restartbot', text: ',restartbot Restart bot' },
      { name: 'anticall', text: ',anticall Kelola anti-call' },
      { name: 'changedmsg', text: ',changedmsg Pantau pesan edit/hapus' },
      { name: 'statussave', text: ',statussave Simpan status WA' },
      { name: 'clear', text: ',clear    Bersihkan temp' },
      { name: 'button', text: ',button   Tes tombol command' },
      { name: 'typing', text: ',typing   Tampilkan typing terus-menerus' }
    ]
  },
  {
    title: 'Multiakun',
    items: [
      { name: 'jadibot', text: ',jadibot  Daftar jadi worker' },
      { name: 'cinta', text: ',cinta    Rekam pesan otomatis cinta' }
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
  setup: ['Format: ,setup [statussave|backup|logs|changedmsg|errors]', ',setup root <path-server>', ',setup <fitur> group <nama-grup|jid>', ',setup <fitur> local [path]', 'Satu tujuan aktif per fitur. Error teknis selalu memakai grup.'],
  stext: ['Format: ,stext [align=justify|left|right|center] <teks>', 'Default rata kiri dengan jarak huruf normal; alias: kiri, kanan, tengah, kiri-kanan.', 'Stiker 512×512, Arial hitam, panel putih membulat, low quality sedikit buram. Ukuran font otomatis menyesuaikan isi.', 'Contoh: ,stext align=center Halo dunia'],
  help: ['Format: ,help <command>', 'Contoh: ,help s, ,help task.'],
  s: ['Format: ,s [q=1-100]', 'Format: ,s <title>,<author> [q=1-100]', 'Default q=100. Kualitas/resolusi hanya diturunkan jika perlu agar ukuran sticker bisa dikirim.', 'Kirim/reply media atau sertakan URL media.'],
  smeme: ['Format: ,smeme up <teks>', 'Format: ,smeme down <teks>', 'Advanced: tambah kualitas 1-99 di akhir.'],
  resend: ['Format: ,resend', 'Legacy: ,rs', 'Reply media/view-once. Sticker statis dikirim sebagai PNG, sticker bergerak sebagai GIF.'],
  qr: ['Format langsung: ,qr [style=square|dot|rounded] [bg=warna|#RRGGBB] <pesan>', 'Format sesi: ,qr [style=square|dot|rounded] [bg=warna|#RRGGBB], lalu kirim pesan terpisah dan akhiri dengan ,end.', 'Background: white, black, red, blue, green, yellow, purple, orange. Default style=square dan bg=white.', 'Lampirkan gambar/GIF pada pesan untuk menjadikannya ikon tengah QR. Caption tetap menjadi isi QR.'],
  status: ['Format: ,status atau ,status bot', ',status menampilkan server ringkas. ,status bot menampilkan destination, scheduler, changedmsg, statussave, dan warning nama grup duplikat.'],
  serverinfo: ['Format: ,serverinfo', 'Menampilkan spesifikasi server lengkap: OS, CPU, RAM, disk, network, Node.js, dan proses bot.'],
  topdf: ['Format: ,topdf [--name "nama"] [--split] [--max-size 1MB | --target-size 2MB]', '--max-size: batas maksimum; --target-size: ukuran tepat, maksimal 100MB.', 'Target tepat dapat menambahkan padding tanpa meningkatkan kualitas. Kompresi PDF dapat mengubah teks menjadi gambar.', 'Nama berspasi wajib dikutip dalam mode flag. Jangan campur flag dengan format lama.', 'Legacy: ,topdf nama max 1MB, ,topdf split nama, dan ,topdf nama,1MB tetap didukung.', 'Kirim/reply media setelah sesi dimulai. Selesai pakai ,end. Batal pakai ,cancel.'],
  tovideo: ['Kirim/reply gambar, video, atau stiker: ,tovideo [duration=3s] [speed=0.25-4|slow=1-4] [format=mp4|gif] [q=1-100].', 'speed=2 mempercepat 2×; slow=2 memperlambat 2× (video dan audio sumber). Tanpa duration, panjang hasil video menyesuaikan kecepatan; duration=... tetap menentukan panjang hasil.', 'Jika mulai dari stiker, kirim gambar/video template yang sudah menampilkan stiker itu di dalam sesi.', 'Tanpa duration, gambar dibuat 5 detik dan video mengikuti durasi aslinya. Durasi dapat diubah selama sesi.', 'Sesi menerima stiker WhatsApp, audio, atau teks: duration=2m, speed=2, slow=2, sync, mute, unmute, vvol=50%, mvol=50%, q=80, format=gif.', 'Selesai: ,end atau ✅/👍/❤️ pada pesan sesi. Batal: ,cancel atau ❌/👎/❎.', 'Stiker harus terlihat pada sumber agar posisi, ukuran, dan rotasinya bisa dicocokkan. GIF WhatsApp tidak bersuara.'],
  stimpa: ['Reply stiker bergerak dengan ,stimpa.', 'Bot mengirim frame pertama sebagai gambar kanvas. Edit gambar itu di WhatsApp, lalu kirim satu atau beberapa gambar edit tanpa crop.', 'Setiap gambar yang cocok ditumpuk pada animasi yang sama; gambar yang tidak cocok dilewati. ,end membuat stiker bergerak; ,cancel membatalkan.'],
  toimg: ['Format: ,toimg', 'Reply/kirim dokumen PDF, lalu bot mengirim tiap halaman sebagai gambar.'],
  note: ['Format: ,note list', 'Format: ,note add <judul> <teks>', 'Format: ,note get <id|judul>', 'Format: ,note del <id|judul>', 'Format: ,note rename <id|judul> <judul-baru>', 'Legacy: ,note <judul> <teks> dan ,note change tetap didukung.'],
  link: ['Format: ,link list', 'Format: ,link add <nama> <https://link>', 'Format: ,link get <id|nama>', 'Format: ,link del <id|nama>', 'Format: ,link rename <id|nama> <nama-baru>', 'Legacy: ,link <nama> <url> dan ,link change tetap didukung.'],
  save: ['Format: ,save <judul> [teks awal]', 'Format: ,save update <id|"judul lama"> ["judul baru"]', 'Saat update, bot menampilkan 2 isi terakhir dari save lama (jika tersedia). Kirim konten tambahan lalu ,end; isi lama tetap ada dan ID tidak berubah.'],
  load: ['Format: ,load', 'Format: ,load <id|judul>', 'Format: ,load del <id|judul>', 'Format: ,load rename <id|"judul lama"> <judul-baru>', 'Legacy: ,load change tetap didukung.'],
  remindme: [',remindme <durasi> membuka listening teks/media/VN/lokasi.', 'Format: ,remindme <teks> <durasi>', 'Unit: s = detik, m = menit, h = jam, d = hari.', 'Contoh: ,remindme cek server 1h30m'],
  task: [',task record <target> every <durasi> count <jumlah>', ',task record <target> every <durasi> forever', 'Tambahkan at <HH:MM> [DD/MM/YYYY] untuk waktu mulai WIB.', 'Pengiriman pertama setelah interval dari ,end; count adalah total kiriman.', 'Task gagal/hasil ambigu dipause; periksa sebelum ,task resume <id>. Resume melanjutkan item belum terkonfirmasi, yang mungkin sudah terkirim.', 'Format: ,task list', 'Format: ,task add <teks> at <HH:MM>', 'Format: ,task add <teks> at <HH:MM> <DD/MM/YYYY>', 'Format: ,task loop <teks> at <HH:MM>', 'Format: ,task repeat <jumlah> <teks> at <HH:MM>', 'Format: ,task record [loop|repeat <jumlah>] <nomor|nama kontak|nama grup> at <HH:MM> [DD/MM/YYYY]', 'Setelah record, kirim pesan bebas/media lalu ,end. ,cancel atau reaction ❌/👎/❎ membatalkan rekaman.', 'Format: ,task pause|stop <id>', 'Format: ,task resume <id>', 'Format: ,task del <id>', 'Legacy: ,ltask true|false|del <id> tetap didukung.'],
  wol: ['Format: ,wol list', 'Format: ,wol add <mac>', 'Format: ,wol wake <id|mac>', 'Format: ,wol del <id|mac>', 'Legacy: ,won, ,won save <mac>, ,won <id|mac>, dan ,won del <id|mac> tetap didukung.'],
  log: ['Format: ,log [baris]', 'Default 30 baris, maksimal 80 baris.'],
  net: ['Format: ,net', 'Cek IP publik, DNS, HTTP latency, IP lokal, dan estimasi download kecil.'],
  services: ['Format: ,services', 'Menampilkan listener TCP/UDP yang terbuka, klasifikasi web/SSH/Samba/dll, IP lokal, dan URL Tailscale.'],
  health: ['Format: ,health', 'Status teknis proses, tool, data count, scheduler, dan runtime file.'],
  info: ['Format: ,info <nomor>', 'Contoh: ,info 08123431212'],
  typing: ['Format: ,typing <nomor|nama-grup|jid>', 'Format: ,typing stop', 'Bisa aktif di beberapa target sekaligus. Status typing diperbarui terus dan dipulihkan setelah reconnect/restart sampai dihentikan manual.'],
  changedmsg: ['Format: ,changedmsg list|allow|del <id|nama-grup|jid>', 'DM dipantau default. Grup harus di-allow. Nama grup duplikat ditolak; pakai JID agar aman.'],
  config: ['Format: ,config, ,config get <key>, ,config set <key> <value>', 'Destination key menerima nama grup, JID, atau nomor. Grup disimpan sebagai JID + nama.'],
  statussave: ['Tambahkan nomor sekali: ,statussave add <nomor>. Status baru tersimpan otomatis ke tujuan aktif.',
    ',statussave — ringkasan auto-save dan tujuan', ',statussave list — daftar nomor dipantau',
    ',statussave list <nomor> atau ,statussave show <nomor> — tampilkan seluruh isi status aktif beserta caption asli di chat ini',
    ',statussave on / off — aktifkan/nonaktifkan auto-save', ',statussave del <nomor|id> — hapus nomor pemantauan',
    ',statussave setup — pilih tujuan grup atau server',
    'Lanjutan: ,statussave active [kontak] [page=2] untuk daftar metadata; ,statussave dump <id-status>|all <kontak> untuk arsip manual.',
    'Menampilkan status tidak mengubah tujuan arsip. Hanya status aktif yang diterima bot yang tersedia.'],
  backup: ['Format: ,backup', 'Backup data/ ke satu tujuan aktif. Pilih grup/server dengan ,setup backup.'],
  restore: ['Format: ,restore atau ,restore save', ',restore memulihkan seluruh data/. ,restore save hanya memulihkan koleksi save.', 'Kirim ZIP/semua part, lalu ,end. Pada restore save pilih semua atau beberapa save dengan angka; 0 kembali. Pilih timpa/gabung lalu ,confirm.'],
  anticall: ['Listening: ,anticall new, kirim teks/media/VN/lokasi, lalu ,end atau ✅/👍/❤️. Batal: ,cancel atau ❌/👎/❎.', 'Format: ,anticall', 'Format: ,anticall new|on|off', 'Format: ,anticall except list|add|del <nomor|id>'],
  allow: ['Format: ,allow here on|off', 'Format: ,allow all on|off', 'Legacy true|false tetap didukung.'],
  admin: ['Format: ,admin list', 'Format: ,admin add <nomor>', 'Format: ,admin del <nomor|id>'],
  pause: ['Format: ,pause', 'Mem-pause command, session, scheduler, backup otomatis, changedmsg, statussave, dan anticall akun utama. Worker tetap berjalan.'],
  resume: ['Format: ,resume', 'Mengaktifkan lagi bot setelah ,pause.'],
  worker: [
    'Format: ,worker atau ,worker list',
    'Format: ,worker info <id|nomor>',
    'Format: ,worker session <id|nomor>, lalu ketik command di chat dengan nomor worker. Keluar: ,end atau ,worker exit',
    'Format: ,worker service list',
    'Format: ,worker service <id|nomor> <nama|off>',
    'Format: ,worker default <id|nomor> on|off (izinkan command default untuk worker yang memakai service)'
  ],
  jadibot: [
    'Format: ,jadibot atau ,jadibot kode',
    'Permintaan dikirim ke admin. Setelah disetujui, QR (atau kode tautan) dikirim dan berlaku 60 detik.',
    'Satu nomor hanya bisa menjadi satu worker. Berhenti jadi worker: logout perangkat tertaut di WhatsApp.'
  ],
  cinta: [
    'Format: ,cinta (mulai sesi rekam pesan otomatis)',
    'Kirim teks, gambar, atau media lain lalu ,end atau ✅/👍/❤️ untuk simpan. Batal: ,cancel atau ❌/👎/❎.',
    'Format: ,cinta trigger <teks> (satu trigger per baris)',
    'Format: ,cinta emoji <emoji|->',
    'Format: ,cinta info, ,cinta test, ,cinta reset'
  ],
  pull: ['Format: ,pull', 'Menjalankan git pull pada branch yang sedang aktif tanpa restart. Restart manual dengan ,restartbot agar perubahan dipakai.'],
  update: ['Format: ,update', 'Menjalankan git pull dan restart service dengan konfirmasi.'],
  restartbot: ['Format: ,restartbot', 'Keluar dari proses bot dengan konfirmasi agar supervisor bisa menyalakan ulang.'],
  clear: ['Format: ,clear', 'Membersihkan temp/ dengan konfirmasi.'],
  button: ['Format: ,button <pesan>', 'Tes tombol interaktif.'],
  end: ['Format: ,end', 'Selesaikan sesi aktif seperti save, PDF, QR, anticall, atau restore.'],
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
  const lines = [`*${BOT_NAME}*`, 'Pilih command atau lihat detail: ,help <command>'];
  for (const section of HELP_SECTIONS) {
    const items = section.items.filter((item) => canShowHelpItem(item.name, jid, context));
    if (items.length) lines.push('', `*${section.title}*`, items.map((item) => `${COMMAND_PREFIX}${item.name}`).join(' · '));
  }
  lines.push('', 'Contoh: ,help task • ,help Media');
  await sendText(jid, lines.join('\n'));
}

async function handleHelpDetail(jid, query, context) {
  const section = HELP_SECTIONS.find((item) => item.title.toLowerCase() === query);
  if (section) {
    const items = section.items.filter((item) => canShowHelpItem(item.name, jid, context));
    await sendText(jid, [`*${section.title}*`, ...items.map((item) => item.text.replace(/\s{2,}/g, ' — ')), '', 'Detail: ,help <command>'].join('\n'));
    return;
  }

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
  if (commandName === 'cinta' && !workerScope.getStore()) return false;
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

async function handleServerInfo(jid) {
  const mem = process.memoryUsage();
  const disk = await getDiskInfo(ROOT_DIR);
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model || 'unknown';
  const cpuSpeed = cpus[0]?.speed ? `${cpus[0].speed} MHz` : 'unknown';
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const networkLines = formatNetworkInterfaces();
  const user = safeUserInfo();
  const diskLines = disk
    ? [
        `Disk source: ${disk.source}`,
        `Disk total: ${formatBytes(disk.size)}`,
        `Disk used: ${formatBytes(disk.used)} (${formatPercent(disk.used, disk.size)})`,
        `Disk free: ${formatBytes(disk.free)} (${formatPercent(disk.free, disk.size)})`
      ]
    : ['Disk: unavailable'];

  await sendText(jid, [
    'Server info:',
    '',
    'System:',
    `Hostname: ${os.hostname()}`,
    `Platform: ${process.platform} ${process.arch}`,
    `OS: ${os.type()} ${os.release()}`,
    `OS version: ${typeof os.version === 'function' ? os.version() : 'unavailable'}`,
    `Machine: ${typeof os.machine === 'function' ? os.machine() : process.arch}`,
    `User: ${user}`,
    `Time: ${new Date().toLocaleString()}`,
    `Timezone offset: UTC${formatTimezoneOffset(new Date().getTimezoneOffset())}`,
    `Uptime OS: ${formatDuration(os.uptime())}`,
    '',
    'CPU:',
    `Model: ${cpuModel}`,
    `Cores: ${cpus.length || 'unknown'}`,
    `Speed: ${cpuSpeed}`,
    `Load avg: ${getLoadAverageText()}`,
    '',
    'Memory:',
    `RAM total: ${formatBytes(totalMem)}`,
    `RAM used: ${formatBytes(usedMem)} (${formatPercent(usedMem, totalMem)})`,
    `RAM free: ${formatBytes(freeMem)} (${formatPercent(freeMem, totalMem)})`,
    `Process RSS: ${formatBytes(mem.rss)}`,
    `Process heap: ${formatBytes(mem.heapUsed)} / ${formatBytes(mem.heapTotal)}`,
    `Process external: ${formatBytes(mem.external)}`,
    '',
    'Storage:',
    ...diskLines,
    '',
    'Runtime:',
    `Bot: ${isBotEnabled() ? 'on' : 'off'}`,
    `PID: ${process.pid}`,
    `Node: ${process.version}`,
    `Exec path: ${process.execPath}`,
    `Working dir: ${process.cwd()}`,
    `Project dir: ${ROOT_DIR}`,
    `Bot uptime: ${formatDuration(process.uptime())}`,
    '',
    'Network:',
    ...networkLines
  ].join('\n'));
}

function safeUserInfo() {
  try {
    const info = os.userInfo();
    return info.username || 'unknown';
  } catch {
    return 'unknown';
  }
}

function formatPercent(value, total) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 'unknown';
  return `${((value / total) * 100).toFixed(1)}%`;
}

function formatTimezoneOffset(offsetMinutes) {
  const sign = offsetMinutes <= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

function formatNetworkInterfaces() {
  const entries = Object.entries(os.networkInterfaces() || {})
    .flatMap(([name, items]) => (items || [])
      .filter((item) => !item.internal)
      .map((item) => `${name}: ${item.family} ${item.address}${item.mac ? `, mac ${item.mac}` : ''}`));
  return entries.length ? entries.slice(0, 12) : ['No external interface found'];
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
    `Dest errors: ${formatDestinationLine('errors')}`,
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
      if (state.runtimeConfig.storageTarget(name === 'saved' ? 'statussave' : name).mode === 'local') continue;
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
        storageTarget(name);
      } catch {
        warnings.push(`Changedmsg aktif tapi dest.${name} belum valid.`);
      }
    }
  }
  if (statusSettings.enabled) {
    try {
      storageTarget('statussave');
    } catch {
      warnings.push('Statussave aktif tapi dest.saved belum valid.');
    }
  }
  return [...new Set(warnings)];
}

function activeSessionType(jid) {
  if (state.saveRecorder?.has(jid)) return 'save';
  if (state.taskRecorder?.has(jid)) return 'rekam task';
  if (state.anticall?.has(jid)) return 'anticall';
  if (state.cintaRecorder?.has(jid)) return 'cinta';
  if (state.pdfSessions?.has(jid)) return 'PDF';
  if (state.toVideoSessions?.has(jid)) return 'video';
  if (state.stimpaSessions?.has(jid)) return 'stimpa';
  if (state.qrSessions?.has(jid)) return 'QR';
  if (state.restoreSessions?.has(jid)) return 'restore';
  return null;
}

function activeSessionActorMatches(jid, actorJid) {
  if (state.saveRecorder?.has(jid)) return state.saveRecorder.isActor(jid, actorJid);
  if (state.taskRecorder?.has(jid)) return state.taskRecorder.isActor(jid, actorJid);
  if (state.anticall?.has(jid)) return state.anticall.isActor(jid, actorJid);
  if (state.cintaRecorder?.has(jid)) return state.cintaRecorder.isActor(jid, actorJid);
  if (state.pdfSessions?.has(jid)) return state.pdfSessions.isActor(jid, actorJid);
  if (state.toVideoSessions?.has(jid)) return state.toVideoSessions.isActor(jid, actorJid);
  if (state.stimpaSessions?.has(jid)) return state.stimpaSessions.isActor(jid, actorJid);
  if (state.qrSessions?.has(jid)) return state.qrSessions.isActor(jid, actorJid);
  if (state.restoreSessions?.has(jid)) return state.restoreSessions.isActor(jid, actorJid);
  return true;
}

function activeSessionOwnerJid(jid) {
  const promptActor = state.sessionPrompts.get(jid)?.actorJid;
  if (promptActor) return promptActor;
  for (const session of [state.saveRecorder?.sessions?.get(jid), state.taskRecorder?.sessions?.get(jid),
    state.anticall?.sessions?.get(jid), state.cintaRecorder?.sessions?.get(jid), state.pdfSessions?.get(jid), state.toVideoSessions?.get(jid),
    state.stimpaSessions?.get(jid), state.qrSessions?.get(jid), state.restoreSessions?.sessions?.get(jid)]) {
    if (session?.actorJid) return session.actorJid;
  }
  return null;
}

function isSessionController(jid, actorJid, isOwner = false) {
  return Boolean(activeSessionType(jid) && (isOwner || state.commandAccess?.isAdmin(actorJid)));
}

function sessionControlActor(jid, actorJid, isOwner = false) {
  return isSessionController(jid, actorJid, isOwner) ? activeSessionOwnerJid(jid) || actorJid : actorJid;
}

function assertNoActiveSession(jid) {
  const active = activeSessionType(jid);
  if (active) throw new UserInputError(`Masih ada sesi ${active} aktif. Selesaikan dengan ,end atau batalkan dengan ,cancel.`);
}

function hasAnyTempSession() {
  return Boolean(
    state.saveRecorder?.sessions?.size
    || state.taskRecorder?.sessions?.size
    || state.anticall?.sessions?.size
    || state.cintaRecorder?.sessions?.size
    || state.pdfSessions?.count()
    || state.toVideoSessions?.count()
    || state.stimpaSessions?.count()
    || state.qrSessions?.count()
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

let promptSaveQueue = Promise.resolve();
function rememberPromptKey(key) {
  if (!key?.remoteJid || !key?.id) return;
  const prompts = state.reactionActions.prompts;
  const promptKeysFile = state.promptKeysFile;
  prompts.add(`${key.remoteJid}:${key.id}`);
  promptSaveQueue = promptSaveQueue.then(() => atomicJson(promptKeysFile, [...prompts])).catch((error) => logger.error('Prompt persistence failed', { error: error.message }));
}

function registerConfirmationPrompt(messageKey, jid, actorJid) {
  rememberPromptKey(messageKey);
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
  state.sessionPrompts.set(jid, { key: messageKey, actorJid, lastActivity: Date.now() });
  rememberPromptKey(messageKey);
  state.reactionActions.register(messageKey, {
    actorJid,
    scope: `session:${jid}:${actorJid}`,
    ttlMs: 30 * 60 * 1000,
    onConfirm: async () => handleEndSession(jid, actorJid),
    onCancel: async () => handleCancelByJid(jid, actorJid)
  });
}

async function listeningProgress(jid, recorded) {
  const prompt = state.sessionPrompts.get(jid);
  if (!prompt || !recorded) return;
  prompt.lastActivity = Date.now();
  const action = state.reactionActions.get(prompt.key, prompt.actorJid);
  if (action) action.expiresAt = Date.now() + 30 * 60 * 1000;
  await editText(jid, prompt.key, `*Listening • ${recorded.count} item*\nTerbaru: ${recorded.type}\nSelesai: ,end atau ✅/👍/❤️\nBatal: ,cancel atau ❌/👎/❎`);
}

async function expireListeningSessions() {
  for (const [jid, prompt] of state.sessionPrompts) {
    if (!activeSessionType(jid)) { state.sessionPrompts.delete(jid); continue; }
    if (Date.now() - prompt.lastActivity < 30 * 60 * 1000) continue;
    await cancelActiveSessionByJid(jid, prompt.actorJid);
    state.reactionActions.clearScope(`session:${jid}:${prompt.actorJid}`);
    state.sessionPrompts.delete(jid);
  }
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
    rememberPromptKey(sent.key);
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
      throw new UserInputError([
        `Nama "${input}" cocok ke lebih dari satu chat. Pakai JID salah satu target:`,
        ...result.candidates.map((item) => `- ${item.currentName || item.savedName} (${item.jid})`)
      ].join('\n'));
    }
    throw new UserInputError(`Target "${input}" tidak ditemukan di cache chat bot. Kirim pesan di chat target dulu atau pakai JID/nomor.`);
  }
  if (options.requireGroup && !result.item.jid.endsWith('@g.us')) {
    throw new UserInputError('Target harus grup. Pakai nama grup atau JID grup.');
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
  if (name === 'errors' && typeof value !== 'object') throw new SetupRequiredError('errors');
  if (!value) throw new UserInputError(`Destination ${name} belum diset. Gunakan ,config set dest.${name} <group|nomor>.`);
  if (typeof value === 'object' && value.jid) return value;
  return resolveDestinationInput(String(value || name), null);
}

function destinationJid(name) {
  return resolveConfiguredDestination(name).jid;
}

function formatDestinationLine(name) {
  try {
    if (name !== 'errors') { const target = state.runtimeConfig.storageTarget(name === 'saved' ? 'statussave' : name); if (target.mode === 'local') return `${name}: local ${target.path}`; }
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
    `Sessions: save=${state.saveRecorder?.sessions?.size || 0}, anticall=${state.anticall?.sessions?.size || 0}, pdf=${state.pdfSessions?.count() || 0}, video=${state.toVideoSessions?.count() || 0}, stimpa=${state.stimpaSessions?.count() || 0}, qr=${state.qrSessions?.count() || 0}, restore=${state.restoreSessions?.count() || 0}, confirm=${state.confirmStore.count()}`,
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
  const options = parseStickerArgs(command.rawArgs, {
    defaultAuthor: DEFAULT_STICKER_AUTHOR,
    defaultTitle: DEFAULT_STICKER_TITLE
  });
  let media = null;
  try {
    media = await downloadQuotedOrOwnMedia(state.sock, message, 'sticker-source');
    if (!media) media = await downloadUrlMedia(command.rawArgs, 'sticker-url');
    if (!media) throw new UserInputError('Kirim/reply media atau sertakan URL media yang valid.');
    const animated = await isAnimatedMedia(media);
    const sticker = await makeSticker(media, {
      author: options.author,
      title: options.title,
      quality: options.quality,
      tools: state.tools
    });
    await sendBotMessage(jid, { sticker, mimetype: 'image/webp', isAnimated: animated || undefined });
  } finally {
    await cleanupFiles([media?.path]);
  }
}

async function handleQr(message, command, actorJid) {
  const jid = message.key.remoteJid;
  const options = parseQrArgs(command.rawArgs);
  if (!options.text) {
    assertNoActiveSession(jid);
    if (mediaNode(message)) {
      throw new UserInputError('Untuk memakai gambar/GIF sebagai ikon, sertakan isi pesan: ,qr <pesan>. Media pada pembuka sesi tidak menjadi ikon global.');
    }
    const session = state.qrSessions.start(jid, { ...options, actorJid });
    const sent = await sendText(jid, formatQrProgressMessage(session));
    session.progressKey = sent.key;
    registerSessionPrompt(sent.key, jid, actorJid);
    return;
  }

  let iconMedia = null;
  try {
    iconMedia = await downloadQrIcon(state.sock, message, 'qr-direct-icon');
    const image = await makeQrCode(options.text, {
      ...options,
      iconMedia,
      tools: state.tools
    });
    await sendBotMessage(jid, { image, mimetype: 'image/png' }, { quoted: message });
  } finally {
    await cleanupFiles([iconMedia?.path]);
  }
}

function formatQrProgressMessage(session) {
  const style = session.style;
  const background = session.background;
  return [
    `Sesi QR aktif (style=${style}, bg=${background}).`,
    `Pesan diterima: ${session.items.length}.`,
    'Kirim setiap teks/caption sebagai pesan terpisah. Gambar/GIF pada pesan akan menjadi ikon tengah QR.',
    'Selesai: ,end atau reaction ✅/👍/❤️. Batal: ,cancel atau reaction ❌/👎/❎.'
  ].join('\n');
}

async function maybeCollectQrItem(message, text) {
  const session = state.qrSessions.get(message.key.remoteJid);
  if (!session) return false;
  await state.qrSessions.add(state.sock, message, text);
  await editText(message.key.remoteJid, session.progressKey, formatQrProgressMessage(session));
  return true;
}

async function handleSmeme(message, command) {
  const jid = message.key.remoteJid;
  const smeme = parseSmemeArgs(command.args);
  let media = null;
  try {
    media = await downloadQuotedOrOwnMedia(state.sock, message, 'smeme-source');
    if (!media) throw new UserInputError('Reply image, GIF, video, atau sticker untuk memakai ,smeme.');
    const supportedDocument = media.type === 'documentMessage' && /^(image|video)\//i.test(media.mimetype || '');
    if (!['imageMessage', 'videoMessage', 'stickerMessage'].includes(media.type) && !supportedDocument) {
      throw new UserInputError('Smeme hanya mendukung image, GIF, video, atau sticker.');
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
    if (command.rawArgs.trim()) throw new UserInputError('Format: reply media/view-once lalu ketik ,resend tanpa parameter. Legacy ,rs tetap didukung.');
    media = await downloadQuotedOrOwnMedia(state.sock, message, 'reverse-source');
    if (!media) throw new UserInputError('Reply media/view-once untuk memakai ,resend. Legacy ,rs tetap didukung.');
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
    if (!media) throw new UserInputError('Kirim/reply dokumen PDF untuk memakai ,toimg.');
    if (!isPdfFile(media.path, media.mimetype) && !isPdfFile(media.fileName, media.mimetype)) {
      throw new UserInputError('Untuk sekarang ,toimg hanya mendukung file PDF.');
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

export async function maybeForwardReactedViewOnce(update, { downloadMedia = downloadMessageMedia, sendMedia = sendDownloadedMedia } = {}) {
  if (!update?.reaction?.key?.fromMe || !String(update.reaction.text || '').trim()) return false;
  const source = state.viewOnceCache.findByKey(update.key);
  if (!source) return false;
  const key = `${update.key.remoteJid}:${update.key.id}`;
  if (state.forwardedViewOnceReactions.has(key)) return true;
  const destinationJid = state.chatDirectory.findByName(PRIMARY_TARGET_NAME);
  if (!destinationJid) throw new Error(`Grup target "${PRIMARY_TARGET_NAME}" tidak ditemukan di cache chat bot.`);
  let media = null;
  try {
    media = await downloadMedia(state.sock, source, 'view-once-reaction');
    if (!media) throw new Error('View-once yang direaksi tidak bisa dibaca.');
    await sendMedia(destinationJid, media);
    state.forwardedViewOnceReactions.add(key);
    if (state.forwardedViewOnceReactions.size > 1000) state.forwardedViewOnceReactions.delete(state.forwardedViewOnceReactions.values().next().value);
    return true;
  } finally {
    await cleanupFiles([media?.path]);
  }
}

async function maybeForwardRepliedViewOnce(message, text) {
  const quoted = extractQuotedViewOnceMessage(message);
  if (!quoted) return false;
  const destinationJid = state.chatDirectory.findByName(PRIMARY_TARGET_NAME);
  if (!destinationJid) throw new Error(`Grup target "${PRIMARY_TARGET_NAME}" tidak ditemukan di cache chat bot.`);

  let media = null;
  try {
    media = await downloadMessageMedia(state.sock, quoted, 'view-once-reply');
    if (!media) throw new Error('Reply mengarah ke view-once, tapi medianya tidak bisa dibaca.');
    const replyCaption = String(text || '').trim();
    await sendDownloadedMedia(destinationJid, media, {
      caption: replyCaption || media.node?.caption || undefined
    });
    return true;
  } finally {
    await cleanupFiles([media?.path]);
  }
}

async function sendLatestViewOnce(destinationJid, targetQuery) {
  const targetJid = state.chatDirectory.findByName(targetQuery);
  if (!targetJid) throw new UserInputError(`Target "${targetQuery}" tidak ditemukan di cache chat/kontak bot.`);
  const source = state.viewOnceCache.latest(targetJid);
  if (!source) throw new UserInputError(`Belum ada view-once terbaru dari "${targetQuery}" selama bot aktif.`);

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
    return sendBotMessage(jid, { audio: buffer, mimetype: media.mimetype, ptt: Boolean(media.node?.ptt) });
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

  let target;
  try { target = storageTarget('logs'); } catch (error) { await handleFailure(error); return false; }
  const logsJid = target.jid;
  const summary = summarizeMessage(message);
  const actorJid = messageActorJid(message);
  const metaText = changedMessageMetaText('LOG', message, {
    actorJid,
    type: summary.type,
    text: summary.text
  });

  let logContentMessage = null;
  let logPath = null;
  let media = null;
  try {
    if (target.mode === 'local') {
      const node = mediaNode(message);
      const maxBytes = state.runtimeConfig.changedmsgSettings().maxMediaBytes;
      if (node && Number(node.node.fileLength || 0) <= maxBytes) {
        media = await downloadMessageMedia(state.sock, message, 'log-archive');
        if (media && (await fs.stat(media.path)).size > maxBytes) { await cleanupFiles([media.path]); media = null; }
      }
      const archived = await state.localArchive.write(target.path, { identity: jid, name: state.chatDirectory.nameFor(jid), timestamp: summary.timestamp, id: message.key.id, text: metaText, media, metadata: { sourceKey: message.key, type: summary.type } });
      logPath = archived.path;
    } else {
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
    logPath,
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
  const item = existing;

  const lines = [
    'Pesan dihapus:',
    ...formatChangedIndexLines(item, messageKey),
    item?.logPath ? `Referensi lokal: ${item.logPath}` : item?.logMessageId ? `Referensi logs: ${shortJid(item.logJid)} / ${item.logMessageId}` : 'Referensi logs: tidak tersedia'
  ];
  await writeChangedReport(messageKey, lines.join('\n'), 'delete');
  if (existing) await state.changedMessages.markDeleted(messageKey);
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
  await writeChangedReport(update.key, lines.join('\n'), 'edit');
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
    `Message ID: ${item.id || '-'}`,
    ...(item.logPath ? [`Arsip lokal: ${item.logPath}`] : item.logMessageId ? [`Arsip grup: ${item.logJid} / ${item.logMessageId}`] : [])
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

function storageTarget(feature) {
  const target = state.runtimeConfig.storageTarget(feature);
  if (target.mode === 'local') {
    if (!target.path) throw new SetupRequiredError(feature);
    return { ...target, key: `local:${target.path}` };
  }
  try {
    const destination = resolveConfiguredDestination(destinationAlias(feature));
    return { mode: 'group', jid: destination.jid, key: `group:${destination.jid}` };
  } catch { throw new SetupRequiredError(feature); }
}

async function setupMenu(jid, feature = '') {
  if (!feature) {
    const lines = ['*Setup tujuan*', `Root lokal: ${state.runtimeConfig.get('storage.root') || 'belum diset (opsional)'}`, ',setup root <path-server>'];
    for (const name of [...STORAGE_FEATURES, 'errors']) {
      let label = 'belum siap';
      try { const target = name === 'errors' ? { mode: 'group', jid: destinationJid('errors') } : storageTarget(name); label = `${target.mode}: ${target.path || state.chatDirectory.nameFor(target.jid) || target.jid}`; } catch {}
      lines.push(`\n*${name}*: ${label}`, `,setup ${name}`);
    }
    return sendText(jid, lines.join('\n'));
  }
  if (![...STORAGE_FEATURES, 'errors'].includes(feature)) throw new UserInputError('Fitur setup: statussave, backup, logs, changedmsg, errors.');
  return sendText(jid, [`*Setup ${feature}*`, 'Pilih satu tujuan aktif:', `• Grup: ,setup ${feature} group <nama-grup|jid>`, feature !== 'errors' ? `• Server: ,setup ${feature} local [path-absolut]\nTanpa path memakai root lokal/${feature}.` : 'Tujuan error: grup errormsg dalam community dev.', 'Tujuan lama tetap aktif sampai pilihan baru berhasil disimpan.'].filter(Boolean).join('\n'));
}

async function handleSetup(message, command, context) {
  if (!context.isOwner) throw new UserInputError('Setup hanya untuk owner.');
  const [feature, mode, ...rest] = command.args;
  const jid = message.key.remoteJid;
  if (!feature || !mode) return setupMenu(jid, feature);
  if (feature === 'root') {
    await state.runtimeConfig.set('storage.root', command.args.slice(1).join(' '));
    return sendText(jid, 'Root penyimpanan lokal disimpan. Tujuan aktif tiap fitur tidak berubah.');
  }
  const input = rest.join(' ');
  if (feature === 'errors') {
    if (mode !== 'group') throw new UserInputError('Error teknis memakai tujuan grup.');
    await state.runtimeConfig.setDestination('dest.errors', resolveDestinationInput(input, context.actorJid, { requireGroup: true }));
  } else if (mode === 'group') {
    await state.runtimeConfig.setStorage(feature, mode, resolveDestinationInput(input, context.actorJid, { requireGroup: true }));
  } else if (mode === 'local') await state.runtimeConfig.setStorage(feature, mode, input);
  else throw new UserInputError('Mode tujuan: group atau local.');
  state.setupNotices.delete(feature);
  applyBotRuntimeState();
  await sendText(jid, `Tujuan ${feature} disimpan. Hanya ${mode} yang aktif.`);
}

async function notifyMissingSetup(feature) {
  if (!state.connected || state.setupNotices.has(feature)) return;
  state.setupNotices.add(feature);
  try { await setupMenu(ownUserJid(), feature); } catch { state.setupNotices.delete(feature); }
}

async function handleFailure(error, { jid, text, messageId } = {}) {
  if (error instanceof SetupRequiredError) {
    if (jid) await setupMenu(jid, error.feature);
    else await notifyMissingSetup(error.feature);
    return;
  }
  if (error instanceof UserInputError && jid) {
    await sendText(jid, error.message);
    return;
  }
  await logger.error('Operation failed', { jid, messageId, command: parseCommand(text || '')?.name, error: error.message, stack: error.stack });
}

async function archiveStatus(item, reply = null) {
  const target = storageTarget('statussave');
  const options = {
    sock: state.sock, targetKey: target.key,
    maxMediaBytes: state.runtimeConfig.statussaveSettings().maxMediaBytes,
    write: async (entry, message, media) => {
      const name = state.contactNames.get(entry.author) || '';
      const text = statusCaption(message);
      const caption = ['Status WhatsApp', `Kontak: ${name || displayPhoneFromJid(entry.author)}`, `Nomor: ${displayPhoneFromJid(entry.author)}`, `${entry.timestampSource === 'reply-received' ? 'Waktu diterima (waktu publikasi tidak tersedia)' : 'Waktu'}: ${formatWib(new Date(entry.timestamp).toISOString())}`, text].filter(Boolean).join('\n');
      if (target.mode === 'local') {
        return await state.localArchive.write(target.path, { identity: entry.author, name, timestamp: entry.timestamp, id: message.key.id, text,
          media, metadata: { type: messageTypeName(message), caption, sourceKey: message.key, timestampSource: entry.timestampSource || 'published' } });
      } else if (media) {
        if (media.type === 'audioMessage' || media.type === 'stickerMessage') await sendText(target.jid, caption);
        await sendDownloadedMedia(target.jid, media, { caption });
      } else await sendText(target.jid, caption);
    }
  };
  return reply ? state.statusInbox.archiveReply(reply, options) : state.statusInbox.archive(item.id, options);
}

async function maybeSaveStatusMessage(message) {
  try {
    const item = await state.statusInbox.receive(message, state.sock);
    if (item && state.runtimeConfig.statussaveSettings().enabled && state.statusSave.isWatched(item.author)) await archiveStatus(item);
  } catch (error) { await handleFailure(error); }
  return true;
}

async function resumeStatusAutoSave(author = null) {
  if (!isBotEnabled() || !state.runtimeConfig.statussaveSettings().enabled) return;
  for (const item of state.statusInbox.list(author)) {
    if (!state.statusSave.isWatched(item.author)) continue;
    try { await archiveStatus(item); } catch (error) { await handleFailure(error); }
  }
}

async function showStatusContact(jid, input) {
  if (!input) throw new UserInputError('Format: ,statussave list <nomor> atau ,statussave show <nomor>.');
  const author = resolveStatusContact(input);
  const items = state.statusInbox.list(author).sort((a, b) => a.timestamp - b.timestamp);
  if (!items.length) return sendText(jid, 'Belum ada status aktif nomor ini yang diterima bot.');
  const name = state.contactNames.get(author) || displayPhoneFromJid(author);
  await sendText(jid, `*Status ${name}*\n${items.length} status aktif, dari paling lama ke terbaru.`);
  const target = state.runtimeConfig.storageTarget('statussave');
  const counts = { success: 0, expired: 0, failed: 0 };
  for (const item of items) {
    try {
      const current = state.statusInbox.list(author).find((candidate) => candidate.id === item.id);
      const result = await presentStatus(current, {
        sock: state.sock, localRoot: target.mode === 'local' ? target.path : undefined,
        maxMediaBytes: state.runtimeConfig.statussaveSettings().maxMediaBytes,
        sendText: (text) => sendText(jid, text),
        sendMedia: (media, caption) => sendDownloadedMedia(jid, media, { caption })
      });
      counts[result]++;
    } catch (error) { counts.failed++; await handleFailure(error); }
  }
  await sendText(jid, `Status ditampilkan: ${counts.success} berhasil, ${counts.expired} kedaluwarsa/terhapus, ${counts.failed} gagal.`);
}

function resolveStatusContact(input) {
  const watched = state.statusSave.list().find((item) => String(item.id) === String(input));
  if (watched) return watched.jid;
  return resolveDestinationInput(input).jid;
}

async function handleStatusBrowse(message, command) {
  const jid = message.key.remoteJid;
  const [action, ...args] = command.args;
  if (action === 'active') {
    let page = 1;
    const last = args.at(-1)?.match(/^page=(\d+)$/);
    if (last) { page = Math.max(1, Number(last[1])); args.pop(); }
    const author = args.length ? resolveStatusContact(args.join(' ')) : null;
    const items = state.statusInbox.list(author).sort((a, b) => a.author.localeCompare(b.author) || a.timestamp - b.timestamp);
    let target; try { target = storageTarget('statussave'); } catch {}
    const pages = Math.max(1, Math.ceil(items.length / 10));
    page = Math.min(page, pages);
    const lines = [`*Status aktif • ${page}/${pages}*`];
    for (const item of items.slice((page - 1) * 10, page * 10)) {
      const msg = reviveValue(item.message);
      lines.push(`\n#${item.id} • ${state.contactNames.get(item.author) || displayPhoneFromJid(item.author)}`, `${messageTypeName(msg)} • ${formatWib(new Date(item.timestamp).toISOString())}`, target && item.saved.includes(target.key) ? 'Sudah tersimpan' : 'Belum tersimpan');
    }
    if (!items.length) lines.push('Belum ada status aktif yang diterima bot.');
    lines.push('\n,statussave dump <id-status>', ',statussave dump all <nomor|nama-kontak>', ',statussave active [kontak] page=2');
    return sendText(jid, lines.join('\n'));
  }
  storageTarget('statussave');
  let items;
  if (!args.length) {
    const quoted = extractQuotedMessage(message);
    if (!quoted?.message) throw new UserInputError('Reply status atau gunakan ,statussave dump <id-status>|all <kontak>.');
    quoted.key.remoteJid = 'status@broadcast';
    const existing = state.statusInbox.list().find((item) => reviveValue(item.message).key.id === quoted.key.id && (!quoted.key.participant || reviveValue(item.message).key.participant === quoted.key.participant));
    // A reply without publication time is archived separately, never advertised as an active status.
    if (!existing) {
      const content = unwrapMessage(message.message);
      const context = Object.values(content || {}).find((node) => node?.contextInfo?.quotedMessage)?.contextInfo;
      if (context?.remoteJid !== 'status@broadcast') throw new UserInputError('Reply ini tidak dikenali sebagai status. Gunakan ,statussave active dan pilih ID status.');
      const result = await archiveStatus(null, quoted);
      return sendText(jid, result === 'saved' ? 'Status reply sudah tersimpan.' : 'Status dari reply tersimpan. Waktu publikasi/kedaluwarsa tidak tersedia dari reply.');
    }
    items = [existing];
  } else if (args[0] === 'all') {
    if (args.length < 2) throw new UserInputError('Format: ,statussave dump all <nomor|nama-kontak>.');
    items = state.statusInbox.list(resolveStatusContact(args.slice(1).join(' ')));
  } else {
    const item = state.statusInbox.list().find((entry) => entry.id === Number(args[0]));
    items = item ? [item] : [];
  }
  if (!items.length) return sendText(jid, 'Status aktif tidak tersedia atau sudah kedaluwarsa. Bot hanya dapat dump status yang diterimanya.');
  const counts = { success: 0, saved: 0, expired: 0, failed: 0 };
  for (const item of items) {
    try { counts[await archiveStatus(item)]++; }
    catch (error) { counts.failed++; await handleFailure(error); }
  }
  await sendText(jid, `Dump selesai: ${counts.success} berhasil, ${counts.saved} sudah tersimpan, ${counts.expired} kedaluwarsa, ${counts.failed} gagal.`);
}

async function runConfiguredBackup() {
  const target = storageTarget('backup');
  if (target.mode === 'group') return sendDataBackupToWhatsApp(botSender(), target.jid, { partSizeBytes: state.runtimeConfig.backupPartSizeBytes() });
  const files = await createDataBackupFiles(state.runtimeConfig.backupPartSizeBytes());
  await fs.mkdir(target.path, { recursive: true });
  for (const file of files) {
    const dest = path.join(target.path, file.fileName);
    await fs.writeFile(`${dest}.tmp`, file.buffer);
    await fs.rename(`${dest}.tmp`, dest);
  }
  return files.map((file) => file.fileName);
}

async function writeChangedReport(messageKey, text, kind) {
  const target = storageTarget('changedmsg');
  if (target.mode === 'group') return sendText(target.jid, text);
  const jid = messageKey.remoteJid;
  return state.localArchive.write(target.path, { identity: jid, name: state.chatDirectory.nameFor(jid), timestamp: Date.now(), id: `${messageKey.id}-${kind}-${Date.now()}`, text, metadata: { sourceKey: messageKey, kind } });
}

let contactQueue = Promise.resolve();
function rememberContacts(contacts) {
  const task = contactQueue.then(() => rememberContactsUnlocked(contacts));
  contactQueue = task.catch(() => {});
  return task;
}
async function rememberContactsUnlocked(contacts) {
  for (const contact of contacts || []) {
    const raw = contact.id;
    if (!raw) continue;
    const name = contact.name || contact.verifiedName;
    const pn = contact.phoneNumber || (raw.endsWith('@s.whatsapp.net') ? raw : await state.sock?.signalRepository?.lidMapping?.getPNForLID(raw));
    for (const jid of [raw, pn].filter(Boolean)) {
      state.chatDirectory.remember(jid, name || contact.notify);
      if (name) state.contactNames.set(jidNormalizedUser(jid), name);
    }
  }
  await atomicJson(path.join(ROOT_DIR, 'data', 'contact-names.json'), Object.fromEntries(state.contactNames));
}

async function resolveErrorGroup() {
  const configured = state.runtimeConfig.destination('errors');
  if (configured && typeof configured === 'object' && configured.jid) return;
  const candidates = [...state.groups.values()].filter((group) => normalizeLookupText(group.subject) === 'errormsg' && normalizeLookupText(state.groups.get(group.linkedParent)?.subject) === 'dev');
  if (candidates.length === 1) await state.runtimeConfig.setDestination('dest.errors', { jid: candidates[0].id, savedName: candidates[0].subject, updatedBy: 'community-dev' });
  else await notifyMissingSetup('errors');
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
  for (const feature of STORAGE_FEATURES) {
    try { const target = storageTarget(feature); if (target.mode === 'group' && sameJid(jid, target.jid)) return true; } catch {}
  }
  try { return sameJid(jid, destinationJid('errors')); } catch { return false; }
}

function normalizePhoneToJid(input) {
  try {
    return normalizePhoneToWhatsAppJid(input);
  } catch {
    throw new UserInputError('Format: ,info <nomor telepon>');
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

async function handleTyping(message, command, context) {
  if (!context.isOwner) throw new UserInputError('Command ,typing hanya bisa dipakai nomor yang terhubung ke session bot.');
  const replyJid = message.key.remoteJid;
  const input = command.rawArgs.trim();
  if (!input) {
    const targets = state.typing.snapshot();
    await sendText(replyJid, targets.length
      ? ['Typing aktif:', ...targets.map((target) => `- ${target.name} (${target.jid})`), '', 'Matikan semua: ,typing stop'].join('\n')
      : 'Typing tidak aktif.\nFormat: ,typing <nomor|nama-grup|jid>');
    return;
  }
  if (input.toLowerCase() === 'stop') {
    const stopped = await state.typing.stopAll();
    await sendText(replyJid, stopped.length
      ? `Semua typing dihentikan (${stopped.length} target).`
      : 'Tidak ada typing yang sedang aktif.');
    return;
  }

  const destination = resolveDestinationInput(input, context.actorJid);
  const name = destination.savedName || state.chatDirectory.nameFor(destination.jid) || destination.jid;
  const result = await state.typing.add({
    jid: destination.jid,
    name,
    type: destination.type,
    addedAt: new Date().toISOString()
  });
  await sendText(replyJid, [
    `Typing ${result.added ? 'diaktifkan' : 'tetap aktif'} untuk ${name}.`,
    `Target: ${destination.jid}`,
    `Total target aktif: ${state.typing.snapshot().length}.`,
    'Typing akan terus diperbarui sampai ,typing stop.'
  ].join('\n'));
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
  if (action === 'record') {
    assertNoActiveSession(jid);
    const schedule = parseTaskRecordingArgs(command.args);
    const target = resolveDestinationInput(schedule.targetInput, actorJid);
    const session = state.taskRecorder.start(jid, schedule, actorJid, target);
    const sent = await sendText(jid, `Mulai rekam task ke ${session.schedule.targetName}. Kirim teks, gambar, video, dokumen, audio, sticker, lokasi, kontak, poll, atau event. Selesai: ,end atau reaction ✅/👍/❤️. Batal: ,cancel atau reaction ❌/👎/❎.`);
    registerSessionPrompt(sent.key, jid, actorJid);
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
  return ['pause', 'stop', 'resume', 'del', 'true', 'false'].includes(String(action || '').toLowerCase());
}

function normalizeTaskStateAction(action) {
  const text = String(action || '').toLowerCase();
  if (text === 'pause' || text === 'stop' || text === 'false') return 'pause';
  if (text === 'resume' || text === 'true') return 'resume';
  if (text === 'del') return 'del';
  return null;
}

async function handleTaskStateChange(jid, actorJid, actionRaw, idRaw, formatHint) {
  const action = normalizeTaskStateAction(actionRaw);
  const id = Number(idRaw);
  if (!action || !Number.isInteger(id)) throw new UserInputError(`Format: ${formatHint}`);
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

async function handleStimpa(message, actorJid) {
  const jid = message.key.remoteJid;
  assertNoActiveSession(jid);
  const media = await downloadQuotedOrOwnMedia(state.sock, message, 'stimpa-source');
  if (!media) throw new UserInputError('Reply stiker bergerak dengan ,stimpa.');
  try {
    const { preview } = await state.stimpaSessions.start(jid, actorJid, media);
    await sendBotMessage(jid, { image: preview, mimetype: 'image/png', caption: 'Kanvas ,stimpa: edit gambar ini di WhatsApp, lalu kirim hasilnya tanpa crop.' });
    const sent = await sendText(jid, '*Sesi stimpa*\nKirim satu atau beberapa gambar hasil edit kanvas (tanpa crop). Semua edit yang cocok akan digabung.\nBuat stiker bergerak: ,end atau ✅/👍/❤️. Batal: ,cancel atau ❌/👎/❎.');
    registerSessionPrompt(sent.key, jid, actorJid);
  } catch (error) {
    if (state.stimpaSessions.has(jid)) await state.stimpaSessions.cancel(jid, actorJid);
    else await cleanupFiles([media.path]);
    throw error;
  }
}

async function collectStimpaItem(message) {
  const jid = message.key.remoteJid;
  const session = await state.stimpaSessions.add(state.sock, message);
  if (!session) return;
  if (session.ignored) {
    if (mediaNode(message)) await sendText(jid, `Gambar dilewati: ${session.reason}`);
    return;
  }
  const prompt = state.sessionPrompts.get(jid);
  if (prompt?.key) await editText(jid, prompt.key, `*Sesi stimpa* • ${session.edits.length} gambar edit diterima\nGambar lain yang cocok akan digabung.\nBuat stiker bergerak: ,end atau ✅/👍/❤️. Batal: ,cancel atau ❌/👎/❎.`);
}

async function finishStimpaByJid(jid, actorJid) {
  const session = state.stimpaSessions?.get(jid);
  if (!session || !state.stimpaSessions.isActor(jid, actorJid)) return false;
  if (session.busy) return true;
  if (!session.edit) {
    await sendText(jid, 'Kirim gambar kanvas yang sudah diedit sebelum ,end. Sesi masih aktif.');
    return true;
  }
  const progress = await sendText(jid, '*Membuat stiker bergerak • 0%*\nMenunggu proses');
  let lastPercent = -1;
  try {
    await state.stimpaSessions.finish(jid, actorJid, async (percent, label) => {
      const value = Math.floor(percent);
      if (value <= lastPercent) return;
      lastPercent = value;
      await editText(jid, progress.key, `*Membuat stiker bergerak • ${value}%*\n${label}`).catch(() => {});
    }, async (sticker) => sendBotMessage(jid, { sticker, mimetype: 'image/webp', isAnimated: true }));
  } catch (error) {
    await editText(jid, progress.key, `*Pembuatan stiker gagal*\n${error.message}\nSesi masih aktif; kirim gambar edit baru atau ketik ,end.`);
    if (error instanceof UserInputError) return true;
    throw error;
  }
  return true;
}

async function handleToVideo(message, command, actorJid) {
  const jid = message.key.remoteJid;
  assertNoActiveSession(jid);
  const options = parseToVideoOptions(command.rawArgs);
  if (!state.tools?.ffmpeg || !state.tools?.ffprobe) throw new UserInputError('FFmpeg dan FFprobe diperlukan untuk ,tovideo.');
  const media = mediaNode(message)
    ? await downloadMessageMedia(state.sock, message, 'tovideo-source')
    : await downloadQuotedOrOwnMedia(state.sock, message, 'tovideo-source');
  if (!media) throw new UserInputError('Lampirkan gambar/video atau reply stiker dengan ,tovideo.');
  if (!['image', 'video', 'sticker'].includes(videoMediaKind(media))) {
    await cleanupFiles([media.path]);
    throw new UserInputError('Media awal ,tovideo harus gambar, video, atau stiker WhatsApp.');
  }
  const session = state.toVideoSessions.start(jid, actorJid, media, options);
  const sent = await sendText(jid, formatToVideoSession(session));
  registerSessionPrompt(sent.key, jid, actorJid);
}

function formatToVideoSession(session) {
  const options = session.options;
  const duration = options.durationMode === 'sync' ? 'mengikuti musik (sync)'
    : options.durationMode === 'explicit' ? `${options.durationMs / 1000}s`
      : videoMediaKind(session.source) === 'video' ? 'mengikuti video' : '5s';
  return [
    `*Sesi video* • ${options.format.toUpperCase()} • durasi ${duration} • speed=${options.speed || 1}× • q=${options.quality}`,
    `Sumber: ${videoMediaKind(session.source) || 'menunggu gambar/video template'}. Stiker: ${session.stickers.length}. Musik: ${session.music ? 'ada' : 'belum ada'}.`,
    !session.source ? 'Kirim gambar/video template yang sudah menampilkan stiker pada posisi tujuan.' : null,
    options.format === 'gif' && session.music ? 'Musik diabaikan pada GIF WhatsApp.' : null,
    'Kirim stiker WhatsApp, audio, atau instruksi seperti duration=2m, speed=2, slow=2, sync, mute, vvol=50%, mvol=50%, q=80, format=gif.',
    'Buat: ,end atau ✅/👍/❤️. Batal: ,cancel atau ❌/👎/❎.'
  ].filter(Boolean).join('\n');
}

async function collectToVideoItem(message, text) {
  const jid = message.key.remoteJid;
  const session = state.toVideoSessions.get(jid);
  if (!session) return;
  await state.toVideoSessions.add(state.sock, message, text);
  const prompt = state.sessionPrompts.get(jid);
  if (prompt?.key) await editText(jid, prompt.key, formatToVideoSession(session));
}

async function finishToVideoByJid(jid, actorJid) {
  const session = state.toVideoSessions.get(jid);
  if (!session || !state.toVideoSessions.isActor(jid, actorJid)) return false;
  if (session.busy) return true;
  if (!session.source) {
    await sendText(jid, 'Kirim gambar atau video template sebelum ,end. Sesi masih aktif.');
    return true;
  }
  const progress = await sendText(jid, '*Membuat video • 0%*\nMenunggu proses');
  let lastPercent = -1;
  let lastEdit = 0;
  let progressQueue = Promise.resolve();
  const update = async (percent, label) => {
    const now = Date.now();
    const value = Math.max(lastPercent, 0, Math.min(100, Math.floor(percent)));
    if (value !== 100 && value <= lastPercent + 1 && now - lastEdit < 2000) return;
    lastPercent = value;
    lastEdit = now;
    progressQueue = progressQueue.then(() => editText(jid, progress.key, `*Membuat video • ${value}%*\n${label}`)).catch(() => {});
    await progressQueue;
  };
  try {
    await state.toVideoSessions.finish(jid, actorJid, update, async (output, format) => {
      await sendBotMessage(jid, {
        video: { url: output },
        mimetype: 'video/mp4',
        ...(format === 'gif' ? { gifPlayback: true } : {})
      });
    });
  } catch (error) {
    await progressQueue;
    await editText(jid, progress.key, `*Pembuatan video gagal*\n${error.message}\nSesi masih aktif; perbaiki sumber/opsi lalu ketik ,end.`);
    if (error instanceof UserInputError) return true;
    throw error;
  }
  return true;
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
  if (session.targetSizeBytes) lines.push(`Target ukuran tepat: ${formatBytes(session.targetSizeBytes)} (${session.targetSizeBytes} byte). Padding tidak meningkatkan kualitas.`);
  if (session.maxSizeBytes || session.targetSizeBytes) lines.push('Jika perlu, kompresi PDF mengubah halaman menjadi gambar; teks tidak lagi bisa diseleksi.');
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
          ...(file.rasterized ? { caption: 'PDF dikompres menjadi gambar; teks tidak lagi bisa diseleksi.' } : {}),
          mimetype: 'application/pdf',
          fileName: file.fileName
        });
      }
    } else {
      const pdf = await state.pdfSessions.build(session);
      await sendBotMessage(jid, {
        document: pdf,
        ...(session.rasterized ? { caption: 'PDF dikompres menjadi gambar; teks tidak lagi bisa diseleksi.' } : {}),
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
  const update = parseSaveUpdate(command);
  if (update) {
    const jid = message.key.remoteJid;
    assertNoActiveSession(jid);
    const { item, title } = await prepareSavedUpdate(update.query, update.newTitle);
    const previewCount = Math.min(2, visibleRecordedEntries(item.entries || []).length);
    if (previewCount) {
      await sendText(jid, `Isi terakhir save #${item.id} "${item.title}" (${previewCount} item):`);
      await sendRecentSaved(botSender(), jid, item);
    }
    const session = state.saveRecorder.startUpdate(jid, item, title, actorJid);
    const sent = await sendText(jid, `Mulai tambah isi save #${item.id} "${item.title}"${title !== item.title ? ` menjadi "${title}"` : ''}. Kirim konten tambahan lalu ,end untuk simpan atau ,cancel untuk batal. Isi lama tetap ada dan ID tidak berubah.`);
    registerSessionPrompt(sent.key, jid, actorJid);
    return;
  }
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

  throw new UserInputError('Format: ,anticall [new|on|off|except]');
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
    if (!input) throw new UserInputError('Format: ,anticall except add <nomor>');
    const item = await state.anticall.addException(input);
    invalidateListKind('anticall-exceptions');
    await sendText(jid, `Exception anticall #${item.id} ${item.title} ditambahkan.`);
    return;
  }
  if (subaction === 'del') {
    const query = command.args.slice(2).join(' ').trim();
    if (!query) throw new UserInputError('Format: ,anticall except del <nomor|id>');
    const item = await state.anticall.deleteException(query);
    invalidateListKind('anticall-exceptions');
    await sendText(jid, `Exception anticall #${item.id} ${item.title} dihapus.`);
    return;
  }
  throw new UserInputError('Format: ,anticall except list|add|del <nomor|id>');
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
  if (['change', 'rename'].includes(command.args[0].toLowerCase())) {
    const query = command.args[1];
    const newTitle = command.args.slice(2).join(' ').trim();
    if (!query || !newTitle) throw new UserInputError('Format: ,load rename <id|"judul-lama"> <judul-baru>');
    const item = await renameSaved(query, newTitle);
    invalidateListKind('saved');
    await sendText(jid, `Save #${item.id} diganti judul menjadi "${item.title}".`);
    return;
  }
  if (command.args[0].toLowerCase() === 'del') {
    const query = command.args.slice(1).join(' ').trim();
    if (!query) throw new UserInputError('Format: ,load del <id|judul>');
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
  if (!item) throw new UserInputError(`Save "${query}" tidak ditemukan.`);
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
  const notesFile = state.notesFile;
  await sendReactionList(jid, actorJid, 'notes', await listNotes(notesFile), {
    emptyText: 'Belum ada note.',
    formatItem: (item) => `#${item.id} - ${item.title}`,
    deleteTitle: (item) => `Hapus note #${item.id}`,
    deleteDescription: 'Note ini akan dihapus permanen.',
    deleteItem: async (item) => handleNoteCommand({ args: ['del', String(item.id)], rawArgs: `del ${item.id}` }, notesFile)
  });
}

async function sendLinkList(jid, actorJid) {
  const linksFile = state.linksFile;
  await sendReactionList(jid, actorJid, 'links', await listLinks(linksFile), {
    emptyText: 'Belum ada link.',
    formatItem: (item) => `#${item.id} - ${item.title}`,
    deleteTitle: (item) => `Hapus link #${item.id}`,
    deleteDescription: 'Link ini akan dihapus permanen.',
    deleteItem: async (item) => handleLinkCommand({ args: ['del', String(item.id)], rawArgs: `del ${item.id}` }, linksFile)
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
  const action = item.appendedCount ? `ditambah ${item.appendedCount} item` : 'tersimpan';
  await sendText(jid, `Save #${item.id} "${item.title}" ${action} (${item.entries.length} item total).`);
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
  if (await state.taskRecorder.cancel(jid, actorJid)) {
    await sendText(jid, 'Rekaman task dibatalkan.');
    return true;
  }
  if (await state.anticall.cancel(jid, actorJid)) {
    await sendText(jid, 'Rekaman anticall dibatalkan.');
    return true;
  }
  if (await state.cintaRecorder?.cancel(jid, actorJid)) {
    await sendText(jid, 'Rekaman cinta dibatalkan.');
    return true;
  }

  const pdfSession = state.pdfSessions.end(jid, actorJid);
  if (pdfSession) {
    await state.pdfSessions.cleanup(pdfSession);
    await sendText(jid, 'Sesi PDF dibatalkan.');
    return true;
  }

  if (await state.toVideoSessions.cancel(jid, actorJid)) {
    await sendText(jid, 'Sesi video dibatalkan.');
    return true;
  }
  if (await state.stimpaSessions?.cancel(jid, actorJid)) {
    await sendText(jid, 'Sesi stimpa dibatalkan.');
    return true;
  }

  if (await state.qrSessions.cancel(jid, actorJid)) {
    await sendText(jid, 'Sesi QR dibatalkan.');
    return true;
  }

  if (await state.restoreSessions.cancel(jid, actorJid)) {
    await sendText(jid, 'Sesi restore dibatalkan.');
    return true;
  }

  return false;
}

async function handleCancelByJid(jid, actorJid) {
  if (activeSessionActorMatches(jid, actorJid)) { state.reactionActions.clearScope(`session:${jid}:${actorJid}`); state.sessionPrompts.delete(jid); }
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
  const result = await finishActiveSession(jid, actorJid);
  if (result && !activeSessionType(jid)) {
    state.sessionPrompts.delete(jid);
    state.reactionActions.clearScope(`session:${jid}:${actorJid}`);
  }
  return result;
}
async function finishActiveSession(jid, actorJid) {
  if (await finishSaveByJid(jid, actorJid)) return true;
  const task = await state.taskRecorder.finish(jid, actorJid);
  if (task) {
    await sendText(jid, `Task #${task.id} dibuat untuk ${task.targetName || `+${task.targetJid.split('@')[0]}`}. Berikutnya: ${formatWib(task.nextRunAt)}`);
    return true;
  }
  if (await finishAnticallByJid(jid, actorJid)) return true;
  if (await finishCintaByJid(jid, actorJid)) return true;
  if (await finishQrByJid(jid, actorJid)) return true;
  if (await finishToVideoByJid(jid, actorJid)) return true;
  if (await finishStimpaByJid(jid, actorJid)) return true;
  if (state.restoreSessions.has(jid)) {
    if (!activeSessionActorMatches(jid, actorJid)) return false;
    const session = state.restoreSessions.sessions.get(jid);
    if (session.mode === 'save') {
      if (session.phase === 'upload') {
        const result = await state.restoreSessions.prepareSaved(session);
        await sendText(jid, `Backup terbaca: ${result.count} save dari ${result.parts} part.\n1. Semua save\n2. Pilih save tertentu\n0. Kembali ke unggah ZIP\nKetik angka pilihan.`);
      } else if (session.phase === 'select') {
        if (!session.selectedIds.size) throw new UserInputError('Pilih setidaknya satu save dari daftar.');
        session.phase = 'mode';
        await sendSaveRestoreMode(jid, session);
      } else if (session.phase === 'scope') {
        await sendSaveRestoreScope(jid, session);
      } else {
        await sendSaveRestoreMode(jid, session);
      }
      return true;
    }
    await requestConfirmation(jid, actorJid, {
      title: 'Restore data',
      description: 'Folder data/ akan ditimpa dari file restore yang sudah dikirim.',
      execute: async () => finishRestoreByJid(jid, actorJid)
    });
    return true;
  }
  return handleEndPdfByJid(jid, actorJid);
}

async function finishQrByJid(jid, actorJid) {
  const session = state.qrSessions.end(jid, actorJid);
  if (!session) return false;
  const failures = [];
  let sentCount = 0;
  try {
    if (!session.items.length) {
      await sendText(jid, 'Sesi QR selesai, tetapi belum ada pesan yang diterima.');
      return true;
    }
    for (const [index, item] of session.items.entries()) {
      try {
        const image = await makeQrCode(item.text, {
          style: session.style,
          background: session.background,
          iconMedia: item.iconMedia,
          tools: state.tools
        });
        await sendBotMessage(jid, { image, mimetype: 'image/png' }, { quoted: item.sourceMessage });
        sentCount += 1;
      } catch (error) {
        failures.push(`#${index + 1}: ${error instanceof UserInputError ? error.message : 'Gagal diproses.'}`);
        await logger.warn('QR session item failed', {
          jid,
          actorJid,
          item: index + 1,
          error: error.message
        });
      }
    }
    const summary = [`Sesi QR selesai: ${sentCount}/${session.items.length} QR berhasil dikirim.`];
    if (failures.length) summary.push('Gagal:', ...failures);
    await sendText(jid, summary.join('\n'));
    return true;
  } finally {
    await state.qrSessions.cleanup(session);
  }
}

async function finishRestore(message, actorJid = messageActorJid(message)) {
  return finishRestoreByJid(message.key.remoteJid, actorJid);
}

async function finishRestoreByJid(jid, actorJid) {
  const session = state.restoreSessions.end(jid, actorJid);
  if (!session) return false;
  if (session.mode === 'save') {
    try {
      if (state.saveRecorder.sessions.size) throw new UserInputError('Selesaikan sesi ,save yang masih aktif sebelum restore save.');
      const result = await state.restoreSessions.restoreSaved(session);
      invalidateListKind('saved');
      await sendText(jid, `Restore save selesai: ${result.restored} save dipulihkan (${result.mode === 'merge' ? 'gabung' : 'timpa'}). Total sekarang ${result.total} save.`);
    } finally {
      await state.restoreSessions.cleanup(session);
    }
    return true;
  }
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
  const session = state.restoreSessions.sessions.get(message.key.remoteJid);
  if (session.mode === 'save' && session.phase !== 'upload') {
    await handleSaveRestoreChoice(message.key.remoteJid, session.actorJid, getMessageText(message));
    return true;
  }
  const item = await state.restoreSessions.add(state.sock, message);
  if (item) {
    await sendText(message.key.remoteJid, `Restore part diterima: ${item.fileName}`);
    return true;
  }
  await sendText(message.key.remoteJid, 'Kirim dokumen .zip untuk restore, atau ketik ,end jika semua part sudah dikirim.');
  return true;
}

async function sendSaveRestoreScope(jid, session) {
  await sendText(jid, `Backup berisi ${session.savedItems.length} save.\n1. Semua save\n2. Pilih save tertentu\n0. Kembali ke unggah ZIP`);
}

async function sendSaveRestoreList(jid, session) {
  const start = session.page * 10;
  const items = session.savedItems.slice(start, start + 10);
  const lines = [`Pilih save (halaman ${session.page + 1}/${Math.ceil(session.savedItems.length / 10)}). Ketik angka untuk menandai/melepas:`];
  lines.push(...items.map((item, index) => `${index + 1}. ${session.selectedIds.has(item.id) ? '✅ ' : ''}#${item.id} ${item.title} (${item.entries.length} item)`));
  if (start + 10 < session.savedItems.length) lines.push('11. Halaman berikutnya');
  if (session.page) lines.push('12. Halaman sebelumnya');
  lines.push('0. Kembali', `Terpilih: ${session.selectedIds.size}. Ketik ,end untuk lanjut.`);
  await sendText(jid, lines.join('\n'));
}

async function sendSaveRestoreMode(jid, session) {
  await sendText(jid, `${session.selectedIds.size} save dipilih.\n1. Timpa seluruh koleksi save sekarang dengan pilihan backup\n2. Gabung sebagai save baru (judul bentrok diberi pembeda)\n0. Kembali`);
}

async function handleSaveRestoreChoice(jid, actorJid, text) {
  const session = state.restoreSessions.sessions.get(jid);
  if (!session || session.mode !== 'save' || session.actorJid !== actorJid) return false;
  const choice = String(text || '').trim();
  if (session.phase === 'scope') {
    if (choice === '0') {
      session.phase = 'upload';
      await sendText(jid, 'Kirim ZIP/part backup tambahan, lalu ketik ,end.');
    } else if (choice === '1') {
      session.scopeSelection = 'all';
      session.selectedIds = new Set(session.savedItems.map((item) => item.id));
      session.phase = 'mode';
      await sendSaveRestoreMode(jid, session);
    } else if (choice === '2') {
      session.scopeSelection = 'selected';
      session.selectedIds.clear();
      session.page = 0;
      session.phase = 'select';
      await sendSaveRestoreList(jid, session);
    } else await sendSaveRestoreScope(jid, session);
  } else if (session.phase === 'select') {
    const start = session.page * 10;
    if (choice === '0') {
      session.phase = 'scope';
      await sendSaveRestoreScope(jid, session);
    } else if (choice === '11' && start + 10 < session.savedItems.length) {
      session.page++;
      await sendSaveRestoreList(jid, session);
    } else if (choice === '12' && session.page) {
      session.page--;
      await sendSaveRestoreList(jid, session);
    } else if (/^(?:[1-9]|10)$/.test(choice) && session.savedItems[start + Number(choice) - 1]) {
      const id = session.savedItems[start + Number(choice) - 1].id;
      if (session.selectedIds.has(id)) session.selectedIds.delete(id);
      else session.selectedIds.add(id);
      await sendSaveRestoreList(jid, session);
    } else await sendSaveRestoreList(jid, session);
  } else if (session.phase === 'mode') {
    if (choice === '0') {
      session.phase = session.scopeSelection === 'selected' ? 'select' : 'scope';
      if (session.phase === 'select') await sendSaveRestoreList(jid, session);
      else await sendSaveRestoreScope(jid, session);
    } else if (choice === '1' || choice === '2') {
      session.restoreMode = choice === '1' ? 'overwrite' : 'merge';
      const count = session.selectedIds.size;
      await requestConfirmation(jid, actorJid, {
        title: `Restore ${count} save (${session.restoreMode === 'overwrite' ? 'timpa' : 'gabung'})`,
        description: session.restoreMode === 'overwrite'
          ? `Seluruh koleksi save sekarang akan diganti oleh ${count} save yang dipilih dari backup. Data fitur lain tetap.`
          : `${count} save dari backup akan ditambahkan sebagai save baru. Data save sekarang tetap.`,
        execute: async () => finishRestoreByJid(jid, actorJid)
      });
    } else await sendSaveRestoreMode(jid, session);
  }
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
  if (command.args.length === 1) {
    const jid = message.key.remoteJid;
    assertNoActiveSession(jid);
    const intervalMs = parseDurationMs(command.args[0]);
    const actorJid = messageActorJid(message);
    const target = resolveDestinationInput(PRIMARY_TARGET_NAME, actorJid);
    state.taskRecorder.start(jid, { targetInput: PRIMARY_TARGET_NAME, intervalMs, count: 1, loop: false }, actorJid, target);
    const sent = await sendText(jid, 'Listening reminder. Kirim teks/media/VN/lokasi. Selesai: ,end atau ✅/👍/❤️. Batal: ,cancel atau ❌/👎/❎.');
    registerSessionPrompt(sent.key, jid, actorJid);
    return;
  }
  const reminder = await createReminder(command.args);
  await sendText(message.key.remoteJid, `Reminder #${reminder.id} dibuat. Terkirim dalam ${formatCountdown(new Date(reminder.dueAt).getTime() - Date.now())} ke ${PRIMARY_TARGET_NAME}.`);
}

async function handleClear(jid) {
  if (hasAnyTempSession()) throw new UserInputError('Tidak bisa clear temp saat ada sesi save/anticall/PDF/QR/restore aktif.');
  await cleanupStartupTemp();
  await sendText(jid, 'Temp dibersihkan.');
}

async function handleBackup(jid) {
  storageTarget('backup');
  await sendText(jid, 'Membuat backup data/...');
  const files = await runConfiguredBackup();
  await sendText(jid, `Backup selesai ke ${formatDestinationLine('backup')}:\n${files.join('\n')}`);
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
    fetchText('https://api.ipify.org?format=text', 5000).catch(async (error) => { await logger.warn('Network probe failed', { error: error.message }); return 'gagal'; }),
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
    await logger.warn('Network probe failed', { error: error.message });
    return 'gagal';
  }
}

async function measureHttpLatency(url) {
  const start = Date.now();
  try {
    const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000), cache: 'no-store' });
    return `${Date.now() - start}ms (HTTP ${response.status})`;
  } catch (error) {
    await logger.warn('Network probe failed', { error: error.message });
    return 'gagal';
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
    await logger.warn('Network probe failed', { error: error.message });
    return 'gagal';
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
  if (!text) throw new UserInputError('Format: ,button <pesan>');
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
  const commands = ['help', 's', 'smeme', 'resend', 'qr', 'tovideo', 'stimpa']
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

async function handlePauseCommand(message, command, context) {
  if (!context.isOwner) throw new UserInputError(`Command ,${command.name} hanya bisa dipakai nomor yang terhubung ke session bot.`);
  const jid = message.key.remoteJid;
  const snapshot = await state.botState.setEnabled(command.name === 'resume');
  applyBotRuntimeState();
  await sendText(jid, snapshot.enabled ? 'Bot aktif kembali.' : 'Bot di-pause. Ketik ,resume untuk mengaktifkan lagi.');
}

async function handleAdminCommand(message, command, context) {
  if (!context.isOwner) throw new UserInputError('Command ,admin hanya bisa dipakai nomor yang terhubung ke session bot.');
  const jid = message.key.remoteJid;
  const action = (command.args[0] || 'list').toLowerCase();
  if (action === 'list') {
    await sendAdminList(jid, context.actorJid);
    return;
  }
  if (action === 'add') {
    const input = command.args.slice(1).join(' ').trim();
    if (!input) throw new UserInputError('Format: ,admin add <nomor>');
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
    if (!query) throw new UserInputError('Format: ,admin del <nomor|id>');
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
  throw new UserInputError('Format: ,admin list|add|del <nomor|id>');
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
  if (!context.isOwner) throw new UserInputError('Command ,config hanya bisa dipakai nomor yang terhubung ke session bot.');
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
    if (!key) throw new UserInputError('Format: ,config get <key>');
    await sendText(jid, `${key} = ${formatConfigValue(state.runtimeConfig.get(key))}`);
    return;
  }
  if (action === 'set') {
    const key = command.args[1];
    const value = command.args.slice(2).join(' ').trim();
    if (!key || !value) throw new UserInputError('Format: ,config set <key> <value>');
    const def = configKeyList().find((item) => item.key === key);
    if (!def) throw new UserInputError(`Config "${key}" tidak bisa diubah. Ketik ,config untuk daftar key.`);
    let saved;
    if (def.type === 'destination') {
      saved = await state.runtimeConfig.setDestination(key, resolveDestinationInput(value, context.actorJid, { requireGroup: key === 'dest.errors' }));
      const feature = key === 'dest.saved' ? 'statussave' : key.slice(5);
      if (STORAGE_FEATURES.includes(feature)) await state.runtimeConfig.setStorage(feature, 'group', saved);
    } else {
      saved = await state.runtimeConfig.set(key, value);
    }
    if (key.startsWith('backup.')) applyBotRuntimeState();
    await sendText(jid, `Config ${key} disimpan: ${formatConfigValue(saved)}`);
    return;
  }
  throw new UserInputError('Format: ,config [get|set] <key> <value>');
}

async function handleChangedMsgCommand(message, command, context) {
  if (!context.isOwner) throw new UserInputError('Command ,changedmsg hanya bisa dipakai nomor yang terhubung ke session bot.');
  const jid = message.key.remoteJid;
  const action = (command.args[0] || 'list').toLowerCase();
  if (action === 'list') {
    await sendChangedMsgAllowList(jid, context.actorJid);
    return;
  }
  if (action === 'allow' || action === 'add') {
    const input = command.args.slice(1).join(' ').trim();
    if (!input) throw new UserInputError('Format: ,changedmsg allow <nama-grup|jid>');
    const destination = resolveDestinationInput(input, context.actorJid, { requireGroup: true });
    const item = await state.changedMessages.addAllowed(destination);
    invalidateListKind('changedmsg-allow');
    await sendText(jid, `Changedmsg allowlist #${item.id} ditambahkan: ${item.savedName} (${shortJid(item.jid)}).`);
    return;
  }
  if (action === 'del' || action === 'delete') {
    const query = command.args.slice(1).join(' ').trim();
    if (!query) throw new UserInputError('Format: ,changedmsg del <id|nama-grup|jid>');
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
  throw new UserInputError('Format: ,changedmsg list|allow|del <group|id>');
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
  if (!context.isOwner) throw new UserInputError('Command ,statussave hanya bisa dipakai nomor yang terhubung ke session bot.');
  const jid = message.key.remoteJid;
  const action = (command.args[0] || '').toLowerCase();
  if (!action) {
    const enabled = state.runtimeConfig.statussaveSettings().enabled;
    return sendText(jid, [`*Statussave • ${enabled ? 'otomatis aktif' : 'otomatis nonaktif'}*`,
      `Tujuan: ${formatDestinationLine('saved')}`, `Nomor dipantau: ${state.statusSave.list().length}`,
      '', '1. Tambahkan sekali: ,statussave add <nomor>',
      '2. Status berikutnya tersimpan otomatis ke tujuan di atas.',
      '3. Lihat seluruh status aktif di chat ini: ,statussave list <nomor>',
      '', ',statussave list — daftar nomor', ',statussave on / off — atur auto-save',
      ',statussave setup — ubah tujuan', 'Detail/command lanjutan: ,help statussave'].join('\n'));
  }
  if (action === 'on' || action === 'off') {
    await state.runtimeConfig.set('statussave.enabled', action === 'on');
    await sendText(jid, `Penyimpanan status otomatis ${action === 'on' ? 'diaktifkan' : 'dinonaktifkan'}. Tujuan: ${formatDestinationLine('saved')}`);
    if (action === 'on') await resumeStatusAutoSave();
    return;
  }
  if (action === 'show' || (action === 'list' && command.args.length > 1)) return showStatusContact(jid, command.args.slice(1).join(' '));
  if (action === 'active' || action === 'dump') return handleStatusBrowse(message, command);
  if (action === 'setup') return handleSetup(message, { args: ['statussave', ...command.args.slice(1)] }, context);
  if (action === 'list') {
    await sendStatusSaveList(jid, context.actorJid);
    return;
  }
  if (action === 'add') {
    const input = command.args.slice(1).join(' ').trim();
    if (!input) throw new UserInputError('Format: ,statussave add <nomor>');
    const phoneJid = normalizePhoneToWhatsAppJid(input);
    const existing = state.statusSave.list().find((item) => sameJid(item.jid, phoneJid));
    const item = existing || await state.statusSave.add(input, context.actorJid);
    invalidateListKind('statussave');
    const enabled = state.runtimeConfig.statussaveSettings().enabled;
    await sendText(jid, [`Nomor ${item.title} ${existing ? 'sudah terdaftar' : 'ditambahkan'}.`,
      `Auto-save: ${enabled ? 'aktif; status baru tersimpan tanpa save manual' : 'nonaktif; ketik ,statussave on untuk mengaktifkan'}.`,
      `Tujuan: ${formatDestinationLine('saved')}`, `Lihat isinya di WhatsApp: ,statussave list ${item.title}`].join('\n'));
    try { storageTarget('statussave'); } catch { await setupMenu(jid, 'statussave'); }
    await resumeStatusAutoSave(item.jid);
    return;
  }
  if (action === 'del' || action === 'delete') {
    const query = command.args.slice(1).join(' ').trim();
    if (!query) throw new UserInputError('Format: ,statussave del <nomor|id>');
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
  throw new UserInputError('Format: ,statussave add|list|show|del <nomor|id>, atau ,statussave on|off');
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

async function handleRestoreStart(message, command, actorJid) {
  const jid = message.key.remoteJid;
  assertNoActiveSession(jid);
  const mode = command.args[0]?.toLowerCase() === 'save' ? 'save' : 'full';
  if (command.args.length > (mode === 'save' ? 1 : 0)) throw new UserInputError('Gunakan ,restore atau ,restore save.');
  await state.restoreSessions.start(jid, actorJid, { mode });
  const sent = await sendText(jid, mode === 'save'
    ? 'Sesi restore save dimulai. Kirim ZIP/semua part backup sebagai dokumen, lalu ,end untuk memilih save. ,cancel membatalkan.'
    : 'Sesi restore dimulai. Kirim file .zip/PART zip sebagai dokumen WhatsApp, lalu ketik ,end dan ,confirm untuk overwrite folder data/. Ketik ,cancel untuk batal.');
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

async function handleServices(jid) {
  const result = await listOpenServices();
  await sendText(jid, formatServices(result));
}

async function handlePullBot(jid) {
  const branchResult = await runTool('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT_DIR });
  const branch = String(branchResult.stdout || '').trim();
  if (!branch || branch === 'HEAD') throw new UserInputError('Branch aktif tidak terdeteksi (detached HEAD).');
  await sendText(jid, `Menjalankan git pull ${UPDATE_REMOTE} ${branch}...`);
  const pull = await runTool('git', ['pull', UPDATE_REMOTE, branch], { cwd: ROOT_DIR });
  await sendText(jid, [
    `Pull branch ${branch} selesai.`,
    formatCommandOutput(pull) || 'git pull selesai tanpa output.',
    '',
    'Bot belum di-restart. Ketik ,restartbot agar perubahan dipakai.'
  ].join('\n'));
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
  await logger.error('Systemctl restart failed', { jid, error: commandErrorText(systemctlError) });
  if (LINUX_SUDO_PASSWORD && process.platform !== 'win32') {
    try {
      await runToolWithInput('sudo', ['-S', '-p', '', 'systemctl', '--no-block', 'restart', UPDATE_SYSTEMD_SERVICE], `${LINUX_SUDO_PASSWORD}\n`);
      return;
    } catch (error) { await logger.error('Sudo restart failed', { jid, error: error.message, stderr: error.stderr }); }
  }
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
    case 'setup':
      await handleSetup(message, command, context);
      break;
    case 'stext': {
      const result = await makeTextSticker(parseTextSticker(command.rawArgs));
      await sendBotMessage(jid, { sticker: result.buffer });
      break;
    }
    case 'help':
      await handleHelp(jid, command, context);
      break;
    case 'status':
      if ((command.args[0] || '').toLowerCase() === 'bot') await handleStatusBot(jid);
      else await handleStatus(jid);
      break;
    case 'serverinfo':
      await handleServerInfo(jid);
      break;
    case 'health':
      await handleHealth(jid);
      break;
    case 'info':
      await handleInfo(message, command);
      break;
    case 'typing':
      await handleTyping(message, command, context);
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
        if (!query) throw new UserInputError(HELP_DETAILS.note.join('\n'));
        const notesFile = state.notesFile;
        await requestConfirmation(jid, context.actorJid, {
          title: `Hapus note "${query}"`,
          description: 'Note ini akan dihapus permanen.',
          execute: async () => {
            const text = await handleNoteCommand(command, notesFile);
            invalidateListKind('notes');
            await sendText(jid, text);
          }
        });
      } else {
        const text = await handleNoteCommand(command, state.notesFile);
        if (isNamedMutation(command)) invalidateListKind('notes');
        await sendText(jid, text);
      }
      break;
    case 'link':
      if (!command.args.length || command.args[0]?.toLowerCase() === 'list') {
        await sendLinkList(jid, context.actorJid);
      } else if (command.args[0]?.toLowerCase() === 'del') {
        const query = command.args.slice(1).join(' ').trim();
        if (!query) throw new UserInputError(HELP_DETAILS.link.join('\n'));
        const linksFile = state.linksFile;
        await requestConfirmation(jid, context.actorJid, {
          title: `Hapus link "${query}"`,
          description: 'Link ini akan dihapus permanen.',
          execute: async () => {
            const text = await handleLinkCommand(command, linksFile);
            invalidateListKind('links');
            await sendText(jid, text);
          }
        });
      } else {
        const text = await handleLinkCommand(command, state.linksFile);
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
    case 'qr':
      await handleQr(message, command, context.actorJid);
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
    case 'tovideo':
      await handleToVideo(message, command, context.actorJid);
      break;
    case 'stimpa':
      await handleStimpa(message, context.actorJid);
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
        if (!query) throw new UserInputError(HELP_DETAILS.wol.join('\n'));
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
    case 'services':
      await handleServices(jid);
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
      await handleRestoreStart(message, command, context.actorJid);
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
    case 'pause':
    case 'resume':
      await handlePauseCommand(message, command, context);
      break;
    case 'worker':
      await handleWorkerAdminCommand(message, command, context);
      break;
    case 'pull':
      await requestConfirmation(jid, context.actorJid, {
        title: 'Git pull branch aktif',
        description: 'Akan menjalankan git pull pada branch yang sedang aktif tanpa restart bot.',
        execute: async () => handlePullBot(jid)
      });
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
      const revoked = message.message?.protocolMessage?.key;
      if (revoked) { await state.statusInbox.remove(revoked); continue; }
      if (isBotEnabled()) await maybeSaveStatusMessage(message);
      continue;
    }
    const jid = message.key.remoteJid;
    const isOwner = Boolean(message.key?.fromMe);
    if (isOwner && isIgnoredOwnOutput(message)) continue;
    if (!isOwner && isWorkerBotOutput(message)) continue;
    const text = getMessageText(message);
    const command = parseCommand(text);
    const context = commandContext(message);
    try {
      if (!isBotEnabled()) {
        if (context.isOwner && command?.name === 'resume') await handleCommand(message, command, context);
        continue;
      }
      if (context.isOwner && await isAdminSessionChat(message)) continue;

      rememberMessageDirectory(message);
      state.viewOnceCache.remember(message);
      if (!message.message?.protocolMessage) await maybeMirrorChangedMessage(message);

      const sessionActive = activeSessionType(jid);
      const sessionActorMatches = activeSessionActorMatches(jid, context.actorJid);
      const controlCommand = ['end', 'cancel'].includes(command?.name);
      const canControlSession = controlCommand && (sessionActorMatches || isSessionController(jid, context.actorJid, context.isOwner));
      if (sessionActorMatches && state.sessionPrompts.has(jid)) {
        const prompt = state.sessionPrompts.get(jid); prompt.lastActivity = Date.now();
        const action = state.reactionActions.get(prompt.key, prompt.actorJid); if (action) action.expiresAt = Date.now() + 1800000;
      }
      if (sessionActive && !sessionActorMatches && !canControlSession && (!command || ['end', 'cancel', 'confirm'].includes(command.name))) {
        continue;
      }

      if (sessionActorMatches && state.saveRecorder.has(jid) && (!command || !['end', 'cancel'].includes(command.name))) {
        await listeningProgress(jid, await state.saveRecorder.record(state.sock, message));
        continue;
      }
      if (sessionActorMatches && state.taskRecorder.has(jid) && (!command || !['end', 'cancel'].includes(command.name))) {
        await listeningProgress(jid, await state.taskRecorder.record(state.sock, message));
        continue;
      }
      if (sessionActorMatches && state.anticall.has(jid) && (!command || !['end', 'cancel'].includes(command.name))) {
        await listeningProgress(jid, await state.anticall.record(state.sock, message));
        continue;
      }
      if (sessionActorMatches && state.restoreSessions.has(jid) && (!command || !['end', 'cancel', 'confirm'].includes(command.name))) {
        await maybeCollectRestorePart(message);
        continue;
      }
      if (sessionActorMatches && state.qrSessions.has(jid) && (!command || !['end', 'cancel'].includes(command.name))) {
        await maybeCollectQrItem(message, text);
        continue;
      }
      if (sessionActorMatches && state.toVideoSessions.has(jid) && (!command || !['end', 'cancel'].includes(command.name))) {
        await collectToVideoItem(message, text);
        continue;
      }
      if (sessionActorMatches && state.stimpaSessions?.has(jid) && (!command || !['end', 'cancel'].includes(command.name))) {
        await collectStimpaItem(message);
        continue;
      }
      if (!command && context.isOwner && await maybeHandleJadibotTextApproval(message, text)) {
        continue;
      }
      if (!command && !state.pdfSessions.has(jid) && context.isOwner && await maybeForwardRepliedViewOnce(message, text)) {
        continue;
      }
      if (command) {
        if (command.name === 'jadibot') {
          await handleJadibot(message, command, context);
          continue;
        }
        if (!state.commandAccess?.canUseAs(command.name, jid, context.actorJid, { owner: context.isOwner }) && !(sessionActive && canControlSession)) continue;
        if (canControlSession && !sessionActorMatches) {
          await handleCommand(message, command, { ...context, actorJid: sessionControlActor(jid, context.actorJid, context.isOwner) });
        } else {
          await handleCommand(message, command, context);
        }
      } else {
        if (sessionActorMatches) await maybeCollectPdfItem(message, text);
      }
    } catch (error) {
      await handleFailure(error, { jid, text, messageId: message.key?.id });
    }
  }
}

async function onMessagesUpdate(updates) {
  if (!isBotEnabled()) return;
  for (const update of updates || []) {
    try {
      if (update.key?.remoteJid === 'status@broadcast') {
        if (update.update?.messageStubType === WAMessageStubType.REVOKE || update.update?.message === null) await state.statusInbox.remove(update.key);
        continue;
      }
      if (update?.update?.message?.editedMessage?.message) {
        await handleChangedEdit(update);
        continue;
      }
      if (update?.update?.messageStubType === WAMessageStubType.REVOKE || update?.update?.message === null) {
        await handleChangedDelete(update.key);
      }
    } catch (error) {
      await handleFailure(error);
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
    for (const key of update?.keys || []) {
      if (key.remoteJid === 'status@broadcast') await state.statusInbox.remove(key);
      else await handleChangedDelete(key);
    }
  } catch (error) {
    await handleFailure(error);
  }
}

async function onMessagesReaction(updates) {
  if (!isBotEnabled()) return;
  for (const update of updates || []) {
    try {
      if (await maybeHandleJadibotReaction(update)) continue;
      if (await maybeForwardReactedViewOnce(update)) continue;
      await handleReactionAction(update);
    } catch (error) {
      await handleFailure(error, { jid: update?.key?.remoteJid, messageId: update.key?.id });
    }
  }
}

async function handleReactionAction(update) {
  const intent = reactionIntent(update?.reaction?.text);
  if (!intent) return;
  const actorJid = reactionActorJid(update);
  let action = state.reactionActions.get(update.key, actorJid);
  const jid = update.key?.remoteJid;
  const prompt = state.sessionPrompts.get(jid);
  if (!action && prompt?.key?.id === update.key?.id && prompt.key.remoteJid === jid
    && isSessionController(jid, actorJid, Boolean(update.reaction?.key?.fromMe))) {
    action = state.reactionActions.get(update.key, prompt.actorJid);
  }
  if (!action) {
    if (intent === 'cancel' && update.reaction?.key?.fromMe && update.key?.fromMe && !state.reactionActions.isPrompt(update.key)) await sendBotMessage(update.key.remoteJid, { delete: update.key });
    return;
  }
  const handler = intent === 'confirm' ? action.onConfirm : action.onCancel;
  if (!handler) return;
  await handler(update);
  if (action.scope?.startsWith('session:') && activeSessionType(jid)) action.expiresAt = Date.now() + 30 * 60 * 1000;
  else state.reactionActions.delete(update.key);
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
      state.groups.set(group.id, group);
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
  state.scheduler = new TaskScheduler(botSender(), state.chatDirectory, logger);
  state.reminderScheduler?.stop();
  state.reminderScheduler = new ReminderScheduler(botSender(), state.chatDirectory, logger);

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('contacts.upsert', (contacts) => rememberContacts(contacts).catch((error) => handleFailure(error)));
  sock.ev.on('contacts.update', (contacts) => rememberContacts(contacts).catch((error) => handleFailure(error)));
  sock.ev.on('messaging-history.set', async ({ messages, contacts }) => {
    try {
      await rememberContacts(contacts);
      if (isBotEnabled()) for (const message of messages || []) if (message.key?.remoteJid === 'status@broadcast') await maybeSaveStatusMessage(message);
    } catch (error) { await handleFailure(error); }
  });
  sock.ev.on('lid-mapping.update', async () => {
    try {
      for (const item of state.statusInbox.list()) if (item.author.endsWith('@lid')) await maybeSaveStatusMessage(reviveValue(item.message));
    } catch (error) { await handleFailure(error); }
  });
  let inputQueue = Promise.resolve();
  const enqueue = (fn) => { inputQueue = inputQueue.then(fn).catch((error) => handleFailure(error)); };
  sock.ev.on('messages.upsert', (event) => enqueue(() => onMessageUpsert(event)));
  sock.ev.on('messages.update', onMessagesUpdate);
  sock.ev.on('messages.delete', onMessagesDelete);
  sock.ev.on('messages.reaction', (updates) => enqueue(() => onMessagesReaction(updates)));
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
      state.connected = true;
      console.log('WhatsApp connected.');
      await logger.info('WhatsApp connected');
      await loadGroups(sock);
      await hydrateConfiguredDestinations();
      await resolveErrorGroup();
      await resumeStatusAutoSave();
      await state.errorReporter.flush();
      state.typing?.attach(sock);
      applyBotRuntimeState();
    }
    if (connection === 'close') {
      state.connected = false;
      state.typing?.detach();
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

const JADIBOT_REQUEST_TTL_MS = 10 * 60 * 1000;
const JADIBOT_QR_TTL_MS = 60 * 1000;
const JADIBOT_LOGIN_WAIT_LIMIT = 4;
const JADIBOT_APPROVE_WORDS = ['accept', 'yes', 'ya'];
const JADIBOT_REJECT_WORDS = ['no', 'tolak', 'reject', 'tidak'];

const workerRuntimes = new Map();
const jadibotRequests = new Map();
const jadibotApprovals = new Map();
const jadibotCooldowns = new Map();
const jadibotPairings = new Map();
let nextJadibotRequestId = 1;
let adminWorkerSession = null;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runAsOwner(fn) {
  return workerScope.exit(fn);
}

function ownerAccountJids() {
  const user = ownerState.sock?.user;
  return [user?.id, user?.lid].filter(Boolean).map((jid) => jidNormalizedUser(jid));
}

function isOwnerAccountJid(jid) {
  if (!jid) return false;
  return ownerAccountJids().some((ownerJid) => sameActor(ownerJid, jid));
}

async function notifyOwner(text) {
  await runAsOwner(async () => {
    if (!state.connected) return;
    try {
      await sendText(ownUserJid(), text);
    } catch (error) {
      await logger.warn('Owner notification failed', { error: error.message });
    }
  });
}

async function safeSendText(jid, text) {
  try {
    await sendText(jid, text);
  } catch (error) {
    await logger.warn('Send text failed', { jid, error: error.message });
  }
}

async function handleJadibot(message, command, context) {
  const jid = message.key.remoteJid;
  if (context.isOwner) throw new UserInputError('Akun admin utama tidak bisa menjadi worker.');
  const firstArg = (command.args[0] || '').toLowerCase();
  const mode = ['kode', 'code'].includes(firstArg) ? 'code' : 'qr';
  const requesterJid = context.actorJid;
  const phoneJid = await resolveRequesterPhoneJid(message, requesterJid);

  if (phoneJid) {
    const existing = state.workerStore.findByPhone(phoneJid);
    if (existing && existing.status !== 'logged_out') {
      throw new UserInputError(`Nomor kamu sudah terhubung sebagai worker #${existing.id}. Untuk berhenti, logout perangkat tertaut di WhatsApp.`);
    }
  }
  if (mode === 'code' && !phoneJid) throw new UserInputError('Nomor kamu tidak terbaca untuk kode tautan. Pakai ,jadibot untuk QR.');
  await cleanupJadibotState();
  const activePairing = jadibotPairings.get(requesterJid);
  if (activePairing) {
    if (mode !== 'code' || activePairing.request.mode === 'code') throw new UserInputError('QR/kode kamu masih aktif. Cek chat atau tunggu sampai kedaluwarsa.');
    await failJadibotPairing(activePairing, null);
  }

  const request = { requesterJid, phoneJid, chatJid: jid, messageKey: message.key, mode, name: message.pushName || '' };
  if ((jadibotApprovals.get(requesterJid) || 0) > Date.now()) {
    await startJadibotPairing(request);
    return;
  }
  if (findJadibotRequestByRequester(requesterJid)) throw new UserInputError('Permintaan jadibot kamu masih menunggu persetujuan admin.');
  if ((jadibotCooldowns.get(requesterJid) || 0) > Date.now()) throw new UserInputError('Permintaan jadibot kamu baru saja ditolak. Coba lagi nanti.');

  request.id = nextJadibotRequestId++;
  request.createdAt = Date.now();
  jadibotRequests.set(request.id, request);
  await sendText(jid, 'Permintaan jadibot dikirim ke admin. Tunggu persetujuan, ya.');
  const notice = await sendText(ownUserJid(), formatJadibotNotice(request));
  request.noticeKey = notice?.key || null;
}

async function resolveRequesterPhoneJid(message, actorJid) {
  const candidates = [actorJid, message.key?.participantAlt, message.key?.remoteJidAlt];
  for (const candidate of candidates) {
    if (candidate && candidate.endsWith('@s.whatsapp.net')) return jidNormalizedUser(candidate);
  }
  if (actorJid?.endsWith('@lid')) {
    try {
      const phoneJid = await state.sock?.signalRepository?.lidMapping?.getPNForLID(actorJid);
      if (phoneJid) return jidNormalizedUser(phoneJid);
    } catch (error) {
      await logger.warn('LID lookup failed', { jid: actorJid, error: error.message });
    }
  }
  return null;
}

function formatJadibotNotice(request) {
  const phone = request.phoneJid
    ? `+${displayPhoneFromJid(request.phoneJid)} (wa.me/${displayPhoneFromJid(request.phoneJid)})`
    : `nomor tidak terbaca (${request.requesterJid})`;
  const chat = request.chatJid.endsWith('@g.us')
    ? `grup ${state.chatDirectory.nameFor(request.chatJid) || request.chatJid}`
    : 'chat pribadi';
  return [
    `*Permintaan jadibot #${request.id}*`,
    `Dari: ${request.name || '-'} ${phone}`,
    `Chat: ${chat}`,
    `Mode: ${request.mode === 'code' ? 'kode tautan' : 'QR'}`,
    '',
    'Setujui: reply pesan ini dengan accept/yes/ya, atau react ✅/👍/❤️ di pesan ini atau di pesan ,jadibot user.',
    'Tolak: reply no/tolak, atau react ❌/👎/❎.',
    'Kedaluwarsa dalam 10 menit.'
  ].join('\n');
}

function findJadibotRequestByRequester(requesterJid) {
  return [...jadibotRequests.values()].find((request) => sameActor(request.requesterJid, requesterJid)) || null;
}

function findJadibotRequestByMessage(key) {
  if (!key?.id) return null;
  return [...jadibotRequests.values()].find((request) => request.messageKey?.id === key.id || request.noticeKey?.id === key.id) || null;
}

async function maybeHandleJadibotReaction(update) {
  if (!jadibotRequests.size || !update.reaction?.key?.fromMe) return false;
  const request = findJadibotRequestByMessage(update.key);
  if (!request) return false;
  const intent = reactionIntent(update.reaction.text);
  if (!intent) return false;
  if (intent === 'confirm') await approveJadibotRequest(request);
  else await rejectJadibotRequest(request);
  return true;
}

async function maybeHandleJadibotTextApproval(message, text) {
  if (!jadibotRequests.size) return false;
  const answer = String(text || '').trim().toLowerCase().replace(/[.!]+$/, '');
  const approve = JADIBOT_APPROVE_WORDS.includes(answer);
  const reject = JADIBOT_REJECT_WORDS.includes(answer);
  if (!approve && !reject) return false;

  const quoted = extractQuotedMessage(message);
  let request = quoted ? findJadibotRequestByMessage(quoted.key) : null;
  // Without a reply, a plain answer in the owner's own chat is accepted only when one request is waiting.
  if (!request && !quoted && isOwnerAccountJid(message.key.remoteJid) && jadibotRequests.size === 1) {
    request = [...jadibotRequests.values()][0];
  }
  if (!request) return false;
  if (approve) await approveJadibotRequest(request);
  else await rejectJadibotRequest(request);
  return true;
}

async function approveJadibotRequest(request) {
  jadibotRequests.delete(request.id);
  jadibotApprovals.set(request.requesterJid, Date.now() + JADIBOT_REQUEST_TTL_MS);
  await sendText(ownUserJid(), `Permintaan jadibot #${request.id} disetujui.`);
  await startJadibotPairing(request);
}

async function rejectJadibotRequest(request) {
  jadibotRequests.delete(request.id);
  jadibotCooldowns.set(request.requesterJid, Date.now() + JADIBOT_REQUEST_TTL_MS);
  await sendText(ownUserJid(), `Permintaan jadibot #${request.id} ditolak.`);
  await safeSendText(request.chatJid, 'Permintaan jadibot kamu ditolak admin.');
}

async function cleanupJadibotState() {
  const now = Date.now();
  for (const request of [...jadibotRequests.values()]) {
    if (now - request.createdAt < JADIBOT_REQUEST_TTL_MS) continue;
    jadibotRequests.delete(request.id);
    await safeSendText(request.chatJid, 'Permintaan jadibot kedaluwarsa karena belum disetujui admin. Coba lagi nanti.');
  }
  for (const map of [jadibotApprovals, jadibotCooldowns]) {
    for (const [jid, until] of map) if (until <= now) map.delete(jid);
  }
}

async function startJadibotPairing(request) {
  const isPrivateChat = !request.chatJid.endsWith('@g.us');
  const dmJid = isPrivateChat ? request.chatJid : (request.phoneJid || request.requesterJid);
  const pairing = {
    request,
    dmJid,
    authDir: path.join(WORKERS_PENDING_DIR, `${Date.now()}-${displayPhoneFromJid(request.requesterJid)}`),
    qrKey: null,
    codeSent: false,
    finished: false,
    loginWaits: 0,
    timer: null,
    connection: null
  };
  pairing.connection = new WorkerConnection({
    authDir: pairing.authDir,
    logger,
    label: `pairing-${displayPhoneFromJid(request.requesterJid)}`,
    handlers: {
      onQr: (qr, sock) => sendPairingQr(pairing, qr, sock),
      onOpen: (sock) => finishJadibotPairing(pairing, sock),
      onLoggedOut: () => failJadibotPairing(pairing, 'Login dibatalkan dari WhatsApp. Ketik ,jadibot untuk mencoba lagi.')
    }
  });
  jadibotPairings.set(request.requesterJid, pairing);
  const target = request.mode === 'code' ? 'Kode tautan' : 'QR';
  await sendText(request.chatJid, isPrivateChat
    ? `Disetujui admin! ${target} dikirim di chat ini.`
    : `Disetujui admin! ${target} dikirim lewat chat pribadi.`);
  pairing.timer = setTimeout(() => expireJadibotPairing(pairing).catch((error) => handleFailure(error)), JADIBOT_QR_TTL_MS);
  await runAsOwner(() => pairing.connection.start());
}

async function sendPairingQr(pairing, qr, sock) {
  if (pairing.finished) return;
  try {
    if (pairing.request.mode === 'code') {
      if (pairing.codeSent) return;
      pairing.codeSent = true;
      await sendPairingCode(pairing, sock);
    } else {
      await sendPairingImage(pairing, qr);
    }
  } catch (error) {
    await logger.error('Pairing delivery failed', { requester: pairing.request.requesterJid, dmJid: pairing.dmJid, mode: pairing.request.mode, error: error.message });
    await failJadibotPairing(pairing, 'Gagal mengirim QR/kode ke chat pribadi kamu. Kirim pesan apa saja ke nomor bot ini lewat chat pribadi, lalu ketik ,jadibot lagi.', pairing.request.chatJid);
    return;
  }
  // The countdown starts when the QR/code reaches the user, not when the connection is opened.
  if (!pairing.deliveredAt) {
    pairing.deliveredAt = Date.now();
    clearTimeout(pairing.timer);
    pairing.timer = setTimeout(() => expireJadibotPairing(pairing).catch((error) => handleFailure(error)), JADIBOT_QR_TTL_MS);
    await logger.info('Pairing QR/code delivered', { requester: pairing.request.requesterJid, dmJid: pairing.dmJid, mode: pairing.request.mode });
  }
}

async function sendPairingCode(pairing, sock) {
  const code = await sock.requestPairingCode(displayPhoneFromJid(pairing.request.phoneJid));
  const formattedCode = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
  await sendText(pairing.dmJid, [
    'Kode tautan worker ada di pesan berikutnya. Salin kodenya (tekan lama pesan, lalu Salin).',
    'Buka WhatsApp > Perangkat tertaut > Tautkan perangkat > Tautkan dengan nomor telepon, lalu tempel kodenya.',
    'Berlaku 60 detik.'
  ].join('\n'));
  await sendText(pairing.dmJid, formattedCode);
}

async function sendPairingImage(pairing, qr) {
  const image = await QRCode.toBuffer(qr, { type: 'png', width: 1024, margin: 4 });
  const sent = await sendBotMessage(pairing.dmJid, {
    image,
    mimetype: 'image/png',
    caption: [
      'Scan QR ini untuk menjadi worker.',
      'WhatsApp > Perangkat tertaut > Tautkan perangkat.',
      'QR harus discan dari HP/perangkat lain. Berlaku 60 detik.'
    ].join('\n')
  });
  if (pairing.qrKey) await sendBotMessage(pairing.dmJid, { delete: pairing.qrKey }).catch(() => {});
  pairing.qrKey = sent?.key || null;
  if (!pairing.hintSent) {
    pairing.hintSent = true;
    await sendText(pairing.dmJid, 'Tidak bisa scan QR (misalnya hanya punya satu HP)? Bisa login pakai kode: ketik *,jadibot kode*, nanti kodenya dikirim dan tinggal disalin untuk login.');
  }
}

async function expireJadibotPairing(pairing) {
  if (pairing.finished) return;
  // The QR was scanned and WhatsApp is still finishing the login, so wait a little longer.
  if (pairing.connection.isRegistered() && pairing.loginWaits < JADIBOT_LOGIN_WAIT_LIMIT) {
    pairing.loginWaits += 1;
    pairing.timer = setTimeout(() => expireJadibotPairing(pairing).catch((error) => handleFailure(error)), 15000);
    return;
  }
  await logger.warn('Pairing expired', { requester: pairing.request.requesterJid, mode: pairing.request.mode, delivered: Boolean(pairing.deliveredAt), registered: pairing.connection.isRegistered() });
  const hint = pairing.request.mode === 'qr' ? ' Jika QR tidak bisa discan, coba ,jadibot kode.' : '';
  await failJadibotPairing(pairing, `QR/kode kedaluwarsa. Ketik ,jadibot lagi untuk mendapatkan yang baru (tanpa persetujuan ulang selama 10 menit).${hint}`, pairing.deliveredAt ? pairing.dmJid : pairing.request.chatJid);
}

async function closePairing(pairing) {
  pairing.finished = true;
  clearTimeout(pairing.timer);
  jadibotPairings.delete(pairing.request.requesterJid);
  if (pairing.qrKey) await sendBotMessage(pairing.dmJid, { delete: pairing.qrKey }).catch(() => {});
}

async function failJadibotPairing(pairing, text, noticeJid = pairing.dmJid) {
  if (pairing.finished) return;
  await closePairing(pairing);
  pairing.connection.stop();
  await fs.rm(pairing.authDir, { recursive: true, force: true });
  if (text) await safeSendText(noticeJid, text);
}

async function rejectPairedAccount(pairing, text) {
  await pairing.connection.logout();
  await fs.rm(pairing.authDir, { recursive: true, force: true });
  await safeSendText(pairing.dmJid, text);
}

async function finishJadibotPairing(pairing, sock) {
  if (pairing.finished) return;
  await closePairing(pairing);
  const phoneJid = jidNormalizedUser(sock.user.id);
  const lidJid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null;
  const name = sock.user?.name || pairing.request.name || '';

  if (isOwnerAccountJid(phoneJid)) {
    await rejectPairedAccount(pairing, 'Nomor admin utama tidak bisa dipakai sebagai worker. Login dibatalkan.');
    return;
  }
  const existing = state.workerStore.findByPhone(phoneJid);
  if (existing && existing.status !== 'logged_out') {
    await rejectPairedAccount(pairing, `Nomor ini sudah terhubung sebagai worker #${existing.id}. Login baru dibatalkan.`);
    return;
  }

  pairing.connection.stop();
  // Give Baileys a moment to finish writing the login files before the folder is moved.
  await wait(1000);
  const requestedBy = pairing.request.phoneJid || pairing.request.requesterJid;
  const worker = existing
    ? await state.workerStore.restore(existing.id)
    : await state.workerStore.create({ phoneJid, lidJid, name, requestedBy });
  const authDir = state.workerStore.authDir(worker);
  await fs.rm(authDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(authDir), { recursive: true });
  await fs.rename(pairing.authDir, authDir);
  await state.workerStore.update(worker.id, { lidJid, name, requestedBy, approvedAt: new Date().toISOString() });
  await startWorker(worker);

  await safeSendText(pairing.dmJid, [
    `Berhasil! Nomor kamu sekarang terhubung sebagai worker #${worker.id}.`,
    'Ketik ,help di chat "Pesan ke diri sendiri" untuk melihat command worker.',
    'Untuk berhenti, logout perangkat "IrOBot Worker" di WhatsApp > Perangkat tertaut.'
  ].join('\n'));
  await notifyOwner(`Worker #${worker.id} terhubung: ${name || '-'} (+${worker.phone}, ${waLink(worker)}).${existing ? ' Folder lama dipakai lagi.' : ''}`);
}

function createWorkerAccess(workerId) {
  return {
    canUseAs: (commandName) => workerCommandAllowed(ownerState.workerStore.get(workerId), commandName),
    isOpen: () => false,
    isAdmin: () => false
  };
}

function createWorkerScope(worker, connection) {
  const dataDir = ownerState.workerStore.dataDir(worker);
  return {
    workerId: worker.id,
    state: {
      get sock() { return connection.sock; },
      get connected() { return connection.connected; },
      chatDirectory: new ChatDirectory(),
      viewOnceCache: new ViewOnceCache(),
      sessionPrompts: new Map(),
      confirmStore: new PendingConfirmStore(),
      reactionActions: new ReactionActionStore(),
      ignoredOwnMessageIds: new Set(),
      pdfSessions: new PdfSessions(ownerState.tools),
      toVideoSessions: new ToVideoSessions(ownerState.tools),
      stimpaSessions: new StimpaSessions(),
      qrSessions: new QrSessions(),
      restoreSessions: new RestoreSessions(),
      saveRecorder: new SaveRecorder({ file: path.join(dataDir, 'saved-messages.json'), mediaDir: path.join(dataDir, 'saved-messages') }),
      taskRecorder: new TaskRecorder(),
      anticall: new AnticallStore(path.join(dataDir, 'anticall.json'), path.join(dataDir, 'anticall-media')),
      commandAccess: createWorkerAccess(worker.id),
      notesFile: path.join(dataDir, 'notes.json'),
      linksFile: path.join(dataDir, 'links.json'),
      promptKeysFile: path.join(dataDir, 'prompt-keys.json'),
      cintaRecorder: new CintaRecorder()
    }
  };
}

async function startWorker(worker) {
  if (workerRuntimes.has(worker.id)) return workerRuntimes.get(worker.id);
  const runtime = { workerId: worker.id, connection: null, scope: null, limiter: new ReplyLimiter() };
  runtime.connection = new WorkerConnection({
    authDir: state.workerStore.authDir(worker),
    logger,
    label: `worker-${worker.id}`,
    handlers: {
      onOpen: (sock) => handleWorkerOpen(runtime, sock),
      onClose: () => handleWorkerClose(runtime),
      onLoggedOut: () => handleWorkerLoggedOut(runtime),
      onMessages: (event) => workerScope.run(runtime.scope, () => onWorkerMessageUpsert(runtime, event)),
      onReactions: (updates) => workerScope.run(runtime.scope, () => onWorkerReactions(runtime, updates))
    }
  });
  runtime.scope = createWorkerScope(worker, runtime.connection);
  workerRuntimes.set(worker.id, runtime);
  await runAsOwner(() => runtime.connection.start());
  return runtime;
}

async function startAllWorkers() {
  await fs.rm(WORKERS_PENDING_DIR, { recursive: true, force: true });
  for (const worker of state.workerStore.activeWorkers()) {
    await state.workerStore.update(worker.id, { status: 'offline' });
    startWorker(worker).catch((error) => logger.error('Worker start failed', { worker: worker.id, error: error.message }));
  }
}

async function handleWorkerOpen(runtime, sock) {
  const worker = state.workerStore.get(runtime.workerId);
  if (!worker) return;
  const now = new Date().toISOString();
  await state.workerStore.update(worker.id, {
    status: 'online',
    connectedAt: now,
    lastSeenAt: now,
    lidJid: sock.user?.lid ? jidNormalizedUser(sock.user.lid) : worker.lidJid,
    name: sock.user?.name || worker.name
  });
  if (!worker.hasProfilePicture) await saveWorkerProfilePicture(worker, sock);
}

async function saveWorkerProfilePicture(worker, sock) {
  try {
    const url = await sock.profilePictureUrl(worker.phoneJid, 'image');
    if (!url) return;
    const response = await fetch(url);
    if (!response.ok) return;
    await fs.writeFile(state.workerStore.profilePath(worker), Buffer.from(await response.arrayBuffer()));
    await state.workerStore.update(worker.id, { hasProfilePicture: true });
  } catch (error) {
    await logger.warn('Worker profile picture unavailable', { worker: worker.id, error: error.message });
  }
}

async function handleWorkerClose(runtime) {
  const worker = state.workerStore.get(runtime.workerId);
  if (worker?.status === 'online') await state.workerStore.update(worker.id, { status: 'offline', lastSeenAt: new Date().toISOString() });
}

async function handleWorkerLoggedOut(runtime) {
  workerRuntimes.delete(runtime.workerId);
  if (adminWorkerSession?.workerId === runtime.workerId) adminWorkerSession = null;
  const worker = await state.workerStore.archive(runtime.workerId);
  if (worker) await notifyOwner(`Worker #${worker.id} (${worker.name || worker.phone}, ${waLink(worker)}) logout dari WhatsApp. Folder diarsipkan.`);
}

async function runWorkerHousekeeping() {
  await cleanupJadibotState();
  for (const runtime of workerRuntimes.values()) {
    runtime.limiter.cleanup(CINTA_REPLY_WINDOW_MS);
    await workerScope.run(runtime.scope, () => expireListeningSessions());
  }
}

async function showWorkerTyping(jid, delayRange) {
  await state.sock.sendPresenceUpdate('composing', jid).catch(() => {});
  await wait(randomDelayMs(delayRange));
  await state.sock.sendPresenceUpdate('paused', jid).catch(() => {});
}

async function onWorkerMessageUpsert(runtime, event) {
  if (event.type !== 'notify') return;
  for (const message of event.messages || []) {
    if (!message.message || !message.key?.remoteJid) continue;
    const jid = message.key.remoteJid;
    if (jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue;
    if (message.message.protocolMessage || message.message.reactionMessage) continue;
    if (message.key.fromMe && isIgnoredOwnOutput(message)) continue;
    const text = getMessageText(message);
    try {
      const worker = state.workerStore.get(runtime.workerId);
      if (!worker) return;
      rememberMessageDirectory(message);
      state.viewOnceCache.remember(message);
      const fromAdmin = !message.key.fromMe && await isAdminInWorkerSession(runtime, message);
      if (message.key.fromMe || fromAdmin) await handleWorkerOperatorMessage(runtime, worker, message, text, fromAdmin);
      else await maybeReplyWorkerService(runtime, worker, message, text);
    } catch (error) {
      await handleFailure(error, { jid, text, messageId: message.key?.id });
    }
  }
}

async function onWorkerReactions(runtime, updates) {
  for (const update of updates || []) {
    try {
      const fromAdmin = adminWorkerSession?.workerId === runtime.workerId && await isOwnerChat(runtime.connection.sock, update);
      if (!update.reaction?.key?.fromMe && !fromAdmin) continue;
      await handleReactionAction(update);
    } catch (error) {
      await handleFailure(error, { jid: update?.key?.remoteJid, messageId: update.key?.id });
    }
  }
}

// Message ids are the same for sender and receiver, so bot replies can be recognized on the other account.
function isWorkerBotOutput(message) {
  const id = message.key?.id;
  if (!id) return false;
  for (const runtime of workerRuntimes.values()) {
    if (runtime.scope.state.ignoredOwnMessageIds.has(id)) return true;
  }
  return false;
}

async function toPhoneJid(sock, jid) {
  if (!jid || !jid.endsWith('@lid')) return jid || null;
  try {
    return (await sock?.signalRepository?.lidMapping?.getPNForLID(jid)) || null;
  } catch {
    return null;
  }
}

// WhatsApp can address the same account by phone JID or LID, so a LID is converted to a phone JID before comparing.
async function isSameAccount(sock, left, right) {
  if (!left || !right) return false;
  if (sameActor(left, right)) return true;
  const [leftPhone, rightPhone] = await Promise.all([toPhoneJid(sock, left), toPhoneJid(sock, right)]);
  return Boolean(leftPhone && rightPhone && sameActor(leftPhone, rightPhone));
}

async function isOwnerChat(sock, message) {
  const chatJids = [message.key.remoteJid, message.key.remoteJidAlt].filter(Boolean);
  const ownerJids = ownerAccountJids();
  for (const chatJid of chatJids) {
    for (const ownerJid of ownerJids) {
      if (await isSameAccount(sock, chatJid, ownerJid)) return true;
    }
  }
  return false;
}

async function isAdminInWorkerSession(runtime, message) {
  if (adminWorkerSession?.workerId !== runtime.workerId) return false;
  if (ownerState.ignoredOwnMessageIds.has(message.key.id)) return false;
  if (message.key.remoteJid.endsWith('@g.us')) return false;
  const matched = await isOwnerChat(runtime.connection.sock, message);
  if (!matched) {
    await logger.info('Worker message ignored during admin session', { worker: runtime.workerId, remoteJid: message.key.remoteJid, remoteJidAlt: message.key.remoteJidAlt || null, owner: ownerAccountJids() });
  }
  return matched;
}

async function handleWorkerOperatorMessage(runtime, worker, message, text, fromAdmin) {
  const jid = message.key.remoteJid;
  const command = parseCommand(text);
  const actorJid = messageActorJid(message);
  const sessionActorMatches = activeSessionActorMatches(jid, actorJid);
  const isControlCommand = ['end', 'cancel'].includes(command?.name);
  if (sessionActorMatches && !isControlCommand) {
    if (state.cintaRecorder.has(jid)) {
      await listeningProgress(jid, await state.cintaRecorder.record(state.sock, message));
      return;
    }
    if (state.qrSessions.has(jid)) {
      await maybeCollectQrItem(message, text);
      return;
    }
    if (state.toVideoSessions.has(jid)) {
      await collectToVideoItem(message, text);
      return;
    }
    if (state.stimpaSessions.has(jid)) {
      await collectStimpaItem(message);
      return;
    }
  }
  if (!command) {
    if (sessionActorMatches) await maybeCollectPdfItem(message, text);
    return;
  }
  await runWorkerCommand(runtime, worker, message, command, { actorJid, fromAdmin });
}

async function runWorkerCommand(runtime, worker, message, command, { actorJid, fromAdmin }) {
  const jid = message.key.remoteJid;
  const isExit = command.name === 'worker' && (command.args[0] || '').toLowerCase() === 'exit';
  if (fromAdmin && (isExit || (command.name === 'end' && !activeSessionType(jid)))) {
    await exitAdminWorkerSession(jid);
    return;
  }
  if (!workerCommandAllowed(worker, command.name)) {
    await sendText(jid, `Command ${COMMAND_PREFIX}${command.name} tidak tersedia untuk worker ini. Ketik ,help`);
    return;
  }
  if (!['end', 'cancel', 'confirm'].includes(command.name)) {
    const limitKey = `command:${actorJid}:${normalizeLookupText(getMessageText(message))}`;
    if (!runtime.limiter.allow(limitKey, WORKER_COMMAND_LIMIT, WORKER_COMMAND_WINDOW_MS)) return;
    await showWorkerTyping(jid, WORKER_COMMAND_DELAY_MS);
  }
  if (command.name === 'cinta') {
    await handleCintaCommand(worker, jid, command, actorJid);
  } else if (command.name === 'status') {
    await handleWorkerStatus(jid, worker);
  } else {
    await handleCommand(message, command, { actorJid, isOwner: false, isAdmin: false, publicOpen: false });
  }
}

async function handleWorkerStatus(jid, worker) {
  await sendText(jid, [
    `*Status worker #${worker.id}*`,
    `Nomor: +${worker.phone}`,
    `Koneksi: ${state.connected ? 'online' : 'offline'}`,
    `Service: ${worker.service || 'default'}`,
    `Terhubung sejak: ${worker.connectedAt ? formatWib(worker.connectedAt) : '-'}`,
    worker.service === 'cinta' ? `Balasan cinta terkirim: ${worker.stats?.cintaReplies || 0}` : null,
    '',
    'Berhenti jadi worker: logout perangkat tertaut di WhatsApp.'
  ].filter((line) => line !== null).join('\n'));
}

async function isAdminSessionChat(message) {
  if (!adminWorkerSession) return false;
  const worker = state.workerStore?.get(adminWorkerSession.workerId);
  if (!worker) return false;
  const chatJids = [message.key.remoteJid, message.key.remoteJidAlt].filter(Boolean);
  for (const workerJid of [worker.phoneJid, worker.lidJid].filter(Boolean)) {
    for (const chatJid of chatJids) {
      if (await isSameAccount(ownerState.sock, workerJid, chatJid)) return true;
    }
  }
  return false;
}

async function startAdminWorkerSession(jid, worker) {
  const runtime = workerRuntimes.get(worker.id);
  if (!runtime?.connection.connected) throw new UserInputError(`Worker #${worker.id} sedang tidak online.`);
  const previous = adminWorkerSession?.workerId;
  adminWorkerSession = { workerId: worker.id, startedAt: Date.now() };
  await sendText(jid, [
    previous && previous !== worker.id ? `Sesi worker #${previous} ditutup.` : null,
    `Masuk sesi worker #${worker.id} (${worker.name || worker.phone}).`,
    `Buka chat dengan ${waLink(worker)} lalu ketik command di sana. Command dijalankan sebagai worker.`,
    'Keluar: ,end atau ,worker exit'
  ].filter(Boolean).join('\n'));
}

async function exitAdminWorkerSession(jid) {
  if (!adminWorkerSession) {
    await sendText(jid, 'Tidak ada sesi worker yang aktif.');
    return;
  }
  const workerId = adminWorkerSession.workerId;
  adminWorkerSession = null;
  await sendText(jid, `Keluar dari sesi worker #${workerId}.`);
}

async function handleWorkerAdminCommand(message, command, context) {
  if (!context.isOwner) throw new UserInputError('Command ,worker hanya bisa dipakai akun admin utama.');
  const jid = message.key.remoteJid;
  const action = (command.args[0] || 'list').toLowerCase();
  if (action === 'list') {
    await sendText(jid, formatWorkerList(state.workerStore.list()));
  } else if (action === 'info') {
    await sendWorkerInfo(jid, state.workerStore.find(command.args[1]));
  } else if (action === 'session') {
    await startAdminWorkerSession(jid, state.workerStore.find(command.args[1]));
  } else if (action === 'exit') {
    await exitAdminWorkerSession(jid);
  } else if (action === 'service') {
    await handleWorkerServiceCommand(jid, command.args.slice(1));
  } else if (action === 'default') {
    await handleWorkerDefaultCommand(jid, command.args.slice(1));
  } else {
    throw new UserInputError(HELP_DETAILS.worker.join('\n'));
  }
}

async function sendWorkerInfo(jid, worker) {
  const dataDir = state.workerStore.dataDir(worker);
  const [notes, links] = await Promise.all([
    listNotes(path.join(dataDir, 'notes.json')),
    listLinks(path.join(dataDir, 'links.json'))
  ]);
  const caption = formatWorkerInfo(worker, {
    folder: path.relative(ROOT_DIR, state.workerStore.dirFor(worker)),
    notesCount: notes.length,
    linksCount: links.length,
    adminSession: adminWorkerSession?.workerId === worker.id
  });
  const profilePath = state.workerStore.profilePath(worker);
  if (worker.hasProfilePicture && await fileExists(profilePath)) {
    await sendBotMessage(jid, { image: { url: profilePath }, caption });
  } else {
    await sendText(jid, `${caption}\nFoto profil: tidak tersedia`);
  }
}

async function handleWorkerServiceCommand(jid, args) {
  if (!args.length || args[0].toLowerCase() === 'list') {
    await sendText(jid, formatWorkerServiceList());
    return;
  }
  const worker = state.workerStore.find(args[0]);
  const serviceName = (args[1] || '').toLowerCase();
  if (!serviceName) throw new UserInputError('Format: ,worker service <id|nomor> <nama|off>');
  if (serviceName === 'off') {
    await state.workerStore.update(worker.id, { service: null });
    await sendText(jid, `Service worker #${worker.id} dilepas. Worker kembali memakai command default.`);
    return;
  }
  const service = findWorkerService(serviceName);
  if (!service) throw new UserInputError(`Service "${serviceName}" tidak ada. Lihat ,worker service list`);
  await state.workerStore.update(worker.id, { service: service.name });
  await sendText(jid, [
    `Worker #${worker.id} sekarang memakai service ${service.name}.`,
    `Atur service: ,worker session ${worker.id}, lalu ketik ,${service.commands[0]} di chat dengan worker.`
  ].join('\n'));
}

async function handleWorkerDefaultCommand(jid, args) {
  const worker = state.workerStore.find(args[0]);
  const value = (args[1] || '').toLowerCase();
  if (!['on', 'off'].includes(value)) throw new UserInputError('Format: ,worker default <id|nomor> on|off');
  await state.workerStore.update(worker.id, { allowDefaultCommands: value === 'on' });
  await sendText(jid, `Command default worker #${worker.id} ${value === 'on' ? 'diaktifkan' : 'dinonaktifkan'}.${worker.service ? '' : ' Worker tanpa service selalu memakai command default.'}`);
}

function currentWorker() {
  const scope = workerScope.getStore();
  return scope ? ownerState.workerStore.get(scope.workerId) : null;
}

async function sendCintaReply(jid, worker) {
  const { entries } = cintaConfig(worker);
  if (!entries.length) {
    await sendText(jid, DEFAULT_CINTA_CAPTION);
    return;
  }
  await sendRecordedEntries(botSender(), jid, absoluteEntries(entries, state.workerStore.dataDir(worker)));
}

async function maybeReplyWorkerService(runtime, worker, message, text) {
  if (worker.service !== 'cinta') return;
  const jid = message.key.remoteJid;
  if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) return;
  if (Date.now() - timestampMs(message) > CINTA_MAX_MESSAGE_AGE_MS) return;
  const config = cintaConfig(worker);
  if (!matchCintaTrigger(text, config.triggers)) return;
  if (!runtime.limiter.allow(`cinta:${jidNormalizedUser(jid)}`, CINTA_REPLY_LIMIT, CINTA_REPLY_WINDOW_MS)) return;

  if (config.reactionEmoji) await sendBotMessage(jid, { react: { text: config.reactionEmoji, key: message.key } });
  await state.sock.readMessages([message.key]).catch(() => {});
  await showWorkerTyping(jid, CINTA_DELAY_MS);
  await sendCintaReply(jid, worker);
  await state.workerStore.update(worker.id, {
    stats: { ...worker.stats, cintaReplies: (worker.stats?.cintaReplies || 0) + 1 },
    lastSeenAt: new Date().toISOString()
  });
}

function formatCintaConfig(worker) {
  const config = cintaConfig(worker);
  return [
    '*Pengaturan service cinta*',
    `Trigger: ${config.triggers.map((trigger) => `"${trigger}"`).join(', ')}`,
    `Emoji reaksi: ${config.reactionEmoji || 'tidak ada'}`,
    `Pesan otomatis: ${config.entries.length ? `${config.entries.length} item rekaman` : 'bawaan (teks Tako-Wae)'}`,
    '',
    ',cinta rekam pesan otomatis baru',
    ',cinta trigger <teks> (satu trigger per baris)',
    ',cinta emoji <emoji|->',
    ',cinta test',
    ',cinta reset'
  ].join('\n');
}

async function updateCintaConfig(worker, changes) {
  const current = worker.serviceConfig?.cinta || {};
  const serviceConfig = { ...worker.serviceConfig, cinta: { ...current, ...changes } };
  return state.workerStore.update(worker.id, { serviceConfig });
}

async function handleCintaCommand(worker, jid, command, actorJid) {
  const action = (command.args[0] || '').toLowerCase();
  if (!action) {
    await startCintaRecording(jid, actorJid);
  } else if (action === 'info') {
    await sendText(jid, formatCintaConfig(worker));
  } else if (action === 'trigger') {
    const triggers = parseCintaTriggers(command.rawArgs.replace(/^\S+/, ''));
    await updateCintaConfig(worker, { triggers });
    await sendText(jid, `Trigger tersimpan: ${triggers.map((trigger) => `"${trigger}"`).join(', ')}`);
  } else if (action === 'emoji') {
    const reactionEmoji = parseReactionEmoji(command.args[1]);
    await updateCintaConfig(worker, { reactionEmoji });
    await sendText(jid, reactionEmoji ? `Emoji reaksi diganti menjadi ${reactionEmoji}.` : 'Reaksi emoji dimatikan.');
  } else if (action === 'test') {
    await sendCintaReply(jid, worker);
  } else if (action === 'reset') {
    await resetCintaConfig(worker, jid, actorJid);
  } else {
    throw new UserInputError(HELP_DETAILS.cinta.join('\n'));
  }
}

async function startCintaRecording(jid, actorJid) {
  assertNoActiveSession(jid);
  await state.cintaRecorder.start(jid, actorJid);
  const sent = await sendText(jid, 'Mulai rekam pesan otomatis cinta. Kirim teks, gambar, atau media lain lalu ,end atau ✅ untuk simpan, ,cancel atau ❌ untuk batal. Rekaman baru menggantikan pesan otomatis lama.');
  registerSessionPrompt(sent.key, jid, actorJid);
}

async function finishCintaByJid(jid, actorJid) {
  if (!state.cintaRecorder?.has(jid)) return false;
  const worker = currentWorker();
  const dataDir = state.workerStore.dataDir(worker);
  const previousEntries = cintaConfig(worker).entries;
  const entries = await state.cintaRecorder.finish(jid, actorJid, path.join(dataDir, 'cinta', `reply-${Date.now()}`));
  if (!entries) return false;
  await updateCintaConfig(worker, { entries: relativeEntries(entries, dataDir) });
  await removeStoredMedia(previousEntries, dataDir);
  await sendText(jid, `Pesan otomatis cinta tersimpan (${entries.length} item). Ketik ,cinta test untuk mencoba.`);
  return true;
}

async function resetCintaConfig(worker, jid, actorJid) {
  const dataDir = state.workerStore.dataDir(worker);
  await requestConfirmation(jid, actorJid, {
    title: 'Reset pengaturan cinta',
    description: 'Trigger, emoji reaksi, dan pesan otomatis kembali ke bawaan.',
    execute: async () => {
      await removeStoredMedia(cintaConfig(worker).entries, dataDir);
      await state.workerStore.update(worker.id, { serviceConfig: { ...worker.serviceConfig, cinta: {} } });
      await sendText(jid, 'Pengaturan cinta dikembalikan ke bawaan.');
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
  state.statusInbox = await new StatusInbox(path.join(ROOT_DIR, 'data', 'status-inbox.json')).load();
  try { state.contactNames = new Map(Object.entries(JSON.parse(await fs.readFile(path.join(ROOT_DIR, 'data', 'contact-names.json'), 'utf8')))); } catch {}
  for (const [jid, name] of state.contactNames) state.chatDirectory.remember(jid, name);
  state.errorReporter = new ErrorReporter(path.join(ROOT_DIR, 'data', 'error-outbox.json'));
  await state.errorReporter.load();
  setErrorSink((message, meta) => state.errorReporter.report(message, meta));
  state.errorReporter.send = async (text) => {
    if (!state.connected) throw new Error('WhatsApp disconnected');
    let jid; try { jid = destinationJid('errors'); } catch { await notifyMissingSetup('errors'); throw new Error('Error destination unavailable'); }
    await sendText(jid, text);
  };
  setInterval(() => state.errorReporter.flush().catch(() => {}), 30000).unref();
  for (const feature of STORAGE_FEATURES) {
    const target = state.runtimeConfig.storageTarget(feature);
    if (target.mode === 'local') {
      try { await prepareLocalPath(target.path); } catch (error) { await logger.error('Local storage unavailable', { feature, error: error.message }); }
    }
  }
  setInterval(() => expireListeningSessions().catch((error) => handleFailure(error)), 30000).unref();
  setInterval(() => state.statusInbox.serial(() => state.statusInbox.save()).catch((error) => handleFailure(error)), 60000).unref();
  try { state.reactionActions.prompts = new Set(JSON.parse(await fs.readFile(path.join(ROOT_DIR, 'data', 'prompt-keys.json'), 'utf8'))); } catch {}
  state.tools = await detectTools();
  state.workerStore = await new WorkerStore().load();
  state.pdfSessions = new PdfSessions(state.tools);
  state.toVideoSessions = new ToVideoSessions(state.tools);
  state.stimpaSessions = new StimpaSessions();
  state.qrSessions = new QrSessions();
  state.restoreSessions = new RestoreSessions();
  state.saveRecorder = new SaveRecorder();
  state.taskRecorder = new TaskRecorder();
  state.anticall = new AnticallStore();
  await state.anticall.load();
  state.typing = new TypingController({ logger });
  await state.typing.load();
  state.backupScheduler = new DailyBackupScheduler(
    logger,
    async () => { try { return await runConfiguredBackup(); } catch (error) { await handleFailure(error); throw error; } },
    {
      shouldRun: () => state.connected && state.runtimeConfig.isBackupAutoDaily(),
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
  await startAllWorkers();
  setInterval(() => runWorkerHousekeeping().catch((error) => handleFailure(error)), 30000).unref();
}

process.on('SIGINT', async () => {
  await logger.info('SIGINT received');
  state.scheduler?.stop();
  state.reminderScheduler?.stop();
  state.backupScheduler?.stop();
  state.typing?.detach();
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { error: reason?.message || String(reason) });
});

export { state, workerRuntimes, workerScope, createWorkerScope, onWorkerMessageUpsert, onMessageUpsert, onMessagesReaction, onMessagesUpdate, handleSetup, handleFailure, storageTarget, archiveStatus, handleStatusBrowse, resolveErrorGroup, runConfiguredBackup, expireListeningSessions, rememberContacts };

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(async (error) => {
  await logger.error('Fatal startup error', { error: error.message });
  console.error(error);
  process.exit(1);
});
