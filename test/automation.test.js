import { presentStatus } from '../src/statusViewer.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { RuntimeConfigStore } from '../src/runtimeConfig.js';
import { LocalArchive, wibDay } from '../src/storage.js';
import { StatusInbox, resolveStatusAuthor } from '../src/statusInbox.js';
import { ErrorReporter } from '../src/errorReporter.js';
import { UserInputError } from '../src/errors.js';
import { persistRecordedEntries, recordMessageEntry, sendRecordedEntries } from '../src/recordedMessages.js';
import { parseTaskRecordingArgs, TaskRecorder, TaskScheduler, listTasks, updateTaskState } from '../src/tasks.js';
import { parseTextSticker, makeTextSticker } from '../src/textSticker.js';
import { state, onMessageUpsert, onMessagesReaction, handleFailure, handleSetup, expireListeningSessions, resolveErrorGroup, onMessagesUpdate, handleStatusBrowse, runConfiguredBackup } from '../src/index.js';
import { ChangedMessageStore } from '../src/changedMessages.js';
import { StatusSaveStore } from '../src/statusSave.js';
import { SaveRecorder } from '../src/saved.js';
import { AnticallStore } from '../src/anticall.js';
import { CommandAccessStore } from '../src/commandAccess.js';
import { setErrorSink } from '../src/logger.js';
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'iro-feature-'));
const phone = '628123456789@s.whatsapp.net';
const now = Date.now();
const status = (id, participant = phone, extra = {}) => ({ key: { id, remoteJid: 'status@broadcast', participant, ...extra }, messageTimestamp: Math.floor(now / 1000), message: { conversation: 'Status test' } });

