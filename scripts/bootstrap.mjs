import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const NODE_MODULES_DIR = path.join(ROOT_DIR, 'node_modules');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const AUTH_DIR = path.join(ROOT_DIR, 'auth');
const LOG_DIR = path.join(ROOT_DIR, 'logs');
const TEMP_DIR = path.join(ROOT_DIR, 'temp');
const TASK_MEDIA_DIR = path.join(DATA_DIR, 'task-media');
const SAVED_MESSAGES_DIR = path.join(DATA_DIR, 'saved-messages');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const SAVED_MESSAGES_FILE = path.join(DATA_DIR, 'saved-messages.json');

const args = new Set(process.argv.slice(2));
const prepareOnly = args.has('--prepare-only');
const withTools = args.has('--with-tools');
const skipNpm = args.has('--skip-npm') || prepareOnly;

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

async function main() {
  checkNodeVersion();
  await installNodeDependencies();
  await ensureRuntimeDirs();
  const createdTasks = await ensureJsonFile(TASKS_FILE, { nextId: 1, tasks: [] });
  const createdSaved = await ensureJsonFile(SAVED_MESSAGES_FILE, { nextId: 1, items: [] });
  await maybeInstallSystemTools();

  log('Runtime directories siap.');
  if (createdTasks) log('Membuat data/tasks.json');
  if (createdSaved) log('Membuat data/saved-messages.json');
  log('Selesai.');
}

main().catch((error) => fail(error.message));
