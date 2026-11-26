import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

// yt-dlp (link sosmed untuk ,stimpa) dipasang sebagai binary resmi di ~/.local/bin.
async function installYtdlp() {
  if (await commandExists('yt-dlp')) {
    await run('yt-dlp', ['-U']).catch(() => {});
    return;
  }
  const target = path.join(os.homedir(), '.local', 'bin', 'yt-dlp');
  await fs.mkdir(path.dirname(target), { recursive: true });
  const response = await fetch(YTDLP_URL);
  if (!response.ok) throw new Error(`Download yt-dlp gagal: HTTP ${response.status}`);
  const temp = `${target}.download`;
  await fs.writeFile(temp, Buffer.from(await response.arrayBuffer()), { mode: 0o755 });
  await fs.rename(temp, target);
  console.log(`[setup:full] yt-dlp terpasang di ${target}`);
}

function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], {
      shell: process.platform === 'win32',
      stdio: 'ignore'
    });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: process.platform === 'win32',
      stdio: 'inherit'
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} gagal dengan exit code ${code}`));
    });
    child.on('error', reject);
  });
}

async function installWindows() {
  if (!(await commandExists('winget'))) {
    throw new Error('winget tidak ditemukan. Install manual: FFmpeg dan LibreOffice.');
  }

  await run('winget', ['install', '--accept-package-agreements', '--accept-source-agreements', '-e', '--id', 'Gyan.FFmpeg']);
  await run('winget', ['install', '--accept-package-agreements', '--accept-source-agreements', '-e', '--id', 'TheDocumentFoundation.LibreOffice']);
  await run('winget', ['install', '--accept-package-agreements', '--accept-source-agreements', '-e', '--id', 'yt-dlp.yt-dlp']);
}

async function installLinux() {
  if (await commandExists('apt-get')) {
    await run('sudo', ['apt-get', 'update']);
    await run('sudo', ['apt-get', 'install', '-y', 'ffmpeg', 'libreoffice', 'cabextract', 'fontconfig', 'tesseract-ocr', 'tesseract-ocr-eng']);
    return;
  }

  if (await commandExists('dnf')) {
    await run('sudo', ['dnf', 'install', '-y', 'ffmpeg', 'libreoffice', 'cabextract', 'fontconfig']);
    return;
  }

  if (await commandExists('pacman')) {
    await run('sudo', ['pacman', '-Sy', '--noconfirm', 'ffmpeg', 'libreoffice-fresh', 'cabextract', 'fontconfig']);
    return;
  }

  if (await commandExists('zypper')) {
    await run('sudo', ['zypper', 'install', '-y', 'ffmpeg', 'libreoffice', 'cabextract', 'fontconfig']);
    return;
  }

  throw new Error('Package manager Linux belum dikenali. Install manual: ffmpeg, ffprobe, libreoffice/soffice.');
}

async function main() {
  if (process.platform === 'win32') {
    await installWindows();
    return;
  }

  if (process.platform === 'linux') {
    await installLinux();
    await installYtdlp();
    return;
  }

  throw new Error(`Platform ${process.platform} belum didukung untuk auto-install tool sistem.`);
}

main().catch((error) => {
  console.error(`[setup:full] ${error.message}`);
  process.exit(1);
});
