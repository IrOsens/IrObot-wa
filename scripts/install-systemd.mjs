import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const SERVICE_NAME = 'irobot-wa';
const SERVICE_FILE = `${SERVICE_NAME}.service`;
const SYSTEM_SERVICE_PATH = path.join('/etc/systemd/system', SERVICE_FILE);
const USER_SERVICE_PATH = path.join(os.homedir(), '.config', 'systemd', 'user', SERVICE_FILE);

const rawArgs = process.argv.slice(2);
const flags = new Set(rawArgs.filter((arg) => arg.startsWith('--')));
const action = rawArgs.find((arg) => !arg.startsWith('--')) || 'install';

function log(message) {
  console.log(`[service] ${message}`);
}

function fail(message) {
  console.error(`[service] ${message}`);
  process.exit(1);
}

function isRoot() {
  return process.getuid?.() === 0;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      stdio: 'inherit',
      ...options
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} gagal dengan exit code ${code}`));
    });
    child.on('error', reject);
  });
}

function runCapture(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('exit', (code) => resolve({ ok: code === 0, stdout: Buffer.concat(chunks).toString('utf8') }));
    child.on('error', () => resolve({ ok: false, stdout: '' }));
  });
}

function runWithInput(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      stdio: ['pipe', 'ignore', 'inherit']
    });
    child.stdin.end(input);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} gagal dengan exit code ${code}`));
    });
    child.on('error', reject);
  });
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function commandExists(command) {
  const result = await runCapture('sh', ['-lc', `command -v ${command}`]);
  return result.ok && result.stdout.trim();
}

async function canUsePasswordlessSudo() {
  if (!(await commandExists('sudo'))) return false;
  const result = await runCapture('sudo', ['-n', 'true']);
  return result.ok;
}

async function resolveNpmPath() {
  const result = await runCapture('sh', ['-lc', 'command -v npm']);
  return result.stdout.trim() || '/usr/bin/npm';
}

function quoteSystemdValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function serviceContent(mode) {
  const npmPath = await resolveNpmPath();
  if (mode === 'user') {
    return [
      '[Unit]',
      'Description=IrOBot WhatsApp Bot',
      'After=default.target',
      '',
      '[Service]',
      'Type=simple',
      `WorkingDirectory=${quoteSystemdValue(ROOT_DIR)}`,
      `ExecStart=${quoteSystemdValue(npmPath)} start`,
      'Restart=always',
      'RestartSec=10',
      'StartLimitIntervalSec=0',
      'Environment=NODE_ENV=production',
      '',
      '[Install]',
      'WantedBy=default.target',
      ''
    ].join('\n');
  }

  return [
    '[Unit]',
    'Description=IrOBot WhatsApp Bot',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${quoteSystemdValue(ROOT_DIR)}`,
    `ExecStart=${quoteSystemdValue(npmPath)} start`,
    'Restart=always',
    'RestartSec=10',
    'StartLimitIntervalSec=0',
    'Environment=NODE_ENV=production',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    ''
  ].join('\n');
}

async function resolveMode() {
  if (flags.has('--user') || flags.has('--user-service')) return 'user';
  if (flags.has('--system') || flags.has('--system-service')) return 'system';
  if (action !== 'install') {
    if (await pathExists(SYSTEM_SERVICE_PATH)) return 'system';
    if (await pathExists(USER_SERVICE_PATH)) return 'user';
  }
  if (isRoot() || await canUsePasswordlessSudo()) return 'system';
  return 'user';
}

async function systemctl(mode, args) {
  if (mode === 'user') return run('systemctl', ['--user', ...args]);
  if (isRoot()) return run('systemctl', args);
  if (await canUsePasswordlessSudo()) return run('sudo', ['-n', 'systemctl', ...args]);
  throw new Error('Mode system butuh sudo. Jalankan `sudo npm run service:install` atau pakai `npm run service:install -- --user`.');
}

async function writeSystemService(content) {
  if (isRoot()) {
    await fs.writeFile(SYSTEM_SERVICE_PATH, content);
    return SYSTEM_SERVICE_PATH;
  }
  if (await canUsePasswordlessSudo()) {
    await runWithInput('sudo', ['-n', 'tee', SYSTEM_SERVICE_PATH], content);
    return SYSTEM_SERVICE_PATH;
  }
  throw new Error('Install system service butuh sudo. Jalankan `sudo npm run service:install` atau pilih user service.');
}

async function writeUserService(content) {
  await fs.mkdir(path.dirname(USER_SERVICE_PATH), { recursive: true });
  await fs.writeFile(USER_SERVICE_PATH, content);
  return USER_SERVICE_PATH;
}

async function install(mode) {
  const target = mode === 'system'
    ? await writeSystemService(await serviceContent(mode))
    : await writeUserService(await serviceContent(mode));

  log(`Service file dibuat: ${target}`);
  await systemctl(mode, ['daemon-reload']);
  await systemctl(mode, ['enable', SERVICE_FILE]);
  await systemctl(mode, ['restart', SERVICE_FILE]);
  log(`Service ${SERVICE_FILE} aktif.`);
  log(mode === 'system'
    ? `Cek status: sudo systemctl status ${SERVICE_NAME} --no-pager`
    : `Cek status: systemctl --user status ${SERVICE_NAME} --no-pager`);
  if (mode === 'user') {
    log('Agar user service auto-start setelah reboot tanpa login, jalankan jika diperlukan: sudo loginctl enable-linger $USER');
  }
}

async function main() {
  if (process.platform !== 'linux') fail('Systemd service hanya didukung di Linux.');
  if (!(await commandExists('systemctl'))) fail('systemctl tidak ditemukan. Jalankan bot lewat supervisor lain atau install systemd.');

  const mode = await resolveMode();
  if (action === 'install') {
    await install(mode);
    return;
  }
  if (action === 'status') {
    await systemctl(mode, ['status', SERVICE_FILE, '--no-pager']);
    return;
  }
  if (action === 'logs') {
    const args = mode === 'user'
      ? ['--user', '-u', SERVICE_FILE, '-f']
      : ['-u', SERVICE_FILE, '-f'];
    await run('journalctl', args);
    return;
  }
  if (action === 'restart') {
    await systemctl(mode, ['restart', SERVICE_FILE]);
    return;
  }
  if (action === 'enable') {
    await systemctl(mode, ['enable', SERVICE_FILE]);
    return;
  }
  if (action === 'disable') {
    await systemctl(mode, ['disable', '--now', SERVICE_FILE]);
    return;
  }
  fail('Command service tidak dikenal. Pakai install, status, logs, restart, enable, atau disable.');
}

main().catch((error) => fail(error.message));
