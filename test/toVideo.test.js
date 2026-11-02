import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import webp from 'node-webpmux';
import { ToVideoSessions, parseToVideoOptions, resolveToVideoDuration } from '../src/toVideo.js';
import { matchSticker } from '../src/stickerMatch.js';
import { decodeStickerFrames } from '../src/sticker.js';
import { runTool } from '../src/tools.js';
import { getMessageText } from '../src/text.js';

test('tovideo uses automatic duration until explicitly changed', () => {
  const initial = parseToVideoOptions('');
  assert.equal(initial.durationMs, 5000);
  assert.equal(initial.durationMode, 'auto');
  assert.equal(parseToVideoOptions('format=gif').durationMs, 5000);
  const updated = parseToVideoOptions('duration=2m', { previous: initial });
  assert.equal(updated.durationMs, 120000);
  assert.equal(updated.durationMode, 'explicit');
  assert.equal(parseToVideoOptions('sync', { previous: updated }).durationMode, 'sync');
  assert.deepEqual(parseToVideoOptions('duration=3s', { previous: updated }).durationMs, 3000);
});

test('tovideo parses speed and slow with a bounded playback multiplier', () => {
  assert.equal(parseToVideoOptions('').speed, 1);
  assert.equal(parseToVideoOptions('speed=2').speed, 2);
  assert.equal(parseToVideoOptions('speed=0.5').speed, 0.5);
  assert.equal(parseToVideoOptions('slow=2').speed, 0.5);
  assert.equal(parseToVideoOptions('slow=4').speed, 0.25);
  assert.equal(parseToVideoOptions('speed=3', { previous: parseToVideoOptions('slow=2') }).speed, 3);
  for (const input of ['speed=0', 'speed=5', 'speed=-1', 'speed=nan', 'slow=0', 'slow=5', 'slow=0.5']) {
    assert.throws(() => parseToVideoOptions(input), /speed|slow/i);
  }
});

