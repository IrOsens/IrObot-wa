import { spawn } from 'node:child_process';

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
    throw new Error('winget tidak ditemukan. Install manual: FFmpeg, yt-dlp, dan LibreOffice.');
  }

  await run('winget', ['install', '--accept-package-agreements', '--accept-source-agreements', '-e', '--id', 'Gyan.FFmpeg']);
  await run('winget', ['install', '--accept-package-agreements', '--accept-source-agreements', '-e', '--id', 'yt-dlp.yt-dlp']);
  await run('winget', ['install', '--accept-package-agreements', '--accept-source-agreements', '-e', '--id', 'TheDocumentFoundation.LibreOffice']);
}

async function installLinux() {
  if (await commandExists('apt-get')) {
    await run('sudo', ['apt-get', 'update']);
    await run('sudo', ['apt-get', 'install', '-y', 'ffmpeg', 'yt-dlp', 'libreoffice']);
    return;
  }

  if (await commandExists('dnf')) {
    await run('sudo', ['dnf', 'install', '-y', 'ffmpeg', 'yt-dlp', 'libreoffice']);
    return;
  }

  if (await commandExists('pacman')) {
    await run('sudo', ['pacman', '-Sy', '--noconfirm', 'ffmpeg', 'yt-dlp', 'libreoffice-fresh']);
    return;
  }

  if (await commandExists('zypper')) {
    await run('sudo', ['zypper', 'install', '-y', 'ffmpeg', 'yt-dlp', 'libreoffice']);
    return;
  }

  throw new Error('Package manager Linux belum dikenali. Install manual: ffmpeg, ffprobe, yt-dlp, libreoffice/soffice.');
}

async function main() {
  if (process.platform === 'win32') {
    await installWindows();
    return;
  }

  if (process.platform === 'linux') {
    await installLinux();
    return;
  }

  throw new Error(`Platform ${process.platform} belum didukung untuk auto-install tool sistem.`);
}

main().catch((error) => {
  console.error(`[setup:full] ${error.message}`);
  process.exit(1);
});
