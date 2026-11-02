import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import webp from 'node-webpmux';
import { UserInputError } from './errors.js';
import { DEFAULT_STICKER_AUTHOR, DEFAULT_STICKER_TITLE } from './config.js';
import { cleanupFiles, downloadMessageMedia } from './media.js';
import { buildStickerExif, decodeStickerFrames, isAnimatedMedia } from './sticker.js';

const SESSION_MS = 30 * 60 * 1000;
const CANVAS = 512;
const MAX_BYTES = 950 * 1024;
const MAX_DURATION_MS = 10_000;
const PRESETS = [
  { canvas: 512, quality: 90, stride: 1 },
  { canvas: 512, quality: 75, stride: 1 },
  { canvas: 448, quality: 65, stride: 1 },
  { canvas: 384, quality: 55, stride: 2 },
  { canvas: 320, quality: 45, stride: 3 }
];

export class StimpaSessions {
  constructor() { this.sessions = new Map(); }
  has(jid) { return this.sessions.has(jid); }
  get(jid) { return this.sessions.get(jid) || null; }
  count() { return this.sessions.size; }
  isActor(jid, actorJid) { return !this.has(jid) || this.get(jid).actorJid === actorJid; }

  async start(jid, actorJid, media) {
    if (media?.type !== 'stickerMessage' || !(await isAnimatedMedia(media))) {
      throw new UserInputError('Reply stiker WhatsApp bergerak untuk memakai ,stimpa.');
    }
    const decoded = await decodeStickerFrames(media.path);
    const duration = decoded.frames.reduce((sum, frame) => sum + frame.delay, 0);
    if (decoded.frames.length < 2) throw new UserInputError('Stiker sumber tidak memiliki animasi.');
    if (duration > MAX_DURATION_MS) throw new UserInputError('Durasi stiker melebihi 10 detik.');
    const reference = await previewFrame(decoded.frames[0].data, decoded.width, decoded.height);
    const preview = await sharp(reference, { raw: { width: CANVAS, height: CANVAS, channels: 4 } }).png().toBuffer();
    const session = { jid, actorJid, media, reference, edit: null, edits: [], files: [media.path], busy: false };
    this.sessions.set(jid, session);
    this.touch(session);
    return { session, preview };
  }

  touch(session) {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => this.cancel(session.jid).catch(() => {}), SESSION_MS);
    session.timer.unref?.();
  }

  async add(sock, message) {
    const session = this.get(message.key.remoteJid);
    if (!session || session.busy) return null;
    const media = await downloadMessageMedia(sock, message, 'stimpa-edit');
    if (!media) return { ignored: true, reason: 'Kirim gambar kanvas yang sudah diedit.' };
    return this.addMedia(message.key.remoteJid, media);
  }

  async addMedia(jid, media) {
    const session = this.get(jid);
    if (!session || session.busy) { await cleanupFiles([media?.path]); return null; }
    try {
      const image = media.type === 'imageMessage' ||
        (media.type === 'documentMessage' && /^image\/(png|jpeg|webp)$/i.test(media.mimetype));
      if (!image) throw new UserInputError('Edit harus berupa gambar PNG, JPG, atau WebP.');
      const metadata = await sharp(media.path).metadata();
      if (!metadata.width || !metadata.height || Math.abs(metadata.width / metadata.height - 1) > 0.03) {
        throw new UserInputError('Kanvas edit harus persegi, tanpa crop. Edit gambar yang dikirim bot lalu kirim kembali.');
      }
      const overlay = await extractOverlay(session.reference, media.path);
      session.edits.push({ media, overlay });
      session.edit = media;
      session.files.push(media.path);
      this.touch(session);
      return session;
    } catch (error) {
      await cleanupFiles([media.path]);
      if (error instanceof UserInputError) return { ignored: true, reason: error.message };
      throw error;
    }
  }

  async cancel(jid, actorJid = null) {
    const session = this.get(jid);
    if (!session || (actorJid && session.actorJid !== actorJid) || session.busy) return false;
    clearTimeout(session.timer);
    this.sessions.delete(jid);
    await cleanupFiles(session.files);
    return true;
  }

  async finish(jid, actorJid, onProgress, send) {
    const session = this.get(jid);
    if (!session || session.actorJid !== actorJid) return false;
    if (session.busy) return true;
    if (!session.edit) throw new UserInputError('Kirim gambar kanvas yang sudah diedit sebelum ,end.');
    session.busy = true;
    clearTimeout(session.timer);
    try {
      await onProgress(5, 'Membaca gambar edit');
      const raw = { raw: { width: CANVAS, height: CANVAS, channels: 4 } };
      const layers = session.edits?.length
        ? session.edits.map((item) => item.overlay)
        : [await extractOverlay(session.reference, session.edit.path)];
      let overlay = layers[0];
      for (const layer of layers.slice(1)) {
        const png = await sharp(layer, raw).png().toBuffer();
        overlay = await sharp(overlay, raw).composite([{ input: png, left: 0, top: 0 }]).raw().toBuffer();
      }
      await onProgress(20, 'Menyiapkan frame animasi');
      const decoded = await decodeStickerFrames(session.media.path);
      let result;
      for (const [index, preset] of PRESETS.entries()) {
        await onProgress(20 + Math.round(index * 13), `Membuat stiker (${preset.canvas}px)`);
        result = await renderSticker(decoded, overlay, preset);
        if (result.length <= MAX_BYTES) break;
      }
      if (result.length > MAX_BYTES) throw new UserInputError('Stiker hasil masih terlalu besar untuk WhatsApp. Sederhanakan gambar edit lalu coba lagi.');
      await onProgress(92, 'Mengirim stiker');
      await send(result);
      await onProgress(100, 'Selesai');
      this.sessions.delete(jid);
      await cleanupFiles(session.files);
      return true;
    } finally {
      session.busy = false;
      if (this.has(jid)) this.touch(session);
    }
  }
}

