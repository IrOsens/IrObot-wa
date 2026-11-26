import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ImportantStore, ImportantVault } from '../src/importantStore.js';
import { ImportantAuth, generateKey, normalizeKey } from '../src/importantAuth.js';
import { ImportantRecorder, normalizeMessage } from '../src/importantRecorder.js';
import { ImportantWeb } from '../src/importantWeb.js';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'important-'));
}

async function makeStore() {
  const dir = await tempDir();
  const vault = await new ImportantVault(path.join(dir, 'secret.json')).load();
  return { dir, vault, store: new ImportantStore(path.join(dir, 'root'), vault) };
}

const DAY = 86_400_000;

test('vault encrypts with a fresh IV and keeps its key across loads', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'secret.json');
  const vault = await new ImportantVault(file).load();
  const a = vault.encrypt(Buffer.from('halo'));
  const b = vault.encrypt(Buffer.from('halo'));
  assert.notDeepEqual(a, b);
  const again = await new ImportantVault(file).load();
  assert.equal(again.decrypt(a).toString(), 'halo');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('store writes no plaintext and folds edits, deletes and reactions into messages', async () => {
  const { store, dir } = await makeStore();
  const chat = '628111@s.whatsapp.net';
  const ts = Date.parse('2026-11-20T10:00:00+07:00');
  await store.append(1, { t: 'msg', id: 'A', chat, ts, sender: chat, fromMe: false, kind: 'text', text: 'rahasia banget', pushName: 'Budi' });
  await store.append(1, { t: 'msg', id: 'B', chat, ts: ts + 1000, sender: 'me', fromMe: true, kind: 'text', text: 'oke' });
  await store.append(1, { t: 'edit', id: 'A', chat, ts: ts + 2000, sender: chat, text: 'rahasia diedit' });
  await store.append(1, { t: 'react', id: 'B', chat, ts: ts + 3000, sender: chat, emoji: '❤️' });
  await store.append(1, { t: 'del', id: 'B', chat, ts: ts + 4000, sender: 'me' });
  await store.flush();

  const files = await fs.readdir(path.join(dir, 'root', '1', 'messages'));
  for (const name of files) {
    const raw = await fs.readFile(path.join(dir, 'root', '1', 'messages', name), 'utf8');
    assert.equal(raw.includes('rahasia'), false);
  }
  const index = await fs.readFile(path.join(dir, 'root', '1', 'chats.enc'));
  assert.equal(index.includes(Buffer.from('Budi')), false);

  const fresh = new ImportantStore(path.join(dir, 'root'), store.vault);
  const list = await fresh.messages(1, chat);
  assert.deepEqual(list.map((item) => item.id), ['A', 'B']);
  assert.equal(list[0].text, 'rahasia diedit');
  assert.ok(list[0].edited);
  assert.deepEqual(list[0].history.map((item) => item.text), ['rahasia banget']);
  assert.equal(list[1].reactions[chat], '❤️');
  assert.ok(list[1].deleted);
  const [summary] = await fresh.chats(1);
  assert.equal(summary.jid, chat);
  assert.equal(summary.displayName, 'Budi');
});

test('media is stored encrypted and read back', async () => {
  const { store, dir } = await makeStore();
  const id = await store.saveMedia(2, Date.now(), Buffer.from('PNGDATA-plain'));
  const day = id.split('_')[0];
  const raw = await fs.readFile(path.join(dir, 'root', '2', 'media', day, `${id}.bin`));
  assert.equal(raw.includes(Buffer.from('PNGDATA')), false);
  assert.equal((await store.readMedia(2, id)).toString(), 'PNGDATA-plain');
  assert.equal(await store.readMedia(2, '../../secret'), null);
});

test('purgeOlderThan removes old days and their chats; purgeAll empties the worker', async () => {
  const { store, dir } = await makeStore();
  const now = Date.parse('2026-11-26T12:00:00+07:00');
  const old = '6281@s.whatsapp.net';
  const recent = '6282@s.whatsapp.net';
  await store.append(3, { t: 'msg', id: 'O', chat: old, ts: now - 10 * DAY, sender: old, kind: 'text', text: 'lama' });
  const oldMedia = await store.saveMedia(3, now - 10 * DAY, Buffer.from('x'));
  await store.append(3, { t: 'msg', id: 'R', chat: recent, ts: now - DAY, sender: recent, kind: 'text', text: 'baru' });
  const removed = await store.purgeOlderThan(3, 7, now);
  assert.equal(removed, 1);
  assert.equal(await store.readMedia(3, oldMedia), null);
  assert.deepEqual((await store.chats(3)).map((chat) => chat.jid), [recent]);
  assert.equal((await store.messages(3, old)).length, 0);
  assert.equal((await store.messages(3, recent)).length, 1);

  await store.purgeAll(3);
  await assert.rejects(fs.access(path.join(dir, 'root', '3')));
  assert.equal((await store.chats(3)).length, 0);
});

