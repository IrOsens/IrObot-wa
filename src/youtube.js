import fs from 'node:fs/promises';
import path from 'node:path';
import { TEMP_DIR, makeTempPath } from './config.js';
import { cleanupFiles } from './media.js';
import { runTool } from './tools.js';

const QUALITIES = new Set(['360', '480', '720', '1080']);

export function parseYoutubeArgs(args) {
  const [url, kind = 'mp4', quality = '720'] = args;
  if (!url || !/^https?:\/\/(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\//i.test(url)) {
    throw new Error('Format: ,yt <link-youtube> <mp3|mp4> [360|480|720|1080]');
  }
  const type = kind.toLowerCase();
  if (!['mp3', 'mp4'].includes(type)) throw new Error('Jenis download harus mp3 atau mp4.');
  const q = String(quality || '720');
  if (type === 'mp4' && !QUALITIES.has(q)) throw new Error('Quality video harus 360, 480, 720, atau 1080.');
  return { url, type, quality: q };
}

export async function downloadYoutube(args, tools) {
  if (!tools.ytDlp) throw new Error('yt-dlp belum tersedia. Install yt-dlp di Windows/Linux dan pastikan ada di PATH.');
  const parsed = parseYoutubeArgs(args);
  if (parsed.type === 'mp3' && !tools.ffmpeg) {
    throw new Error('FFmpeg belum tersedia. yt-dlp butuh FFmpeg untuk convert MP3.');
  }

  const prefix = path.basename(makeTempPath('yt', ''));
  const outputTemplate = path.join(TEMP_DIR, `${prefix}.%(ext)s`);
  const baseArgs = [
    '--no-playlist',
    '--restrict-filenames',
    '--windows-filenames',
    '-o', outputTemplate
  ];

  if (parsed.type === 'mp3') {
    await runTool(tools.ytDlp, [
      ...baseArgs,
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      parsed.url
    ], { timeout: 10 * 60 * 1000 });
  } else {
    await runTool(tools.ytDlp, [
      ...baseArgs,
      '-f', `bestvideo[height<=${parsed.quality}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${parsed.quality}][ext=mp4]/best[height<=${parsed.quality}]`,
      '--merge-output-format', 'mp4',
      parsed.url
    ], { timeout: 15 * 60 * 1000 });
  }

  const entries = await fs.readdir(TEMP_DIR);
  const matches = entries
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(TEMP_DIR, name));
  if (!matches.length) throw new Error('Download YouTube selesai tapi file output tidak ditemukan.');
  const sorted = await Promise.all(matches.map(async (file) => ({ file, stat: await fs.stat(file) })));
  const selected = sorted.sort((a, b) => b.stat.size - a.stat.size)[0].file;
  const cleanup = matches.filter((file) => file !== selected);
  await cleanupFiles(cleanup);

  return {
    path: selected,
    type: parsed.type,
    quality: parsed.quality,
    mimetype: parsed.type === 'mp3' ? 'audio/mpeg' : 'video/mp4',
    fileName: `youtube-${Date.now()}.${parsed.type}`
  };
}
