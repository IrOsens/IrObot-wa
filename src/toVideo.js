import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { UserInputError } from './errors.js';
import { cleanupFiles, downloadMessageMedia } from './media.js';
import { parseDurationMs } from './reminders.js';
import { decodeStickerFrames } from './sticker.js';
import { matchSticker } from './stickerMatch.js';
import { runTool } from './tools.js';

const SESSION_MS = 30 * 60 * 1000;
const FORMATS = new Set(['mp4', 'gif']);
let renderQueue = Promise.resolve();

export function parseToVideoOptions(text, { previous = {} } = {}) {
  const options = { durationMs: 5000, durationMode: 'auto', format: 'mp4', quality: 100, videoVolume: 100, musicVolume: 100, mute: false, speed: 1, ...previous };
  for (const token of String(text || '').trim().split(/\s+/).filter(Boolean)) {
    const [key, ...parts] = token.toLowerCase().split('=');
    const value = parts.join('=');
    if (key === 'mute' && !parts.length) options.mute = true;
    else if (key === 'unmute' && !parts.length) options.mute = false;
    else if (key === 'sync' && !parts.length) {
      options.durationMode = 'sync';
      options.sync = true;
    }
    else if (key === 'duration' && value) {
      options.durationMs = parseDurationMs(value);
      options.durationMode = 'explicit';
      options.sync = false;
    } else if (key === 'format' && FORMATS.has(value)) options.format = value;
    else if (key === 'speed' || key === 'slow') {
      const factor = Number(value);
      if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(factor)
        || factor < (key === 'speed' ? 0.25 : 1) || factor > 4) {
        throw new UserInputError('Gunakan speed=0.25-4 atau slow=1-4 (contoh: speed=2, slow=2).');
      }
      options.speed = key === 'slow' ? 1 / factor : factor;
    }
    else if (['q', 'vvol', 'mvol'].includes(key) && /^\d{1,3}%?$/.test(value)) {
      const number = Number(value.replace('%', ''));
      if (key === 'q' && number >= 1 && number <= 100) options.quality = number;
      else if (key === 'vvol' && number <= 200) options.videoVolume = number;
      else if (key === 'mvol' && number <= 200) options.musicVolume = number;
      else throw new UserInputError(`${key} di luar rentang: q=1-100, vvol/mvol=0-200%.`);
    } else throw new UserInputError(`Opsi tidak dikenal: ${token}. Gunakan duration=3s, speed=2, slow=2, format=gif, q=80, mute, sync, vvol=50%, atau mvol=50%.`);
  }
  return options;
}

export class ToVideoSessions {
  constructor(tools) {
    this.tools = tools;
    this.sessions = new Map();
  }

  has(jid) { return this.sessions.has(jid); }
  get(jid) { return this.sessions.get(jid) || null; }
  count() { return this.sessions.size; }
  isActor(jid, actorJid) { return !this.has(jid) || this.get(jid).actorJid === actorJid; }

  start(jid, actorJid, media, options) {
    const kind = videoMediaKind(media);
    if (!['image', 'video', 'sticker'].includes(kind)) throw new UserInputError('Mulai sesi dengan gambar, video, atau stiker WhatsApp.');
    const session = {
      jid, actorJid,
      source: kind === 'sticker' ? null : media,
      stickers: kind === 'sticker' ? [media] : [],
      music: null, options, files: [media.path], busy: false, startedAt: Date.now()
    };
    session.timer = setTimeout(() => this.cancel(jid).catch(() => {}), SESSION_MS);
    session.timer.unref?.();
    this.sessions.set(jid, session);
    return session;
  }

