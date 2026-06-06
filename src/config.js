import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';

export const ROOT_DIR = process.cwd();
export const AUTH_DIR = path.join(ROOT_DIR, 'auth');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const TASK_MEDIA_DIR = path.join(DATA_DIR, 'task-media');
export const SAVED_MESSAGES_DIR = path.join(DATA_DIR, 'saved-messages');
export const SAVED_MESSAGES_FILE = path.join(DATA_DIR, 'saved-messages.json');
export const ANTICALL_MEDIA_DIR = path.join(DATA_DIR, 'anticall-media');
export const ANTICALL_FILE = path.join(DATA_DIR, 'anticall.json');
export const LOG_DIR = path.join(ROOT_DIR, 'logs');
export const TEMP_DIR = path.join(ROOT_DIR, 'temp');
export const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const COMMAND_ACCESS_FILE = path.join(DATA_DIR, 'command-access.json');
export const BOT_STATE_FILE = path.join(DATA_DIR, 'bot-state.json');
export const CHANGED_MESSAGES_FILE = path.join(DATA_DIR, 'changed-messages.json');
export const STATUS_SAVE_FILE = path.join(DATA_DIR, 'status-save.json');
export const NOTES_FILE = path.join(DATA_DIR, 'notes.json');
export const LINKS_FILE = path.join(DATA_DIR, 'links.json');
export const REMINDERS_FILE = path.join(DATA_DIR, 'reminders.json');
export const WOL_FILE = path.join(DATA_DIR, 'wol.json');
export const ENV_FILE = path.join(ROOT_DIR, '.env');

export const DEFAULT_APP_CONFIG = {
  botName: 'IrOBot',
  commandPrefix: ',',
  targets: {
    primaryGroup: 'IrOBot',
    taskChats: ['dev', 'IrOBot'],
    reminderChat: 'IrOBot'
  },
  sticker: {
    defaultAuthor: 'IrO',
    defaultTitle: ':3'
  },
  pdf: {
    defaultFileName: 'IrOBot',
    sessionTimeoutMs: 30 * 60 * 1000
  },
  wol: {
    broadcastAddress: '255.255.255.255',
    port: 9
  },
  sessions: {
    restoreTimeoutMs: 30 * 60 * 1000
  },
  backup: {
    partSizeMb: 45,
    autoDaily: true,
    dailyTimeWib: '00:00'
  },
  destinations: {
    logs: 'logs',
    changedmsg: 'changedmsg',
    saved: 'saved',
    backup: 'backup'
  },
  changedmsg: {
    enabled: true,
    indexMaxItems: 1000,
    maxMediaMb: 25
  },
  statussave: {
    enabled: true,
    maxMediaMb: 25
  },
  update: {
    restartMode: 'systemctl',
    systemdService: 'irobot-wa.service',
    remote: 'origin',
    branch: 'main'
  }
};

ensureLocalRuntimeFilesSync();
loadEnvFile();

export const APP_CONFIG = loadAppConfig();

