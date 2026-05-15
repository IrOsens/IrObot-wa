import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import webp from 'node-webpmux';
import { TEMP_DIR, makeTempPath } from './config.js';
import { cleanupFiles, isLikelyAnimated } from './media.js';
import { runTool } from './tools.js';

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
  lineHeight: 1.05,
  letterSpacing: 0,
  webpQuality: 90
};

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

export async function makeSticker(media, { author, title, tools }) {
  const temp = [];
  try {
    const rawSticker = makeTempPath('sticker', '.webp');
    temp.push(rawSticker);
    if (isLikelyAnimated({ mimetype: media.mimetype, fileName: media.fileName || media.path })) {
      if (!tools.ffmpeg) throw new Error('FFmpeg belum tersedia. Install FFmpeg untuk membuat sticker bergerak.');
      await runTool(tools.ffmpeg, [
        '-y',
        '-i', media.path,
        '-t', '10',
        '-vf', 'fps=15,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:-1:-1:color=0x00000000',
        '-loop', '0',
        '-an',
        '-vsync', '0',
        rawSticker
      ]);
    } else {
      await sharp(media.path, { animated: false })
        .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 90 })
        .toFile(rawSticker);
    }

    const withExif = await attachExif(rawSticker, author, title);
    temp.push(withExif);
    return await fs.readFile(withExif);
  } finally {
    await cleanupFiles(temp);
  }
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
  const animated = media.node?.isAnimated || isLikelyAnimated({ mimetype: media.mimetype, fileName: media.fileName || media.path });
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
    const overlay = makeSmemeOverlaySvg(smeme.text, smeme.position, canvas);
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
  if (!tools.ffmpeg) throw new Error('FFmpeg belum tersedia. Smeme bergerak butuh FFmpeg.');
  const tempDir = await fs.mkdtemp(path.join(TEMP_DIR, 'smeme-frames-'));
  const framePaths = [];
  const overlayPaths = [];
  const temp = [];
  try {
    const canvas = smeme.canvasSize;
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

    const overlay = makeSmemeOverlaySvg(smeme.text, smeme.position, canvas);
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
  const animated = media.node?.isAnimated || isLikelyAnimated({ mimetype: media.mimetype, fileName: media.fileName || media.path });
  const outPath = makeTempPath('reverse-sticker', animated ? '.gif' : '.png');
  try {
    if (animated) {
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

function makeSmemeOverlaySvg(text, position, canvas) {
  const padding = Math.max(4, Math.round(canvas * SMEME_STYLE.paddingScale));
  const fontSize = Math.max(SMEME_STYLE.minFontSize, Math.round(canvas * SMEME_STYLE.fontScale));
  const strokeWidth = Math.max(SMEME_STYLE.minStrokeWidth, Math.round(canvas * SMEME_STYLE.strokeScale));
  const maxChars = Math.max(4, Math.floor((canvas - padding * 2) / (fontSize * 0.58)));
  const lines = wrapSmemeText(text, maxChars).slice(0, 4);
  const lineHeight = Math.round(fontSize * SMEME_STYLE.lineHeight);
  const blockHeight = lineHeight * lines.length;
  const firstBaseline = position === 'up'
    ? padding + fontSize
    : canvas - padding - blockHeight + fontSize;
  const tspans = lines.map((line, index) => (
    `<tspan x="50%" y="${firstBaseline + index * lineHeight}">${escapeSvg(line)}</tspan>`
  )).join('');

  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg width="${canvas}" height="${canvas}" viewBox="0 0 ${canvas} ${canvas}" xmlns="http://www.w3.org/2000/svg">
  <style>
    text {
      font-family: ${SMEME_STYLE.fontFamily};
      font-size: ${fontSize}px;
      font-weight: ${SMEME_STYLE.fontWeight};
      letter-spacing: ${SMEME_STYLE.letterSpacing}px;
      fill: ${SMEME_STYLE.fillColor};
      stroke: ${SMEME_STYLE.strokeColor};
      stroke-width: ${strokeWidth}px;
      paint-order: stroke fill;
      stroke-linejoin: round;
      text-anchor: middle;
      text-transform: uppercase;
    }
  </style>
  <text>${tspans}</text>
</svg>`);
}

function wrapSmemeText(text, maxChars) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (Array.from(next).length <= maxChars) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    if (Array.from(word).length <= maxChars) {
      current = word;
    } else {
      const chars = Array.from(word);
      while (chars.length) lines.push(chars.splice(0, maxChars).join(''));
      current = '';
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

function escapeSvg(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

export function parseStickerMeta(args) {
  if (!args.length) return { author: 'IrO', title: ':3' };
  if (args.length === 1) return { author: args[0] || 'IrO', title: ':3' };
  return {
    author: args[0] || 'IrO',
    title: args.slice(1).join(' ') || ':3'
  };
}
