import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const NODE_MODULES_DIR = path.join(ROOT_DIR, 'node_modules');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const AUTH_DIR = path.join(ROOT_DIR, 'auth');
const LOG_DIR = path.join(ROOT_DIR, 'logs');
const TEMP_DIR = path.join(ROOT_DIR, 'temp');
const ENV_FILE = path.join(ROOT_DIR, '.env');
const CONFIG_EXAMPLE_FILE = path.join(ROOT_DIR, 'config.example.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const COMMAND_ACCESS_FILE = path.join(DATA_DIR, 'command-access.json');
const BOT_STATE_FILE = path.join(DATA_DIR, 'bot-state.json');
const CHANGED_MESSAGES_FILE = path.join(DATA_DIR, 'changed-messages.json');
const STATUS_SAVE_FILE = path.join(DATA_DIR, 'status-save.json');
const TASK_MEDIA_DIR = path.join(DATA_DIR, 'task-media');
const SAVED_MESSAGES_DIR = path.join(DATA_DIR, 'saved-messages');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const SAVED_MESSAGES_FILE = path.join(DATA_DIR, 'saved-messages.json');
const NOTES_FILE = path.join(DATA_DIR, 'notes.json');
const LINKS_FILE = path.join(DATA_DIR, 'links.json');
const REMINDERS_FILE = path.join(DATA_DIR, 'reminders.json');
const WOL_FILE = path.join(DATA_DIR, 'wol.json');

const args = new Set(process.argv.slice(2));
const prepareOnly = args.has('--prepare-only');
const withTools = args.has('--with-tools');
const skipNpm = args.has('--skip-npm') || prepareOnly;
const skipService = args.has('--no-service') || prepareOnly || Boolean(process.env.CI);
const serviceFlag = args.has('--service');
const userServiceFlag = args.has('--user-service');
const systemServiceFlag = args.has('--system-service');
const REQUIRED_ENV_LINES = [
  'LINUX_SUDO_PASSWORD=',
  'BACKUP_PART_SIZE_MB=45'
];

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function log(message) {
  console.log(`[setup] ${message}`);
}

function fail(message) {
  console.error(`[setup] ${message}`);
  process.exit(1);
}

function checkNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(major) || major < 20) {
    fail(`Node.js >= 20 wajib. Versi aktif: ${process.version}`);
  }
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: ROOT_DIR,
      shell: process.platform === 'win32',
      stdio: 'inherit',
      ...options
    });

    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${commandArgs.join(' ')} gagal dengan exit code ${code}`));
    });
    child.on('error', reject);
  });
}

async function ensureRuntimeDirs() {
  await Promise.all([
    fs.mkdir(AUTH_DIR, { recursive: true }),
    fs.mkdir(DATA_DIR, { recursive: true }),
    fs.mkdir(TASK_MEDIA_DIR, { recursive: true }),
    fs.mkdir(SAVED_MESSAGES_DIR, { recursive: true }),
    fs.mkdir(LOG_DIR, { recursive: true }),
    fs.mkdir(TEMP_DIR, { recursive: true })
  ]);
}

async function ensureJsonFile(target, value) {
  if (await pathExists(target)) return false;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
  return true;
}

async function ensureTextFile(target, value) {
  if (await pathExists(target)) return false;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value);
  return true;
}

async function ensureEnvFile(target) {
  try {
    const original = await fs.readFile(target, 'utf8');
    const keys = new Set(original.split(/\r?\n/).map((line) => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1]).filter(Boolean));
    const missing = REQUIRED_ENV_LINES.filter((line) => !keys.has(line.split('=')[0]));
    if (!missing.length) return false;
    await fs.writeFile(target, `${original}${original.endsWith('\n') ? '' : '\n'}${missing.join('\n')}\n`);
    return true;
  } catch {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${REQUIRED_ENV_LINES.join('\n')}\n`);
    return true;
  }
}

async function readDefaultConfig() {
  try {
    return JSON.parse(await fs.readFile(CONFIG_EXAMPLE_FILE, 'utf8'));
  } catch {
    return {
      botName: 'IrOBot',
      commandPrefix: ',',
      targets: { primaryGroup: 'IrOBot', taskChats: ['dev', 'IrOBot'], reminderChat: 'IrOBot' },
      sticker: { defaultAuthor: 'IrO', defaultTitle: ':3' },
      pdf: { defaultFileName: 'IrOBot', sessionTimeoutMs: 1800000 },
      wol: { broadcastAddress: '255.255.255.255', port: 9 },
      sessions: { restoreTimeoutMs: 1800000 },
      backup: { partSizeMb: 45, autoDaily: true, dailyTimeWib: '00:00' },
      destinations: { logs: 'logs', changedmsg: 'changedmsg', saved: 'saved', backup: 'backup' },
      changedmsg: { enabled: true, indexMaxItems: 1000, maxMediaMb: 25 },
      statussave: { enabled: true, maxMediaMb: 25 }
    };
  }
}

