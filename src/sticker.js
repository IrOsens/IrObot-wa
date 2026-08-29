import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parse as parseEmoji } from '@twemoji/parser';
import sharp from 'sharp';
import webp from 'node-webpmux';
import { TEMP_DIR, makeTempPath } from './config.js';
import { cleanupFiles, isLikelyAnimated } from './media.js';
import { runTool } from './tools.js';

const require = createRequire(import.meta.url);
const TWEMOJI_SVG_DIR = path.dirname(require.resolve('@twemoji/svg/package.json'));
const GRAPHEME_SEGMENTER = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('und', { granularity: 'grapheme' })
  : null;
const emojiSvgCache = new Map();

//edit smeme
export const SMEME_STYLE = {
  baseSize: 512,
  minCanvasSize: 64,
  maxDurationSeconds: 10,
  fps: 15,
  fontFamily: 'Impact, Arial Black, Noto Color Emoji, Segoe UI Emoji, Apple Color Emoji, sans-serif',
  fontScale: 0.12,
  minFontSize: 18,
  fillColor: '#ffffff',
  strokeColor: '#000000',
  strokeScale: 0.012,
  minStrokeWidth: 2,
  fontWeight: 900,
  paddingScale: 0.045,
  maxTextBlockScale: 0.34,
  maxLines: 6,
  characterWidthScale: 0.58,
  spaceWidthScale: 0.35,
  emojiScale: 1.08,
  lineHeight: 1.05,
  letterSpacing: 0,
  webpQuality: 90
};

const STICKER_MAX_BYTES = 950 * 1024;
const STATIC_STICKER_FALLBACKS = [
  { canvas: 512, quality: 95 },
  { canvas: 512, quality: 90 },
  { canvas: 448, quality: 82 },
  { canvas: 384, quality: 74 }
];
const ANIMATED_STICKER_FALLBACKS = [
  { canvas: 512, quality: 88, fps: 15, durationSeconds: 10 },
  { canvas: 512, quality: 76, fps: 12, durationSeconds: 8 },
  { canvas: 448, quality: 68, fps: 10, durationSeconds: 6 },
  { canvas: 384, quality: 60, fps: 8, durationSeconds: 5 },
  { canvas: 320, quality: 52, fps: 8, durationSeconds: 4 }
];

function buildStickerExif(author, title) {
  const json = Buffer.from(JSON.stringify({
    'sticker-pack-id': 'com.iro.wabot',
    'sticker-pack-name': title,
    'sticker-pack-publisher': author,
    emojis: [':3']
  }), 'utf8');
  const header = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x16, 0x00, 0x00, 0x00
  ]);
  header.writeUIntLE(json.length, 14, 4);
  return Buffer.concat([header, json]);
}

async function attachExif(inputPath, author, title) {
  const outPath = makeTempPath('sticker-exif', '.webp');
  const img = new webp.Image();
  await img.load(inputPath);
  img.exif = buildStickerExif(author, title);
  await img.save(outPath);
  return outPath;
}

export async function makeSticker(media, { author, title, tools, quality = 100 }) {
  const animated = await isAnimatedMedia(media);
  const presets = stickerPresets(animated, quality);
  let smallestOversize = Infinity;
  let lastError = null;

  for (const preset of presets) {
    const temp = [];
    try {
      const rawSticker = makeTempPath('sticker', '.webp');
      temp.push(rawSticker);
      if (animated) await renderAnimatedStickerWebp(media, rawSticker, tools, preset);
      else await renderStaticStickerWebp(media, rawSticker, preset);

      const withExif = await attachExif(rawSticker, author, title);
      temp.push(withExif);
      const sticker = await fs.readFile(withExif);
      if (sticker.length <= STICKER_MAX_BYTES) return sticker;
      smallestOversize = Math.min(smallestOversize, sticker.length);
    } catch (error) {
      lastError = error;
    } finally {
      await cleanupFiles(temp);
    }
  }

  if (Number.isFinite(smallestOversize)) {
    throw new Error(`Sticker hasil konversi masih terlalu besar (${formatStickerBytes(smallestOversize)}). Coba URL/media yang lebih pendek atau lebih kecil.`);
  }
  throw lastError || new Error('Sticker gagal dibuat.');
}