  touch(session) {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => this.cancel(session.jid).catch(() => {}), SESSION_MS);
    session.timer.unref?.();
  }

  async add(sock, message, text = '') {
    const session = this.get(message.key.remoteJid);
    if (!session || session.busy) return null;
    const nextOptions = text.trim() ? parseToVideoOptions(text, { previous: session.options }) : session.options;
    const media = await downloadMessageMedia(sock, message, 'tovideo-item');
    if (media) {
      const kind = videoMediaKind(media);
      if (kind === 'sticker') {
        session.stickers.push(media);
        session.files.push(media.path);
      } else if (kind === 'audio') {
        const old = session.music;
        session.music = media;
        session.files.push(media.path);
        if (old) await cleanupFiles([old.path]);
      } else if (kind === 'image' || kind === 'video') {
        const old = session.source;
        session.source = media;
        session.files.push(media.path);
        if (old) await cleanupFiles([old.path]);
      } else {
        await cleanupFiles([media.path]);
        throw new UserInputError('Sesi video hanya menerima gambar, video, stiker WhatsApp, atau audio.');
      }
    }
    session.options = nextOptions;
    this.touch(session);
    return session;
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
    session.busy = true;
    clearTimeout(session.timer);
    const previous = renderQueue;
    let release;
    renderQueue = new Promise((resolve) => { release = resolve; });
    let output;
    try {
      await previous;
      let attempt = 0;
      for (;;) {
        output = await renderToVideo(session, this.tools, onProgress, attempt);
        await onProgress(95, 'Mengirim ke WhatsApp');
        try {
          await send(output, session.options.format);
          break;
        } catch (error) {
          if (!/too large|size|besar|limit|413/i.test(String(error?.message || '')) || attempt >= 2) throw error;
          await cleanupFiles([output]);
          output = null;
          attempt += 1;
          await onProgress(95, `Mencoba kompresi ${attempt + 1}`);
        }
      }
      await onProgress(100, 'Selesai');
      this.sessions.delete(jid);
      await cleanupFiles(session.files);
      return true;
    } finally {
      release();
      await cleanupFiles([output]);
      session.busy = false;
      if (this.has(jid)) this.touch(session);
    }
  }
}

