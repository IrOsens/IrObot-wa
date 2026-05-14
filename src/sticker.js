import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import webp from 'node-webpmux';
import { TEMP_DIR, makeTempPath } from './config.js';
import { cleanupFiles, isLikelyAnimated } from './media.js';
import { runTool } from './tools.js';

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
