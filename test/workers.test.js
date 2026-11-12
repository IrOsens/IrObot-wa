import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorkerStore, formatWorkerInfo, formatWorkerList } from '../src/workers.js';
import {
  CINTA_DELAY_MS,
  DEFAULT_CINTA_CAPTION,
  ReplyLimiter,
  WORKER_COMMAND_DELAY_MS,
  WORKER_REPLY_KEY,
  matchCintaTrigger,
  matchReactionTrigger,
  parseReactionTriggers,
  parseCintaTriggers,
  parseReactionEmoji,
  workerCommandAllowed
} from '../src/workerServices.js';
import { UserInputError } from '../src/errors.js';
import { state, workerRuntimes, workerScope, createWorkerScope, onWorkerMessageUpsert, onWorkerReactions, onMessageUpsert } from '../src/index.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'iro-workers-'));
const workerPhone = '628111111111@s.whatsapp.net';
const customer = '628222222222@s.whatsapp.net';

test('cinta trigger matches the exact text, all lowercase, or all uppercase only', () => {
  const triggers = ['Aku mau pesan kak', 'Aku mau pesan kak!'];
  assert.equal(matchCintaTrigger('Aku mau pesan kak', triggers), true);
  assert.equal(matchCintaTrigger('aku mau pesan kak!', triggers), true);
  assert.equal(matchCintaTrigger('AKU MAU PESAN KAK', triggers), true);
  assert.equal(matchCintaTrigger('  Aku mau pesan kak!  ', triggers), true);
  assert.equal(matchCintaTrigger('Aku Mau Pesan Kak', triggers), false);
  assert.equal(matchCintaTrigger('Aku mau pesan kak.', triggers), false);
  assert.equal(matchCintaTrigger('Aku mau pesan kak!!', triggers), false);
  assert.equal(matchCintaTrigger('Halo, aku mau pesan kak', triggers), false);
});

test('reply limiter allows two replies per window and then blocks', () => {
  const limiter = new ReplyLimiter();
  const start = 1_000_000;
  assert.equal(limiter.allow('a', 2, 1000, start), true);
  assert.equal(limiter.allow('a', 2, 1000, start + 10), true);
  assert.equal(limiter.allow('a', 2, 1000, start + 20), false);
  assert.equal(limiter.allow('b', 2, 1000, start + 20), true);
  assert.equal(limiter.allow('a', 2, 1000, start + 1001), true);
  limiter.cleanup(1000, start + 5000);
  assert.equal(limiter.history.size, 0);
});

test('worker command access follows service and default command setting', () => {
  const plain = { service: null };
  assert.equal(workerCommandAllowed(plain, 's'), true);
  assert.equal(workerCommandAllowed(plain, 'note'), true);
  assert.equal(workerCommandAllowed(plain, 'cinta'), false);
  assert.equal(workerCommandAllowed(plain, 'backup'), false);
  assert.equal(workerCommandAllowed(plain, 'worker'), false);

  const cinta = { service: 'cinta', allowDefaultCommands: false };
  assert.equal(workerCommandAllowed(cinta, 'cinta'), true);
  assert.equal(workerCommandAllowed(cinta, 'status'), true);
  assert.equal(workerCommandAllowed(cinta, 's'), false);
  assert.equal(workerCommandAllowed({ ...cinta, allowDefaultCommands: true }, 's'), true);
  assert.equal(workerCommandAllowed({ ...cinta, allowDefaultCommands: true }, 'config'), false);
});

test('cinta config input validation', () => {
  assert.deepEqual(parseCintaTriggers('Halo kak\n\n Pesan dong \nHalo kak'), ['Halo kak', 'Pesan dong']);
  assert.throws(() => parseCintaTriggers('   '), UserInputError);
  assert.equal(parseReactionEmoji('🐙'), '🐙');
  assert.equal(parseReactionEmoji('❤️'), '❤️');
  assert.equal(parseReactionEmoji('-'), '');
  assert.throws(() => parseReactionEmoji('ok'), UserInputError);
  assert.throws(() => parseReactionEmoji('1'), UserInputError);
});