async function installNodeDependencies() {
  if (skipNpm) return;
  if (await pathExists(NODE_MODULES_DIR)) {
    log('node_modules sudah ada, lewati npm install.');
    return;
  }
  log('Menjalankan npm install...');
  await run('npm', ['install']);
}

async function maybeInstallSystemTools() {
  if (!withTools) return;
  log('Menjalankan installer tool sistem opsional...');
  await run('node', ['scripts/install-system-tools.mjs']);
}

async function maybeInstallSystemdService() {
  if (process.platform !== 'linux') {
    if (serviceFlag || userServiceFlag || systemServiceFlag) log('Systemd service hanya tersedia di Linux. Lewati.');
    return;
  }

  if (serviceFlag || userServiceFlag || systemServiceFlag) {
    const serviceArgs = ['scripts/install-systemd.mjs', 'install'];
    if (userServiceFlag) serviceArgs.push('--user');
    if (systemServiceFlag) serviceArgs.push('--system');
    await run('node', serviceArgs);
    return;
  }

  if (skipService || !process.stdin.isTTY) return;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Install systemd service agar bot auto-start setelah reboot/crash? (y/N) ')).trim().toLowerCase();
    if (!['y', 'yes', 'ya'].includes(answer)) return;
  } finally {
    rl.close();
  }

  await run('node', ['scripts/install-systemd.mjs', 'install']);
}

async function main() {
  checkNodeVersion();
  await installNodeDependencies();
  await ensureRuntimeDirs();
  const createdEnv = await ensureEnvFile(ENV_FILE);
  const createdConfig = await ensureJsonFile(CONFIG_FILE, await readDefaultConfig());
  const createdCommandAccess = await ensureJsonFile(COMMAND_ACCESS_FILE, { all: false, chats: {}, admins: [], nextAdminId: 1 });
  const createdBotState = await ensureJsonFile(BOT_STATE_FILE, { enabled: true, updatedAt: null });
  const createdChangedMessages = await ensureJsonFile(CHANGED_MESSAGES_FILE, { allowedChats: [], nextAllowedId: 1, index: [], updatedAt: null });
  const createdStatusSave = await ensureJsonFile(STATUS_SAVE_FILE, { nextId: 1, items: [], updatedAt: null });
  const createdTasks = await ensureJsonFile(TASKS_FILE, { nextId: 1, tasks: [] });
  const createdSaved = await ensureJsonFile(SAVED_MESSAGES_FILE, { nextId: 1, items: [] });
  const createdNotes = await ensureJsonFile(NOTES_FILE, { nextId: 1, items: [] });
  const createdLinks = await ensureJsonFile(LINKS_FILE, { nextId: 1, items: [] });
  const createdReminders = await ensureJsonFile(REMINDERS_FILE, { nextId: 1, items: [] });
  const createdWol = await ensureJsonFile(WOL_FILE, { nextId: 1, items: [] });
  await maybeInstallSystemTools();
  await maybeInstallSystemdService();

  log('Runtime directories siap.');
  if (createdEnv) log('Membuat .env.');
  if (createdConfig) log('Membuat data/config.json - cek target grup, sticker default, PDF, WOL, dan timeout.');
  if (createdCommandAccess) log('Membuat data/command-access.json');
  if (createdBotState) log('Membuat data/bot-state.json');
  if (createdChangedMessages) log('Membuat data/changed-messages.json');
  if (createdStatusSave) log('Membuat data/status-save.json');
  if (createdTasks) log('Membuat data/tasks.json');
  if (createdSaved) log('Membuat data/saved-messages.json');
  if (createdNotes) log('Membuat data/notes.json');
  if (createdLinks) log('Membuat data/links.json');
  if (createdReminders) log('Membuat data/reminders.json');
  if (createdWol) log('Membuat data/wol.json');
  log('Peringatan: data/config.json bisa disesuaikan bila nama grup/setting berbeda. Backup dikirim ke destination WhatsApp.');
  log('Selesai.');
}

main().catch((error) => fail(error.message));