export function videoMediaKind(media) {
  const type = media?.type;
  const mime = String(media?.mimetype || '');
  if (type === 'stickerMessage') return 'sticker';
  if (type === 'audioMessage' || /^audio\//i.test(mime)) return 'audio';
  if (type === 'imageMessage' || /^image\//i.test(mime)) return 'image';
  if (type === 'videoMessage' || /^video\//i.test(mime)) return 'video';
  return null;
}

async function probe(tools, file) {
  const result = await runTool(tools.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  return JSON.parse(result.stdout);
}

export async function resolveToVideoDuration(session, tools, sourceInfo = null) {
  const mode = session.options.durationMode || (session.options.sync ? 'sync' : 'explicit');
  if (mode === 'explicit') return session.options.durationMs / 1000;
  if (mode === 'sync') {
    if (!session.music) throw new UserInputError('Perintah sync memerlukan musik di dalam sesi.');
    const musicInfo = await probe(tools, session.music.path);
    const duration = Number(musicInfo.format?.duration) || Number(musicInfo.streams?.find((item) => item.codec_type === 'audio')?.duration);
    if (!(duration > 0)) throw new UserInputError('Durasi musik tidak dapat dibaca.');
    return duration;
  }
  if (videoMediaKind(session.source) !== 'video') return 5;
  const info = sourceInfo || await probe(tools, session.source.path);
  const duration = Number(info.format?.duration) || Number(info.streams?.find((item) => item.codec_type === 'video')?.duration);
  if (!(duration > 0)) throw new UserInputError('Durasi video tidak dapat dibaca. Gunakan duration=... untuk mengaturnya.');
  return duration / (session.options.speed || 1);
}

async function renderToVideo(session, tools, onProgress, attempt) {
  if (!tools.ffmpeg || !tools.ffprobe) throw new UserInputError('FFmpeg dan FFprobe diperlukan untuk ,tovideo.');
  const sourceKind = videoMediaKind(session.source);
  if (!['image', 'video'].includes(sourceKind)) throw new UserInputError('Kirim gambar atau video template sebelum ,end.');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'tovideo-'));
  const output = path.join(os.tmpdir(), `tovideo-result-${randomUUID()}.mp4`);
  try {
    await onProgress(3, 'Memeriksa media');
    const sourceInfo = sourceKind === 'video' ? await probe(tools, session.source.path) : null;
    const stream = sourceInfo?.streams?.find((item) => item.codec_type === 'video');
    const dimensions = sourceKind === 'video' ? { width: stream?.width, height: stream?.height } : await sharp(session.source.path).metadata();
    if (!dimensions.width || !dimensions.height) throw new UserInputError('Resolusi sumber tidak dapat dibaca.');
    const duration = await resolveToVideoDuration(session, tools, sourceInfo);

    const baseFrame = path.join(work, 'base.png');
    if (sourceKind === 'image') await sharp(session.source.path).rotate().png().toFile(baseFrame);
    else await runTool(tools.ffmpeg, ['-y', '-i', session.source.path, '-frames:v', '1', baseFrame]);
    const baseMeta = await sharp(baseFrame).metadata();
    const matches = [];
    for (const [index, sticker] of session.stickers.entries()) {
      await onProgress(5 + Math.round(index * 12 / Math.max(1, session.stickers.length)), `Mencocokkan stiker ${index + 1}/${session.stickers.length}`);
      const decoded = await decodeStickerFrames(sticker.path);
      const match = await matchSticker(baseFrame, decoded, matches.map((item) => item.match), async (done, total) => {
        await onProgress(5 + Math.round(((index + done / total) / session.stickers.length) * 12), `Mencocokkan stiker ${index + 1}/${session.stickers.length}`);
      });
      if (!match) throw new UserInputError(`Stiker ${index + 1} tidak dapat dicocokkan dengan sumber. Kirim sumber atau stiker yang sesuai, lalu konfirmasi lagi.`);
      matches.push({ decoded, match });
    }
    const maskPath = path.join(work, 'mask.png');
    const stickerInputs = [];
    if (matches.length) {
      const masks = [];
      for (const [index, item] of matches.entries()) {
        const { decoded, match } = item;
        const frames = [];
        for (const [frameIndex, frame] of decoded.frames.entries()) {
          const png = path.join(work, `sticker-${index}-${frameIndex}.png`);
          await transformSticker(frame.data, decoded.width, decoded.height, match, png);
          frames.push({ png, delay: frame.delay });
        }
        const listPath = path.join(work, `sticker-${index}.txt`);
        const lines = frames.flatMap((frame) => [`file '${frame.png}'`, `duration ${(frame.delay / 1000).toFixed(3)}`]);
        lines.push(`file '${frames.at(-1).png}'`);
        await fs.writeFile(listPath, `${lines.join('\n')}\n`);
        stickerInputs.push({ listPath, match, index });
        const mask = await stickerMask(frames.map((frame) => frame.png), match.left, match.top, baseMeta.width, baseMeta.height);
        if (mask) masks.push(mask);
      }
      await sharp({ create: { width: baseMeta.width, height: baseMeta.height, channels: 3, background: '#000000' } })
        .composite(masks.map(({ input, left, top }) => ({ input, left, top, blend: 'add' })))
        .png().toFile(maskPath);
    }
    await onProgress(18, 'Membuat video');
    const inputArgs = sourceKind === 'image'
      ? ['-loop', '1', '-i', baseFrame]
      : ['-stream_loop', '-1', '-i', session.source.path];
    for (const sticker of stickerInputs) inputArgs.push('-stream_loop', '-1', '-f', 'concat', '-safe', '0', '-i', sticker.listPath);
    const musicIndex = 1 + stickerInputs.length;
    const useMusic = Boolean(session.music && session.options.format !== 'gif');
    if (useMusic) inputArgs.push('-stream_loop', '-1', '-i', session.music.path);
    const filters = [];
    const speed = session.options.speed || 1;
    let current = '[0:v]';
    if (sourceKind === 'video' && speed !== 1) {
      filters.push(`${current}setpts=(PTS-STARTPTS)/${speed}[timed]`);
      current = '[timed]';
    }
    if (matches.length) {
      filters.push(`${current}removelogo=f=${maskPath}[clean]`);
      current = '[clean]';
    }
    for (const [index, sticker] of stickerInputs.entries()) {
      let stickerStream = `[${index + 1}:v]`;
      if (speed !== 1) {
        filters.push(`${stickerStream}setpts=(PTS-STARTPTS)/${speed}[sticker${index}]`);
        stickerStream = `[sticker${index}]`;
      }
      filters.push(`${current}${stickerStream}overlay=${sticker.match.left}:${sticker.match.top}:shortest=0:eof_action=repeat[v${index}]`);
      current = `[v${index}]`;
    }
    filters.push(`${current}pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p[vout]`);
    const sourceAudio = sourceKind === 'video' && sourceInfo?.streams?.some((item) => item.codec_type === 'audio') && !session.options.mute && session.options.format !== 'gif';
    const tempo = speed > 2 ? `atempo=2,atempo=${speed / 2}`
      : speed < 0.5 ? `atempo=0.5,atempo=${speed * 2}` : `atempo=${speed}`;
    const sourceAudioFilter = `[0:a]${speed !== 1 ? `${tempo},` : ''}volume=${session.options.videoVolume / 100}[va]`;
    if (sourceAudio) filters.push(sourceAudioFilter);
    if (sourceAudio && useMusic) {
      filters.push(`[${musicIndex}:a]volume=${session.options.musicVolume / 100}[ma]`);
      filters.push('[va][ma]amix=inputs=2:duration=longest:dropout_transition=0,alimiter=limit=0.95[aout]');
    } else if (sourceAudio) filters.push('[va]anull[aout]');
    else if (useMusic) filters.push(`[${musicIndex}:a]volume=${session.options.musicVolume / 100}[aout]`);
    const crf = Math.min(40, Math.round(14 + (100 - session.options.quality) * 0.24 + attempt * 7));
    const args = ['-y', ...inputArgs, '-filter_complex', filters.join(';'), '-map', '[vout]'];
    if (sourceAudio || useMusic) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k');
    else args.push('-an');
    args.push('-t', String(duration), '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', output);
    await runFfmpegProgress(tools.ffmpeg, args, duration, async (fraction) => onProgress(18 + Math.min(72, Math.floor(fraction * 72)), 'Membuat video'));
    await onProgress(92, 'Video siap dikirim');
    return output;
  } catch (error) {
    await cleanupFiles([output]);
    throw error;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

async function transformSticker(data, width, height, match, target) {
  await sharp(data, { raw: { width, height, channels: 4 } })
    .resize(match.width, match.height, { fit: 'fill' })
    .rotate(match.angle, { background: '#00000000' })
    .png().toFile(target);
}

async function stickerMask(framePaths, left, top, canvasWidth, canvasHeight) {
  const meta = await sharp(framePaths[0]).metadata();
  const union = Buffer.alloc(meta.width * meta.height);
  for (const framePath of framePaths) {
    const alpha = await sharp(framePath).extractChannel('alpha').raw().toBuffer();
    for (let index = 0; index < union.length; index++) union[index] = Math.max(union[index], alpha[index]);
  }
  const sourceLeft = Math.max(0, -left);
  const sourceTop = Math.max(0, -top);
  const targetLeft = Math.max(0, left);
  const targetTop = Math.max(0, top);
  const width = Math.min(meta.width - sourceLeft, canvasWidth - targetLeft);
  const height = Math.min(meta.height - sourceTop, canvasHeight - targetTop);
  if (width <= 0 || height <= 0) return null;
  const edgeMargin = Math.min(4, Math.max(1.2, Math.max(meta.width, meta.height) * 0.006));
  const input = await sharp(union, { raw: { width: meta.width, height: meta.height, channels: 1 } })
    .blur(edgeMargin)
    .threshold(8)
    .extract({ left: sourceLeft, top: sourceTop, width, height })
    .png().toBuffer();
  return { input, left: targetLeft, top: targetTop };
}

function runFfmpegProgress(command, args, duration, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errorText = '';
    let last = -1;
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const lines = output.split(/\r?\n/);
      output = lines.pop() || '';
      for (const line of lines) {
        const match = line.match(/^out_time_ms=(\d+)$/);
        if (!match) continue;
        const percent = Math.min(1, Number(match[1]) / 1_000_000 / duration);
        const whole = Math.floor(percent * 100);
        if (whole >= last + 2) { last = whole; Promise.resolve(onProgress(percent)).catch(() => {}); }
      }
    });
    child.stderr.on('data', (chunk) => { errorText = (errorText + chunk.toString()).slice(-4000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg gagal (${code}): ${errorText.slice(-1000)}`)));
  });
}
