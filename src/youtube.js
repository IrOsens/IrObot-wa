import fs from 'node:fs/promises';
import path from 'node:path';
import { TEMP_DIR, makeTempPath } from './config.js';
import { cleanupFiles } from './media.js';
import { runTool } from './tools.js';

const QUALITIES = new Set(['360', '480', '720', '1080']);
const YOUTUBE_FALLBACK_EXTRACTOR_ARGS = 'youtube:player_client=default,mweb,web_embedded';

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
    '--no-cache-dir',
    '--restrict-filenames',
    '--windows-filenames',
    '-o', outputTemplate
  ];

  const attempts = buildDownloadAttempts(parsed, baseArgs);
  let lastError = null;
  for (const attempt of attempts) {
    try {
      await runTool(tools.ytDlp, attempt.args, { timeout: attempt.timeout });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      await cleanupPrefix(prefix);
      if (!attempt.retryable || !isRetryableYoutubeError(error)) break;
    }
  }
  if (lastError) throw friendlyYoutubeError(lastError);

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

function buildDownloadAttempts(parsed, baseArgs) {
  if (parsed.type === 'mp3') {
    return [
      {
        retryable: true,
        timeout: 10 * 60 * 1000,
        args: [...baseArgs, '-x', '--audio-format', 'mp3', '--audio-quality', '0', parsed.url]
      },
      {
        retryable: false,
        timeout: 10 * 60 * 1000,
        args: [
          ...baseArgs,
          '--extractor-args', YOUTUBE_FALLBACK_EXTRACTOR_ARGS,
          '-x',
          '--audio-format', 'mp3',
          '--audio-quality', '0',
          parsed.url
        ]
      }
    ];
  }

  const primaryFormat = `bestvideo[height<=${parsed.quality}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${parsed.quality}][ext=mp4]/best[height<=${parsed.quality}]`;
  const fallbackFormat = `bv*[height<=${parsed.quality}]+ba/b[height<=${parsed.quality}]/b`;
  return [
    {
      retryable: true,
      timeout: 15 * 60 * 1000,
      args: [...baseArgs, '-f', primaryFormat, '--merge-output-format', 'mp4', parsed.url]
    },
    {
      retryable: false,
      timeout: 15 * 60 * 1000,
      args: [
        ...baseArgs,
        '--extractor-args', YOUTUBE_FALLBACK_EXTRACTOR_ARGS,
        '-f', fallbackFormat,
        '--merge-output-format', 'mp4',
        '--remux-video', 'mp4',
        parsed.url
      ]
    }
  ];
}

async function cleanupPrefix(prefix) {
  const entries = await fs.readdir(TEMP_DIR).catch(() => []);
  const matches = entries
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(TEMP_DIR, name));
  await cleanupFiles(matches);
}

function isRetryableYoutubeError(error) {
  const text = `${error?.stderr || ''}\n${error?.stdout || ''}\n${error?.message || ''}`;
  return /Precondition check failed|HTTP Error 403|HTTP Error 400|nsig extraction failed|Unable to download API page/i.test(text);
}

function friendlyYoutubeError(error) {
  const text = `${error?.stderr || ''}\n${error?.stdout || ''}\n${error?.message || ''}`;
  if (isRetryableYoutubeError(error)) {
    return new Error([
      'YouTube menolak download dari yt-dlp saat ini.',
      'Coba update yt-dlp ke versi terbaru. Jika tetap gagal, video ini mungkin butuh cookies browser atau PO token YouTube.',
      lastUsefulLine(text)
    ].filter(Boolean).join('\n'));
  }
  return error;
}

function lastUsefulLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /ERROR|WARNING|HTTP Error|Precondition|Forbidden|nsig/i.test(line))
    .at(-1);
}
