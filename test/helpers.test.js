import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import webp from 'node-webpmux';
import { addNamedItem, assertUniqueTitle, deleteNamedItem, readCollection } from '../src/namedStore.js';
import { defaultPdfBaseName, parsePdfSizeLimit, parsePdfStartArgs, PdfSessions, parsePdfOrderText } from '../src/pdf.js';
import { parseDurationMs } from '../src/reminders.js';
import { normalizeMac } from '../src/wol.js';
import { parseTaskArgs } from '../src/tasks.js';
import { extractZipBuffer, zipDirectory } from '../src/zip.js';
import { PendingConfirmStore, parseSecretMediaTriggerText } from '../src/confirm.js';
import { CommandAccessStore, parseAllowArgs } from '../src/commandAccess.js';
import { ReactionActionStore, reactionIntent } from '../src/reactionActions.js';
import { normalizePhoneNumber, normalizePhoneToJid } from '../src/phone.js';
import { handleLinkCommand, handleNoteCommand } from '../src/notes.js';
import { getMessageText } from '../src/text.js';
import {
  isAnimatedMedia,
  makeSmemeOverlaySvg,
  makeSmemeSticker,
  makeSticker,
  parseSmemeArgs,
  parseStickerMeta,
  reverseSticker,
  splitSmemeTextRuns
} from '../src/sticker.js';
import { detectTools } from '../src/tools.js';
import { AnticallStore, formatAnticallStatus } from '../src/anticall.js';
import { RuntimeConfigStore } from '../src/runtimeConfig.js';
import { ChangedMessageStore, messageIndexKey } from '../src/changedMessages.js';
import { MultiAccountStore } from '../src/multiAccount.js';
import { WorkerLogStore, createWorkerLogEntry, shouldLogMessage, waLink } from '../src/workerLogs.js';

test('parseDurationMs supports compact countdown formats', () => {
  assert.equal(parseDurationMs('10s'), 10_000);
  assert.equal(parseDurationMs('5m'), 5 * 60_000);
  assert.equal(parseDurationMs('2h'), 2 * 60 * 60_000);
  assert.equal(parseDurationMs('1d'), 24 * 60 * 60_000);
  assert.equal(parseDurationMs('1h30m'), 90 * 60_000);
  assert.throws(() => parseDurationMs('soon'), /Format durasi/);
});

test('normalizeMac accepts common MAC separators', () => {
  assert.equal(normalizeMac('aa:bb:cc:dd:ee:ff'), 'AA:BB:CC:DD:EE:FF');
  assert.equal(normalizeMac('aa-bb-cc-dd-ee-ff'), 'AA:BB:CC:DD:EE:FF');
  assert.equal(normalizeMac('aabb.ccdd.eeff'), 'AA:BB:CC:DD:EE:FF');
  assert.throws(() => normalizeMac('aa:bb'), /MAC address/);
});

test('normalizePhoneNumber accepts Indonesian public formats', () => {
  assert.equal(normalizePhoneNumber('08123431212'), '628123431212');
  assert.equal(normalizePhoneNumber('+62 123-1234-1234'), '6212312341234');
  assert.equal(normalizePhoneToJid('+6212312341234'), '6212312341234@s.whatsapp.net');
});

test('assertUniqueTitle rejects case-insensitive duplicates', () => {
  const store = { items: [{ id: 1, title: 'Laporan' }] };
  assert.throws(() => assertUniqueTitle(store, 'laporan'), /sudah ada/);
  assert.doesNotThrow(() => assertUniqueTitle(store, 'Laporan Baru'));
  assert.doesNotThrow(() => assertUniqueTitle(store, 'laporan', 1));
});

test('deleteNamedItem renumbers remaining items', async () => {
  const tempRoot = path.join(process.cwd(), 'temp');
  await fs.mkdir(tempRoot, { recursive: true });
  const file = path.join(tempRoot, `named-${Date.now()}.json`);
  try {
    await addNamedItem(file, 'Satu', { text: '1' });
    await addNamedItem(file, 'Dua', { text: '2' });
    await addNamedItem(file, 'Tiga', { text: '3' });
    await deleteNamedItem(file, '2', 'Item');
    const store = await readCollection(file);
    assert.deepEqual(store.items.map((item) => [item.id, item.title]), [[1, 'Satu'], [2, 'Tiga']]);
    assert.equal(store.nextId, 3);
  } finally {
    await fs.rm(file, { force: true });
  }
});

