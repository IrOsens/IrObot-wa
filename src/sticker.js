import { UserInputError } from './errors.js';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse as parseEmoji } from '@twemoji/parser';
import sharp from 'sharp';
import webp from 'node-webpmux';
import { DEFAULT_STICKER_AUTHOR, DEFAULT_STICKER_TITLE, TEMP_DIR, makeTempPath } from './config.js';
import { cleanupFiles, isLikelyAnimated } from './media.js';
import { runTool } from './tools.js';

const require = createRequire(import.meta.url);
const TWEMOJI_SVG_DIR = path.dirname(require.resolve('@twemoji/svg/package.json'));
const GRAPHEME_SEGMENTER = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('und', { granularity: 'grapheme' })
  : null;
const emojiSvgCache = new Map();

const IMPACT_FONT = fileURLToPath(new URL('../data/fonts/impact.ttf', import.meta.url));
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

export const SMEME_STYLE = {
  baseSize: 512,
  minCanvasSize: 64,
  maxDurationSeconds: 10,
  fps: 15,
  fontScale: 0.12,
  paddingScale: 0.06,
  maxTextBlockScale: 0.34,
  maxLines: 6,
  emojiScale: 1.08,
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

export function buildStickerExif(author, title) {
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

async function readStickerTitle(input, tesseract) {
  let dir;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sticker-ocr-'));
    const framePath = path.join(dir, 'frame.png');
    await sharp(input, { page: 0, pages: 1 })
      .resize({ width: 1024, height: 1024, fit: 'inside' })
      .flatten({ background: '#b0b0b0' })
      .extend({ top: 16, bottom: 16, left: 16, right: 16, background: '#b0b0b0' })
      .png().toFile(framePath);
    for (const mode of ['11', '6']) {
      const { stdout } = await runTool(tesseract, [framePath, 'stdout', '-l', 'eng', '--psm', mode], {
        timeout: 3000, maxBuffer: 32 * 1024, env: { ...process.env, OMP_THREAD_LIMIT: '1' }
      });
      const title = stdout.replace(/\s+/g, ' ').trim();
      if (/[\p{L}\p{N}]/u.test(title)) return title;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function applyStickerMetadata(input, {
  author = DEFAULT_STICKER_AUTHOR, title, tesseract, fallbackTitle = DEFAULT_STICKER_TITLE
} = {}) {
  const detectedTitle = !title && tesseract ? await readStickerTitle(input, tesseract) : null;
  const image = new webp.Image();
  await image.load(input);
  image.exif = buildStickerExif(author, title || detectedTitle || fallbackTitle);
  return image.save(null);
}

export async function makeSticker(media, { author, title, tools, quality = 100, animated }) {
  animated ??= await isAnimatedMedia(media);
  const metadata = { author, title, tesseract: tools?.tesseract };
  if (media.type === 'stickerMessage' && isWebpMedia(media) && quality === 100) {
    const image = new webp.Image();
    await image.load(media.path);
    const duration = image.frames?.reduce((ms, frame) => ms + normalizeFrameDelay(frame.delay), 0) || 0;
    if (image.width === 512 && image.height === 512 && duration <= 10_000
        && (await fs.stat(media.path)).size <= STICKER_MAX_BYTES) {
      const sticker = await applyStickerMetadata(media.path, metadata);
      if (sticker.length <= STICKER_MAX_BYTES) return sticker;
    }
  }
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

      if (!title && metadata.tesseract) {
        const { size } = await fs.stat(rawSticker);
        if (size > STICKER_MAX_BYTES) {
          smallestOversize = Math.min(smallestOversize, size);
          continue;
        }
      }
      const sticker = await applyStickerMetadata(rawSticker, metadata);
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
    throw new UserInputError('Kualitas sticker harus angka 1-100.');
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
    throw new UserInputError('Format: ,smeme up/down <teks> [1-99]');
  }

  const tail = [...rest];
  let quality = 99;
  const maybeQuality = tail.at(-1);
  if (/^\d+$/.test(maybeQuality || '')) {
    quality = Number(tail.pop());
    if (!Number.isInteger(quality) || quality < 1 || quality > 99) {
      throw new UserInputError('Kualitas smeme harus angka 1-99.');
    }
  }

  const text = tail.join(' ').trim();
  if (!text) throw new UserInputError('Teks smeme wajib diisi.');
  return {
    position,
    text,
    quality,
    canvasSize: smemeCanvasSize(quality)
  };
}

export async function makeSmemeSticker(media, { author, title, tools, smeme }) {
  if (!smeme) throw new Error('Argumen smeme tidak valid.');
  await fs.access(IMPACT_FONT).catch(() => {
    throw new Error('Font Impact belum tersedia. Jalankan npm run setup:font -- --impact-only.');
  });
  const metadata = { author, title, tesseract: tools?.tesseract, fallbackTitle: smeme.text };
  const animated = await isAnimatedMedia(media);
  return animated
    ? makeAnimatedSmemeSticker(media, { metadata, tools, smeme })
    : makeStaticSmemeSticker(media, { metadata, smeme });
}

async function makeStaticSmemeSticker(media, { metadata, smeme }) {
  const temp = [];
  try {
    const rawSticker = makeTempPath('smeme', '.webp');
    temp.push(rawSticker);
    const canvas = smeme.canvasSize;
    const { data, info } = await sharp(media.path)
      .rotate()
      .resize(canvas, canvas, { fit: 'contain', background: TRANSPARENT })
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const bounds = visibleSmemeBounds(data, info.width, info.height);
    const overlay = await makeSmemeOverlay(smeme, bounds || info);
    const image = sharp(data, { raw: info });
    await (overlay ? image.composite([overlay]) : image)
      .webp({ quality: SMEME_STYLE.webpQuality })
      .toFile(rawSticker);

    return await applyStickerMetadata(rawSticker, metadata);
  } finally {
    await cleanupFiles(temp);
  }
}

async function makeAnimatedSmemeSticker(media, { metadata, tools, smeme }) {
  const tempDir = await fs.mkdtemp(path.join(TEMP_DIR, 'smeme-frames-'));
  const temp = [];
  try {
    const canvas = smeme.canvasSize;
    if (await isAnimatedWebpMedia(media)) {
      const rawSticker = makeTempPath('smeme', '.webp');
      temp.push(rawSticker);
      await animatedWebpToStickerWebp(media.path, rawSticker, {
        canvas,
        smeme,
        quality: SMEME_STYLE.webpQuality
      });

      return await applyStickerMetadata(rawSticker, metadata);
    }

    if (!tools?.ffmpeg) throw new Error('FFmpeg belum tersedia. Smeme bergerak butuh FFmpeg.');
    await runTool(tools.ffmpeg, [
      '-y',
      '-i', media.path,
      '-t', String(SMEME_STYLE.maxDurationSeconds),
      '-vf', `fps=${SMEME_STYLE.fps},scale=${canvas}:${canvas}:force_original_aspect_ratio=decrease,format=rgba`,
      path.join(tempDir, 'frame-%04d.png')
    ]);

    const entries = (await fs.readdir(tempDir))
      .filter((name) => /^frame-\d+\.png$/.test(name))
      .sort();
    if (!entries.length) throw new UserInputError('Frame smeme bergerak tidak ditemukan.');

    let bounds;
    let width;
    let height;
    // Opaque video normally fills the frame immediately. Transparent GIFs can need more frames.
    for (const name of entries) {
      const { data, info } = await sharp(path.join(tempDir, name))
        .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      ({ width, height } = info);
      bounds = visibleSmemeBounds(data, width, height, bounds);
      if (bounds?.width === width && bounds.height === height) break;
    }
    const overlay = await makeSmemeOverlay(smeme, fitSmemeBounds(
      bounds || { left: 0, top: 0, width, height }, width, height, canvas, 1
    ));

    for (const name of entries) {
      const source = path.join(tempDir, name);
      const out = path.join(tempDir, name.replace('frame-', 'overlay-'));
      const image = sharp(source).resize(canvas, canvas, {
        fit: 'contain', withoutEnlargement: true, background: TRANSPARENT
      });
      await (overlay ? image.composite([overlay]) : image).png().toFile(out);
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

    return await applyStickerMetadata(rawSticker, metadata);
  } finally {
    await cleanupFiles(temp);
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

// Sound sticker -> regular MP4 with its audio. The visual loops until the audio ends.
// Download format for a sticker: animated -> GIF, static -> PNG.
export async function stickerToDownload(media, tools) {
  const animated = await isAnimatedMedia(media);
  const outPath = makeTempPath('sticker-download', animated ? '.gif' : '.png');
  try {
    if (animated) await animatedWebpToGif(media.path, outPath, tools);
    else await sharp(media.path, { animated: false }).png().toFile(outPath);
    return animated
      ? { buffer: await fs.readFile(outPath), mimetype: 'image/gif', ext: 'gif' }
      : { buffer: await fs.readFile(outPath), mimetype: 'image/png', ext: 'png' };
  } finally {
    await fs.rm(outPath, { force: true }).catch(() => {});
  }
}

export async function stickerToAudioVideo(media, audioPath, tools) {
  if (!tools?.ffmpeg) throw new Error('FFmpeg belum tersedia untuk mengubah stiker beraudio menjadi video.');
  const animated = await isAnimatedMedia(media);
  const visual = makeTempPath('sound-sticker-visual', animated ? '.mp4' : '.png');
  const outPath = makeTempPath('sound-sticker', '.mp4');
  try {
    if (animated) await animatedWebpToGifPlaybackVideo(media.path, visual, tools);
    else await sharp(media.path, { animated: false }).flatten({ background: '#ffffff' }).png().toFile(visual);
    // -shortest alone overshoots with looped inputs, so cut at the probed audio length.
    const seconds = tools.ffprobe
      ? Number(String((await runTool(tools.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audioPath])).stdout).trim())
      : NaN;
    await runTool(tools.ffmpeg, [
      '-y',
      ...(animated ? ['-stream_loop', '-1', '-i', visual] : ['-loop', '1', '-framerate', '25', '-i', visual]),
      '-i', audioPath,
      '-map', '0:v:0', '-map', '1:a:0',
      ...(Number.isFinite(seconds) && seconds > 0 ? ['-t', seconds.toFixed(3)] : []),
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', animated ? 'animation' : 'stillimage',
      '-c:a', 'aac', '-b:a', '128k',
      '-shortest', '-movflags', '+faststart',
      outPath
    ]);
    return { buffer: await fs.readFile(outPath), mimetype: 'video/mp4', fileName: 'sticker.mp4' };
  } finally {
    await cleanupFiles([visual, outPath]);
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

// Track the union of visible pixels so a caption stays put across animated frames.
function visibleSmemeBounds(data, width, height, previous) {
  let left = previous?.left ?? width;
  let top = previous?.top ?? height;
  let right = previous ? previous.left + previous.width : 0;
  let bottom = previous ? previous.top + previous.height : 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] < 16) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + 1);
      bottom = Math.max(bottom, y + 1);
    }
  }
  if (right > left && bottom > top) {
    return { left, top, width: right - left, height: bottom - top };
  }
  return null;
}

function fitSmemeBounds(bounds, width, height, canvas, scale = canvas / Math.max(width, height)) {
  return {
    left: Math.floor((canvas - Math.round(width * scale)) / 2) + Math.floor(bounds.left * scale),
    top: Math.floor((canvas - Math.round(height * scale)) / 2) + Math.floor(bounds.top * scale),
    width: Math.max(1, Math.round(bounds.width * scale)),
    height: Math.max(1, Math.round(bounds.height * scale))
  };
}

async function makeSmemeOverlay({ text, position }, { left = 0, top = 0, width, height }) {
  const padding = Math.min(
    Math.max(1, Math.round(Math.min(width, height) * SMEME_STYLE.paddingScale)),
    Math.floor((Math.min(width, height) - 1) / 2)
  );
  const maxWidth = width - 2 * padding;
  const maxHeight = Math.max(1, Math.round(height * SMEME_STYLE.maxTextBlockScale));
  const baseSize = Math.max(8, Math.round(Math.min(width, height * 2) * SMEME_STYLE.fontScale));
  const uppercase = text.toUpperCase();
  const { lines, size } = layoutSmemeText(uppercase, baseSize, maxWidth, maxHeight);
  const rendered = (await Promise.all(lines.map((line) => renderSmemeLine(line, size)))).filter(Boolean);
  if (!rendered.length) return null;

  const blockWidth = Math.max(...rendered.map((line) => line.width));
  const gap = Math.max(1, Math.round(size * 0.12));
  let blockHeight = 0;
  const layers = rendered.map((line) => {
    const layer = { input: line.input, left: Math.floor((blockWidth - line.width) / 2), top: blockHeight };
    blockHeight += line.height + gap;
    return layer;
  });
  blockHeight -= gap;
  const block = await sharp({
    create: { width: blockWidth, height: blockHeight, channels: 4, background: TRANSPARENT }
  }).composite(layers).png().toBuffer();
  const { data: input, info } = await sharp(block)
    .resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer({ resolveWithObject: true });
  return {
    input,
    left: left + Math.floor((width - info.width) / 2),
    top: position === 'up' ? top + padding : top + height - padding - info.height
  };
}

function layoutSmemeText(text, baseSize, maxWidth, maxHeight) {
  for (let size = baseSize; size >= 8; size -= 1) {
    const maxLines = Math.max(1, Math.min(SMEME_STYLE.maxLines, Math.floor(maxHeight / size)));
    const { lines, truncated } = wrapSmemeTextToWidth(text, maxWidth, size, maxLines);
    if (!truncated || size === 8) return { lines, size };
  }
}

async function renderSmemeLine(line, size) {
  let width = 0;
  const parts = [];
  for (const run of splitSmemeTextRuns(line)) {
    const emoji = run.type === 'emoji' && await readTwemojiSvg(run.codepoint);
    const leading = run.text.startsWith(' ') ? Math.round(size * 0.25) : 0;
    const trailing = run.text.endsWith(' ') ? Math.round(size * 0.25) : 0;
    if (!run.text.trim()) {
      width += leading;
      continue;
    }
    const part = emoji ? renderSmemeEmoji(emoji, size) : await renderSmemeGlyphs(run.text.trim(), size);
    if (!part) continue;
    parts.push({ ...part, left: width + leading });
    width += leading + part.width + trailing;
  }
  if (!parts.length) return null;

  const height = Math.max(...parts.map((part) => part.height));
  const input = await sharp({ create: { width, height, channels: 4, background: TRANSPARENT } })
    .composite(parts.map((part) => ({
      input: part.input,
      left: part.left,
      top: Math.floor((height - part.height) / 2)
    })))
    .png().toBuffer();
  return { input, width, height };
}

async function renderSmemeGlyphs(text, size) {
  let glyphs;
  try {
    glyphs = await sharp({ text: {
      text: `<span foreground="white">${escapeXml(text)}</span>`,
      font: `Impact ${size}`, fontfile: IMPACT_FONT, rgba: true, wrap: 'none', dpi: 72
    } }).raw().toBuffer({ resolveWithObject: true });
  } catch (error) {
    if (error.message.includes('no text to render')) return null;
    throw error;
  }
  const radius = Math.max(1, Math.round(size * 0.055));
  const width = glyphs.info.width + 2 * radius;
  const height = glyphs.info.height + 2 * radius;
  const pixels = Buffer.alloc(width * height * 4);
  const offsets = [];
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx * dx + dy * dy <= radius * radius) offsets.push((dy * width + dx) * 4);
    }
  }
  // Expand the glyph alpha into a rounded black outline, then layer the white glyphs over it.
  for (let y = 0; y < glyphs.info.height; y += 1) {
    for (let x = 0; x < glyphs.info.width; x += 1) {
      const alpha = glyphs.data[(y * glyphs.info.width + x) * 4 + 3];
      if (!alpha) continue;
      const center = ((y + radius) * width + x + radius) * 4 + 3;
      for (const offset of offsets) pixels[center + offset] = Math.max(pixels[center + offset], alpha);
    }
  }
  const input = await sharp(pixels, { raw: { width, height, channels: 4 } })
    .composite([{ input: glyphs.data, raw: glyphs.info, left: radius, top: radius }])
    .png().toBuffer();
  return { input, width, height };
}

