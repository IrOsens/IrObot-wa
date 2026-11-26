import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isSocialUrl, parseStartTime, startTimeFromArgs, withSocialAudio, withSocialDownload, ensureYtdlp } from '../src/socialAudio.js';

test('isSocialUrl recognises social media hosts only', () => {
  assert.equal(isSocialUrl('https://vt.tiktok.com/ZS123/'), true);
  assert.equal(isSocialUrl('https://www.instagram.com/reel/abc/'), true);
  assert.equal(isSocialUrl('https://youtu.be/xyz'), true);
  assert.equal(isSocialUrl('https://x.com/a/status/1'), true);
  assert.equal(isSocialUrl('https://example.com/song.mp3'), false);
  assert.equal(isSocialUrl('https://nottiktok.com/x'), false);
  assert.equal(isSocialUrl('bukan url'), false);
});

test('start time parsing', () => {
  assert.equal(parseStartTime('1:05'), 65);
  assert.equal(parseStartTime('0:01:05'), 65);
  assert.equal(parseStartTime('90'), 90);
  assert.equal(parseStartTime('1m5s'), 65);
  assert.equal(parseStartTime('abc'), 0);
  assert.equal(startTimeFromArgs('https://youtu.be/x 1:30', 'https://youtu.be/x'), 90);
  assert.equal(startTimeFromArgs('https://youtu.be/x', 'https://youtu.be/x'), 0);
});

test('withSocialAudio removes the download folder after success and failure', async () => {
  let dir = null;
  const run = async (command, args) => {
    const output = args[args.indexOf('-o') + 1];
    dir = path.dirname(output);
    await fs.writeFile(output.replace('%(ext)s', 'm4a'), 'audio');
    await fs.writeFile(path.join(dir, 'leftover.part'), 'x');
    assert.ok(args.includes('--download-sections'));
    assert.equal(args.at(-1), 'https://vt.tiktok.com/x');
    return { stdout: '', stderr: '' };
  };
  const tools = { ytdlp: '/bin/yt-dlp', ffmpeg: '/bin/ffmpeg' };
  const result = await withSocialAudio(tools, 'https://vt.tiktok.com/x', { run, startSec: 5 }, async (media) => {
    assert.equal(path.extname(media.path), '.m4a');
    assert.equal(await fs.readFile(media.path, 'utf8'), 'audio');
    return 'ok';
  });
  assert.equal(result, 'ok');
  await assert.rejects(fs.access(dir));

  await assert.rejects(
    withSocialAudio(tools, 'https://vt.tiktok.com/x', { run }, async () => { throw new Error('convert gagal'); }),
    /convert gagal/
  );
  await assert.rejects(fs.access(dir));

  const failing = async (command, args) => {
    dir = path.dirname(args[args.indexOf('-o') + 1]);
    throw Object.assign(new Error('fail'), { stderr: 'ERROR: Private video. Sign in' });
  };
  await assert.rejects(withSocialAudio(tools, 'https://vt.tiktok.com/x', { run: failing }, async () => {}), /privat/);
  await assert.rejects(fs.access(dir));
  const none = { find: async () => null, install: async () => null };
  await assert.rejects(withSocialAudio({}, 'https://vt.tiktok.com/x', { ytdlp: none }, async () => {}), /yt-dlp belum terpasang/);
  const later = {};
  await ensureYtdlp(later, { find: async () => '/home/x/.local/bin/yt-dlp', install: async () => null });
  assert.equal(later.ytdlp, '/home/x/.local/bin/yt-dlp', 'found after startup without restart');
  const installed = {};
  await ensureYtdlp(installed, { find: async () => null, install: async () => '/new/yt-dlp' });
  assert.equal(installed.ytdlp, '/new/yt-dlp');
});

test('withSocialDownload returns every photo/video with the title and cleans up', async () => {
  let dir = null;
  const run = async (command, args) => {
    const output = args[args.indexOf('-o') + 1];
    dir = path.dirname(output);
    await fs.writeFile(path.join(dir, '01.jpg'), 'a');
    await fs.writeFile(path.join(dir, '02.mp4'), 'b');
    await fs.writeFile(path.join(dir, '03.part'), 'c');
    return { stdout: 'kreator\tJudul video\n', stderr: '' };
  };
  const result = await withSocialDownload({ ytdlp: '/bin/yt-dlp' }, 'https://www.instagram.com/p/x/', { run }, async (data) => {
    assert.deepEqual(data.files.map((file) => file.kind), ['image', 'video']);
    return data;
  });
  assert.equal(result.title, 'Judul video');
  assert.equal(result.uploader, 'kreator');
  await assert.rejects(fs.access(dir));

  const empty = async (command, args) => { dir = path.dirname(args[args.indexOf('-o') + 1]); return { stdout: '' }; };
  await assert.rejects(withSocialDownload({ ytdlp: '/bin/yt-dlp' }, 'https://youtu.be/x', { run: empty }, async () => {}), /Tidak ada video/);
  await assert.rejects(fs.access(dir));
});