async function renderStaticStickerWebp(media, outPath, preset) {
  const image = sharp(media.path, { animated: false })
    .resize(preset.canvas, preset.canvas, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    });
  await image
    .webp(preset.lossless
      ? { lossless: true, effort: 6 }
      : { quality: preset.quality, alphaQuality: 100, effort: 6 })
    .toFile(outPath);
}

async function renderAnimatedStickerWebp(media, outPath, tools, preset) {
  if (await isAnimatedWebpMedia(media)) {
    await animatedWebpToStickerWebp(media.path, outPath, {
      canvas: preset.canvas,
      quality: preset.quality,
      lossless: preset.lossless,
      maxDurationMs: preset.durationSeconds * 1000
    });
    return;
  }

  if (!tools.ffmpeg) throw new Error('FFmpeg belum tersedia. Install FFmpeg untuk membuat sticker bergerak.');
  const encodeArgs = preset.lossless
    ? ['-lossless', '1']
    : ['-quality', String(preset.quality)];
  await runTool(tools.ffmpeg, [
    '-y',
    '-i', media.path,
    '-t', String(preset.durationSeconds),
    '-vf', `fps=${preset.fps},scale=${preset.canvas}:${preset.canvas}:force_original_aspect_ratio=decrease,pad=${preset.canvas}:${preset.canvas}:-1:-1:color=0x00000000,format=rgba`,
    '-loop', '0',
    '-an',
    '-fps_mode', 'passthrough',
    '-c:v', 'libwebp_anim',
    '-pix_fmt', 'yuva420p',
    ...encodeArgs,
    outPath
  ]);
}

function stickerPresets(animated, requestedQuality) {
  const quality = normalizeStickerQuality(requestedQuality);
  const primary = animated
    ? { canvas: 512, quality, fps: 15, durationSeconds: 10, lossless: quality === 100 }
    : { canvas: 512, quality, lossless: quality === 100 };
  const fallbacks = animated ? ANIMATED_STICKER_FALLBACKS : STATIC_STICKER_FALLBACKS;
  const presets = [primary];
  for (const fallback of fallbacks) {
    const preset = {
      ...fallback,
      quality: Math.min(quality, fallback.quality),
      lossless: false
    };
    const duplicate = presets.some((item) => item.canvas === preset.canvas
      && item.quality === preset.quality
      && item.fps === preset.fps
      && item.durationSeconds === preset.durationSeconds
      && item.lossless === preset.lossless);
    if (!duplicate) presets.push(preset);
  }
  return presets;
}

function normalizeStickerQuality(value) {
  const quality = Number(value);
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw new Error('Kualitas sticker harus angka 1-100.');
  }
  return quality;
}

function formatStickerBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

export function parseSmemeArgs(args) {
  const [positionRaw, ...rest] = args;
  const position = String(positionRaw || '').toLowerCase();
  if (!['up', 'down'].includes(position)) {
    throw new Error('Format: ,smeme up/down <teks> [1-99]');
  }

  const tail = [...rest];
  let quality = 99;
  const maybeQuality = tail.at(-1);
  if (/^\d+$/.test(maybeQuality || '')) {
    quality = Number(tail.pop());
    if (!Number.isInteger(quality) || quality < 1 || quality > 99) {
      throw new Error('Kualitas smeme harus angka 1-99.');
    }
  }

  const text = tail.join(' ').trim();
  if (!text) throw new Error('Teks smeme wajib diisi.');
  return {
    position,
    text,
    quality,
    canvasSize: smemeCanvasSize(quality)
  };
}

export async function makeSmemeSticker(media, { author, title, tools, smeme }) {
  if (!smeme) throw new Error('Argumen smeme tidak valid.');
  const animated = await isAnimatedMedia(media);
  return animated
    ? makeAnimatedSmemeSticker(media, { author, title, tools, smeme })
    : makeStaticSmemeSticker(media, { author, title, smeme });
}