function renderSmemeEmoji(emoji, fontSize) {
  const size = Math.max(1, Math.round(fontSize * SMEME_STYLE.emojiScale));
  const input = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${escapeXml(emoji.viewBox)}">${emoji.body}</svg>`);
  return { input, width: size, height: size };
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
    width + (/^\s+$/.test(char) ? fontSize * 0.25 : fontSize * 0.56)
  ), 0);
}

function measureSmemeLine(line, fontSize) {
  return splitSmemeTextRuns(line).reduce((width, run) => width + measureSmemeRun(run, fontSize), 0);
}

function wrapSmemeTextToWidth(text, maxWidth, fontSize, maxLines) {
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
    const parts = splitLongSmemeWord(word, maxWidth, fontSize);
    current = parts.pop();
    lines.push(...parts);
    if (lines.length >= maxLines) {
      return { lines: trimSmemeLines(lines, maxLines, fontSize, maxWidth), truncated: true };
    }
  }

  if (current) lines.push(current);
  return { lines, truncated: false };
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

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
  smeme,
  quality = 90,
  lossless = false,
  maxDurationMs = SMEME_STYLE.maxDurationSeconds * 1000
}) {
  const decoded = await decodeAnimatedWebpFrames(inputPath, {
    maxDurationMs
  });
  let overlay;
  if (smeme) {
    const { width, height } = decoded;
    const bounds = decoded.frames.reduce((previous, frame) => (
      visibleSmemeBounds(frame.data, width, height, previous)
    ), null) || { left: 0, top: 0, width, height };
    overlay = await makeSmemeOverlay(smeme, fitSmemeBounds(bounds, width, height, canvas));
  }
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
    if (overlay) image = image.composite([overlay]);
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
    // ANMF stores frame offsets in two-pixel units. node-webpmux exposes the
    // encoded values, while Sharp composites the decoded frame at x/y * 2.
    const x = Math.max(0, (Number(frame.x) || 0) * 2);
    const y = Math.max(0, (Number(frame.y) || 0) * 2);
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

export async function decodeStickerFrames(inputPath) {
  if (await isAnimatedWebpPath(inputPath)) {
    return decodeAnimatedWebpFrames(inputPath, { maxDurationMs: Number.MAX_SAFE_INTEGER });
  }
  const { data, info } = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, frames: [{ data, delay: 1000 }] };
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
  const { defaultTitle = ':3' } = options;
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
    if (!/^\d+$/.test(value)) throw new UserInputError('Kualitas sticker harus memakai format q=1-100.');
    quality = normalizeStickerQuality(value);
  }

  const metaInput = raw.replace(/(?:^|\s)q=\S+(?=\s|$)/gi, ' ').trim();
  return {
    ...parseStickerMeta(metaInput, options),
    quality
  };
}
