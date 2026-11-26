import fs from 'node:fs/promises';
import path from 'node:path';
import { generateWAMessage, prepareWAMessageMedia, proto } from 'baileys';
import { makeTempPath } from './config.js';
import { UserInputError } from './errors.js';
import { cleanupFiles, downloadMessageMedia } from './media.js';
import { runTool } from './tools.js';

// WhatsApp "sound stickers" are not in WAProto yet (WhiskeySockets/Baileys#2932).
// Wire layout: Message.134 { 1: Message { 26: StickerMessage { ..., 24: 0, 25: emoji?, 26: AudioMessage } } }
const SOUND_STICKER_FIELD = 134;
const WRAPPED_MESSAGE_FIELD = 1;
const STICKER_FIELD = 26;
const STICKER_UNKNOWN_INT_FIELD = 24;
const STICKER_EMOJI_FIELD = 25;
const STICKER_AUDIO_FIELD = 26;
export const STICKER_AUDIO_MIMETYPE = 'audio/ogg; codecs=opus';
const AUDIO_MAX_BYTES = 950 * 1024;
const AUDIO_MAX_MS = 10_000;
const AUDIO_BITRATES = ['64k', '48k', '32k', '24k', '16k'];
const PATCHED = Symbol.for('iro.soundStickerPatched');

function readVarint(buf, pos) {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (pos >= buf.length) throw new RangeError('varint out of range');
    const byte = buf[pos++];
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) return [value, pos];
    shift += 7;
    if (shift > 63) throw new RangeError('varint too long');
  }
}