async function makeStaticSmemeSticker(media, { author, title, smeme }) {
  const temp = [];
  try {
    const rawSticker = makeTempPath('smeme', '.webp');
    temp.push(rawSticker);
    const canvas = smeme.canvasSize;
    const overlay = await makeSmemeOverlaySvg(smeme.text, smeme.position, canvas);
    await sharp(media.path, { animated: false })
      .resize(canvas, canvas, { fit: 'inside', withoutEnlargement: true })
      .extend(await transparentExtendOptions(media.path, canvas))
      .composite([{ input: overlay, top: 0, left: 0 }])
      .webp({ quality: SMEME_STYLE.webpQuality })
      .toFile(rawSticker);

    const withExif = await attachExif(rawSticker, author, title);
    temp.push(withExif);
    return await fs.readFile(withExif);
  } finally {
    await cleanupFiles(temp);
  }
}

async function makeAnimatedSmemeSticker(media, { author, title, tools, smeme }) {
  const tempDir = await fs.mkdtemp(path.join(TEMP_DIR, 'smeme-frames-'));
  const framePaths = [];
  const overlayPaths = [];
  const temp = [];
  try {
    const canvas = smeme.canvasSize;
    const overlay = await makeSmemeOverlaySvg(smeme.text, smeme.position, canvas);
    if (await isAnimatedWebpMedia(media)) {
      const rawSticker = makeTempPath('smeme', '.webp');
      temp.push(rawSticker);
      await animatedWebpToStickerWebp(media.path, rawSticker, {
        canvas,
        overlay,
        quality: SMEME_STYLE.webpQuality
      });

      const withExif = await attachExif(rawSticker, author, title);
      temp.push(withExif);
      return await fs.readFile(withExif);
    }

    if (!tools.ffmpeg) throw new Error('FFmpeg belum tersedia. Smeme bergerak butuh FFmpeg.');
    await runTool(tools.ffmpeg, [
      '-y',
      '-i', media.path,
      '-t', String(SMEME_STYLE.maxDurationSeconds),
      '-vf', `fps=${SMEME_STYLE.fps},scale=${canvas}:${canvas}:force_original_aspect_ratio=decrease,pad=${canvas}:${canvas}:-1:-1:color=0x00000000`,
      path.join(tempDir, 'frame-%04d.png')
    ]);

    const entries = (await fs.readdir(tempDir))
      .filter((name) => /^frame-\d+\.png$/.test(name))
      .sort();
    if (!entries.length) throw new Error('Frame smeme bergerak tidak ditemukan.');

    for (const name of entries) {
      const source = path.join(tempDir, name);
      const out = path.join(tempDir, name.replace('frame-', 'overlay-'));
      framePaths.push(source);
      overlayPaths.push(out);
      await sharp(source)
        .composite([{ input: overlay, top: 0, left: 0 }])
        .png()
        .toFile(out);
    }

    const rawSticker = makeTempPath('smeme', '.webp');
    temp.push(rawSticker);
    await runTool(tools.ffmpeg, [
      '-y',
      '-framerate', String(SMEME_STYLE.fps),
      '-i', path.join(tempDir, 'overlay-%04d.png'),
      '-loop', '0',
      '-an',
      '-q:v', String(Math.max(1, 100 - SMEME_STYLE.webpQuality)),
      rawSticker
    ]);

    const withExif = await attachExif(rawSticker, author, title);
    temp.push(withExif);
    return await fs.readFile(withExif);
  } finally {
    await cleanupFiles([...framePaths, ...overlayPaths, ...temp]);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function reverseSticker(media, tools) {
  const animated = await isAnimatedMedia(media);
  const outPath = makeTempPath('reverse-sticker', animated && tools.ffmpeg ? '.mp4' : animated ? '.gif' : '.png');
  try {
    if (animated) {
      if (tools.ffmpeg) {
        await animatedWebpToGifPlaybackVideo(media.path, outPath, tools);
        return {
          buffer: await fs.readFile(outPath),
          mimetype: 'video/mp4',
          fileName: 'sticker.mp4',
          gifPlayback: true
        };
      }
      await animatedWebpToGif(media.path, outPath, tools);
      return {
        buffer: await fs.readFile(outPath),
        mimetype: 'image/gif',
        fileName: 'sticker.gif'
      };
    }
    await sharp(media.path, { animated: false }).png().toFile(outPath);
    return {
      buffer: await fs.readFile(outPath),
      mimetype: 'image/png',
      fileName: 'sticker.png'
    };
  } finally {
    await cleanupFiles([outPath]);
  }
}

export async function isAnimatedMedia(media) {
  if (media?.node?.isAnimated) return true;
  if (isLikelyAnimated({ mimetype: media?.mimetype, fileName: media?.fileName || media?.path })) return true;
  if (!isWebpMedia(media)) return false;
  return isAnimatedWebpPath(media.path);
}

async function isAnimatedWebpMedia(media) {
  return isWebpMedia(media) && await isAnimatedWebpPath(media.path);
}

function smemeCanvasSize(quality) {
  return Math.max(SMEME_STYLE.minCanvasSize, Math.round(SMEME_STYLE.baseSize * (quality / 99)));
}

async function transparentExtendOptions(inputPath, canvas) {
  const metadata = await sharp(inputPath, { animated: false }).metadata();
  const ratio = Math.min(canvas / (metadata.width || canvas), canvas / (metadata.height || canvas), 1);
  const width = Math.round((metadata.width || canvas) * ratio);
  const height = Math.round((metadata.height || canvas) * ratio);
  return {
    top: Math.floor((canvas - height) / 2),
    bottom: Math.ceil((canvas - height) / 2),
    left: Math.floor((canvas - width) / 2),
    right: Math.ceil((canvas - width) / 2),
    background: { r: 0, g: 0, b: 0, alpha: 0 }
  };
}

export async function makeSmemeOverlaySvg(text, position, canvas) {
  const padding = Math.max(4, Math.round(canvas * SMEME_STYLE.paddingScale));
  const layout = layoutSmemeText(text, canvas, padding);
  const { lines, fontSize, lineHeight } = layout;
  const strokeWidth = Math.max(SMEME_STYLE.minStrokeWidth, Math.round(canvas * SMEME_STYLE.strokeScale));
  const blockHeight = lineHeight * lines.length;
  const firstBaseline = position === 'up'
    ? padding + fontSize
    : canvas - padding - blockHeight + fontSize;
  const lineElements = [];
  for (const [index, line] of lines.entries()) {
    lineElements.push(await renderSmemeLineSvg(line, firstBaseline + index * lineHeight, canvas, fontSize, padding));
  }

  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg width="${canvas}" height="${canvas}" viewBox="0 0 ${canvas} ${canvas}" xmlns="http://www.w3.org/2000/svg">
  <style>
    .smeme-text {
      font-family: ${SMEME_STYLE.fontFamily};
      font-size: ${fontSize}px;
      font-weight: ${SMEME_STYLE.fontWeight};
      letter-spacing: ${SMEME_STYLE.letterSpacing}px;
      fill: ${SMEME_STYLE.fillColor};
      stroke: ${SMEME_STYLE.strokeColor};
      stroke-width: ${strokeWidth}px;
      paint-order: stroke fill;
      stroke-linejoin: round;
      text-anchor: start;
    }
  </style>
  ${lineElements.join('\n  ')}
</svg>`);
}

function layoutSmemeText(text, canvas, padding) {
  const baseFontSize = Math.max(SMEME_STYLE.minFontSize, Math.round(canvas * SMEME_STYLE.fontScale));
  const maxWidth = Math.max(1, canvas - padding * 2);
  const maxBlockHeight = Math.max(
    SMEME_STYLE.minFontSize,
    Math.round(canvas * SMEME_STYLE.maxTextBlockScale)
  );

  for (let size = baseFontSize; size >= SMEME_STYLE.minFontSize; size -= 1) {
    const lineHeight = Math.max(1, Math.round(size * SMEME_STYLE.lineHeight));
    const maxLines = Math.max(1, Math.min(SMEME_STYLE.maxLines, Math.floor(maxBlockHeight / lineHeight)));
    const lines = wrapSmemeTextToWidth(text, maxWidth, size, maxLines);
    if (lines.length <= maxLines && lines.every((line) => measureSmemeLine(line, size) <= maxWidth)) {
      return { lines, fontSize: size, lineHeight };
    }
  }

  const lineHeight = Math.max(1, Math.round(SMEME_STYLE.minFontSize * SMEME_STYLE.lineHeight));
  const maxLines = Math.max(1, Math.min(SMEME_STYLE.maxLines, Math.floor(maxBlockHeight / lineHeight)));
  return {
    lines: wrapSmemeTextToWidth(text, maxWidth, SMEME_STYLE.minFontSize, maxLines, true),
    fontSize: SMEME_STYLE.minFontSize,
    lineHeight
  };
}

async function renderSmemeLineSvg(line, baseline, canvas, fontSize, padding) {
  const runs = splitSmemeTextRuns(line);
  const widths = runs.map((run) => measureSmemeRun(run, fontSize));
  const totalWidth = widths.reduce((sum, width) => sum + width, 0);
  let x = Math.max(padding, (canvas - totalWidth) / 2);
  const elements = [];

  for (const [index, run] of runs.entries()) {
    const width = widths[index];
    if (run.type === 'emoji') {
      const emojiSize = Math.round(fontSize * 1.08);
      const emoji = await readTwemojiSvg(run.codepoint);
      if (emoji) {
        elements.push(renderInlineEmojiSvg(emoji, x, baseline - emojiSize * 0.86, emojiSize));
      } else {
        elements.push(renderTextSvg(run.text, x, baseline, false));
      }
    } else if (run.text) {
      elements.push(renderTextSvg(run.text, x, baseline, true));
    }
    x += width;
  }

  return `<g>${elements.join('')}</g>`;
}

function renderTextSvg(text, x, baseline, uppercase) {
  const renderedText = uppercase ? String(text).toUpperCase() : String(text);
  return `<text class="smeme-text" x="${svgNumber(x)}" y="${svgNumber(baseline)}" xml:space="preserve">${escapeSvg(renderedText)}</text>`;
}

function renderInlineEmojiSvg(emoji, x, y, size) {
  return `<svg class="smeme-emoji" x="${svgNumber(x)}" y="${svgNumber(y)}" width="${svgNumber(size)}" height="${svgNumber(size)}" viewBox="${escapeSvgAttribute(emoji.viewBox)}" overflow="visible">${emoji.body}</svg>`;
}

export function splitSmemeTextRuns(text) {
  const value = String(text || '');
  const entities = parseEmoji(value).sort((a, b) => a.indices[0] - b.indices[0]);
  const runs = [];
  let offset = 0;

  for (const entity of entities) {
    const [start, end] = entity.indices;
    if (start > offset) runs.push({ type: 'text', text: value.slice(offset, start) });
    runs.push({
      type: 'emoji',
      text: entity.text,
      codepoint: emojiCodepointFromEntity(entity)
    });
    offset = Math.max(offset, end);
  }

  if (offset < value.length) runs.push({ type: 'text', text: value.slice(offset) });
  return runs.filter((run) => run.text);
}

function measureSmemeRun(run, fontSize) {
  if (run.type === 'emoji') return fontSize * SMEME_STYLE.emojiScale;
  return graphemes(run.text).reduce((width, char) => (
    width + (/^\s+$/.test(char) ? fontSize * SMEME_STYLE.spaceWidthScale : fontSize * SMEME_STYLE.characterWidthScale)
  ), 0);
}

function measureSmemeLine(line, fontSize) {
  return splitSmemeTextRuns(line).reduce((width, run) => width + measureSmemeRun(run, fontSize), 0);
}

function wrapSmemeTextToWidth(text, maxWidth, fontSize, maxLines, forceTruncate = false) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (measureSmemeLine(next, fontSize) <= maxWidth) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    if (lines.length >= maxLines) return trimSmemeLines(lines, maxLines, fontSize, maxWidth);
    if (measureSmemeLine(word, fontSize) <= maxWidth) {
      current = word;
    } else {
      const parts = splitLongSmemeWord(word, maxWidth, fontSize);
      while (parts.length) {
        lines.push(parts.shift());
        if (lines.length >= maxLines) return trimSmemeLines(lines, maxLines, fontSize, maxWidth);
      }
      current = '';
    }
  }

  if (current) lines.push(current);
  const result = lines.length ? lines : [''];
  if (forceTruncate && result.length > maxLines) return trimSmemeLines(result, maxLines, fontSize, maxWidth);
  return result.slice(0, maxLines);
}

function splitLongSmemeWord(word, maxWidth, fontSize) {
  const chars = graphemes(word);
  const parts = [];
  let current = '';
  for (const char of chars) {
    const next = `${current}${char}`;
    if (!current || measureSmemeLine(next, fontSize) <= maxWidth) {
      current = next;
    } else {
      parts.push(current);
      current = char;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function trimSmemeLines(lines, maxLines, fontSize, maxWidth) {
  const result = lines.slice(0, maxLines);
  if (!result.length) return [''];
  let last = result.at(-1);
  while (last && measureSmemeLine(`${last}...`, fontSize) > maxWidth) {
    last = graphemes(last).slice(0, -1).join('');
  }
  result[result.length - 1] = `${last || ''}...`;
  return result;
}

function wrapSmemeText(text, maxChars) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (graphemes(next).length <= maxChars) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    if (graphemes(word).length <= maxChars) {
      current = word;
    } else {
      const chars = graphemes(word);
      while (chars.length) lines.push(chars.splice(0, maxChars).join(''));
      current = '';
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

function graphemes(value) {
  const text = String(value || '');
  if (GRAPHEME_SEGMENTER) return [...GRAPHEME_SEGMENTER.segment(text)].map((item) => item.segment);
  return Array.from(text);
}

function emojiCodepointFromEntity(entity) {
  try {
    return path.basename(new URL(entity.url).pathname, '.svg').toLowerCase();
  } catch {
    return Array.from(entity.text || '')
      .map((char) => char.codePointAt(0).toString(16))
      .join('-');
  }
}

async function readTwemojiSvg(codepoint) {
  const key = String(codepoint || '').toLowerCase();
  if (!key) return null;
  if (emojiSvgCache.has(key)) return emojiSvgCache.get(key);

  try {
    const svg = await fs.readFile(path.join(TWEMOJI_SVG_DIR, `${key}.svg`), 'utf8');
    const parsed = extractInlineSvgData(svg);
    emojiSvgCache.set(key, parsed);
    return parsed;
  } catch {
    emojiSvgCache.set(key, null);
    return null;
  }
}

function extractInlineSvgData(svg) {
  const match = String(svg || '').match(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/i);
  if (!match) return null;
  return {
    viewBox: svgAttribute(match[1], 'viewBox') || '0 0 36 36',
    body: match[2].trim()
  };
}

function svgAttribute(attrs, name) {
  const match = String(attrs || '').match(new RegExp(`\\b${name}\\s*=\\s*(['"])(.*?)\\1`, 'i'));
  return match ? match[2] : '';
}

function escapeSvg(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeSvgAttribute(value) {
  return escapeSvg(value).replace(/'/g, '&apos;');
}

function svgNumber(value) {
  return String(Math.round(Number(value) * 100) / 100);
}

async function isAnimatedWebpPath(filePath) {
  if (!filePath) return false;
  try {
    const buffer = await fs.readFile(filePath);
    if (buffer.includes(Buffer.from('ANIM')) || buffer.includes(Buffer.from('ANMF'))) return true;
  } catch {
    return false;
  }

  try {
    const image = new webp.Image();
    await image.load(filePath);
    const frames = await image.demux({ buffers: false });
    return Array.isArray(frames) && frames.length > 1;
  } catch {
    return false;
  }
}

function isWebpMedia(media) {
  return /webp/i.test(media?.mimetype || '') || /\.webp$/i.test(media?.fileName || media?.path || '');
}

async function animatedWebpToStickerWebp(inputPath, outPath, {
  canvas,
  overlay = null,
  quality = 90,
  lossless = false,
  maxDurationMs = SMEME_STYLE.maxDurationSeconds * 1000
}) {
  const decoded = await decodeAnimatedWebpFrames(inputPath, {
    maxDurationMs
  });
  const frames = [];
  for (const frame of decoded.frames) {
    let image = sharp(frame.data, {
      raw: {
        width: decoded.width,
        height: decoded.height,
        channels: 4
      }
    }).resize(canvas, canvas, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    });
    if (overlay) image = image.composite([{ input: overlay, top: 0, left: 0 }]);
    const buffer = await image.webp(lossless
      ? { lossless: true, effort: 6 }
      : { quality, alphaQuality: 100, effort: 6 }).toBuffer();
    frames.push(await webp.Image.generateFrame({
      buffer,
      delay: frame.delay,
      x: 0,
      y: 0,
      blend: false,
      dispose: false
    }));
  }
  if (!frames.length) throw new Error('Frame sticker bergerak tidak ditemukan.');
  await webp.Image.save(outPath, {
    width: canvas,
    height: canvas,
    frames,
    bgColor: [0, 0, 0, 0],
    loops: 0
  });
}

async function decodeAnimatedWebpFrames(inputPath, { maxDurationMs = 10_000 } = {}) {
  const image = new webp.Image();
  await image.load(inputPath);
  if (!image.hasAnim || !image.frames?.length) throw new Error('Frame sticker bergerak tidak ditemukan.');
  await webp.Image.initLib();

  const width = image.width;
  const height = image.height;
  let canvas = Buffer.alloc(width * height * 4);
  const frames = [];
  let elapsed = 0;

  for (const [index, frame] of image.frames.entries()) {
    const remaining = maxDurationMs - elapsed;
    if (remaining <= 0) break;
    const delay = Math.min(normalizeFrameDelay(frame.delay), remaining);
    const base = Buffer.from(canvas);
    const x = Math.max(0, Number(frame.x) || 0);
    const y = Math.max(0, Number(frame.y) || 0);
    const frameWidth = Number(frame.width) || width;
    const frameHeight = Number(frame.height) || height;
    if (frame.blend === false) clearRawRect(base, width, height, x, y, frameWidth, frameHeight);

    const frameData = Buffer.from(await image.getFrameData(index));
    const composited = await sharp(base, { raw: { width, height, channels: 4 } })
      .composite([{
        input: frameData,
        raw: { width: frameWidth, height: frameHeight, channels: 4 },
        left: x,
        top: y
      }])
      .raw()
      .toBuffer();

    frames.push({ data: Buffer.from(composited), delay });
    elapsed += delay;
    canvas = Buffer.from(composited);
    if (frame.dispose) clearRawRect(canvas, width, height, x, y, frameWidth, frameHeight);
  }

  return { width, height, frames };
}

function normalizeFrameDelay(delay) {
  const value = Number(delay);
  if (Number.isFinite(value) && value > 0) return Math.max(20, Math.round(value));
  return Math.round(1000 / SMEME_STYLE.fps);
}

function clearRawRect(buffer, canvasWidth, canvasHeight, x, y, width, height) {
  const left = Math.max(0, Math.min(canvasWidth, Math.round(x)));
  const top = Math.max(0, Math.min(canvasHeight, Math.round(y)));
  const right = Math.max(left, Math.min(canvasWidth, Math.round(x + width)));
  const bottom = Math.max(top, Math.min(canvasHeight, Math.round(y + height)));
  for (let row = top; row < bottom; row += 1) {
    buffer.fill(0, (row * canvasWidth + left) * 4, (row * canvasWidth + right) * 4);
  }
}

async function animatedWebpToGifPlaybackVideo(inputPath, outPath, tools) {
  const tempDir = await fs.mkdtemp(path.join(TEMP_DIR, 'reverse-video-frames-'));
  const framePaths = [];
  const listPath = path.join(tempDir, 'frames.txt');
  try {
    const decoded = await decodeAnimatedWebpFrames(inputPath, {
      maxDurationMs: SMEME_STYLE.maxDurationSeconds * 1000
    });
    for (const [index, frame] of decoded.frames.entries()) {
      const framePath = path.join(tempDir, `frame-${String(index).padStart(4, '0')}.png`);
      framePaths.push(framePath);
      await sharp(frame.data, {
        raw: {
          width: decoded.width,
          height: decoded.height,
          channels: 4
        }
      })
        .png()
        .toFile(framePath);
    }
    if (!framePaths.length) throw new Error('Frame sticker bergerak tidak ditemukan.');
    const lines = [];
    for (const [index, framePath] of framePaths.entries()) {
      lines.push(ffmpegConcatFileLine(framePath));
      lines.push(`duration ${(decoded.frames[index].delay / 1000).toFixed(3)}`);
    }
    lines.push(ffmpegConcatFileLine(framePaths.at(-1)));
    await fs.writeFile(listPath, `${lines.join('\n')}\n`);
    await runTool(tools.ffmpeg, [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
      '-fps_mode', 'vfr',
      '-movflags', '+faststart',
      '-an',
      outPath
    ]);
  } finally {
    await cleanupFiles(framePaths);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function ffmpegConcatFileLine(filePath) {
  return `file '${String(filePath).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
}

async function animatedWebpToGif(inputPath, outPath, tools) {
  try {
    await sharp(inputPath, { animated: true, pages: -1 })
      .gif({ loop: 0 })
      .toFile(outPath);
    return;
  } catch (error) {
    if (!tools.ffmpeg) {
      throw new Error(`Gagal membaca sticker bergerak dan FFmpeg tidak tersedia untuk fallback: ${error.message}`);
    }
  }

  const tempDir = await fs.mkdtemp(path.join(TEMP_DIR, 'reverse-frames-'));
  const framePaths = [];
  try {
    const image = new webp.Image();
    await image.load(inputPath);
    const frames = await image.demux({ buffers: true });
    if (!frames?.length) throw new Error('Frame sticker bergerak tidak ditemukan.');

    for (const [index, frame] of frames.entries()) {
      const framePath = path.join(tempDir, `frame-${String(index).padStart(4, '0')}.png`);
      framePaths.push(framePath);
      await sharp(frame).png().toFile(framePath);
    }

    await runTool(tools.ffmpeg, [
      '-y',
      '-framerate', '15',
      '-i', path.join(tempDir, 'frame-%04d.png'),
      '-loop', '0',
      outPath
    ]);
  } finally {
    await cleanupFiles(framePaths);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function parseStickerMeta(input, options = {}) {
  const defaultAuthor = options.defaultAuthor || 'IrO';
  const defaultTitle = options.defaultTitle || ':3';
  const text = (Array.isArray(input) ? input.join(' ') : String(input || ''))
    .replace(/https?:\/\/[^\s"'<>]+/gi, '')
    .trim();
  if (!text) return { author: defaultAuthor, title: defaultTitle };

  const [titleRaw, ...authorParts] = text.split(',');
  const title = titleRaw.trim() || defaultTitle;
  const author = authorParts.join(',').trim() || defaultAuthor;
  return { author, title };
}

export function parseStickerArgs(input, options = {}) {
  const raw = Array.isArray(input) ? input.join(' ') : String(input || '');
  const qualityTokens = raw.match(/(?:^|\s)q=\S+(?=\s|$)/gi) || [];
  if (qualityTokens.length > 1) throw new Error('Parameter kualitas sticker hanya boleh satu kali.');

  let quality = 100;
  if (qualityTokens.length) {
    const value = qualityTokens[0].trim().slice(2);
    if (!/^\d+$/.test(value)) throw new Error('Kualitas sticker harus memakai format q=1-100.');
    quality = normalizeStickerQuality(value);
  }

  const metaInput = raw.replace(/(?:^|\s)q=\S+(?=\s|$)/gi, ' ').trim();
  return {
    ...parseStickerMeta(metaInput, options),
    quality
  };
}
