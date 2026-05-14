import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function which(command) {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const { stdout } = await execFileAsync(finder, [command], { windowsHide: true });
    const first = stdout.split(/\r?\n/).map((item) => item.trim()).find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

export async function detectTools() {
  const officeCandidates = process.platform === 'win32'
    ? [
        'soffice.exe',
        'libreoffice.exe',
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'LibreOffice', 'program', 'soffice.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'LibreOffice', 'program', 'soffice.exe')
      ]
    : ['soffice', 'libreoffice'];

  const [ffmpeg, ffprobe, ytDlp, ytDlpExe] = await Promise.all([
    which('ffmpeg'),
    which('ffprobe'),
    which('yt-dlp'),
    process.platform === 'win32' ? which('yt-dlp.exe') : Promise.resolve(null)
  ]);
  let office = null;
  for (const candidate of officeCandidates) {
    if (path.isAbsolute(candidate)) {
      if (await fileExists(candidate)) {
        office = candidate;
        break;
      }
    } else {
      office = await which(candidate);
      if (office) break;
    }
  }

  return { ffmpeg, ffprobe, office, ytDlp: ytDlp || ytDlpExe };
}

export async function runTool(command, args, options = {}) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    windowsHide: true,
    maxBuffer: 50 * 1024 * 1024,
    ...options
  });
  return { stdout, stderr };
}

export async function getDiskInfo(targetPath) {
  if (process.platform === 'win32') {
    const root = path.parse(path.resolve(targetPath)).root.replace(/\\$/, '');
    const script = [
      `$d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${root}'"`,
      'if ($d) { "$($d.Size)|$($d.FreeSpace)" }'
    ].join('; ');
    try {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true });
      const [size, free] = stdout.trim().split('|').map((value) => Number(value));
      if (Number.isFinite(size) && Number.isFinite(free)) {
        return { size, free, used: size - free, source: root };
      }
    } catch {
      return null;
    }
    return null;
  }

  try {
    const { stdout } = await execFileAsync('df', ['-k', targetPath], { windowsHide: true });
    const lines = stdout.trim().split(/\r?\n/);
    const parts = lines.at(-1).trim().split(/\s+/);
    const size = Number(parts[1]) * 1024;
    const used = Number(parts[2]) * 1024;
    const free = Number(parts[3]) * 1024;
    return { size, used, free, source: parts[5] || targetPath };
  } catch {
    return null;
  }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || !parts.length) parts.push(`${minutes}m`);
  return parts.join(' ');
}

export function getLoadAverageText() {
  if (process.platform === 'win32') return 'N/A on Windows';
  return os.loadavg().map((value) => value.toFixed(2)).join(', ');
}
