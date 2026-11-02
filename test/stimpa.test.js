import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import webp from 'node-webpmux';
import { StimpaSessions, extractOverlay } from '../src/stimpa.js';
import { decodeStickerFrames } from '../src/sticker.js';
import { PUBLIC_COMMANDS } from '../src/commandAccess.js';

async function animatedSticker(file) {
  const frames = [];
  for (const color of ['#e63946', '#4169e1']) {
    const buffer = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#00000000' } })
      .composite([{ input: Buffer.from(`<svg width="32" height="32"><rect width="32" height="32" fill="${color}"/></svg>`), left: 16, top: 16 }])
      .webp({ lossless: true }).toBuffer();
    frames.push(await webp.Image.generateFrame({ buffer, delay: 400, blend: false, dispose: false }));
  }
  await webp.Image.save(file, { width: 64, height: 64, frames, bgColor: [0, 0, 0, 0], loops: 0 });
}

function rgba(frame, width, x, y) {
  return [...frame.data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
}

test('public user can cancel a stimpa session with ,cancel', async () => {
  const { state, onMessageUpsert, onMessagesReaction } = await import('../src/index.js');
  const { ReactionActionStore } = await import('../src/reactionActions.js');
  const { CommandAccessStore } = await import('../src/commandAccess.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stimpa-command-'));
  const jid = 'stimpa-test@g.us';
  const actor = '628111111111@s.whatsapp.net';
  const old = { sock: state.sock, stimpaSessions: state.stimpaSessions, commandAccess: state.commandAccess,
    saveRecorder: state.saveRecorder, taskRecorder: state.taskRecorder, anticall: state.anticall,
    pdfSessions: state.pdfSessions, toVideoSessions: state.toVideoSessions, qrSessions: state.qrSessions,
    restoreSessions: state.restoreSessions, sessionPrompts: state.sessionPrompts, reactionActions: state.reactionActions };
  for (const kind of ['saveRecorder', 'taskRecorder', 'anticall', 'toVideoSessions', 'qrSessions', 'restoreSessions']) {
    state[kind] = { has: () => false, get: () => null, cancel: async () => false, finish: async () => null, end: () => null };
  }
  state.pdfSessions = { has: () => false, get: () => null, end: () => null };
  const sent = [];
  try {
    const source = path.join(dir, 'source.webp');
    await animatedSticker(source);
    state.sock = { user: { id: '628222222222@s.whatsapp.net' }, sendMessage: async (target, content) => { sent.push(content); return { key: { remoteJid: target, id: 'sent-1', fromMe: true } }; } };
    state.stimpaSessions = new StimpaSessions();
    state.sessionPrompts = new Map();
    state.reactionActions = new ReactionActionStore();
    state.commandAccess = new CommandAccessStore();
    state.commandAccess.data = { all: true, chats: {}, admins: [], nextAdminId: 1 };
    await state.stimpaSessions.start(jid, actor, { path: source, type: 'stickerMessage', mimetype: 'image/webp' });
    await onMessageUpsert({ messages: [{ key: { remoteJid: jid, participant: actor, id: 'cancel-1', fromMe: false }, message: { conversation: ',cancel' } }] });
    assert.equal(state.stimpaSessions.has(jid), false);
    const secondSource = path.join(dir, 'second.webp');
    const edit = path.join(dir, 'edit.png');
    await animatedSticker(secondSource);
    const { session, preview } = await state.stimpaSessions.start(jid, actor, { path: secondSource, type: 'stickerMessage', mimetype: 'image/webp' });
    await sharp(preview).composite([{ input: Buffer.from('<svg width="48" height="48"><circle cx="24" cy="24" r="18" fill="lime"/></svg>'), left: 232, top: 232 }]).png().toFile(edit);
    session.edit = { path: edit, type: 'imageMessage' };
    session.files.push(edit);
    const incoming = (participant, id, text, fromMe = false) => ({ key: { remoteJid: jid, participant, id, fromMe }, message: { conversation: text } });
    await onMessageUpsert({ messages: [incoming('other@s.whatsapp.net', 'not-owner', ',end')] });
    assert.equal(state.stimpaSessions.has(jid), true, 'another public user must not end session');
    assert.equal(state.stimpaSessions.isActor(jid, actor), true);
    await onMessageUpsert({ messages: [incoming(actor, 'end-1', ',end')] });
    assert.equal(state.stimpaSessions.has(jid), false, 'session owner can end via command');
    const thirdSource = path.join(dir, 'third.webp');
    await animatedSticker(thirdSource);
    await state.stimpaSessions.start(jid, actor, { path: thirdSource, type: 'stickerMessage', mimetype: 'image/webp' });
    await onMessageUpsert({ messages: [incoming('other@s.whatsapp.net', 'stranger-cancel', ',cancel')] });
    assert.equal(state.stimpaSessions.has(jid), true);
    const admin = '628333333333@s.whatsapp.net';
    state.commandAccess.data.admins = [{ id: 1, title: 'admin', jid: admin }];
    await onMessageUpsert({ messages: [incoming(admin, 'admin-cancel', ',cancel')] });
    assert.equal(state.stimpaSessions.has(jid), false, 'configured admin can interrupt another user');
    const fourthSource = path.join(dir, 'fourth.webp');
    await animatedSticker(fourthSource);
    await state.stimpaSessions.start(jid, actor, { path: fourthSource, type: 'stickerMessage', mimetype: 'image/webp' });
    await onMessageUpsert({ messages: [incoming('628222222222@s.whatsapp.net', 'owner-cancel', ',cancel', true)] });
    assert.equal(state.stimpaSessions.has(jid), false, 'bot owner can interrupt another user');
    const fifthSource = path.join(dir, 'fifth.webp');
    await animatedSticker(fifthSource);
    await state.stimpaSessions.start(jid, actor, { path: fifthSource, type: 'stickerMessage', mimetype: 'image/webp' });
    const promptKey = { remoteJid: jid, id: 'stimpa-prompt', fromMe: true };
    state.sessionPrompts.set(jid, { key: promptKey, actorJid: actor });
    let confirmations = 0;
    state.reactionActions.register(promptKey, { actorJid: actor, scope: `session:${jid}:${actor}`,
      onConfirm: async () => { confirmations++; },
      onCancel: async () => { await state.stimpaSessions.cancel(jid, actor); } });
    const reaction = (participant, text, fromMe = false) => ({ key: promptKey, reaction: { text,
      key: { remoteJid: jid, participant, fromMe } } });
    await onMessagesReaction([reaction('other@s.whatsapp.net', '👍')]);
    assert.equal(confirmations, 0, 'ordinary users cannot control another session by reacting');
    await onMessagesReaction([reaction(admin, '👍')]);
    assert.equal(confirmations, 1, 'admin positive reaction controls session prompt');
    await onMessagesReaction([reaction(admin, '👎')]);
    assert.equal(state.stimpaSessions.has(jid), false, 'admin negative reaction cancels session');
    const sixthSource = path.join(dir, 'sixth.webp');
    await animatedSticker(sixthSource);
    const { preview: sixthPreview } = await state.stimpaSessions.start(jid, actor,
      { path: sixthSource, type: 'stickerMessage', mimetype: 'image/webp' });
    const sixthEdit = path.join(dir, 'sixth-edit.png');
    await sharp(sixthPreview).composite([{ input: Buffer.from('<svg width="40" height="40"><rect width="40" height="40" fill="lime"/></svg>'), left: 220, top: 220 }]).png().toFile(sixthEdit);
    await state.stimpaSessions.addMedia(jid, { path: sixthEdit, type: 'imageMessage', mimetype: 'image/png' });
    await onMessageUpsert({ messages: [incoming(admin, 'admin-end', ',end')] });
    assert.equal(state.stimpaSessions.has(jid), false, 'admin can complete another user session with ,end');
  } finally {
    if (state.stimpaSessions?.has(jid)) await state.stimpaSessions.cancel(jid);
    Object.assign(state, old);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('stimpa puts the edited layer over every original animation frame', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stimpa-test-'));
  const sessions = new StimpaSessions();
  try {
    const source = path.join(dir, 'source.webp');
    const edit = path.join(dir, 'edit.png');
    const result = path.join(dir, 'result.webp');
    await animatedSticker(source);
    const { session, preview } = await sessions.start('chat', 'actor', { path: source, type: 'stickerMessage', mimetype: 'image/webp' });
    await sharp(preview).composite([{
      input: Buffer.from('<svg width="48" height="48"><circle cx="24" cy="24" r="18" fill="#00ff00"/></svg>'),
      left: 232, top: 232
    }]).png().toFile(edit);
    session.edit = { path: edit, type: 'imageMessage' };
    session.files.push(edit);
    await sessions.finish('chat', 'actor', async () => {}, async (buffer) => fs.writeFile(result, buffer));
    const decoded = await decodeStickerFrames(result);
    assert.equal(decoded.frames.length, 2);
    assert.deepEqual(decoded.frames.map((frame) => frame.delay), [400, 400]);
    for (const frame of decoded.frames) {
      const drawn = rgba(frame, decoded.width, 256, 256);
      assert.ok(drawn[1] > 180 && drawn[3] > 220, `overlay pixel: ${drawn}`);
      assert.equal(rgba(frame, decoded.width, 10, 10)[3], 0);
    }
    const first = rgba(decoded.frames[0], decoded.width, 160, 160);
    const second = rgba(decoded.frames[1], decoded.width, 160, 160);
    assert.ok(first[0] > first[2], `first frame: ${first}`);
    assert.ok(second[2] > second[0], `second frame: ${second}`);
    assert.equal(sessions.has('chat'), false);
  } finally {
    await sessions.cancel('chat', 'actor');
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('stimpa stacks multiple matching canvases and skips unrelated images', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stimpa-multiple-'));
  const sessions = new StimpaSessions();
  try {
    const source = path.join(dir, 'source.webp');
    await animatedSticker(source);
    const { session, preview } = await sessions.start('multi', 'actor', { path: source, type: 'stickerMessage', mimetype: 'image/webp' });
    for (const [color, left, top] of [['lime', 220, 220], ['yellow', 280, 280]]) {
      const file = path.join(dir, `${color}.png`);
      await sharp(preview).composite([{ input: Buffer.from(`<svg width="36" height="36"><rect width="36" height="36" fill="${color}"/></svg>`), left, top }]).png().toFile(file);
      const result = await sessions.addMedia('multi', { path: file, type: 'imageMessage', mimetype: 'image/png' });
      assert.equal(result.ignored, undefined);
    }
    const unrelated = path.join(dir, 'unrelated.png');
    await sharp({ create: { width: 512, height: 512, channels: 4, background: '#101010' } }).png().toFile(unrelated);
    const rejected = await sessions.addMedia('multi', { path: unrelated, type: 'imageMessage', mimetype: 'image/png' });
    assert.equal(rejected.ignored, true);
    assert.equal(session.edits.length, 2);
    const result = path.join(dir, 'result.webp');
    await sessions.finish('multi', 'actor', async () => {}, async (buffer) => fs.writeFile(result, buffer));
    const decoded = await decodeStickerFrames(result);
    const first = decoded.frames[0];
    assert.ok(rgba(first, decoded.width, 235, 235)[1] > 130);
    assert.ok(rgba(first, decoded.width, 295, 295)[0] > 130);
  } finally {
    await sessions.cancel('multi', 'actor');
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('stimpa requires meaningful edits and keeps the session after failure', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stimpa-empty-'));
  const sessions = new StimpaSessions();
  try {
    const source = path.join(dir, 'source.webp');
    const edit = path.join(dir, 'edit.png');
    await animatedSticker(source);
    const { session, preview } = await sessions.start('chat', 'actor', { path: source, type: 'stickerMessage', mimetype: 'image/webp' });
    await fs.writeFile(edit, preview);
    session.edit = { path: edit, type: 'imageMessage' };
    session.files.push(edit);
    await assert.rejects(() => sessions.finish('chat', 'actor', async () => {}, async () => {}), /Tidak ada perubahan/);
    assert.equal(sessions.has('chat'), true);
    assert.equal(sessions.isActor('chat', 'other'), false);
    assert.equal(await sessions.cancel('chat', 'other'), false);
  } finally {
    await sessions.cancel('chat', 'actor');
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('stimpa accepts only animated stickers and is a public command', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stimpa-static-'));
  try {
    const source = path.join(dir, 'static.webp');
    await sharp({ create: { width: 64, height: 64, channels: 4, background: '#ff0000' } }).webp().toFile(source);
    const sessions = new StimpaSessions();
    await assert.rejects(() => sessions.start('chat', 'actor', { path: source, type: 'stickerMessage', mimetype: 'image/webp' }), /bergerak/);
    assert.equal(sessions.has('chat'), false);
    assert.equal(PUBLIC_COMMANDS.has('stimpa'), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('stimpa ignores small image differences from compression', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stimpa-noise-'));
  try {
    const reference = Buffer.alloc(512 * 512 * 4, 255);
    const edit = path.join(dir, 'edit.png');
    await sharp({ create: { width: 512, height: 512, channels: 4, background: '#fafafa' } }).png().toFile(edit);
    await assert.rejects(() => extractOverlay(reference, edit), /Tidak ada perubahan/);
    const art = await sharp({ create: { width: 512, height: 512, channels: 4, background: '#ffffff' } })
      .composite([{ input: Buffer.from('<svg width="260" height="260"><circle cx="130" cy="130" r="110" fill="red"/></svg>'), left: 126, top: 126 }])
      .ensureAlpha().raw().toBuffer();
    const jpeg = path.join(dir, 'reencoded.jpg');
    await sharp(art, { raw: { width: 512, height: 512, channels: 4 } }).jpeg({ quality: 82 }).toFile(jpeg);
    await assert.rejects(() => extractOverlay(art, jpeg), /Tidak ada perubahan/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
