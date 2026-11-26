import fs from 'node:fs/promises';
import path from 'node:path';
import mime from 'mime-types';
import { makeTempPath } from './config.js';
import { UserInputError } from './errors.js';
import os from 'node:os';
import { fileExists, runTool } from './tools.js';

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
export const LOCAL_YTDLP = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
let installing = null;

// Downloads the official yt-dlp binary to ~/.local/bin (no sudo needed).
async function installYtdlp() {
  if (process.platform === 'win32') return null;
  const response = await fetch(YTDLP_URL, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  await fs.mkdir(path.dirname(LOCAL_YTDLP), { recursive: true });
  const temp = `${LOCAL_YTDLP}.download`;
  await fs.writeFile(temp, Buffer.from(await response.arrayBuffer()), { mode: 0o755 });
  await fs.rename(temp, LOCAL_YTDLP);
  return LOCAL_YTDLP;
}

// Tools are detected once at startup; yt-dlp may be installed later, so look again
// (and install it once) before giving up. The found path is stored on `tools`.
export async function ensureYtdlp(tools, { find = () => fileExists(LOCAL_YTDLP).then((ok) => (ok ? LOCAL_YTDLP : null)), install = installYtdlp } = {}) {
  if (tools?.ytdlp) return tools.ytdlp;
  let found = await find();
  if (!found) {
    installing ||= install().catch(() => null).finally(() => { installing = null; });
    found = await installing;
  }
  if (!found) throw new UserInputError('yt-dlp belum terpasang dan gagal dipasang otomatis. Di server jalankan: `cd ~/projects/IrObot-wa && npm run setup:full`');
  if (tools) tools.ytdlp = found;
  return found;
}

const SOCIAL_HOSTS = [
  'tiktok.com', 'instagram.com', 'youtube.com', 'youtu.be', 'x.com', 'twitter.com',
  'facebook.com', 'fb.watch', 'fb.com', 'threads.net', 'threads.com', 'soundcloud.com',
  'pinterest.com', 'pin.it', 'snapchat.com', 'vimeo.com', 'dailymotion.com', 'reddit.com',
  'bilibili.com', 'likee.video', 'capcut.com'
];
const DOWNLOAD_TIMEOUT_MS = 90_000;
// A few seconds more than the 10 s sticker audio, so the cut never lands short.
const SECTION_SECONDS = 12;

export function isSocialUrl(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return SOCIAL_HOSTS.some((item) => host === item || host.endsWith(`.${item}`));
}

// "1:05", "65", "0:01:05", "1m5s" -> seconds. Anything else -> 0.
export function parseStartTime(text) {
  const value = String(text || '').trim();
  if (!value) return 0;
  const clock = value.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})$/);
  if (clock) return Number(clock[1] || 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  if (/^\d+$/.test(value)) return Number(value);
  const units = value.match(/^(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (units && (units[1] || units[2])) return Number(units[1] || 0) * 60 + Number(units[2] || 0);
  return 0;
}

// Takes the first time-like word after the link, e.g. ",stimpa <link> 1:05".
export function startTimeFromArgs(rawArgs, url) {
  const rest = String(rawArgs || '').replace(url || '', ' ').trim().split(/\s+/);
  for (const word of rest) {
    const seconds = parseStartTime(word);
    if (seconds > 0) return seconds;
  }
  return 0;
}

function describeFailure(error, video = false) {
  const text = `${error?.stderr || ''}\n${error?.message || ''}`;
  if (error?.killed || /timed? ?out/i.test(text)) return 'Link kelamaan diunduh, coba lagi atau pakai link lain.';
  if (/private|login|sign in|cookies|age/i.test(text)) return 'Konten ini privat atau butuh login.';
  if (/max-filesize|larger than/i.test(text)) return 'File di link terlalu besar.';
  const what = video ? 'videonya' : 'audionya';
  if (/unsupported url|no video|no media|not available|removed|404/i.test(text)) return `Link ini tidak bisa diambil ${what} (privat/dihapus?).`;
  return `Link ini tidak bisa diambil ${what}.`;
}

// Downloads a short section of a social media link with yt-dlp, hands the file to `use`,
// then removes the whole download folder (also .part files) no matter what happens.
async function withSocialSection(tools, url, { startSec = 0, video = false, run = runTool, ytdlp = {} } = {}, use) {
  await ensureYtdlp(tools, ytdlp);
  const dir = makeTempPath(video ? 'sosmed-clip' : 'sosmed');
  await fs.mkdir(dir, { recursive: true });
  try {
    const start = Math.max(0, Math.floor(Number(startSec) || 0));
    const args = [
      '--no-playlist', '--no-progress', '--no-warnings', '--no-mtime',
      '--socket-timeout', '20',
      '--max-filesize', '80M',
      '-f', video ? CLIP_FORMAT : 'bestaudio/best',
      ...(video ? ['--merge-output-format', 'mp4'] : []),
      '--download-sections', `*${start}-${start + SECTION_SECONDS}`,
      '-o', path.join(dir, `${video ? 'clip' : 'audio'}.%(ext)s`)
    ];
    if (tools.ffmpeg) args.push('--ffmpeg-location', tools.ffmpeg);
    args.push('--', url);
    try {
      await run(tools.ytdlp, args, { timeout: DOWNLOAD_TIMEOUT_MS, cwd: dir });
    } catch (error) {
      throw new UserInputError(describeFailure(error, video));
    }
    const files = (await fs.readdir(dir)).filter((name) => !/\.(part|ytdl|temp)$/i.test(name));
    if (!files.length) throw new UserInputError(video ? 'Link ini tidak punya video yang bisa diambil.' : 'Link ini tidak bisa diambil audionya.');
    const file = path.join(dir, files[0]);
    const mimetype = mime.lookup(file) || (video ? 'video/mp4' : 'audio/mpeg');
    if (video) {
      if (!/^video\//.test(mimetype)) throw new UserInputError('Link ini bukan video. Untuk foto pakai `,dl <link>` lalu reply `,s`.');
      return await use({ path: file, mimetype, type: 'videoMessage', ext: path.extname(file), node: {} });
    }
    const media = { path: file, mimetype: /^video\//.test(mimetype) ? mimetype : (/^audio\//.test(mimetype) ? mimetype : 'audio/mpeg'), type: 'audioMessage', ext: path.extname(file) };
    return await use(media);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  }
}

// ~12 s of audio for a sticker sound.
export function withSocialAudio(tools, url, options = {}, use) {
  return withSocialSection(tools, url, { ...options, video: false }, use);
}

// ~12 s of video (small, with sound) to turn into an animated sticker.
export function withSocialClip(tools, url, options = {}, use) {
  return withSocialSection(tools, url, { ...options, video: true }, use);
}

// Only clock-like times ("1:05", "0:01:05", "1m5s", "30s"), so plain numbers in other args are left alone.
export function clipStartFromArgs(rawArgs, url) {
  const rest = String(rawArgs || '').replace(url || '', ' ').trim().split(/\s+/);
  const word = rest.find((item) => /^(?:\d+:)?\d{1,2}:\d{2}$|^(?:\d+m)(?:\d+s)?$|^\d+s$/i.test(item));
  return { startSec: word ? parseStartTime(word) : 0, word: word || '' };
}

export const SOCIAL_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
const VIDEO_FORMAT = [
  'bv*[height<=720][vcodec^=avc]+ba[ext=m4a]',
  'b[height<=720][vcodec^=avc]',
  'bv*[height<=720]+ba',
  'b[height<=720]',
  'b'
].join('/');
// Stickers are 512 px, so a small (<=480p) clip is plenty and downloads fast.
const CLIP_FORMAT = [
  'bv*[height<=480][vcodec^=avc]+ba[ext=m4a]',
  'b[height<=480][vcodec^=avc]',
  'bv*[height<=480]+ba',
  'b[height<=480]',
  'bv*[height<=720]+ba',
  'b'
].join('/');
const MEDIA_EXT = {
  video: new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v']),
  image: new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic']),
  audio: new Set(['.m4a', '.mp3', '.opus', '.ogg', '.aac', '.wav'])
};

function kindOfFile(file) {
  const ext = path.extname(file).toLowerCase();
  return Object.keys(MEDIA_EXT).find((kind) => MEDIA_EXT[kind].has(ext)) || null;
}

// Downloads a TikTok/Instagram/YouTube/... post (video, or every photo of a carousel) with yt-dlp.
// `use` gets { title, uploader, files: [{ path, kind, mimetype, size }] }; the folder is always removed afterwards.
export async function withSocialDownload(tools, url, { audioOnly = false, run = runTool, ytdlp = {} } = {}, use) {
  await ensureYtdlp(tools, ytdlp);
  const dir = makeTempPath('sosmed-dl');
  await fs.mkdir(dir, { recursive: true });
  try {
    const args = [
      '--no-progress', '--no-warnings', '--no-mtime',
      '--socket-timeout', '20',
      '--max-filesize', `${Math.floor(SOCIAL_DOWNLOAD_MAX_BYTES / 1024 / 1024)}M`,
      '--playlist-items', '1-10',
      '-f', audioOnly ? 'ba[ext=m4a]/ba/b' : VIDEO_FORMAT,
      '--merge-output-format', 'mp4',
      '--no-simulate', '--print', 'before_dl:%(uploader|)s\t%(title|)s',
      '-o', path.join(dir, '%(autonumber)02d.%(ext)s')
    ];
    if (tools.ffmpeg) args.push('--ffmpeg-location', tools.ffmpeg);
    args.push('--', url);
    let stdout = '';
    try {
      ({ stdout } = await run(tools.ytdlp, args, { timeout: 4 * 60_000, cwd: dir }));
    } catch (error) {
      throw new UserInputError(describeFailure(error));
    }
    const names = (await fs.readdir(dir)).filter((name) => kindOfFile(name)).sort();
    const files = [];
    for (const name of names) {
      const file = path.join(dir, name);
      const { size } = await fs.stat(file);
      if (size > SOCIAL_DOWNLOAD_MAX_BYTES) continue;
      files.push({ path: file, kind: kindOfFile(name), mimetype: mime.lookup(file) || 'application/octet-stream', size });
    }
    if (!files.length) throw new UserInputError(names.length ? 'File-nya terlalu besar untuk dikirim lewat WhatsApp (maks 64 MB).' : 'Tidak ada video/foto yang bisa diambil dari link ini.');
    const [uploader = '', title = ''] = String(stdout).split('\n').find((row) => row.includes('\t'))?.split('\t') || [];
    return await use({ title: title.trim(), uploader: uploader.trim(), files });
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  }
}