function writeVarint(value) {
  const out = [];
  let rest = value;
  while (rest > 0x7f) {
    out.push((rest % 128) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return Buffer.from(out);
}

function lengthDelimited(field, bytes) {
  return Buffer.concat([writeVarint((field << 3) | 2), writeVarint(bytes.length), Buffer.from(bytes)]);
}

// Returns the length-delimited payloads of the given top-level field numbers.
function findFields(buf, fields) {
  const found = {};
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) {
      [, pos] = readVarint(buf, pos);
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else if (wire === 2) {
      let length;
      [length, pos] = readVarint(buf, pos);
      if (fields.includes(field) && !(field in found)) found[field] = buf.subarray(pos, pos + length);
      pos += length;
    } else {
      return found;
    }
  }
  return found;
}

export function encodeSoundStickerWrapper(sticker, audio, emoji = null) {
  const parts = [
    Buffer.from(proto.Message.StickerMessage.encode(sticker).finish()),
    writeVarint(STICKER_UNKNOWN_INT_FIELD << 3), writeVarint(0)
  ];
  if (emoji) parts.push(lengthDelimited(STICKER_EMOJI_FIELD, Buffer.from(emoji, 'utf8')));
  parts.push(lengthDelimited(STICKER_AUDIO_FIELD, proto.Message.AudioMessage.encode(audio).finish()));
  const inner = lengthDelimited(STICKER_FIELD, Buffer.concat(parts));
  return lengthDelimited(WRAPPED_MESSAGE_FIELD, inner);
}

function attachSoundSticker(message, bytes) {
  const wrapper = findFields(bytes, [SOUND_STICKER_FIELD])[SOUND_STICKER_FIELD];
  if (!wrapper) return;
  const innerBytes = findFields(wrapper, [WRAPPED_MESSAGE_FIELD])[WRAPPED_MESSAGE_FIELD];
  if (!innerBytes) return;
  const inner = proto.Message.decode(innerBytes);
  const sticker = inner.stickerMessage;
  if (!sticker) return;
  const stickerBytes = findFields(innerBytes, [STICKER_FIELD])[STICKER_FIELD];
  const extra = stickerBytes ? findFields(stickerBytes, [STICKER_EMOJI_FIELD, STICKER_AUDIO_FIELD]) : {};
  if (extra[STICKER_AUDIO_FIELD]) sticker.soundAudio = proto.Message.AudioMessage.decode(extra[STICKER_AUDIO_FIELD]);
  if (extra[STICKER_EMOJI_FIELD]) sticker.soundEmoji = Buffer.from(extra[STICKER_EMOJI_FIELD]).toString('utf8');
  if (!message.stickerMessage) message.stickerMessage = sticker;
}

export function installSoundStickerProto(root = proto) {
  const Message = root.Message;
  if (Message[PATCHED]) return;
  const originalEncode = Message.encode;
  const originalDecode = Message.decode;

  Message.encode = function encode(message, writer) {
    const sticker = message?.stickerMessage;
    if (!sticker?.soundAudio) return originalEncode.call(this, message, writer);
    const rest = Object.assign(Object.create(Object.getPrototypeOf(message)), message);
    delete rest.stickerMessage;
    const out = originalEncode.call(this, rest, writer);
    out.uint32((SOUND_STICKER_FIELD << 3) | 2).bytes(encodeSoundStickerWrapper(sticker, sticker.soundAudio, sticker.soundEmoji));
    return out;
  };

  Message.decode = function decode(reader, length, end) {
    let bytes = null;
    if (reader instanceof Uint8Array) bytes = reader;
    else if (reader?.buf) bytes = reader.buf.subarray(reader.pos, length === undefined ? reader.len : reader.pos + length);
    const message = originalDecode.call(this, reader, length, end);
    if (bytes && !message.stickerMessage) {
      try {
        attachSoundSticker(message, bytes);
      } catch {
        // Unknown layout: keep the regular decode result.
      }
    }
    return message;
  };
  Message[PATCHED] = true;
}

installSoundStickerProto();

export function stickerAudioOf(media) {
  const audio = media?.node?.soundAudio;
  return audio?.mediaKey?.length && (audio.directPath || audio.url) ? audio : null;
}

export async function downloadStickerAudio(sock, media, prefix = 'sticker-audio') {
  const audio = stickerAudioOf(media);
  if (!audio) return null;
  const key = media.sourceMessage?.key || { id: `sound-${Date.now()}` };
  return downloadMessageMedia(sock, { key, message: { audioMessage: audio } }, prefix);
}

export async function hasAudioStream(tools, inputPath) {
  if (!tools?.ffprobe) return false;
  try {
    const result = await runTool(tools.ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', inputPath]);
    return Boolean(String(result.stdout || '').trim());
  } catch {
    return false;
  }
}

async function audioSeconds(tools, file) {
  if (!tools?.ffprobe) return null;
  try {
    const result = await runTool(tools.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
    const seconds = Number(String(result.stdout || '').trim());
    return Number.isFinite(seconds) ? Math.max(1, Math.round(seconds)) : null;
  } catch {
    return null;
  }
}

// Opus in Ogg, audio only (cover art streams stop the sticker from playing).
export async function prepareStickerAudio(tools, inputPath, { maxMs = AUDIO_MAX_MS } = {}) {
  if (!tools?.ffmpeg) throw new UserInputError('FFmpeg diperlukan untuk stiker beraudio.');
  if (!(await hasAudioStream(tools, inputPath)) && tools.ffprobe) throw new UserInputError('Media tidak memiliki audio.');
  for (const bitrate of AUDIO_BITRATES) {
    const output = makeTempPath('sticker-audio', '.ogg');
    try {
      await runTool(tools.ffmpeg, [
        '-y', '-i', inputPath,
        '-t', String(maxMs / 1000),
        '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '48000',
        '-c:a', 'libopus', '-b:a', bitrate, '-application', 'audio',
        '-map_metadata', '-1', '-f', 'ogg', output
      ]);
      const stat = await fs.stat(output);
      if (stat.size <= AUDIO_MAX_BYTES) return { path: output, seconds: await audioSeconds(tools, output) };
    } catch (error) {
      await cleanupFiles([output]);
      throw error;
    }
    await cleanupFiles([output]);
  }
  throw new UserInputError('Audio terlalu besar untuk stiker WhatsApp.');
}

export async function sendSoundSticker(sock, jid, sticker, audio, { isAnimated, messageId, quoted } = {}) {
  const upload = sock.waUploadToServer;
  const userJid = sock.authState?.creds?.me?.id || sock.user?.id;
  const audioBuffer = await fs.readFile(audio.path);
  const [message, prepared] = await Promise.all([
    generateWAMessage(jid, { sticker, isAnimated: isAnimated || undefined }, { upload, userJid, messageId, quoted }),
    prepareWAMessageMedia({ audio: audioBuffer, mimetype: STICKER_AUDIO_MIMETYPE, ptt: false, seconds: audio.seconds || undefined }, { upload })
  ]);
  const audioMessage = prepared.audioMessage;
  audioMessage.mimetype = STICKER_AUDIO_MIMETYPE;
  audioMessage.ptt = false;
  message.message.stickerMessage.soundAudio = audioMessage;
  await sock.relayMessage(jid, message.message, { messageId: message.key.id });
  return message;
}

export function isAudioSourceMedia(media) {
  if (!media) return false;
  if (media.type === 'stickerMessage') return Boolean(stickerAudioOf(media));
  return media.type === 'audioMessage' || media.type === 'videoMessage' || /^(audio|video)\//i.test(media.mimetype || '');
}

// Turns a downloaded audio, voice note, video or sound sticker into sticker audio.
// The caller still owns media.path.
export async function audioFromMedia(sock, tools, media) {
  if (!isAudioSourceMedia(media)) {
    throw new UserInputError(media?.type === 'stickerMessage' ? 'Stiker ini tidak memiliki audio.' : 'Kirim audio, voice note, video, atau stiker beraudio.');
  }
  let source = media;
  try {
    if (media.type === 'stickerMessage') {
      source = await downloadStickerAudio(sock, media);
      if (!source) throw new UserInputError('Audio stiker tidak bisa diunduh.');
      const seconds = Number(stickerAudioOf(media).seconds);
      const { size } = await fs.stat(source.path);
      if (seconds > 0 && seconds <= AUDIO_MAX_MS / 1000 && size <= AUDIO_MAX_BYTES) {
        const file = await fs.open(source.path, 'r');
        const header = Buffer.alloc(64);
        try { await file.read(header); } finally { await file.close(); }
        if (header.toString('ascii', 0, 4) === 'OggS' && header.includes('OpusHead')) {
          const audio = { path: source.path, seconds };
          source = media;
          return audio;
        }
      }
    }
    return await prepareStickerAudio(tools, source.path);
  } finally {
    if (source !== media) await cleanupFiles([source?.path]);
  }
}

export function parseStickerAudioFlag(rawArgs) {
  const raw = String(rawArgs || '');
  const pattern = /(?:^|\s)(?:-a|--audio)(?=\s|$)/gi;
  const audio = pattern.test(raw);
  return { audio, rest: raw.replace(pattern, ' ').replace(/\s+/g, ' ').trim() };
}

// A reply's quotedMessage carries the sticker but usually not its sound (field 134 is
// dropped from the quote), so keep the audio of every sound sticker the bot sees and
// look it up by the quoted stanza id.
export class SoundStickerAudioCache {
  constructor({ max = 500, ttlMs = 24 * 60 * 60 * 1000, file = null, onError } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.entries = new Map();
    this.file = file;
    this.onError = onError;
    this.pending = Promise.resolve();
  }

  async load() {
    if (!this.file) return;
    try {
      const entries = JSON.parse(await fs.readFile(this.file, 'utf8'));
      for (const { id, audio, emoji, seenAt } of entries.slice(-this.max)) {
        if (!id || !Number.isFinite(seenAt) || Date.now() - seenAt > this.ttlMs) continue;
        this.entries.set(id, { audio: proto.Message.AudioMessage.decode(Buffer.from(audio, 'base64')), emoji, seenAt });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') await this.onError?.(error);
    }
  }

  save() {
    clearTimeout(this.timer);
    if (!this.file) return this.pending;
    this.pending = this.pending.catch(() => {}).then(async () => {
      const entries = [];
      for (const [id, { audio, emoji, seenAt }] of this.entries) {
        if (Date.now() - seenAt > this.ttlMs) continue;
        entries.push({ id, emoji, seenAt, audio: Buffer.from(proto.Message.AudioMessage.encode(audio).finish()).toString('base64') });
      }
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(temp, JSON.stringify(entries), { mode: 0o600 });
      await fs.rename(temp, this.file);
    });
    return this.pending;
  }

  static keyOf(key) {
    return key?.remoteJid && key?.id ? `${key.remoteJid}|${key.id}` : null;
  }

  remember(message, stickerNode) {
    const audio = stickerAudioOf({ node: stickerNode });
    const id = SoundStickerAudioCache.keyOf(message?.key);
    if (!audio || !id) return false;
    this.entries.delete(id);
    this.entries.set(id, { audio, emoji: stickerNode.soundEmoji || null, seenAt: Date.now() });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value);
    if (this.file) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.save().catch((error) => this.onError?.(error)), 500);
      this.timer.unref?.();
    }
    return true;
  }

  find(key) {
    const id = SoundStickerAudioCache.keyOf(key);
    const entry = id ? this.entries.get(id) : null;
    if (!entry) return null;
    if (Date.now() - entry.seenAt > this.ttlMs) { this.entries.delete(id); return null; }
    return entry;
  }

  // Gives a downloaded sticker without sound the cached sound of the same message.
  attach(media) {
    if (media?.type !== 'stickerMessage' || !media.node || stickerAudioOf(media)) return Boolean(stickerAudioOf(media));
    const entry = this.find(media.sourceMessage?.key);
    if (!entry) return false;
    media.node.soundAudio = entry.audio;
    if (entry.emoji && !media.node.soundEmoji) media.node.soundEmoji = entry.emoji;
    return true;
  }
}