test('tovideo changes video and audio playback speed, with automatic duration', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tovideo-speed-test-'));
  const sessions = new ToVideoSessions({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
  try {
    const source = path.join(dir, 'source.mp4');
    await runTool('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=20', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '2', '-c:v', 'libx264', '-c:a', 'aac', source]);
    for (const [label, option, expectedDuration] of [['fast', 'speed=2', 1], ['slow', 'slow=2', 4]]) {
      const outputPath = path.join(dir, `${label}.mp4`);
      const inputPath = path.join(dir, `${label}-source.mp4`);
      await fs.copyFile(source, inputPath);
      const session = sessions.start(label, 'actor', { path: inputPath, type: 'videoMessage' }, parseToVideoOptions(option));
      assert.ok(Math.abs(await resolveToVideoDuration(session, { ffprobe: 'ffprobe' }) - expectedDuration) < 0.1);
      await sessions.finish(label, 'actor', async () => {}, async (output) => fs.copyFile(output, outputPath));
      const info = JSON.parse((await runTool('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outputPath])).stdout);
      assert.ok(Math.abs(Number(info.format.duration) - expectedDuration) < 0.25, `${label}: ${info.format.duration}`);
      assert.ok(info.streams.some((stream) => stream.codec_type === 'audio'), `${label}: audio retained`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('tovideo can start from a sticker and waits for a template', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tovideo-session-test-'));
  const stickerPath = path.join(dir, 'sticker.webp');
  await fs.writeFile(stickerPath, Buffer.from('test'));
  const sessions = new ToVideoSessions({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
  const session = sessions.start('chat', 'actor', { path: stickerPath, type: 'stickerMessage' }, parseToVideoOptions(''));
  try {
    assert.equal(session.source, null);
    assert.equal(session.stickers.length, 1);
    assert.match(getMessageText({ message: { stickerMessage: { caption: ',tovideo' } } }), /,tovideo/);
    await assert.rejects(() => sessions.finish('chat', 'actor', async () => {}, async () => {}), /Kirim gambar atau video template/);
    assert.equal(sessions.has('chat'), true);
  } finally {
    await sessions.cancel('chat', 'actor');
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('tovideo follows video length in auto mode and preserves explicit duration', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tovideo-duration-test-'));
  try {
    const source = path.join(dir, 'source.mp4');
    await runTool('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10', '-t', '1.4', '-c:v', 'libx264', source]);
    const session = { source: { path: source, type: 'videoMessage' }, options: parseToVideoOptions('') };
    assert.ok(Math.abs(await resolveToVideoDuration(session, { ffprobe: 'ffprobe' }) - 1.4) < 0.05);
    session.options = parseToVideoOptions('duration=3s', { previous: session.options });
    assert.equal(await resolveToVideoDuration(session, { ffprobe: 'ffprobe' }), 3);
    session.source = { path: source, type: 'imageMessage' };
    session.options = parseToVideoOptions('');
    assert.equal(await resolveToVideoDuration(session, { ffprobe: 'ffprobe' }), 5);
    const sessions = new ToVideoSessions({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
    sessions.start('video-chat', 'actor', { path: source, type: 'videoMessage' }, parseToVideoOptions(''));
    const outputPath = path.join(dir, 'rendered.mp4');
    await sessions.finish('video-chat', 'actor', async () => {}, async (output) => fs.copyFile(output, outputPath));
    const rendered = JSON.parse((await runTool('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', outputPath])).stdout);
    assert.ok(Math.abs(Number(rendered.format.duration) - 1.4) < 0.15);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('tovideo locates a resized, rotated sticker using a later animation frame', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tovideo-match-test-'));
  try {
    const frames = [];
    for (const color of ['red', 'blue']) {
      const svg = Buffer.from(`<svg width="96" height="96"><path d="M15 18 L70 14 L81 45 L49 80 L17 59 Z" fill="${color}"/><rect x="20" y="30" width="12" height="30" fill="yellow"/><circle cx="65" cy="35" r="8" fill="lime"/></svg>`);
      frames.push({ data: await sharp(svg).ensureAlpha().raw().toBuffer(), delay: 500 });
    }
    const decoded = { width: 96, height: 96, frames };
    const overlay = await sharp(frames[1].data, { raw: { width: 96, height: 96, channels: 4 } })
      .resize(86, 86).rotate(17, { background: '#00000000' }).png().toBuffer();
    const source = path.join(dir, 'source.jpg');
    await sharp({ create: { width: 400, height: 300, channels: 3, background: '#336699' } })
      .composite([{ input: overlay, left: 125, top: 75 }])
      .jpeg({ quality: 78 }).toFile(source);
    const match = await matchSticker(source, decoded);
    assert.ok(match);
    assert.equal(match.matchedFrameIndex, 1);
    assert.ok(Math.abs(match.left - 125) <= 3);
    assert.ok(Math.abs(match.top - 75) <= 3);
    assert.ok(Math.abs(match.width - 86) <= 3);
    assert.ok(Math.abs(match.angle - 17) <= 3);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('tovideo keeps two identical stickers at separate positions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tovideo-duplicates-test-'));
  try {
    const svg = Buffer.from('<svg width="96" height="96"><path d="M15 18 L70 14 L81 45 L49 80 L17 59 Z" fill="blue"/><circle cx="65" cy="35" r="8" fill="lime"/></svg>');
    const data = await sharp(svg).ensureAlpha().raw().toBuffer();
    const decoded = { width: 96, height: 96, frames: [{ data, delay: 500 }] };
    const overlay = await sharp(data, { raw: { width: 96, height: 96, channels: 4 } })
      .resize(86, 86).rotate(17, { background: '#00000000' }).png().toBuffer();
    const source = path.join(dir, 'source.png');
    await sharp({ create: { width: 400, height: 300, channels: 3, background: '#336699' } })
      .composite([{ input: overlay, left: 125, top: 75 }, { input: overlay, left: 265, top: 175 }])
      .png().toFile(source);
    const first = await matchSticker(source, decoded);
    const second = await matchSticker(source, decoded, [first]);
    assert.ok(first && second);
    assert.ok(Math.abs(first.left - second.left) > 100);
    assert.ok(Math.abs(first.top - second.top) > 80);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('tovideo matches a large reference sticker instead of a small inner detail', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tovideo-large-match-'));
  try {
    const svg = (color) => Buffer.from(`<svg width="128" height="128"><path d="M13 17 L100 10 L120 67 L79 116 L18 101 Z" fill="${color}"/><rect x="39" y="33" width="45" height="42" fill="#2367d1"/><circle cx="60" cy="54" r="12" fill="${color}"/><path d="M24 88 L91 91" stroke="white" stroke-width="9"/></svg>`);
    const data = await sharp(svg('#eb394c')).ensureAlpha().raw().toBuffer();
    const decoded = { width: 128, height: 128, frames: [{ data, delay: 500 }] };
    const overlay = await sharp(svg('#eb394c')).resize(475, 475).png().toBuffer();
    const source = path.join(dir, 'reference.png');
    await sharp({ create: { width: 800, height: 600, channels: 3, background: '#193144' } })
      .composite([{ input: overlay, left: 245, top: 55 }]).png().toFile(source);
    const match = await matchSticker(source, decoded);
    assert.ok(match, 'large sticker should be found');
    assert.ok(Math.abs(match.left - 245) < 12, `left=${match.left}`);
    assert.ok(Math.abs(match.top - 55) < 12, `top=${match.top}`);
    assert.ok(Math.abs(match.width - 475) < 15, `width=${match.width}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('tovideo decodes cropped animated WebP frames at their displayed position', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tovideo-partial-sticker-'));
  try {
    const stickerPath = path.join(dir, 'partial.webp');
    const full = await sharp({ create: { width: 80, height: 80, channels: 4, background: '#ff0000ff' } })
      .webp({ lossless: true }).toBuffer();
    const patch = await sharp({ create: { width: 20, height: 20, channels: 4, background: '#0000ffff' } })
      .webp({ lossless: true }).toBuffer();
    await webp.Image.save(stickerPath, {
      width: 80, height: 80, bgColor: [0, 0, 0, 0], loops: 0,
      frames: [
        await webp.Image.generateFrame({ buffer: full, delay: 500, x: 0, y: 0, blend: false }),
        await webp.Image.generateFrame({ buffer: patch, delay: 500, x: 20, y: 20, blend: false })
      ]
    });
    const decoded = await decodeStickerFrames(stickerPath);
    const pixel = (frame, x, y) => [...frame.data.subarray((y * decoded.width + x) * 4, (y * decoded.width + x) * 4 + 4)];
    assert.deepEqual(pixel(decoded.frames[1], 45, 45), [0, 0, 255, 255]);
    assert.deepEqual(pixel(decoded.frames[1], 25, 25), [255, 0, 0, 255]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('tovideo renders an animated sticker into one template video', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tovideo-render-test-'));
  const sessions = new ToVideoSessions({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
  try {
    const stickerPath = path.join(dir, 'sticker.webp');
    const sourcePath = path.join(dir, 'template.png');
    const outputPath = path.join(dir, 'result.mp4');
    const svg = (color) => Buffer.from(`<svg width="96" height="96"><path d="M15 18 L70 14 L81 45 L49 80 L17 59 Z" fill="${color}"/><rect x="20" y="30" width="12" height="30" fill="yellow"/><circle cx="65" cy="35" r="8" fill="lime"/></svg>`);
    const frames = [];
    for (const color of ['red', 'blue']) {
      const buffer = await sharp(svg(color)).webp({ lossless: true }).toBuffer();
      frames.push(await webp.Image.generateFrame({ buffer, delay: 500, blend: false, dispose: false }));
    }
    await webp.Image.save(stickerPath, { width: 96, height: 96, frames, bgColor: [0, 0, 0, 0], loops: 0 });
    const overlay = await sharp(svg('red')).resize(86, 86).rotate(17, { background: '#00000000' }).png().toBuffer();
    await sharp({ create: { width: 400, height: 300, channels: 3, background: '#336699' } })
      .composite([{ input: overlay, left: 125, top: 75 }]).png().toFile(sourcePath);

    const session = sessions.start('chat', 'actor', { path: stickerPath, type: 'stickerMessage' }, parseToVideoOptions('duration=1s'));
    session.source = { path: sourcePath, type: 'imageMessage' };
    session.files.push(sourcePath);
    await sessions.finish('chat', 'actor', async () => {}, async (output) => fs.copyFile(output, outputPath));
    const info = JSON.parse((await runTool('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outputPath])).stdout);
    assert.ok(Math.abs(Number(info.format.duration) - 1) < 0.15);
    assert.equal(info.streams.filter((stream) => stream.codec_type === 'video').length, 1);
    const captures = [];
    for (const [index, seconds] of [0.2, 0.7].entries()) {
      const framePath = path.join(dir, `frame-${index}.png`);
      await runTool('ffmpeg', ['-y', '-ss', String(seconds), '-i', outputPath, '-frames:v', '1', framePath]);
      captures.push(await sharp(framePath).extract({ left: 155, top: 115, width: 1, height: 1 }).raw().toBuffer());
    }
    assert.ok(captures[0][0] > captures[0][2], 'first frame should show the red sticker');
    assert.ok(captures[1][2] > captures[1][0], 'later frame should show the blue sticker at the same position');
  } finally {
    await sessions.cancel('chat', 'actor');
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('tovideo keeps cropped animation frames inside the full reference sticker', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tovideo-cropped-render-'));
  const sessions = new ToVideoSessions({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
  try {
    const stickerPath = path.join(dir, 'sticker.webp');
    const sourcePath = path.join(dir, 'source.png');
    const resultPath = path.join(dir, 'result.mp4');
    const full = await sharp({ create: { width: 80, height: 80, channels: 4, background: '#ff0000ff' } })
      .webp({ lossless: true }).toBuffer();
    const patch = await sharp({ create: { width: 20, height: 20, channels: 4, background: '#0000ffff' } })
      .webp({ lossless: true }).toBuffer();
    await webp.Image.save(stickerPath, {
      width: 80, height: 80, bgColor: [0, 0, 0, 0], loops: 0,
      frames: [
        await webp.Image.generateFrame({ buffer: full, delay: 500, x: 0, y: 0, blend: false }),
        await webp.Image.generateFrame({ buffer: patch, delay: 500, x: 20, y: 20, blend: false })
      ]
    });
    const reference = await sharp(full).resize(120, 120).png().toBuffer();
    await sharp({ create: { width: 320, height: 240, channels: 3, background: '#336699' } })
      .composite([{ input: reference, left: 90, top: 60 }]).png().toFile(sourcePath);
    const session = sessions.start('cropped', 'actor', { path: stickerPath, type: 'stickerMessage' }, parseToVideoOptions('duration=1s'));
    session.source = { path: sourcePath, type: 'imageMessage' };
    session.files.push(sourcePath);
    await sessions.finish('cropped', 'actor', async () => {}, async (output) => fs.copyFile(output, resultPath));
    const capture = path.join(dir, 'later.png');
    await runTool('ffmpeg', ['-y', '-ss', '0.7', '-i', resultPath, '-frames:v', '1', capture]);
    const pixel = async (x, y) => sharp(capture).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer();
    const patchPixel = await pixel(155, 125);
    const bodyPixel = await pixel(110, 80);
    const outsidePixel = await pixel(245, 25);
    assert.ok(patchPixel[2] > patchPixel[0] + 80, `moving patch should appear at the scaled position inside the sticker: ${[...patchPixel]}`);
    assert.ok(bodyPixel[0] > bodyPixel[2] + 80, 'the rest of the full sticker should remain in place');
    assert.ok(outsidePixel[2] > outsidePixel[0], 'no detached patch should appear in the corner');
  } finally {
    await sessions.cancel('cropped', 'actor');
    await fs.rm(dir, { recursive: true, force: true });
  }
});
