import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { proto } from 'baileys';
import {
  STICKER_AUDIO_MIMETYPE, SoundStickerAudioCache, audioFromMedia, encodeSoundStickerWrapper, parseStickerAudioFlag, prepareStickerAudio, stickerAudioOf
} from '../src/soundSticker.js';
import { detectTools } from '../src/tools.js';
import { TEMP_DIR } from '../src/config.js';

const tmp = (name) => path.join(os.tmpdir(), `sound-sticker-${process.pid}-${Math.random().toString(36).slice(2)}-${name}`);
async function tempWritable() {
  try { await fs.mkdir(TEMP_DIR, { recursive: true }); await fs.access(TEMP_DIR, fs.constants.W_OK); return true; } catch { return false; }
}

function soundSticker() {
  const audio = proto.Message.AudioMessage.create({
    url: 'https://mmg.whatsapp.net/a', mimetype: STICKER_AUDIO_MIMETYPE, mediaKey: Buffer.alloc(32, 1), directPath: '/v/a', seconds: 3
  });
  const sticker = proto.Message.StickerMessage.create({
    url: 'https://mmg.whatsapp.net/s', mimetype: 'image/webp', mediaKey: Buffer.alloc(32, 2), directPath: '/v/s', isAnimated: true
  });
  sticker.soundAudio = audio;
  return sticker;
}

test('sound sticker survives encode/decode through field 134', () => {
  const sticker = soundSticker();
  sticker.soundEmoji = '🎵';
  const message = proto.Message.create({ stickerMessage: sticker, messageContextInfo: { messageSecret: Buffer.alloc(32, 3) } });
  const bytes = proto.Message.encode(message).finish();
  assert.equal(bytes.includes(26 * 8 + 2) && Buffer.from(bytes).indexOf(Buffer.from([0xb2, 0x08])) >= 0, true);
  const decoded = proto.Message.decode(bytes);
  assert.equal(decoded.stickerMessage.isAnimated, true);
  assert.equal(decoded.stickerMessage.soundAudio.directPath, '/v/a');
  assert.equal(decoded.stickerMessage.soundAudio.mimetype, STICKER_AUDIO_MIMETYPE);
  assert.equal(decoded.stickerMessage.soundEmoji, '🎵');
  assert.ok(decoded.messageContextInfo.messageSecret.length);
  assert.ok(stickerAudioOf({ node: decoded.stickerMessage }));
});

test('nested deviceSentMessage keeps the sticker audio', () => {
  const message = proto.Message.create({ stickerMessage: soundSticker() });
  const bytes = proto.Message.encode({ deviceSentMessage: { destinationJid: 'x@s.whatsapp.net', message } }).finish();
  const decoded = proto.Message.decode(bytes);
  assert.equal(decoded.deviceSentMessage.message.stickerMessage.soundAudio.seconds, 3);
});

test('plain sticker encoding is unchanged', () => {
  const message = proto.Message.create({ stickerMessage: proto.Message.StickerMessage.create({ url: 'u', isAnimated: true }) });
  const bytes = Buffer.from(proto.Message.encode(message).finish());
  assert.equal(bytes.toString('hex'), Buffer.from([0xd2, 0x01, 0x05, 0x0a, 0x01, 0x75, 0x68, 0x01]).toString('hex'));
  assert.equal(proto.Message.decode(bytes).stickerMessage.soundAudio, undefined);
});

test('hand-built wire layout from WhatsApp decodes as a sticker', () => {
  const sticker = proto.Message.StickerMessage.create({ url: 'w', mimetype: 'image/webp' });
  const audio = proto.Message.AudioMessage.create({ url: 'a', mediaKey: Buffer.alloc(32, 4), directPath: '/d' });
  const wrapper = encodeSoundStickerWrapper(sticker, audio, '😀');
  const context = Buffer.from(proto.Message.encode({ messageContextInfo: { messageSecret: Buffer.alloc(4) } }).finish());
  const bytes = Buffer.concat([context, Buffer.from([0xb2, 0x08]), Buffer.from([wrapper.length & 0x7f | (wrapper.length > 127 ? 0x80 : 0)]),
    ...(wrapper.length > 127 ? [Buffer.from([wrapper.length >> 7])] : []), wrapper]);
  const decoded = proto.Message.decode(bytes);
  assert.equal(decoded.stickerMessage.url, 'w');
  assert.equal(decoded.stickerMessage.soundAudio.directPath, '/d');
  assert.equal(decoded.stickerMessage.soundEmoji, '😀');
});