test('normalizeMessage reads text, media, edits, deletes and reactions', () => {
  const base = { key: { remoteJid: '628@s.whatsapp.net', id: 'X1', fromMe: false }, messageTimestamp: 1_700_000_000, pushName: 'Ani' };
  const text = normalizeMessage({ ...base, message: { conversation: 'halo' } });
  assert.equal(text.t, 'msg');
  assert.equal(text.kind, 'text');
  assert.equal(text.text, 'halo');
  assert.equal(text.ts, 1_700_000_000_000);

  const image = normalizeMessage({ ...base, message: { imageMessage: { mimetype: 'image/jpeg', caption: 'foto', fileLength: 1234 } } });
  assert.equal(image.kind, 'image');
  assert.equal(image.media.size, 1234);
  assert.equal(image.text, 'foto');

  const voice = normalizeMessage({ ...base, message: { audioMessage: { ptt: true, seconds: 3 } } });
  assert.equal(voice.kind, 'voice');

  const del = normalizeMessage({ ...base, message: { protocolMessage: { type: 0, key: { id: 'X0' } } } });
  assert.deepEqual([del.t, del.id], ['del', 'X0']);

  const edit = normalizeMessage({ ...base, message: { protocolMessage: { type: 14, key: { id: 'X0' }, editedMessage: { conversation: 'baru' } } } });
  assert.deepEqual([edit.t, edit.text], ['edit', 'baru']);

  const react = normalizeMessage({ ...base, message: { reactionMessage: { key: { id: 'X0' }, text: '👍' } } });
  assert.deepEqual([react.t, react.emoji], ['react', '👍']);

  assert.equal(normalizeMessage({ ...base, key: { ...base.key, remoteJid: 'status@broadcast' }, message: { conversation: 'x' } }), null);
  assert.equal(normalizeMessage({ ...base, message: { protocolMessage: { type: 3 } } }), null);
});

test('recorder stores incoming and outgoing (append) messages with media once', async () => {
  const { store } = await makeStore();
  let downloads = 0;
  const recorder = new ImportantRecorder({
    store,
    fetchImpl: async () => ({ ok: false }),
    downloadMedia: async () => { downloads += 1; return { buffer: Buffer.from('img'), mimetype: 'image/jpeg' }; }
  });
  const sock = { profilePictureUrl: async () => null, groupMetadata: async () => ({}) };
  const chat = '628@s.whatsapp.net';
  const incoming = { key: { remoteJid: chat, id: 'I1', fromMe: false }, messageTimestamp: 1_700_000_000, pushName: 'Ani', message: { imageMessage: { mimetype: 'image/jpeg' } } };
  const outgoing = { key: { remoteJid: chat, id: 'O1', fromMe: true }, messageTimestamp: 1_700_000_010, message: { conversation: 'siap' } };
  await recorder.record(5, sock, { type: 'notify', messages: [incoming] });
  await recorder.record(5, sock, { type: 'notify', messages: [incoming] });
  await recorder.record(5, sock, { type: 'append', messages: [outgoing] });
  const list = await store.messages(5, chat);
  assert.deepEqual(list.map((item) => [item.id, item.fromMe]), [['I1', false], ['O1', true]]);
  assert.equal(downloads, 1);
  assert.equal((await store.readMedia(5, list[0].media.id)).toString(), 'img');
  assert.equal((await store.contacts(5))[chat], 'Ani');
});

test('auth shows a key once, verifies it loosely, rate limits and resets', async () => {
  const dir = await tempDir();
  let now = 1_000_000;
  const file = path.join(dir, 'auth.json');
  const auth = await new ImportantAuth(file, { now: () => now }).load();
  assert.equal(auth.hasKey(), false);
  const key = await auth.createKey();
  assert.match(key, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){5}$/);
  assert.equal((await fs.readFile(file, 'utf8')).includes(normalizeKey(key)), false);

  const { token } = await auth.login(key.toLowerCase().replaceAll('-', ' '), 'ip1');
  assert.ok(auth.check(token));
  const reloaded = await new ImportantAuth(file, { now: () => now }).load();
  assert.ok(reloaded.check(token), 'session survives restart');

  for (let i = 0; i < 5; i += 1) assert.equal((await auth.login('salah', 'ip2')).token, undefined);
  assert.ok((await auth.login(key, 'ip2')).retryAfter > 0, 'blocked after 5 failures');
  now += 16 * 60 * 1000;
  assert.ok((await auth.login(key, 'ip2')).token, 'unblocked after window');

  const next = await auth.createKey();
  assert.notEqual(next, key);
  assert.equal(auth.check(token), false, 'reset logs out old sessions');
  assert.equal(auth.verify(key), false);
  assert.ok(auth.verify(next));
  assert.notEqual(generateKey(), generateKey());
});