test('PdfSessions rejects duplicate explicit order', () => {
  const sessions = new PdfSessions({});
  const session = sessions.start('jid@test', 'laporan');
  sessions.pushMedia(session, { path: 'a.jpg', mimetype: 'image/jpeg', fileName: 'a.jpg' }, 1);
  assert.throws(() => {
    sessions.pushMedia(session, { path: 'b.jpg', mimetype: 'image/jpeg', fileName: 'b.jpg' }, 1);
  }, /Urutan PDF #1/);
  assert.equal(parsePdfOrderText('2'), 2);
  assert.equal(parsePdfOrderText('bebas'), null);
  sessions.end('jid@test');
});

test('PDF start args support WIB default name, size limit, and unsupported skips', () => {
  assert.equal(defaultPdfBaseName(new Date('2026-05-23T04:57:00.000Z')), '23_5_2026_115700_IrOBot');
  assert.equal(parsePdfSizeLimit('1mb'), 1024 * 1024);
  assert.deepEqual(parsePdfStartArgs('Ini adalah nama pdf,1MB'), {
    fileName: 'Ini adalah nama pdf',
    maxSizeBytes: 1024 * 1024,
    split: false
  });
  assert.deepEqual(parsePdfStartArgs('tugas max 1MB'), {
    fileName: 'tugas',
    maxSizeBytes: 1024 * 1024,
    split: false
  });
  assert.deepEqual(parsePdfStartArgs('split scan max 1MB'), {
    fileName: 'scan',
    maxSizeBytes: 1024 * 1024,
    split: true
  });
  assert.deepEqual(parsePdfStartArgs('split'), { fileName: '', maxSizeBytes: null, split: true });

  const sessions = new PdfSessions({});
  const session = sessions.start('jid@test', '');
  const skipped = sessions.pushMedia(session, {
    path: 'voice.mp3',
    mimetype: 'audio/mpeg',
    fileName: 'voice.mp3',
    type: 'audioMessage'
  });
  assert.equal(skipped.skipped, true);
  assert.match(skipped.reason, /audio/);
  assert.equal(session.files.length, 0);
  sessions.end('jid@test');
});

test('parseTaskArgs supports explicit task actions and legacy schedule syntax', () => {
  assert.deepEqual(parseTaskArgs(['add', 'backup server', 'at', '23:00']), {
    loop: false,
    count: 1,
    text: 'backup server',
    hour: 23,
    minute: 0,
    second: 0,
    dateToken: null
  });
  assert.deepEqual(parseTaskArgs(['loop', 'cek koneksi', 'at', '08:05']), {
    loop: true,
    count: null,
    text: 'cek koneksi',
    hour: 8,
    minute: 5,
    second: 0,
    dateToken: null
  });
  assert.deepEqual(parseTaskArgs(['repeat', '3', 'ingatkan minum', 'at', '21:00', '12/12/2026']), {
    loop: false,
    count: 3,
    text: 'ingatkan minum',
    hour: 21,
    minute: 0,
    second: 0,
    dateToken: '12/12/2026'
  });
  assert.equal(parseTaskArgs(['2', 'legacy', '22', '30']).text, 'legacy');
  assert.throws(() => parseTaskArgs(['add', 'tanpa', 'jam']), /Format task/);
});

test('PdfSessions split mode builds one PDF per media item', async () => {
  const tempRoot = path.join(process.cwd(), 'temp');
  await fs.mkdir(tempRoot, { recursive: true });
  const work = await fs.mkdtemp(path.join(tempRoot, 'pdf-split-test-'));
  const first = path.join(work, 'first.png');
  const second = path.join(work, 'second.png');
  try {
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toFile(first);
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0000ff' } }).png().toFile(second);
    const sessions = new PdfSessions({});
    const session = sessions.start('jid@test', { fileName: 'split', split: true });
    sessions.pushMedia(session, { path: first, mimetype: 'image/png', fileName: 'first.png' });
    sessions.pushMedia(session, { path: second, mimetype: 'image/png', fileName: 'second.png' });
    const files = await sessions.buildSplit(session);
    assert.equal(files.length, 2);
    assert.match(files[0].fileName, /first/i);
    assert.ok(files.every((file) => file.buffer.length > 0));
    sessions.end('jid@test');
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test('parseSecretMediaTriggerText detects text ending with space dot', () => {
  assert.deepEqual(parseSecretMediaTriggerText('halo .'), { caption: 'halo' });
  assert.deepEqual(parseSecretMediaTriggerText(' .'), { caption: '' });
  assert.equal(parseSecretMediaTriggerText('halo.'), null);
  assert.equal(parseSecretMediaTriggerText('halo . terus'), null);
  assert.equal(parseSecretMediaTriggerText('halo . '), null);
});

test('PendingConfirmStore takes and expires pending actions', async () => {
  const store = new PendingConfirmStore({ ttlMs: 50 });
  const execute = async () => 'ok';
  store.set('jid@test', 'actor-a@s.whatsapp.net', { title: 'Test', execute });
  assert.equal(store.count(), 1);
  assert.equal(store.take('jid@test', 'actor-b@s.whatsapp.net'), null);
  assert.equal(store.take('jid@test', 'actor-a@s.whatsapp.net').title, 'Test');
  assert.equal(store.take('jid@test', 'actor-a@s.whatsapp.net'), null);

  store.set('jid@test', 'actor-a@s.whatsapp.net', { title: 'Expired', execute });
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(store.get('jid@test', 'actor-a@s.whatsapp.net'), null);
  assert.equal(store.count(), 0);
});

test('ReactionActionStore matches only the triggering actor and known emojis', () => {
  const store = new ReactionActionStore({ ttlMs: 1000 });
  const key = { remoteJid: 'chat@test', id: 'abc' };
  store.register(key, { actorJid: '62812@s.whatsapp.net', onCancel: async () => 'ok' });
  assert.equal(reactionIntent('✅'), 'confirm');
  assert.equal(reactionIntent('❌'), 'cancel');
  assert.equal(reactionIntent('🙂'), null);
  assert.equal(store.get(key, '62813@s.whatsapp.net'), null);
  assert.equal(store.get(key, '62812@s.whatsapp.net')?.key, 'chat@test:abc');
});

test('parseSmemeArgs supports position text and quality', () => {
  assert.deepEqual(parseSmemeArgs(['up', 'halo', 'dunia']), {
    position: 'up',
    text: 'halo dunia',
    quality: 99,
    canvasSize: 512
  });
  assert.deepEqual(parseSmemeArgs(['down', 'halo', '50']), {
    position: 'down',
    text: 'halo',
    quality: 50,
    canvasSize: 259
  });
  assert.throws(() => parseSmemeArgs(['middle', 'halo']), /Format/);
  assert.throws(() => parseSmemeArgs(['up', 'halo', '100']), /1-99/);
  assert.throws(() => parseSmemeArgs(['up']), /wajib/);
});

test('parseStickerMeta supports title comma author and URL media text', () => {
  assert.deepEqual(parseStickerMeta('', { defaultAuthor: 'Author', defaultTitle: 'Title' }), {
    author: 'Author',
    title: 'Title'
  });
  assert.deepEqual(parseStickerMeta('judul saya', { defaultAuthor: 'Author', defaultTitle: 'Title' }), {
    author: 'Author',
    title: 'judul saya'
  });
  assert.deepEqual(parseStickerMeta('judul saya,author saya', { defaultAuthor: 'Author', defaultTitle: 'Title' }), {
    author: 'author saya',
    title: 'judul saya'
  });
  assert.deepEqual(parseStickerMeta('judul dari url https://example.com/a.gif', { defaultAuthor: 'Author', defaultTitle: 'Title' }), {
    author: 'Author',
    title: 'judul dari url'
  });
});

test('smeme text keeps emoji as colored emoji run', async () => {
  assert.deepEqual(splitSmemeTextRuns('halo 🐫 ok').map((run) => run.type), ['text', 'emoji', 'text']);
  assert.equal(splitSmemeTextRuns('halo 🐫 ok')[1].codepoint, '1f42b');
  const overlay = (await makeSmemeOverlaySvg('halo 🐫', 'up', 512)).toString('utf8');
  assert.match(overlay, /class="smeme-emoji"/);
  assert.match(overlay, /HALO/);
  assert.doesNotMatch(overlay, /01F42B|1F42B/);
});

test('smeme long text stays inside padded canvas', async () => {
  const canvas = 512;
  const overlay = (await makeSmemeOverlaySvg('ini teks sangat panjang sekali sampai harus mengecil dan tetap tidak keluar dari gambar kanan kiri', 'up', canvas)).toString('utf8');
  const xs = [...overlay.matchAll(/<text class="smeme-text" x="([\d.]+)"/g)].map((match) => Number(match[1]));
  assert.ok(xs.length > 0);
  assert.ok(xs.every((x) => x >= 20 && x < canvas));
});

test('getMessageText reads button replies as commands', () => {
  assert.equal(getMessageText({
    message: {
      buttonsResponseMessage: {
        selectedButtonId: ',help',
        selectedDisplayText: 'help'
      }
    }
  }), ',help');
});

test('CommandAccessStore gates public commands', async () => {
  const tempRoot = path.join(process.cwd(), 'temp');
  await fs.mkdir(tempRoot, { recursive: true });
  const file = path.join(tempRoot, `command-access-${Date.now()}.json`);
  const store = new CommandAccessStore(file);
  try {
    await store.load();
    assert.equal(store.canUse('s', 'chat-a'), false);
    assert.deepEqual(parseAllowArgs(['here', 'on']), { scope: 'here', enabled: true });
    assert.deepEqual(parseAllowArgs(['all', 'false']), { scope: 'all', enabled: false });

    await store.setHere('chat-a', true);
    assert.equal(store.canUse('s', 'chat-a'), true);
    assert.equal(store.canUse('smeme', 'chat-a'), true);
    assert.equal(store.canUse('help', 'chat-a'), true);
    assert.equal(store.canUse('resend', 'chat-a'), true);
    assert.equal(store.canUseAs('save', 'chat-a', '628111@s.whatsapp.net'), false);
    assert.equal(store.canUse('s', 'chat-b'), false);

    await store.setAll(true);
    assert.equal(store.canUse('rs', 'chat-b'), true);
    const admin = await store.addAdmin('08123431212');
    assert.equal(admin.jid, '628123431212@s.whatsapp.net');
    assert.equal(store.canUseAs('save', 'chat-b', admin.jid), true);
    assert.equal(store.canUseAs('status', 'chat-b', admin.jid), true);
    assert.equal(store.canUseAs('wol', 'chat-b', admin.jid), true);
    assert.equal(store.canUseAs('backup', 'chat-b', admin.jid), false);
    assert.equal(store.canUseAs('bot', 'chat-b', admin.jid), false);
    assert.equal(store.canUseAs('anticall', 'chat-b', admin.jid), false);
    const deleted = await store.deleteAdmin('08123431212');
    assert.equal(deleted.id, 1);
    assert.equal(store.snapshot().adminCount, 0);

    await store.setAll(false);
    assert.equal(store.canUse('s', 'chat-a'), false);
    assert.equal(store.snapshot().chatCount, 0);
  } finally {
    await fs.rm(file, { force: true });
  }
});

test('RuntimeConfigStore validates safe keys and destination objects', async () => {
  const tempRoot = path.join(process.cwd(), 'temp');
  await fs.mkdir(tempRoot, { recursive: true });
  const file = path.join(tempRoot, `runtime-config-${Date.now()}.json`);
  const store = new RuntimeConfigStore(file);
  try {
    await store.load();
    await store.set('backup.autoDaily', 'off');
    assert.equal(store.get('backup.autoDaily'), false);
    await store.set('backup.dailyTimeWib', '7:05');
    assert.equal(store.get('backup.dailyTimeWib'), '07:05');
    await store.set('workerLogs.defaultMode', 'all');
    assert.equal(store.workerLogsSettings().defaultMode, 'all');
    await store.set('workerControl.timeoutMs', '120000');
    assert.equal(store.workerControlTimeoutMs(), 120000);
    const destination = await store.setDestination('dest.changedmsg', {
      jid: '120363123456@g.us',
      savedName: 'changedmsg',
      input: 'changedmsg'
    });
    assert.equal(destination.jid, '120363123456@g.us');
    assert.match(String(store.backupPartSizeBytes()), /^\d+$/);
    await assert.rejects(() => store.set('update.branch', 'dev'), /tidak bisa diubah/);
  } finally {
    await fs.rm(file, { force: true });
  }
});

test('ChangedMessageStore stores group JID allowlist and reloads small index', async () => {
  const tempRoot = path.join(process.cwd(), 'temp');
  await fs.mkdir(tempRoot, { recursive: true });
  const file = path.join(tempRoot, `changed-${Date.now()}.json`);
  const store = new ChangedMessageStore(file);
  try {
    await store.load();
    const allowed = await store.addAllowed({
      jid: '120363123456@g.us',
      savedName: 'logs dev',
      addedBy: '6281@s.whatsapp.net'
    });
    assert.equal(allowed.jid, '120363123456@g.us');
    assert.equal(store.isAllowedGroup('120363123456@g.us'), true);
    const key = { remoteJid: '6282@s.whatsapp.net', id: 'ABC' };
    await store.upsertIndex({
      key: messageIndexKey(key),
      messageKey: key,
      id: 'ABC',
      remoteJid: key.remoteJid,
      actorJid: key.remoteJid,
      type: 'conversation',
      text: 'lama',
      latestText: 'lama',
      logJid: '120363logs@g.us',
      logMessageId: 'LOG1'
    }, 10);

    const reloaded = new ChangedMessageStore(file);
    await reloaded.load();
    assert.equal(reloaded.findByKey(key).latestText, 'lama');
    await reloaded.markEdited(key, { latestText: 'baru' });
    assert.equal(reloaded.findByKey(key).latestText, 'baru');
    await reloaded.markDeleted(key);
    assert.ok(reloaded.findByKey(key).deletedAt);
    assert.equal(JSON.stringify(reloaded.snapshot()).includes('buffer'), false);
  } finally {
    await fs.rm(file, { force: true });
  }
});

test('MultiAccountStore locks super admin, roles one trust, and deletes secondary', async () => {
  const tempRoot = path.join(process.cwd(), 'temp');
  await fs.mkdir(tempRoot, { recursive: true });
  const file = path.join(tempRoot, `multi-account-${Date.now()}.json`);
  const store = new MultiAccountStore(file, path.join(tempRoot, 'auth'));
  try {
    await store.load();
    assert.equal(store.isSingle(), true);
    await store.configureInitialMode('multi', '08123431212');
    assert.equal(store.isMulti(), true);
    assert.equal(store.superAdminJid(), '628123431212@s.whatsapp.net');
    assert.equal(store.isSuperAdmin('+628123431212@s.whatsapp.net'), true);
    await assert.rejects(() => store.configureInitialMode('multi', '08111111111'), /permanen/);

    const first = await store.addWorker();
    const second = await store.addWorker();
    assert.equal(first.id, 2);
    assert.equal(second.id, 3);
    await store.setRole(first.id, 'trust');
    await store.setRole(second.id, 'trust');
    assert.equal(store.getAccount(first.id).role, 'worker');
    assert.equal(store.getAccount(second.id).role, 'trust');
    await store.deleteAccount(second.id);
    assert.equal(store.getAccount(second.id), null);
    await assert.rejects(() => store.deleteAccount(1), /primary/);
  } finally {
    await fs.rm(file, { force: true });
  }
});

test('WorkerLogStore modes, selected targets, wa links, and extract text', async () => {
  const tempRoot = path.join(process.cwd(), 'temp');
  await fs.mkdir(tempRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(tempRoot, 'worker-logs-test-'));
  const store = new WorkerLogStore(root);
  try {
    const dmMessage = {
      key: { remoteJid: '628111@s.whatsapp.net', id: 'A' },
      message: { conversation: 'halo' },
      messageTimestamp: 1
    };
    const groupMessage = {
      key: { remoteJid: '120363@g.us', participant: '628222@s.whatsapp.net', id: 'B' },
      message: { conversation: 'group' },
      messageTimestamp: 2
    };
    assert.equal(shouldLogMessage({ mode: 'dm' }, dmMessage), true);
    assert.equal(shouldLogMessage({ mode: 'dm' }, groupMessage), false);
    assert.equal(shouldLogMessage({ mode: 'all' }, groupMessage), true);

    const target = await store.addTarget(2, { jid: '120363@g.us', title: 'Worker Group', type: 'group' });
    assert.equal(target.id, 1);
    const selected = await store.loadConfig(2);
    assert.equal(selected.mode, 'selected');
    assert.equal(shouldLogMessage(selected, groupMessage), true);
    assert.equal(waLink('628111@s.whatsapp.net'), 'wa.me/628111');

    const entry = createWorkerLogEntry({ id: 2, jid: '628999@s.whatsapp.net' }, dmMessage, { actorJid: '628111@s.whatsapp.net' });
    await store.append(2, entry);
    const filePath = await store.exportText(2, '628111@s.whatsapp.net', { title: 'Test User' });
    const content = await fs.readFile(filePath, 'utf8');
    assert.match(content, /Extract worker #2/);
    assert.match(content, /halo/);
    await fs.rm(filePath, { force: true });

    const deleted = await store.deleteTarget(2, '1');
    assert.equal(deleted.title, 'Worker Group');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('note and link commands support explicit actions and legacy rename syntax', async () => {
  const tempRoot = path.join(process.cwd(), 'temp');
  await fs.mkdir(tempRoot, { recursive: true });
  const work = await fs.mkdtemp(path.join(tempRoot, 'rename-test-'));
  const notesFile = path.join(work, 'notes.json');
  const linksFile = path.join(work, 'links.json');
  try {
    await fs.writeFile(notesFile, JSON.stringify({ nextId: 1, items: [] }, null, 2));
    await fs.writeFile(linksFile, JSON.stringify({ nextId: 1, items: [] }, null, 2));
    assert.match(await handleNoteCommand({ args: ['add', 'lama', 'isi'], rawArgs: 'add lama isi' }, notesFile), /tersimpan/);
    assert.match(await handleNoteCommand({ args: ['get', 'lama'], rawArgs: 'get lama' }, notesFile), /isi/);
    assert.match(await handleNoteCommand({ args: ['rename', 'lama', 'baru'], rawArgs: 'rename lama baru' }, notesFile), /baru/);
    await handleNoteCommand({ args: ['lain', 'isi'], rawArgs: 'lain isi' }, notesFile);
    await assert.rejects(() => handleNoteCommand({ args: ['change', 'lain', 'baru'], rawArgs: 'change lain baru' }, notesFile), /sudah ada/);
    assert.match(await handleLinkCommand({ args: ['add', 'old', 'https://example.com'], rawArgs: 'add old https://example.com' }, linksFile), /tersimpan/);
    assert.match(await handleLinkCommand({ args: ['get', 'old'], rawArgs: 'get old' }, linksFile), /example/);
    assert.match(await handleLinkCommand({ args: ['rename', 'old', 'new'], rawArgs: 'rename old new' }, linksFile), /new/);
    await assert.rejects(() => handleNoteCommand({ args: ['baru2'], rawArgs: 'baru2' }, notesFile), /tidak ditemukan/);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test('AnticallStore defaults, enable gating, and replacement session safety', async () => {
  const tempRoot = path.join(process.cwd(), 'temp');
  await fs.mkdir(tempRoot, { recursive: true });
  const work = await fs.mkdtemp(path.join(tempRoot, 'anticall-test-'));
  const store = new AnticallStore(path.join(work, 'anticall.json'), path.join(work, 'media'));
  try {
    await store.load();
    assert.deepEqual(store.snapshot(), {
      enabled: false,
      hasMessage: false,
      entryCount: 0,
      exceptionCount: 0,
      exceptions: [],
      updatedAt: null,
      createdAt: null
    });
    await assert.rejects(() => store.setEnabled(true), /belum ada/);

    store.store.entries = [{ kind: 'text', text: 'lagi gak bisa telepon' }];
    await store.save();
    assert.match(formatAnticallStatus(store.snapshot()), /1 item/);
    assert.equal((await store.setEnabled(true)).enabled, true);

    await store.start('jid@test');
    store.sessions.get('jid@test').entries.push({ kind: 'text', text: 'pesan baru' });
    await store.cancel('jid@test');
    assert.equal(store.store.entries[0].text, 'lagi gak bisa telepon');

    await store.start('jid@test');
    store.sessions.get('jid@test').entries.push({ kind: 'text', text: 'pesan baru' });
    const snapshot = await store.finish('jid@test');
    assert.equal(snapshot.enabled, true);
    assert.equal(snapshot.entryCount, 1);
    assert.equal(store.store.entries[0].text, 'pesan baru');

    const exception = await store.addException('+62 123-1234-1234');
    assert.equal(exception.jid, '6212312341234@s.whatsapp.net');
    assert.equal(store.isException('6212312341234@s.whatsapp.net'), true);
    await store.addException('08123431212');
    const deleted = await store.deleteException('1');
    assert.equal(deleted.id, 1);
    assert.deepEqual(store.listExceptions().map((item) => [item.id, item.title]), [[1, '628123431212']]);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test('animated WebP stickers convert without ffmpeg decoder support', async () => {
  const tempRoot = path.join(process.cwd(), 'temp');
  await fs.mkdir(tempRoot, { recursive: true });
  const work = await fs.mkdtemp(path.join(tempRoot, 'animated-webp-test-'));
  const source = path.join(work, 'source.webp');
  try {
    await writeTinyAnimatedWebp(source);
    const media = {
      path: source,
      mimetype: 'image/webp',
      fileName: 'source.webp',
      node: { isAnimated: true }
    };
    assert.equal(await isAnimatedMedia(media), true);

    const sticker = await makeSticker(media, { author: 'A', title: 'T', tools: {} });
    const stickerImage = new webp.Image();
    await stickerImage.load(sticker);
    assert.equal(stickerImage.hasAnim, true);
    assert.equal(stickerImage.frames.length, 2);

    const smeme = await makeSmemeSticker(media, {
      author: 'A',
      title: 'T',
      tools: {},
      smeme: parseSmemeArgs(['up', 'halo'])
    });
    const smemeImage = new webp.Image();
    await smemeImage.load(smeme);
    assert.equal(smemeImage.hasAnim, true);
    assert.equal(smemeImage.frames.length, 2);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test('reverseSticker returns inline gif playback video for animated stickers when ffmpeg exists', async () => {
  const tools = await detectTools();
  if (!tools.ffmpeg) return;

  const tempRoot = path.join(process.cwd(), 'temp');
  await fs.mkdir(tempRoot, { recursive: true });
  const work = await fs.mkdtemp(path.join(tempRoot, 'reverse-webp-test-'));
  const source = path.join(work, 'source.webp');
  try {
    await writeTinyAnimatedWebp(source);
    const converted = await reverseSticker({
      path: source,
      mimetype: 'image/webp',
      fileName: 'source.webp',
      node: { isAnimated: true }
    }, tools);
    assert.equal(converted.mimetype, 'video/mp4');
    assert.equal(converted.fileName, 'sticker.mp4');
    assert.equal(converted.gifPlayback, true);
    assert.ok(converted.buffer.length > 0);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

async function writeTinyAnimatedWebp(filePath) {
  const red = await sharp({
    create: {
      width: 16,
      height: 16,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 }
    }
  }).webp().toBuffer();
  const blue = await sharp({
    create: {
      width: 16,
      height: 16,
      channels: 4,
      background: { r: 0, g: 0, b: 255, alpha: 1 }
    }
  }).webp().toBuffer();
  const frames = [
    await webp.Image.generateFrame({ buffer: red, delay: 80, blend: false, dispose: false }),
    await webp.Image.generateFrame({ buffer: blue, delay: 120, blend: false, dispose: false })
  ];
  await webp.Image.save(filePath, {
    width: 16,
    height: 16,
    frames,
    bgColor: [0, 0, 0, 0],
    loops: 0
  });
}

test('zipDirectory and extractZipBuffer round trip nested data', async () => {
  const tempRoot = path.join(process.cwd(), 'temp');
  await fs.mkdir(tempRoot, { recursive: true });
  const work = await fs.mkdtemp(path.join(tempRoot, 'zip-test-'));
  const source = path.join(work, 'source');
  const out = path.join(work, 'out');
  try {
    await fs.mkdir(path.join(source, 'nested'), { recursive: true });
    await fs.writeFile(path.join(source, 'nested', 'file.txt'), 'hello zip');
    const zip = await zipDirectory(source);
    const count = await extractZipBuffer(zip, out);
    assert.equal(count, 1);
    assert.equal(await fs.readFile(path.join(out, 'nested', 'file.txt'), 'utf8'), 'hello zip');
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});