test('audioFromMedia rejects media without audio', async () => {
  await assert.rejects(audioFromMedia(null, {}, { type: 'documentMessage', mimetype: 'application/pdf' }), /Kirim audio/);
  await assert.rejects(audioFromMedia(null, {}, { type: 'stickerMessage', node: {} }), /tidak memiliki audio/);
});

test('parseStickerAudioFlag strips -a and --audio', () => {
  assert.deepEqual(parseStickerAudioFlag('-a judul,author q=80'), { audio: true, rest: 'judul,author q=80' });
  assert.deepEqual(parseStickerAudioFlag('judul --audio'), { audio: true, rest: 'judul' });
  assert.deepEqual(parseStickerAudioFlag('judul-a,b'), { audio: false, rest: 'judul-a,b' });
});

test('prepareStickerAudio makes a short audio-only opus file', async (t) => {
  const tools = await detectTools();
  if (!tools.ffmpeg || !tools.ffprobe) return t.skip('ffmpeg not installed');
  if (!(await tempWritable())) return t.skip('temp/ is not writable');
  const { runTool } = await import('../src/tools.js');
  const input = tmp('tone.mp4');
  await runTool(tools.ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=14', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=14', '-shortest', '-c:a', 'aac', '-c:v', 'libx264', input]);
  const audio = await prepareStickerAudio(tools, input);
  try {
    const info = JSON.parse((await runTool(tools.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', audio.path])).stdout);
    assert.deepEqual(info.streams.map((stream) => stream.codec_name), ['opus']);
    assert.ok(Number(info.format.duration) <= 10.1);
    assert.equal(info.streams[0].channels, 1);
  } finally {
    await fs.rm(input, { force: true });
    await fs.rm(audio.path, { force: true });
  }
});

test('sound sticker cache restores audio on a quoted sticker without sound', () => {
  const cache = new SoundStickerAudioCache();
  const audio = { url: 'https://x', directPath: '/a', mediaKey: Buffer.alloc(32, 1), mimetype: STICKER_AUDIO_MIMETYPE };
  const original = { key: { remoteJid: 'g@g.us', id: 'ABC', participant: 'p@s.whatsapp.net' } };
  assert.equal(cache.remember(original, { soundAudio: audio, soundEmoji: '🎵' }), true);
  assert.equal(cache.remember({ key: { remoteJid: 'g@g.us', id: 'SILENT' } }, {}), false);

  const quoted = { type: 'stickerMessage', node: {}, sourceMessage: { key: { remoteJid: 'g@g.us', id: 'ABC' } } };
  assert.equal(cache.attach(quoted), true);
  assert.equal(stickerAudioOf(quoted), audio);
  assert.equal(quoted.node.soundEmoji, '🎵');

  const other = { type: 'stickerMessage', node: {}, sourceMessage: { key: { remoteJid: 'g@g.us', id: 'NOPE' } } };
  assert.equal(cache.attach(other), false);
  assert.equal(stickerAudioOf(other), null);
});

test('sound sticker cache drops the oldest entries past its limit', () => {
  const cache = new SoundStickerAudioCache({ max: 2 });
  const node = { soundAudio: { directPath: '/a', mediaKey: Buffer.alloc(32, 1) } };
  for (const id of ['A', 'B', 'C']) cache.remember({ key: { remoteJid: 'j', id } }, node);
  assert.equal(cache.find({ remoteJid: 'j', id: 'A' }), null);
  assert.ok(cache.find({ remoteJid: 'j', id: 'C' }));
});

test('sound sticker cache can restore quoted audio after a restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sound-cache-'));
  const file = path.join(dir, 'cache.json');
  try {
    const message = { key: { remoteJid: 'g@g.us', id: 'ABC' } };
    const cache = new SoundStickerAudioCache({ file });
    cache.remember(message, soundSticker());
    await cache.save();
    const restarted = new SoundStickerAudioCache({ file });
    await restarted.load();
    const quoted = { type: 'stickerMessage', node: {}, sourceMessage: message };
    assert.equal(restarted.attach(quoted), true);
    assert.equal(stickerAudioOf(quoted).directPath, '/v/a');
    assert.deepEqual(Buffer.from(stickerAudioOf(quoted).mediaKey), Buffer.alloc(32, 1));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