export const COMMAND_PREFIX = APP_CONFIG.commandPrefix || ',';
export const BOT_NAME = APP_CONFIG.botName || 'IrOBot';
export const TARGET_CHAT_NAMES = uniqueStrings([
  APP_CONFIG.targets?.primaryGroup,
  APP_CONFIG.targets?.reminderChat
]);
export const PRIMARY_TARGET_NAME = APP_CONFIG.targets?.primaryGroup || 'IrOBot';
export const REMINDER_TARGET_NAMES = uniqueStrings([APP_CONFIG.targets?.reminderChat || PRIMARY_TARGET_NAME]);
export const TASK_TARGET_NAMES = asStringArray(APP_CONFIG.targets?.taskChats, ['dev', PRIMARY_TARGET_NAME]);
export const DEFAULT_STICKER_AUTHOR = APP_CONFIG.sticker?.defaultAuthor || 'IrO';
export const DEFAULT_STICKER_TITLE = APP_CONFIG.sticker?.defaultTitle || ':3';
export const PDF_DEFAULT_FILE_NAME = APP_CONFIG.pdf?.defaultFileName || BOT_NAME;
export const PDF_SESSION_TIMEOUT_MS = numberOr(APP_CONFIG.pdf?.sessionTimeoutMs, 30 * 60 * 1000);
export const RESTORE_SESSION_TIMEOUT_MS = numberOr(APP_CONFIG.sessions?.restoreTimeoutMs, 30 * 60 * 1000);
export const BACKUP_PART_SIZE_BYTES = Math.max(
  1024 * 1024,
  Math.floor(numberOr(process.env.BACKUP_PART_SIZE_MB, APP_CONFIG.backup?.partSizeMb || 45) * 1024 * 1024)
);
export const AUTO_DAILY_BACKUP = APP_CONFIG.backup?.autoDaily !== false;
export const DAILY_BACKUP_TIME_WIB = APP_CONFIG.backup?.dailyTimeWib || '00:00';
export const UPDATE_RESTART_MODE = APP_CONFIG.update?.restartMode || 'systemctl';
export const UPDATE_SYSTEMD_SERVICE = APP_CONFIG.update?.systemdService || 'irobot-wa.service';
export const UPDATE_REMOTE = APP_CONFIG.update?.remote || 'origin';
export const UPDATE_BRANCH = APP_CONFIG.update?.branch || 'main';
export const LINUX_SUDO_PASSWORD = process.env.LINUX_SUDO_PASSWORD || '';
export const WOL_BROADCAST_ADDRESS = APP_CONFIG.wol?.broadcastAddress || '255.255.255.255';
export const WOL_PORT = numberOr(APP_CONFIG.wol?.port, 9);

export async function ensureRuntimeDirs() {
  await Promise.all([
    fs.mkdir(AUTH_DIR, { recursive: true }),
    fs.mkdir(DATA_DIR, { recursive: true }),
    fs.mkdir(TASK_MEDIA_DIR, { recursive: true }),
    fs.mkdir(SAVED_MESSAGES_DIR, { recursive: true }),
    fs.mkdir(ANTICALL_MEDIA_DIR, { recursive: true }),
    fs.mkdir(LOG_DIR, { recursive: true }),
    fs.mkdir(TEMP_DIR, { recursive: true })
  ]);
  await Promise.all([
    ensureEnvFile(ENV_FILE),
    ensureJsonFile(CONFIG_FILE, DEFAULT_APP_CONFIG),
    ensureJsonFile(COMMAND_ACCESS_FILE, { all: false, chats: {}, admins: [], nextAdminId: 1 }),
    ensureJsonFile(BOT_STATE_FILE, { enabled: true, updatedAt: null }),
    ensureJsonFile(CHANGED_MESSAGES_FILE, { allowedChats: [], nextAllowedId: 1, index: [], updatedAt: null }),
    ensureJsonFile(STATUS_SAVE_FILE, { nextId: 1, items: [], updatedAt: null }),
    ensureJsonFile(ANTICALL_FILE, { enabled: false, entries: [], updatedAt: null }),
    ensureJsonFile(TASKS_FILE, { nextId: 1, tasks: [] }),
    ensureJsonFile(SAVED_MESSAGES_FILE, { nextId: 1, items: [] }),
    ensureJsonFile(NOTES_FILE, { nextId: 1, items: [] }),
    ensureJsonFile(LINKS_FILE, { nextId: 1, items: [] }),
    ensureJsonFile(REMINDERS_FILE, { nextId: 1, items: [] }),
    ensureJsonFile(WOL_FILE, { nextId: 1, items: [] })
  ]);
}