test('worker store creates, finds, archives, and restores worker folders', async () => {
  const dir = await tmp();
  try {
    const store = await new WorkerStore({
      file: path.join(dir, 'workers.json'),
      rootDir: path.join(dir, 'workers'),
      archiveDir: path.join(dir, 'workers', 'archive')
    }).load();
    const worker = await store.create({ phoneJid: workerPhone, name: 'Tako' });
    assert.equal(worker.id, 1);
    assert.equal(store.find('1').id, 1);
    assert.equal(store.find('0811-1111-111').id, 1);
    assert.throws(() => store.find('9'), UserInputError);
    await fs.mkdir(store.authDir(worker), { recursive: true });
    await fs.writeFile(path.join(store.dataDir(worker), 'notes.json'), '{}');

    await store.archive(worker.id);
    assert.equal(worker.status, 'logged_out');
    assert.equal(store.activeWorkers().length, 0);
    assert.ok(store.dirFor(worker).includes(path.join('archive', '1')));
    await assert.rejects(fs.access(store.authDir(worker)));
    await fs.access(path.join(store.dataDir(worker), 'notes.json'));

    await store.restore(worker.id);
    assert.equal(worker.status, 'offline');
    await fs.access(path.join(store.dataDir(worker), 'notes.json'));
    assert.match(formatWorkerList(store.list()), /wa\.me\/628111111111/);
    assert.match(formatWorkerInfo(worker, { folder: 'workers/1' }), /Nomor: \+628111111111/);

    const reloaded = await new WorkerStore({ file: store.file, rootDir: store.rootDir, archiveDir: store.archiveDir }).load();
    assert.equal(reloaded.get(1).name, 'Tako');
    assert.equal(reloaded.data.nextId, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('worker messages are answered through the worker socket only', async () => {
  const dir = await tmp();
  const previous = { sock: state.sock, workerStore: state.workerStore };
  Object.assign(CINTA_DELAY_MS, { min: 0, max: 0 });
  Object.assign(WORKER_COMMAND_DELAY_MS, { min: 0, max: 0 });
  try {
    const ownerSent = [];
    state.sock = {
      user: { id: '628999999999@s.whatsapp.net' },
      sendMessage: async (jid, content) => { ownerSent.push({ jid, content }); return { key: { remoteJid: jid, id: `owner-${ownerSent.length}`, fromMe: true } }; }
    };
    state.workerStore = await new WorkerStore({
      file: path.join(dir, 'workers.json'),
      rootDir: path.join(dir, 'workers'),
      archiveDir: path.join(dir, 'workers', 'archive')
    }).load();
    const worker = await state.workerStore.create({ phoneJid: workerPhone, name: 'Tako' });
    await state.workerStore.update(worker.id, { service: 'cinta' });

    const workerSent = [];
    const workerSock = {
      user: { id: workerPhone },
      sendMessage: async (jid, content) => { workerSent.push({ jid, content }); return { key: { remoteJid: jid, id: `worker-${workerSent.length}`, fromMe: true } }; },
      sendPresenceUpdate: async () => {},
      readMessages: async () => {}
    };
    const connection = { sock: workerSock, connected: true };
    const runtime = { workerId: worker.id, connection, scope: createWorkerScope(worker, connection), limiter: new ReplyLimiter() };
    let id = 0;
    const incoming = (text, extra = {}) => ({
      key: { remoteJid: customer, id: `in-${++id}`, fromMe: false, ...extra },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: text }
    });
    const deliver = (message) => workerScope.run(runtime.scope, () => onWorkerMessageUpsert(runtime, { type: 'notify', messages: [message] }));

    await deliver(incoming('Aku mau pesan kak.'));
    await deliver(incoming(',s'));
    assert.equal(workerSent.length, 0);

    await deliver(incoming('AKU MAU PESAN KAK'));
    await deliver(incoming('aku mau pesan kak!'));
    await deliver(incoming('Aku mau pesan kak'));
    await deliver(incoming('Aku mau pesan kak'));
    assert.equal(workerSent.length, 3);
    assert.equal(workerSent[0].jid, customer);
    assert.equal(workerSent[0].content.text, DEFAULT_CINTA_CAPTION);
    assert.equal(worker.stats.cintaReplies, 3);

    const otherCustomer = '628444444444@s.whatsapp.net';
    for (let index = 0; index < 37; index += 1) runtime.limiter.allow(WORKER_REPLY_KEY, 40, 3600000);
    await deliver(incoming('Aku mau pesan kak', { remoteJid: otherCustomer }));
    assert.equal(workerSent.length, 3);

    await deliver(incoming(',status', { remoteJid: workerPhone, fromMe: true }));
    assert.match(workerSent.at(-1).content.text, /Status worker #1/);
    await deliver(incoming(',backup', { remoteJid: workerPhone, fromMe: true }));
    assert.match(workerSent.at(-1).content.text, /tidak tersedia untuk worker/);
    assert.equal(ownerSent.length, 0);
  } finally {
    Object.assign(CINTA_DELAY_MS, { min: 3000, max: 8000 });
    Object.assign(WORKER_COMMAND_DELAY_MS, { min: 1000, max: 2500 });
    state.sock = previous.sock;
    state.workerStore = previous.workerStore;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('jadibot request notifies the owner and can be rejected by replying to the notice', async () => {
  const dir = await tmp();
  const ownerJid = '628999999999@s.whatsapp.net';
  const requester = '628333333333@s.whatsapp.net';
  const group = 'jadibot-test@g.us';
  const sent = [];
  const idle = { has: () => false, finish: async () => null, end: () => null, get: () => null };
  Object.assign(state, {
    sock: {
      user: { id: ownerJid },
      sendMessage: async (jid, content) => {
        const key = { remoteJid: jid, id: `owner-${sent.length + 1}`, fromMe: true };
        sent.push({ jid, content, key });
        return { key };
      }
    },
    saveRecorder: idle,
    taskRecorder: idle,
    anticall: idle,
    qrSessions: idle,
    toVideoSessions: idle,
    stimpaSessions: idle,
    pdfSessions: idle,
    restoreSessions: idle,
    commandAccess: { canUseAs: () => false, isOpen: () => false, isAdmin: () => false }
  });
  try {
    state.workerStore = await new WorkerStore({
      file: path.join(dir, 'workers.json'),
      rootDir: path.join(dir, 'workers'),
      archiveDir: path.join(dir, 'workers', 'archive')
    }).load();
    let id = 0;
    const send = (key, message) => onMessageUpsert({ messages: [{ key: { id: `in-${++id}`, ...key }, message }] });
    const fromRequester = { remoteJid: group, participant: requester, fromMe: false };

    await send(fromRequester, { conversation: ',jadibot' });
    assert.equal(sent[0].jid, group);
    assert.match(sent[0].content.text, /dikirim ke admin/);
    assert.equal(sent[1].jid, ownerJid);
    assert.match(sent[1].content.text, /Permintaan jadibot #\d+/);
    assert.match(sent[1].content.text, /\+628333333333/);
    const noticeId = sent[1].key.id;

    await send(fromRequester, { conversation: ',jadibot' });
    assert.match(sent.at(-1).content.text, /masih menunggu/);

    await send({ remoteJid: ownerJid, fromMe: true }, {
      extendedTextMessage: { text: 'tolak', contextInfo: { stanzaId: noticeId, quotedMessage: { conversation: 'notice' } } }
    });
    assert.ok(sent.some((item) => item.jid === group && /ditolak admin/.test(item.content.text)));

    await send(fromRequester, { conversation: ',jadibot' });
    assert.match(sent.at(-1).content.text, /baru saja ditolak/);

    await send({ remoteJid: ownerJid, fromMe: true }, { conversation: ',jadibot kode' });
    assert.match(sent.at(-1).content.text, /Format: ,jadibot kode <nomor calon worker>/);

    await state.workerStore.create({ phoneJid: workerPhone, name: 'Tako' });
    await send({ remoteJid: ownerJid, fromMe: true }, { conversation: ',jadibot kode 08111111111' });
    assert.match(sent.at(-1).content.text, /sudah terhubung sebagai worker #1/);

    await send({ remoteJid: ownerJid, fromMe: true }, { conversation: ',jadibot kode 08999999999' });
    assert.match(sent.at(-1).content.text, /Nomor admin utama tidak bisa menjadi worker/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('cinta recording session saves the recorded messages as the automatic reply', async () => {
  const dir = await tmp();
  const previous = { sock: state.sock, workerStore: state.workerStore };
  Object.assign(CINTA_DELAY_MS, { min: 0, max: 0 });
  Object.assign(WORKER_COMMAND_DELAY_MS, { min: 0, max: 0 });
  try {
    state.sock = { user: { id: '628999999999@s.whatsapp.net' }, sendMessage: async () => ({ key: {} }) };
    state.workerStore = await new WorkerStore({
      file: path.join(dir, 'workers.json'),
      rootDir: path.join(dir, 'workers'),
      archiveDir: path.join(dir, 'workers', 'archive')
    }).load();
    const worker = await state.workerStore.create({ phoneJid: workerPhone, name: 'Tako' });
    await state.workerStore.update(worker.id, { service: 'cinta' });

    const sent = [];
    const workerSock = {
      user: { id: workerPhone },
      sendMessage: async (jid, content) => { sent.push({ jid, content }); return { key: { remoteJid: jid, id: `worker-${sent.length}`, fromMe: true } }; },
      sendPresenceUpdate: async () => {},
      readMessages: async () => {}
    };
    const connection = { sock: workerSock, connected: true };
    const runtime = { workerId: worker.id, connection, scope: createWorkerScope(worker, connection), limiter: new ReplyLimiter() };
    let id = 0;
    const message = (text, fromMe) => ({
      key: { remoteJid: fromMe ? workerPhone : customer, id: `in-${++id}`, fromMe },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: text }
    });
    const deliver = (item) => workerScope.run(runtime.scope, () => onWorkerMessageUpsert(runtime, { type: 'notify', messages: [item] }));

    await deliver(message(',cinta', true));
    assert.match(sent.at(-1).content.text, /Mulai rekam pesan otomatis cinta/);
    await deliver(message('Halo, ini menu kami', true));
    await deliver(message('Silakan pesan ya', true));
    await deliver(message(',end', true));
    assert.match(sent.at(-1).content.text, /tersimpan \(2 item\)/);
    assert.equal(worker.serviceConfig.cinta.entries.length, 2);

    await deliver(message(',cinta trigger Mau pesan\nMau pesan!', true));
    await deliver(message('mau pesan', false));
    const replies = sent.filter((item) => item.jid === customer).map((item) => item.content.text);
    assert.deepEqual(replies, ['Halo, ini menu kami', 'Silakan pesan ya']);

    await deliver(message(',cinta', true));
    await deliver(message('rekaman batal', true));
    await deliver(message(',cancel', true));
    assert.match(sent.at(-1).content.text, /Rekaman cinta dibatalkan/);
    assert.equal(worker.serviceConfig.cinta.entries.length, 2);
  } finally {
    Object.assign(CINTA_DELAY_MS, { min: 3000, max: 8000 });
    Object.assign(WORKER_COMMAND_DELAY_MS, { min: 1000, max: 2500 });
    state.sock = previous.sock;
    state.workerStore = previous.workerStore;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('admin session runs worker commands from the owner account in any chat with a status header', async () => {
  const dir = await tmp();
  const ownerJid = '628999999999@s.whatsapp.net';
  const groupJid = 'any-chat@g.us';
  const previous = { sock: state.sock, workerStore: state.workerStore };
  const idle = { has: () => false, finish: async () => null, end: () => null, get: () => null, cancel: async () => false, sessions: new Map(), count: () => 0 };
  try {
    const ownerSent = [];
    Object.assign(state, {
      sock: {
        user: { id: ownerJid },
        sendMessage: async (jid, content) => { ownerSent.push({ jid, content }); return { key: { remoteJid: jid, id: `owner-${ownerSent.length}`, fromMe: true } }; }
      },
      saveRecorder: idle, taskRecorder: idle, anticall: idle, qrSessions: idle, toVideoSessions: idle,
      stimpaSessions: idle, pdfSessions: idle, restoreSessions: idle,
      commandAccess: { canUseAs: () => true, isOpen: () => false, isAdmin: () => false }
    });
    state.workerStore = await new WorkerStore({
      file: path.join(dir, 'workers.json'),
      rootDir: path.join(dir, 'workers'),
      archiveDir: path.join(dir, 'workers', 'archive')
    }).load();
    const worker = await state.workerStore.create({ phoneJid: workerPhone, name: 'Tako' });
    await state.workerStore.update(worker.id, { service: 'cinta' });

    let id = 0;
    const send = (chat, text) => onMessageUpsert({ messages: [{ key: { remoteJid: chat, id: `own-${++id}`, fromMe: true }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: text } }] });
    const header = '*Admin sebagai Worker #1 - +628111111111*';

    await send(ownerJid, ',worker session 1');
    assert.match(ownerSent.at(-1).content.text, /Masuk sesi worker #1/);

    await send(groupJid, ',help');
    assert.equal(ownerSent.at(-1).jid, groupJid);
    assert.ok(ownerSent.at(-1).content.text.startsWith(`${header}\n`));
    assert.match(ownerSent.at(-1).content.text, /,cinta/);

    await send(groupJid, ',backup');
    assert.match(ownerSent.at(-1).content.text, /tidak tersedia untuk worker ini/);
    assert.match(ownerSent.at(-1).content.text, /,worker exit/);

    await send(groupJid, ',cinta');
    assert.match(ownerSent.at(-1).content.text, /Mulai rekam pesan otomatis cinta/);
    await send(groupJid, 'Pesan dari admin');
    await send(groupJid, ',worker exit');
    assert.match(ownerSent.at(-1).content.text, /Masih ada sesi aktif/);
    await send(groupJid, ',end');
    assert.match(ownerSent.at(-1).content.text, /tersimpan \(1 item\)/);
    assert.equal(worker.serviceConfig.cinta.entries.length, 1);

    await send(ownerJid, ',worker exit');
    assert.match(ownerSent.at(-1).content.text, /Keluar dari sesi worker #1/);
    assert.ok(!ownerSent.at(-1).content.text.includes(header));

    await send(groupJid, ',help');
    assert.ok(!ownerSent.at(-1).content.text.includes(header));
  } finally {
    state.sock = previous.sock;
    state.workerStore = previous.workerStore;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('reaction trigger emoji parsing and matching', () => {
  assert.deepEqual(parseReactionTriggers('🥢, 🍢,🥢'), ['🥢', '🍢']);
  assert.deepEqual(parseReactionTriggers('🥢🍢'), ['🥢', '🍢']);
  assert.deepEqual(parseReactionTriggers('-'), []);
  assert.throws(() => parseReactionTriggers('abc'), UserInputError);
  assert.throws(() => parseReactionTriggers(''), UserInputError);
  assert.equal(matchReactionTrigger('🥢', ['🥢']), true);
  assert.equal(matchReactionTrigger('❤️', ['❤']), true);
  assert.equal(matchReactionTrigger('👍', ['🥢']), false);
  assert.equal(matchReactionTrigger('', ['🥢']), false);
});

test('worker reaction with a trigger emoji sends the automatic reply and the cinta log records who used it', async () => {
  const dir = await tmp();
  const previous = { sock: state.sock, workerStore: state.workerStore };
  Object.assign(CINTA_DELAY_MS, { min: 0, max: 0 });
  Object.assign(WORKER_COMMAND_DELAY_MS, { min: 0, max: 0 });
  try {
    state.sock = { user: { id: '628999999999@s.whatsapp.net' }, sendMessage: async () => ({ key: {} }) };
    state.workerStore = await new WorkerStore({
      file: path.join(dir, 'workers.json'),
      rootDir: path.join(dir, 'workers'),
      archiveDir: path.join(dir, 'workers', 'archive')
    }).load();
    const worker = await state.workerStore.create({ phoneJid: workerPhone, name: 'Tako' });
    await state.workerStore.update(worker.id, { service: 'cinta' });

    const sent = [];
    const workerSock = {
      user: { id: workerPhone },
      sendMessage: async (jid, content) => { sent.push({ jid, content }); return { key: { remoteJid: jid, id: `worker-${sent.length}`, fromMe: true } }; },
      sendPresenceUpdate: async () => {},
      readMessages: async () => {}
    };
    const connection = { sock: workerSock, connected: true };
    const runtime = { workerId: worker.id, connection, scope: createWorkerScope(worker, connection), limiter: new ReplyLimiter() };
    let id = 0;
    const timestamp = () => Math.floor(Date.now() / 1000);
    const react = (emoji, chat = customer, messageFromMe = false) => workerScope.run(runtime.scope, () => onWorkerReactions(runtime, [{
      key: { remoteJid: chat, id: `msg-${++id}`, fromMe: messageFromMe },
      reaction: { text: emoji, key: { remoteJid: chat, id: `react-${++id}`, fromMe: true } }
    }]));
    const operator = (text) => workerScope.run(runtime.scope, () => onWorkerMessageUpsert(runtime, {
      type: 'notify',
      messages: [{ key: { remoteJid: workerPhone, id: `op-${++id}`, fromMe: true }, messageTimestamp: timestamp(), message: { conversation: text } }]
    }));

    await react('👍');
    assert.equal(sent.length, 0);

    await react('🥢');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].jid, customer);
    assert.equal(sent[0].content.text, DEFAULT_CINTA_CAPTION);

    await react('🥢', customer, true);
    await react('🥢', 'group-chat@g.us');
    assert.equal(sent.length, 2);

    await workerScope.run(runtime.scope, () => onWorkerMessageUpsert(runtime, {
      type: 'notify',
      messages: [{ key: { remoteJid: customer, id: `in-${++id}`, fromMe: false }, pushName: 'Budi', messageTimestamp: timestamp(), message: { conversation: 'Aku mau pesan kak' } }]
    }));
    assert.equal(sent.length, 3);

    await react('🥢');
    assert.equal(sent.length, 3);

    await operator(',cinta emojitrigger 🍢,❤️');
    assert.match(sent.at(-1).content.text, /Emoji pemicu tersimpan: 🍢,❤️/);
    await react('🥢', '628555555555@s.whatsapp.net');
    assert.equal(sent.length, 4);
    await react('🍢', '628666666666@s.whatsapp.net');
    assert.equal(sent.length, 5);
    await operator(',cinta emojitrigger -');
    await react('🍢', '628777777777@s.whatsapp.net');
    assert.equal(sent.length, 6);

    await operator(',cinta log');
    const log = sent.at(-1).content.text;
    assert.match(log, /Total pemakaian trigger: 5/);
    assert.match(log, /Dibalas: 4, ditahan batas anti-banned: 1/);
    assert.match(log, /\+628222222222 \(Budi\) - 4x \(dibalas 3, teks 1, reaksi 3\)/);
    assert.match(log, /\+628666666666 - 1x/);
    assert.doesNotMatch(log, /628555555555/);
  } finally {
    Object.assign(CINTA_DELAY_MS, { min: 3000, max: 8000 });
    Object.assign(WORKER_COMMAND_DELAY_MS, { min: 1000, max: 2500 });
    state.sock = previous.sock;
    state.workerStore = previous.workerStore;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('audit service is passive for the worker and only answers admin commands from the worker account', async () => {
  const dir = await tmp();
  const ownerJid = '628999999999@s.whatsapp.net';
  const ownerLid = '99999999999@lid';
  const workerLid = '11111111111@lid';
  const groupJid = 'audit-group@g.us';
  const previous = { sock: state.sock, workerStore: state.workerStore };
  Object.assign(WORKER_COMMAND_DELAY_MS, { min: 0, max: 0 });
  const idle = { has: () => false, finish: async () => null, end: () => null, get: () => null, cancel: async () => false, sessions: new Map(), count: () => 0 };
  try {
    const ownerSent = [];
    Object.assign(state, {
      sock: {
        user: { id: ownerJid },
        signalRepository: { lidMapping: { getPNForLID: async (lid) => (lid === workerLid ? workerPhone : lid === ownerLid ? ownerJid : null) } },
        sendMessage: async (jid, content) => { ownerSent.push({ jid, content }); return { key: { remoteJid: jid, id: `owner-${ownerSent.length}`, fromMe: true } }; }
      },
      saveRecorder: idle, taskRecorder: idle, anticall: idle, qrSessions: idle, toVideoSessions: idle,
      stimpaSessions: idle, pdfSessions: idle, restoreSessions: idle,
      commandAccess: { canUseAs: () => true, isOpen: () => false, isAdmin: () => false }
    });
    state.workerStore = await new WorkerStore({
      file: path.join(dir, 'workers.json'),
      rootDir: path.join(dir, 'workers'),
      archiveDir: path.join(dir, 'workers', 'archive')
    }).load();
    const worker = await state.workerStore.create({ phoneJid: workerPhone, name: 'Audit' });
    await state.workerStore.update(worker.id, { service: 'audit' });

    const workerSent = [];
    const joinedGroups = new Set([groupJid]);
    const workerSock = {
      user: { id: workerPhone },
      groupMetadata: async (jid) => { if (!joinedGroups.has(jid)) throw new Error('forbidden'); return {}; },
      sendMessage: async (jid, content) => { workerSent.push({ jid, content }); return { key: { remoteJid: jid, id: `worker-${workerSent.length}`, fromMe: true } }; },
      sendPresenceUpdate: async () => {},
      readMessages: async () => {}
    };
    const connection = { sock: workerSock, connected: true };
    const runtime = { workerId: worker.id, connection, scope: createWorkerScope(worker, connection), limiter: new ReplyLimiter() };
    workerRuntimes.set(worker.id, runtime);

    let id = 0;
    const timestamp = () => Math.floor(Date.now() / 1000);
    const workerOwn = (text) => workerScope.run(runtime.scope, () => onWorkerMessageUpsert(runtime, {
      type: 'notify',
      messages: [{ key: { remoteJid: workerPhone, id: `w-${++id}`, fromMe: true }, messageTimestamp: timestamp(), message: { conversation: text } }]
    }));
    const admin = (chat, text, extra = {}) => onMessageUpsert({ messages: [{ key: { remoteJid: chat, id: `own-${++id}`, fromMe: true, ...extra }, messageTimestamp: timestamp(), message: { conversation: text } }] });

    await workerOwn(',help');
    await workerOwn(',test');
    await workerOwn(',cinta');
    assert.equal(workerSent.length, 0);

    await admin(ownerJid, ',worker session 1');
    assert.match(ownerSent.at(-1).content.text, /Masuk sesi worker #1/);

    await admin(groupJid, ',test');
    assert.deepEqual(workerSent.at(-1), { jid: groupJid, content: workerSent.at(-1).content });
    assert.equal(workerSent.at(-1).content.text, 'test');

    await admin(workerLid, ',test');
    assert.equal(workerSent.at(-1).jid, ownerJid);
    assert.equal(workerSent.at(-1).content.text, 'test');

    const sentBefore = workerSent.length;
    await admin('628333333333@s.whatsapp.net', ',test');
    assert.equal(workerSent.length, sentBefore);
    assert.match(ownerSent.at(-1).content.text, /bukan peserta chat ini/);

    await admin('other-group@g.us', ',test');
    assert.equal(workerSent.length, sentBefore);
    assert.match(ownerSent.at(-1).content.text, /tidak berada di grup ini/);

    await admin(groupJid, ',help');
    assert.match(ownerSent.at(-1).content.text, /,test/);
    assert.ok(!/,cinta/.test(ownerSent.at(-1).content.text));
    assert.equal(workerSent.length, sentBefore);

    await admin(groupJid, ',cinta');
    assert.match(ownerSent.at(-1).content.text, /tidak tersedia untuk worker ini/);
  } finally {
    workerRuntimes.delete(1);
    Object.assign(WORKER_COMMAND_DELAY_MS, { min: 1000, max: 2500 });
    state.sock = previous.sock;
    state.workerStore = previous.workerStore;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
