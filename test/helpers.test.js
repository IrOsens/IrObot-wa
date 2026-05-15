import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertUniqueTitle } from '../src/namedStore.js';
import { PdfSessions, parsePdfOrderText } from '../src/pdf.js';
import { parseDurationMs } from '../src/reminders.js';
import { normalizeMac } from '../src/wol.js';
import { normalizeYoutubeCookies, youtubeCookieWarnings } from '../src/youtubeCookies.js';
import { parseYoutubeArgs } from '../src/youtube.js';
import { extractZipBuffer, zipDirectory } from '../src/zip.js';
import { PendingConfirmStore, parseSecretMediaTriggerText } from '../src/confirm.js';
import { parseSmemeArgs } from '../src/sticker.js';

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

test('assertUniqueTitle rejects case-insensitive duplicates', () => {
  const store = { items: [{ id: 1, title: 'Laporan' }] };
  assert.throws(() => assertUniqueTitle(store, 'laporan'), /sudah ada/);
  assert.doesNotThrow(() => assertUniqueTitle(store, 'Laporan Baru'));
  assert.doesNotThrow(() => assertUniqueTitle(store, 'laporan', 1));
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

test('normalizeYoutubeCookies supports raw Cookie header and Netscape text', () => {
  const fromHeader = normalizeYoutubeCookies('Cookie: VISITOR_INFO1_LIVE=abc; SID=def');
  assert.match(fromHeader, /Netscape HTTP Cookie File/);
  assert.match(fromHeader, /\.youtube\.com\tTRUE\t\/\tTRUE\t2147483647\tSID\tdef/);

  const netscape = normalizeYoutubeCookies('.youtube.com\tTRUE\t/\tTRUE\t2147483647\tSID\tdef');
  assert.match(netscape, /Netscape HTTP Cookie File/);
  assert.match(netscape, /SID\tdef/);

  const httpOnly = normalizeYoutubeCookies('#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t2147483647\tSID\tdef');
  assert.match(httpOnly, /#HttpOnly_\.youtube\.com/);
});

test('normalizeYoutubeCookies supports browser JSON export', () => {
  const normalized = normalizeYoutubeCookies(JSON.stringify({
    cookies: [
      {
        domain: '.youtube.com',
        hostOnly: false,
        httpOnly: true,
        name: 'SID',
        path: '/',
        secure: true,
        expirationDate: 1813386668.9,
        value: 'secret'
      }
    ]
  }));
  assert.match(normalized, /Netscape HTTP Cookie File/);
  assert.match(normalized, /#HttpOnly_\.youtube\.com\tTRUE\t\/\tTRUE\t1813386668\tSID\tsecret/);
});

test('normalizeYoutubeCookies repairs damaged YouTube secure cookie names', () => {
  const fromJson = normalizeYoutubeCookies(JSON.stringify({
    cookies: [
      { domain: '.youtube.com', name: '_Secure-3PSID', value: 'a', path: '/', secure: true, httpOnly: true },
      { domain: '.youtube.com', name: 'Secure-1PSID', value: 'b', path: '/', secure: true, httpOnly: true }
    ]
  }));
  assert.match(fromJson, /__Secure-3PSID\ta/);
  assert.match(fromJson, /__Secure-1PSID\tb/);

  const fromHeader = normalizeYoutubeCookies('Cookie: Secure-3PSID=a; _Secure-1PSID=b');
  assert.match(fromHeader, /__Secure-3PSID\ta/);
  assert.match(fromHeader, /__Secure-1PSID\tb/);
});

test('youtubeCookieWarnings reports missing important cookies', () => {
  const warnings = youtubeCookieWarnings('Cookie: PREF=abc');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /SID/);
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
  store.set('jid@test', { title: 'Test', execute });
  assert.equal(store.count(), 1);
  assert.equal(store.take('jid@test').title, 'Test');
  assert.equal(store.take('jid@test'), null);

  store.set('jid@test', { title: 'Expired', execute });
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(store.get('jid@test'), null);
  assert.equal(store.count(), 0);
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

test('parseYoutubeArgs supports optional time range', () => {
  assert.deepEqual(parseYoutubeArgs(['https://www.youtube.com/watch?v=abc', 'mp4', '720', '00:00-01:00']), {
    url: 'https://www.youtube.com/watch?v=abc',
    type: 'mp4',
    quality: '720',
    range: '00:00-01:00'
  });
  assert.deepEqual(parseYoutubeArgs(['https://youtu.be/abc', 'mp4', '00:00-01:00']), {
    url: 'https://youtu.be/abc',
    type: 'mp4',
    quality: '720',
    range: '00:00-01:00'
  });
  assert.deepEqual(parseYoutubeArgs(['https://youtu.be/abc', 'mp3', '1:02:03-1:03:04']).range, '1:02:03-1:03:04');
  assert.throws(() => parseYoutubeArgs(['https://youtu.be/abc', 'mp4', '999']), /Format:/);
});

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