test('web UI requires the key and only serves important workers', async () => {
  const { store } = await makeStore();
  const dir = await tempDir();
  const auth = await new ImportantAuth(path.join(dir, 'auth.json')).load();
  const key = await auth.createKey();
  let retention = false;
  const exported = [];
  const web = new ImportantWeb({
    auth,
    store,
    exportSticker: async (image, audio) => {
      exported.push([image.toString(), audio?.toString() || null]);
      return audio ? { buffer: Buffer.from('mp4'), mimetype: 'video/mp4', ext: 'mp4' } : { buffer: Buffer.from('gif'), mimetype: 'image/gif', ext: 'gif' };
    },
    port: 0,
    host: '127.0.0.1',
    workers: {
      isImportant: (id) => Number(id) === 7,
      list: async () => [{ id: 7, name: 'W', phone: '62', status: 'online' }],
      avatar: async () => null,
      retention: () => retention,
      setRetention: async (_, value) => { retention = value; }
    }
  });
  web.port = 0;
  await web.start();
  const { port } = web.server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/api/workers`)).status, 401);
    assert.equal((await fetch(`${base}/`)).status, 200);
    const headers = { 'X-Requested-With': 'iw', 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${base}/api/login`, { method: 'POST', headers, body: JSON.stringify({ key: 'nope' }) })).status, 401);
    assert.equal((await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) })).status, 403);
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers, body: JSON.stringify({ key }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    const auth1 = { cookie };
    assert.equal((await (await fetch(`${base}/api/workers`, { headers: auth1 })).json()).workers[0].id, 7);
    assert.equal((await fetch(`${base}/api/w/8/chats`, { headers: auth1 })).status, 404);

    const chat = '628@s.whatsapp.net';
    const mediaId = await store.saveMedia(7, Date.now(), Buffer.from('hello media'));
    await store.append(7, { t: 'msg', id: 'M', chat, ts: Date.now(), sender: chat, kind: 'document', text: '', media: { id: mediaId } });
    const chats = await (await fetch(`${base}/api/w/7/chats`, { headers: auth1 })).json();
    assert.equal(chats.chats[0].jid, chat);
    const messages = await (await fetch(`${base}/api/w/7/chats/${encodeURIComponent(chat)}/messages`, { headers: auth1 })).json();
    assert.equal(messages.messages[0].id, 'M');
    const media = await fetch(`${base}/api/w/7/media/${mediaId}`, { headers: { ...auth1, range: 'bytes=0-4' } });
    assert.equal(media.status, 206);
    assert.equal(await media.text(), 'hello');

    const stickerId = await store.saveMedia(7, Date.now(), Buffer.from('webp'));
    const soundId = await store.saveMedia(7, Date.now(), Buffer.from('ogg'));
    const asVideo = await fetch(`${base}/api/w/7/sticker/${stickerId}?audio=${soundId}`, { headers: auth1 });
    assert.equal(asVideo.headers.get('content-type'), 'video/mp4');
    assert.match(asVideo.headers.get('content-disposition'), /attachment; filename="sticker-.+\.mp4"/);
    const asGif = await fetch(`${base}/api/w/7/sticker/${stickerId}`, { headers: auth1 });
    assert.equal(asGif.headers.get('content-type'), 'image/gif');
    assert.deepEqual(exported, [['webp', 'ogg'], ['webp', null]]);
    assert.equal((await fetch(`${base}/api/w/7/sticker/${stickerId}`)).status, 401);

    await store.append(7, { t: 'msg', id: 'T', chat, ts: Date.now() + 1, sender: chat, pushName: 'Budi', kind: 'text', text: 'halo' });
    const txt = await fetch(`${base}/api/w/7/chats/${encodeURIComponent(chat)}/export`, { headers: auth1 });
    assert.equal(txt.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.match(txt.headers.get('content-disposition'), /attachment; filename="chat-.+\.txt"/);
    assert.match(await txt.text(), /\] Budi : halo/);
    const off = await fetch(`${base}/api/w/7/chats/${encodeURIComponent(chat)}/logging`, { method: 'PUT', headers: { ...headers, ...auth1 }, body: JSON.stringify({ enabled: false }) });
    assert.deepEqual(await off.json(), { ok: true, logging: false });
    assert.equal(await store.isPaused(7, chat), true);

    const put = await fetch(`${base}/api/w/7/retention`, { method: 'PUT', headers: { ...headers, ...auth1 }, body: JSON.stringify({ enabled: true }) });
    assert.equal(put.status, 200);
    assert.equal(retention, true);
    assert.equal((await fetch(`${base}/api/w/7/data`, { method: 'DELETE', headers: { ...headers, ...auth1 } })).status, 200);
    assert.equal((await (await fetch(`${base}/api/w/7/chats`, { headers: auth1 })).json()).chats.length, 0);

    await auth.createKey();
    assert.equal((await fetch(`${base}/api/workers`, { headers: auth1 })).status, 401);
  } finally {
    await web.stop();
  }
});