test('storage migrates legacy destinations, validates local paths, and keeps one active mode', async () => {
  const dir = await tmp();
  try {
    const config = new RuntimeConfigStore(path.join(dir, 'config.json')); await config.load();
    assert.equal(config.storageTarget('statussave').mode, 'group');
    await config.set('storage.root', dir);
    await config.setStorage('statussave', 'local');
    assert.deepEqual(config.storageTarget('statussave'), { mode: 'local', path: path.join(dir, 'statussave') });
    await assert.rejects(config.setStorage('statussave', 'local', 'relative'), UserInputError);
    assert.equal(config.storageTarget('statussave').mode, 'local');
    await config.setStorage('statussave', 'group', { jid: '123@g.us', savedName: 'saved' });
    assert.equal(config.storageTarget('statussave').mode, 'group');
    const reloaded = new RuntimeConfigStore(config.filePath); await reloaded.load();
    assert.equal(reloaded.destination('saved').jid, '123@g.us');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('local archive sanitizes names, separates duplicate contacts, keeps renamed folders and WIB dates', async () => {
  const dir = await tmp();
  try {
    const archive = new LocalArchive();
    const first = await archive.write(dir, { identity: phone, name: '../Same/Name', timestamp: Date.UTC(2026, 8, 8, 20), id: '../x', text: 'one' });
    const second = await archive.write(dir, { identity: 'other', name: '../Same/Name', timestamp: now, id: 'two', text: 'two' });
    const renamed = await archive.write(dir, { identity: phone, name: 'Renamed', timestamp: Date.UTC(2026, 8, 8, 20), id: 'three', text: 'three' });
    assert.ok(first.path.startsWith(dir + '/')); assert.ok(first.path.includes('2026-09-09'));
    assert.equal(path.dirname(first.path), path.dirname(renamed.path));
    assert.notEqual(path.dirname(path.dirname(first.path)), path.dirname(path.dirname(second.path)));
    assert.equal(wibDay(Date.UTC(2026, 8, 8, 20)), '2026-09-09');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('status PN/LID resolution, persistent active cache, retry, and destination-specific deduplication', async () => {
  const dir = await tmp(); let time = now;
  try {
    const sock = { signalRepository: { lidMapping: { getPNForLID: async () => phone } } };
    assert.equal(await resolveStatusAuthor(status('lid', '123@lid'), sock), phone);
    assert.equal(await resolveStatusAuthor(status('alt', '123@lid', { participantAlt: phone }), {}), phone);
    const file = path.join(dir, 'inbox.json');
    const inbox = await new StatusInbox(file, { now: () => time }).load();
    const item = await inbox.receive(status('one', '123@lid'), sock);
    await inbox.receive(status('one', '123@lid'), sock);
    assert.equal(inbox.list().length, 1);
    await assert.rejects(inbox.archive(item.id, { targetKey: 'a', write: async () => { throw new Error('disk full'); } }));
    let writes = 0;
    assert.equal(await inbox.archive(item.id, { targetKey: 'a', write: async () => { writes++; } }), 'success');
    const reloaded = await new StatusInbox(file, { now: () => time }).load();
    assert.equal(await reloaded.archive(item.id, { targetKey: 'a', write: async () => { writes++; } }), 'saved');
    assert.equal(await reloaded.archive(item.id, { targetKey: 'b', write: async () => { writes++; } }), 'success');
    assert.equal(writes, 2);
    await reloaded.remove(status('one', '123@lid').key);
    assert.equal(await reloaded.receive(status('one', '123@lid'), sock), null);
    assert.equal(reloaded.list().length, 0);
    const second = await reloaded.receive(status('two'), sock);
    assert.ok(second);
    let replyTime;
    assert.equal(await reloaded.archiveReply(status('reply'), { sock, targetKey: 'a', write: async (entry) => { replyTime = entry.timestampSource; } }), 'success');
    assert.equal(replyTime, 'reply-received');
    assert.equal(reloaded.list().length, 1);
    time += 86400001; assert.equal(reloaded.list().length, 0);
    assert.equal(await reloaded.archive(item.id, {}), 'expired');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('recorded voice notes retain PTT and locations send natively', async () => {
  const dir = await tmp();
  try {
    const audio = path.join(dir, 'source.ogg'); await fs.writeFile(audio, 'fixture');
    const entries = await persistRecordedEntries([{ kind: 'media', tempPath: audio, messageType: 'audioMessage', mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 4 }], path.join(dir, 'stored'));
    const location = await recordMessageEntry({}, { key: { remoteJid: phone }, message: { locationMessage: { degreesLatitude: -6.2, degreesLongitude: 106.8, name: 'Jakarta' } } });
    const sent = [];
    await sendRecordedEntries({ sendMessage: async (jid, payload) => sent.push(payload) }, phone, [...entries, location.entry]);
    assert.equal(sent[0].ptt, true); assert.equal(sent[0].seconds, 4);
    assert.equal(sent[1].location.degreesLatitude, -6.2);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('error outbox redacts secrets, survives restart, combines failures and retries delivery', async () => {
  const dir = await tmp();
  try {
    const file = path.join(dir, 'outbox.json'); const reporter = new ErrorReporter(file); await reporter.load();
    await reporter.report('Download', { error: 'token=secret https://server/a?auth=secret' });
    await reporter.report('Download', { error: 'token=secret https://server/a?auth=secret' });
    assert.equal(reporter.items[0].count, 2); assert.ok(!reporter.items[0].detail.includes('secret'));
    reporter.send = async () => { throw new Error('offline'); }; await reporter.flush(); assert.equal(reporter.items.length, 1);
    const loaded = new ErrorReporter(file); await loaded.load(); let text;
    loaded.send = async (value) => { text = value; }; await loaded.flush();
    assert.ok(text.includes('Kejadian: 2')); assert.equal(loaded.items.length, 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('interval recordings preserve counts, pause ambiguous failures and resume at checkpoint', async () => {
  const schedule = parseTaskRecordingArgs(['record', 'Team', 'every', '1h30m', 'count', '3']);
  assert.equal(schedule.intervalMs, 5400000); assert.equal(schedule.count, 3);
  assert.equal(parseTaskRecordingArgs(['record', 'Team', 'every', '10s', 'forever']).loop, true);
  assert.throws(() => parseTaskRecordingArgs(['record', 'Team', 'every', '0s', 'forever']));
  const recorder = new TaskRecorder(); recorder.start(phone, { ...schedule, intervalMs: 1 }, phone, { jid: '1@g.us' });
  await recorder.record({}, { key: { remoteJid: phone }, message: { conversation: 'one' } });
  await recorder.record({}, { key: { remoteJid: phone }, message: { conversation: 'two' } });
  const task = await recorder.finish(phone, phone);
  assert.equal(task.remaining, 3); assert.ok(new Date(task.nextRunAt).getTime() >= Date.now() - 1000);
  let sends = 0, fail = true;
  const scheduler = new TaskScheduler({ sendMessage: async () => { sends++; if (sends === 2 && fail) throw new Error('timeout'); } }, {}, { error: async () => {} });
  await new Promise((r) => setTimeout(r, 5)); await scheduler.tick();
  let stored = (await listTasks()).find((item) => item.id === task.id);
  assert.equal(stored.paused, true); assert.equal(stored.remaining, 3); assert.equal(stored.deliveryCursor, 1);
  fail = false; await updateTaskState('resume', task.id); await scheduler.tick();
  stored = (await listTasks()).find((item) => item.id === task.id);
  assert.equal(stored.remaining, 2); assert.equal(sends, 3);
  await updateTaskState('del', task.id);
});

test('text sticker parsing and actual Arial renders fit a 512px canvas', async (t) => {
  const fontfile = fileURLToPath(new URL('../data/fonts/arial.ttf', import.meta.url));
  try { await fs.access(fontfile); } catch { t.skip('Run npm run setup:font for actual Arial render tests.'); return; }
  assert.equal(parseTextSticker('hello').align, 'left');
  assert.equal(parseTextSticker('align=kiri halo').align, 'left');
  const sizes = [];
  for (const align of ['left', 'right', 'center', 'justify']) {
    const result = await makeTextSticker({ text: 'Arial <teks> & aman\nBaris kedua untuk tes.', align, fontfile });
    const meta = await sharp(result.buffer).metadata(); assert.equal(meta.width, 512); assert.equal(meta.height, 512);
    const { data, info } = await sharp(result.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixel = (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)];
    assert.equal(pixel(0, 0)[3], 0, 'outer margin is transparent');
    assert.equal(pixel(16, 16)[3], 0, 'card corner is rounded');
    const cardPixel = pixel(256, 24);
    assert.equal(cardPixel[3], 255, 'card is opaque');
    assert.ok(cardPixel.slice(0, 3).every((channel) => channel >= 250), 'lossy WebP card appears white');
    sizes.push(result.fontSize);
  }
  for (const word of ['anjay', 'superpanjangtanpaspasi', 'kata-dengan-tanda-hubung']) {
    for (const align of ['left', 'right', 'center', 'justify']) {
      const single = await makeTextSticker({ text: word, align, fontfile });
      const measured = await sharp({ text: { text: word, font: `Arial ${single.fontSize}`, fontfile, wrap: 'none', dpi: 72, rgba: true } }).metadata();
      assert.ok(measured.width <= 408, `${word} must fit without splitting`);
      assert.equal(single.textHeight, measured.height, `${word} must remain one line`);
    }
  }
  const long = await makeTextSticker({ text: 'Ini kalimat panjang. '.repeat(100), fontfile });
  assert.ok(long.fontSize < sizes[0]);
});

test('bot integration: local status, owner listening, prompt priority, error routing and setup', async () => {
  const dir = await tmp();
  try {
    const sent = []; let id = 0;
    state.sock = { user: { id: phone }, sendMessage: async (jid, content) => { const message = { key: { remoteJid: jid, id: `sent-${++id}`, fromMe: true } }; sent.push({ jid, content, key: message.key }); return message; } };
    state.runtimeConfig = new RuntimeConfigStore(path.join(dir, 'config.json')); await state.runtimeConfig.load();
    await state.runtimeConfig.setStorage('statussave', 'local', path.join(dir, 'statussave'));
    await state.runtimeConfig.set('changedmsg.enabled', false);
    state.statusSave = new StatusSaveStore(path.join(dir, 'watched.json')); await state.statusSave.load(); await state.statusSave.add(phone);
    state.statusInbox = await new StatusInbox(path.join(dir, 'inbox.json')).load();
    state.saveRecorder = new SaveRecorder({ file: path.join(dir, 'saves.json'), mediaDir: path.join(dir, 'media') });
    state.taskRecorder = new TaskRecorder(); state.anticall = new AnticallStore(path.join(dir, 'anticall.json'), path.join(dir, 'anticall')); await state.anticall.load();
    state.commandAccess = new CommandAccessStore(path.join(dir, 'access.json')); await state.commandAccess.load();
    const emptySessions = { has: () => false, get: () => null, cancel: async () => false, end: () => null };
    state.pdfSessions = emptySessions; state.toVideoSessions = emptySessions; state.stimpaSessions = emptySessions; state.qrSessions = emptySessions; state.restoreSessions = emptySessions;
    state.contactNames.set(phone, 'Contact Test');
    await onMessageUpsert({ messages: [status('integration')] });
    assert.equal(sent.length, 0); assert.equal(state.statusInbox.list()[0].saved.length, 1);
    const own = (text, fromMe = true) => ({ key: { remoteJid: '9@g.us', participant: fromMe ? phone : 'other@s.whatsapp.net', id: `in-${++id}`, fromMe }, message: { conversation: text } });
    await onMessageUpsert({ messages: [own(',save demo')] });
    const prompt = sent.at(-1);
    await onMessageUpsert({ messages: [own('intruder', false), own('my message')] });
    assert.equal(state.saveRecorder.sessions.get('9@g.us').entries.length, 1);
    await onMessagesReaction([{ key: prompt.key, reaction: { text: '❌', key: { remoteJid: '9@g.us', fromMe: true } } }]);
    assert.equal(state.saveRecorder.has('9@g.us'), false); assert.ok(!sent.some((item) => item.content.delete));
    await onMessagesReaction([{ key: { remoteJid: '9@g.us', id: 'own-normal', fromMe: true }, reaction: { text: '❌', key: { remoteJid: '9@g.us', fromMe: true } } }]);
    assert.equal(sent.at(-1).content.delete.id, 'own-normal');
    const before = sent.length; const errors = [];
    setErrorSink(async (title, meta) => errors.push(meta));
    await handleFailure(new Error('download failed'), { jid: '9@g.us' });
    assert.equal(sent.length, before); assert.equal(errors.length, 1);
    await handleFailure(new UserInputError('Format salah'), { jid: '9@g.us' }); assert.equal(sent.at(-1).content.text, 'Format salah');
    await handleSetup({ key: { remoteJid: phone } }, { args: ['statussave', 'group', '123@g.us'] }, { isOwner: true, actorJid: phone });
    assert.equal(state.runtimeConfig.storageTarget('statussave').mode, 'group');
    state.groups.set('dev@g.us', { id: 'dev@g.us', subject: 'dev' });
    state.groups.set('err@g.us', { id: 'err@g.us', subject: 'errormsg', linkedParent: 'dev@g.us' });
    await resolveErrorGroup(); assert.equal(state.runtimeConfig.destination('errors').jid, 'err@g.us');
    await onMessageUpsert({ messages: [status('group-save')] });
    assert.equal(sent.at(-1).jid, '123@g.us');
    assert.ok(sent.at(-1).content.text.includes('Status WhatsApp'));
    await handleStatusBrowse({ key: { remoteJid: phone } }, { args: ['active', phone] });
    assert.ok(sent.at(-1).content.text.includes('Status aktif'));
    const cached = state.statusInbox.list().find((item) => item.key.endsWith(':group-save'));
    await handleStatusBrowse({ key: { remoteJid: phone } }, { args: ['dump', String(cached.id)] });
    assert.ok(sent.at(-1).content.text.includes('1 sudah tersimpan'));
    state.changedMessages = new ChangedMessageStore(path.join(dir, 'changed.json')); await state.changedMessages.load();
    await state.runtimeConfig.set('changedmsg.enabled', true);
    await state.runtimeConfig.setStorage('logs', 'local', path.join(dir, 'logs'));
    await state.runtimeConfig.setStorage('changedmsg', 'local', path.join(dir, 'changedmsg'));
    const incoming = { key: { remoteJid: '628777777777@s.whatsapp.net', id: 'original', fromMe: false }, messageTimestamp: Math.floor(now/1000), message: { conversation: 'Before edit' } };
    const beforeMirror = sent.length;
    await onMessageUpsert({ messages: [incoming] });
    const indexed = state.changedMessages.findByKey(incoming.key);
    assert.ok(indexed.logPath.startsWith(path.join(dir, 'logs')));
    assert.equal(sent.length, beforeMirror);
    await onMessagesUpdate([{ key: incoming.key, update: { message: { editedMessage: { message: { conversation: 'After edit' } } } } }]);
    const changedDir = path.join(dir, 'changedmsg', '628777777777', wibDay());
    const reports = await fs.readdir(changedDir);
    const report = await fs.readFile(path.join(changedDir, reports.find((name) => name.endsWith('.txt'))), 'utf8');
    assert.ok(report.includes('Before edit')); assert.ok(report.includes('After edit')); assert.ok(report.includes(indexed.logPath));
    assert.equal(sent.length, beforeMirror);
    const backupRoot = await tmp();
    try {
      await state.runtimeConfig.setStorage('backup', 'local', backupRoot);
      const files = await runConfiguredBackup();
      assert.ok(files[0].endsWith('.zip')); assert.ok((await fs.stat(path.join(backupRoot, files[0]))).size > 0);
      assert.equal(sent.length, beforeMirror);
    } finally { await fs.rm(backupRoot, { recursive: true, force: true }); }
    await state.runtimeConfig.set('changedmsg.enabled', false);
    await onMessageUpsert({ messages: [own(',anticall new')] });
    const anticallPrompt = sent.at(-1);
    await onMessageUpsert({ messages: [own('Reject response')] });
    await onMessagesReaction([{ key: anticallPrompt.key, reaction: { text: '✅', key: { remoteJid: '9@g.us', fromMe: true } } }]);
    assert.equal(state.anticall.snapshot().entryCount, 1);
    await state.anticall.setEnabled(true); await state.anticall.send(state.sock, phone);
    assert.equal(sent.at(-1).content.text, 'Reject response');
    await onMessageUpsert({ messages: [own(',save expire')] });
    state.sessionPrompts.get('9@g.us').lastActivity = Date.now() - 1800001;
    await expireListeningSessions(); assert.equal(state.saveRecorder.has('9@g.us'), false);
    await state.runtimeConfig.setStorage('statussave', 'local', path.join(dir, 'statussave'));
    await onMessageUpsert({ messages: [own(',statussave off')] });
    const pending = status('off-pending');
    await onMessageUpsert({ messages: [pending] });
    const queued = state.statusInbox.list().find((item) => item.key.endsWith(':off-pending'));
    assert.equal(queued.saved.length, 0);
    await onMessageUpsert({ messages: [own(`,statussave add ${phone}`)] });
    assert.equal(state.statusSave.list().length, 1);
    assert.ok(sent.some((item) => item.content.text?.includes('sudah terdaftar')));
    assert.equal(queued.saved.length, 0, 'add must respect auto-save off');
    await onMessageUpsert({ messages: [own(',statussave on')] });
    assert.equal(queued.saved.length, 1, 'on saves pending active statuses automatically');
    const receipts = [...queued.saved];
    for (const command of ['list', 'show']) {
      const beforeShow = sent.length;
      await onMessageUpsert({ messages: [own(`,statussave ${command} ${phone}`)] });
      const shown = sent.slice(beforeShow);
      assert.ok(shown.some((item) => item.content.text === 'Status test'));
      assert.ok(shown.every((item) => item.jid === '9@g.us'));
      assert.deepEqual(queued.saved, receipts);
    }
    await onMessageUpsert({ messages: [own(',statussave')] });
    assert.ok(sent.at(-1).content.text.includes('otomatis aktif'));
    setErrorSink(null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});


test('status preview reuses local media, preserves captions, and is independent from archival receipts', async () => {
  const dir = await tmp();
  try {
    const archive = new LocalArchive();
    for (const type of ['imageMessage', 'videoMessage', 'audioMessage']) {
      const id = `preview-${type}`;
      const message = { key: { remoteJid: 'status@broadcast', participant: phone, id }, message: { [type]: { caption: 'Caption asli\nbaris kedua', mimetype: type === 'audioMessage' ? 'audio/ogg' : 'image/jpeg', ptt: true } } };
      const source = path.join(dir, `${id}.bin`); await fs.writeFile(source, 'media-fixture');
      const reference = await archive.write(dir, { identity: phone, name: 'Test', timestamp: now, id, media: { path: source }, metadata: { sourceKey: message.key } });
      const item = { author: phone, timestamp: now, expiresAt: now + 86400000, message, saved: [`local:${dir}`] };
      // First test legacy archive discovery, then persisted direct references.
      if (type !== 'imageMessage') item.archives = { [`local:${dir}`]: reference };
      const text = [], media = [];
      const options = { localRoot: dir, maxMediaBytes: 1024, sendText: async (value) => text.push(value), sendMedia: async (value, caption) => media.push({ value, caption }), download: async () => { throw new Error('Must use local file'); } };
      for (let repeat = 0; repeat < 2; repeat++) assert.equal(await presentStatus(item, options), 'success');
      assert.equal(media.length, 2); assert.equal(media[0].caption, 'Caption asli\nbaris kedua');
      assert.equal(text.length, type === 'audioMessage' ? 2 : 0);
      await fs.access(reference.mediaPath);
      assert.equal(await presentStatus({ ...item, expiresAt: now - 1 }, options), 'expired');
      assert.deepEqual(item.saved, [`local:${dir}`]);
    }
    const transient = path.join(dir, 'download.bin'); await fs.writeFile(transient, 'temporary');
    const item = { author: phone, expiresAt: now + 86400000, message: { key: { id: 'download' }, message: { imageMessage: { caption: 'new caption' } } } };
    let caption;
    await presentStatus(item, { maxMediaBytes: 1024, download: async () => ({ path: transient, type: 'imageMessage' }), sendText: async () => {}, sendMedia: async (_, text) => { caption = text; } });
    assert.equal(caption, 'new caption'); await assert.rejects(fs.access(transient));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