export async function cleanupStartupTemp() {
  await fs.mkdir(TEMP_DIR, { recursive: true });
  try {
    await fs.rm(TEMP_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    await fs.mkdir(TEMP_DIR, { recursive: true });
    return;
  } catch {
    // A Windows process can briefly lock a temp file. Cleanup is best-effort so startup never fails.
  }

  const entries = await fs.readdir(TEMP_DIR, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.map((entry) => {
    const target = path.join(TEMP_DIR, entry.name);
    return fs.rm(target, { recursive: entry.isDirectory(), force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
  }));
}

export function todayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function makeTempPath(prefix, ext = '') {
  const safeExt = ext ? (ext.startsWith('.') ? ext : `.${ext}`) : '';
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return path.join(TEMP_DIR, `${prefix}-${stamp}${safeExt}`);
}

function loadEnvFile() {
  if (!syncFs.existsSync(ENV_FILE)) return;
  const content = syncFs.readFileSync(ENV_FILE, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] != null) continue;
    process.env[key] = parseEnvValue(rawValue);
  }
}

function ensureLocalRuntimeFilesSync() {
  ensureDirSync(DATA_DIR);
  ensureDirSync(AUTH_DIR);
  ensureEnvFileSync(ENV_FILE);
  ensureJsonFileSync(CONFIG_FILE, DEFAULT_APP_CONFIG);
}

function ensureDirSync(dir) {
  if (!syncFs.existsSync(dir)) syncFs.mkdirSync(dir, { recursive: true });
}

function defaultEnvText() {
  return `${requiredEnvLines().join('\n')}\n`;
}

function requiredEnvLines() {
  return [
    'LINUX_SUDO_PASSWORD=',
    'BACKUP_PART_SIZE_MB=45'
  ];
}

function ensureTextFileSync(target, value) {
  if (syncFs.existsSync(target)) return false;
  ensureDirSync(path.dirname(target));
  syncFs.writeFileSync(target, value);
  return true;
}

function ensureEnvFileSync(target) {
  if (!syncFs.existsSync(target)) return ensureTextFileSync(target, defaultEnvText());
  const original = syncFs.readFileSync(target, 'utf8');
  const keys = new Set(original.split(/\r?\n/).map((line) => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1]).filter(Boolean));
  const missing = requiredEnvLines().filter((line) => !keys.has(line.split('=')[0]));
  if (!missing.length) return false;
  const suffix = `${original.endsWith('\n') ? '' : '\n'}${missing.join('\n')}\n`;
  syncFs.writeFileSync(target, `${original}${suffix}`);
  return true;
}

function ensureJsonFileSync(target, value) {
  if (syncFs.existsSync(target)) return false;
  ensureDirSync(path.dirname(target));
  syncFs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  return true;
}

function parseEnvValue(value) {
  const trimmed = String(value || '').trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\n/g, '\n');
  }
  return trimmed;
}

function loadAppConfig() {
  try {
    const parsed = JSON.parse(syncFs.readFileSync(CONFIG_FILE, 'utf8'));
    return deepMerge(DEFAULT_APP_CONFIG, parsed);
  } catch {
    return DEFAULT_APP_CONFIG;
  }
}

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      result[key] = deepMerge(base[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function asStringArray(value, fallback = []) {
  const items = Array.isArray(value) ? value : [value];
  const clean = items.map((item) => String(item || '').trim()).filter(Boolean);
  return clean.length ? clean : fallback;
}

function uniqueStrings(values) {
  return [...new Set(asStringArray(values))];
}

async function ensureJsonFile(target, value) {
  try {
    await fs.access(target);
    return false;
  } catch {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
    return true;
  }
}

async function ensureTextFile(target, value) {
  try {
    await fs.access(target);
    return false;
  } catch {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, value);
    return true;
  }
}

async function ensureEnvFile(target) {
  try {
    const original = await fs.readFile(target, 'utf8');
    const keys = new Set(original.split(/\r?\n/).map((line) => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1]).filter(Boolean));
    const missing = requiredEnvLines().filter((line) => !keys.has(line.split('=')[0]));
    if (!missing.length) return false;
    const suffix = `${original.endsWith('\n') ? '' : '\n'}${missing.join('\n')}\n`;
    await fs.writeFile(target, `${original}${suffix}`);
    return true;
  } catch {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, defaultEnvText());
    return true;
  }
}