test('sound sticker keeps its audio as a second encrypted media file', async () => {
  const { store } = await makeStore();
  const recorder = new ImportantRecorder({
    store,
    fetchImpl: async () => ({ ok: false }),
    downloadMedia: async () => ({ buffer: Buffer.from('webp'), mimetype: 'image/webp', audio: { buffer: Buffer.from('ogg'), mimetype: 'audio/ogg' } })
  });
  const chat = '628@s.whatsapp.net';
  const message = { key: { remoteJid: chat, id: 'S1', fromMe: false }, messageTimestamp: 1_700_000_000, message: { stickerMessage: { mimetype: 'image/webp', soundAudio: { seconds: 4 } } } };
  await recorder.record(6, null, { type: 'notify', messages: [message] });
  const [saved] = await store.messages(6, chat);
  assert.equal(saved.media.sound, true);
  assert.equal(saved.media.soundSeconds, 4);
  assert.equal((await store.readMedia(6, saved.media.audioId)).toString(), 'ogg');
  assert.match((await store.chats(6))[0].lastPreview, /🔊/);
});

test('exportText writes [time] name : message with media as labels', async () => {
  const { store } = await makeStore();
  const group = '120@g.us';
  const ts = Date.UTC(2026, 10, 26, 7, 5); // 14:05 WIB
  await store.setContact(3, '628111@s.whatsapp.net', 'Ani');
  await store.updateChat(3, group, { name: 'Keluarga' });
  await store.append(3, { t: 'msg', id: 'A', chat: group, ts, sender: '628111@s.whatsapp.net', kind: 'text', text: 'halo\nsemua' });
  await store.append(3, { t: 'msg', id: 'B', chat: group, ts: ts + 1000, sender: '99@lid', pushName: 'Budi', kind: 'sticker', text: '', media: {} });
  await store.append(3, { t: 'msg', id: 'C', chat: group, ts: ts + 2000, sender: 'me', fromMe: true, kind: 'video', text: 'lihat', media: {} });
  await store.append(3, { t: 'msg', id: 'D', chat: group, ts: ts + 3000, sender: '6281234567@s.whatsapp.net', kind: 'document', text: '', media: { fileName: 'a.pdf' } });
  await store.append(3, { t: 'del', id: 'D', chat: group, ts: ts + 4000, sender: '6281234567@s.whatsapp.net' });
  const { title, text } = await store.exportText(3, group, { meName: 'Worker X' });
  assert.equal(title, 'Keluarga');
  const rows = text.split('\n').filter((row) => row.startsWith('['));
  assert.deepEqual(rows, [
    '[26/11/2026 14:05] Ani : halo',
    '[26/11/2026 14:05] Budi : [stiker]',
    '[26/11/2026 14:05] Worker X : [video] lihat',
    '[26/11/2026 14:05] +6281234567 : [dokumen: a.pdf] (dihapus)'
  ]);
  assert.match(text, /\n  semua\n/);
});

test('recorder skips chats whose logging is switched off', async () => {
  const { store } = await makeStore();
  let downloads = 0;
  const recorder = new ImportantRecorder({ store, fetchImpl: async () => ({ ok: false }), downloadMedia: async () => { downloads += 1; return { buffer: Buffer.from('x') }; } });
  const sock = { profilePictureUrl: async () => null, groupMetadata: async () => ({}) };
  const chat = '628@s.whatsapp.net';
  const message = (id) => ({ key: { remoteJid: chat, id, fromMe: false }, messageTimestamp: 1_700_000_000, message: { imageMessage: { mimetype: 'image/jpeg' } } });
  await store.setLogging(9, chat, false);
  await recorder.record(9, sock, { type: 'notify', messages: [message('P1')] });
  assert.equal((await store.messages(9, chat)).length, 0);
  assert.equal(downloads, 0);
  await store.setLogging(9, chat, true);
  await recorder.record(9, sock, { type: 'notify', messages: [message('P2')] });
  assert.deepEqual((await store.messages(9, chat)).map((item) => item.id), ['P2']);
});