async function previewFrame(data, width, height) {
  return sharp(data, { raw: { width, height, channels: 4 } })
    .resize(CANVAS, CANVAS, { fit: 'contain', background: '#ffffff' })
    .flatten({ background: '#ffffff' })
    .ensureAlpha().raw().toBuffer();
}

export async function extractOverlay(reference, editPath) {
  const edited = await sharp(editPath).rotate().resize(CANVAS, CANVAS, { fit: 'fill' })
    .flatten({ background: '#ffffff' }).ensureAlpha().raw().toBuffer();
  const rawInfo = { raw: { width: CANVAS, height: CANVAS, channels: 4 } };
  const [softReference, softEdited] = await Promise.all([
    sharp(reference, rawInfo).blur(0.8).raw().toBuffer(),
    sharp(edited, rawInfo).blur(0.8).raw().toBuffer()
  ]);
  const overlay = Buffer.alloc(CANVAS * CANVAS * 4);
  let changed = 0;
  let referenceFeatures = 0;
  let matchingFeatures = 0;
  for (let pixel = 0; pixel < CANVAS * CANVAS; pixel += 1) {
    const i = pixel * 4;
    const red = Math.abs(softEdited[i] - softReference[i]);
    const green = Math.abs(softEdited[i + 1] - softReference[i + 1]);
    const blue = Math.abs(softEdited[i + 2] - softReference[i + 2]);
    if (Math.min(softReference[i], softReference[i + 1], softReference[i + 2]) < 225) {
      referenceFeatures += 1;
      if (Math.max(red, green, blue) < 42) matchingFeatures += 1;
    }
    // WhatsApp commonly re-encodes edited images as JPEG. Ignore small color
    // differences around the reference art so compression is not a new layer.
    if (Math.max(red, green, blue) < 42 || red + green + blue < 70) continue;
    edited.copy(overlay, i, i, i + 3);
    overlay[i + 3] = 255;
    changed += 1;
  }
  if ((referenceFeatures > 100 && matchingFeatures < referenceFeatures * 0.2) || changed > CANVAS * CANVAS * 0.65) {
    throw new UserInputError('Gambar tidak cocok dengan kanvas sesi ini; gambar dilewati.');
  }
  if (changed < 4) throw new UserInputError('Tidak ada perubahan yang terlihat pada gambar edit. Tambahkan teks, coretan, atau gambar lalu kirim lagi.');
  return overlay;
}

async function renderSticker(decoded, overlay, preset) {
  const frameOverlay = preset.canvas === CANVAS ? overlay : await sharp(overlay, {
    raw: { width: CANVAS, height: CANVAS, channels: 4 }
  }).resize(preset.canvas, preset.canvas).raw().toBuffer();
  const overlayPng = await sharp(frameOverlay, {
    raw: { width: preset.canvas, height: preset.canvas, channels: 4 }
  }).png().toBuffer();
  const frames = [];
  const stride = Math.min(preset.stride, decoded.frames.length - 1);
  for (let index = 0; index < decoded.frames.length; index += stride) {
    const source = decoded.frames[index];
    const delay = decoded.frames.slice(index, index + stride).reduce((sum, frame) => sum + frame.delay, 0);
    const image = await sharp(source.data, { raw: { width: decoded.width, height: decoded.height, channels: 4 } })
      .resize(preset.canvas, preset.canvas, { fit: 'contain', background: '#00000000' })
      .composite([{ input: overlayPng, left: 0, top: 0 }])
      .webp({ quality: preset.quality, alphaQuality: 100, effort: 5 }).toBuffer();
    frames.push(await webp.Image.generateFrame({ buffer: image, delay, x: 0, y: 0, blend: false, dispose: false }));
  }
  if (frames.length < 2) throw new UserInputError('Animasi sumber terlalu pendek untuk dibuat menjadi stiker bergerak.');
  const output = path.join(os.tmpdir(), `stimpa-${Date.now()}-${Math.random().toString(36).slice(2)}.webp`);
  try {
    await webp.Image.save(output, { width: preset.canvas, height: preset.canvas, frames, bgColor: [0, 0, 0, 0], loops: 0 });
    const image = new webp.Image();
    await image.load(output);
    image.exif = buildStickerExif(DEFAULT_STICKER_AUTHOR, DEFAULT_STICKER_TITLE);
    return await image.save(null);
  } finally {
    await fs.rm(output, { force: true });
  }
}
