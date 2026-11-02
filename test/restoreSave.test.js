import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RestoreSessions } from '../src/restore.js';
import { splitBuffer, zipDirectory } from '../src/zip.js';

async function backupSession(work, backup, { split = false } = {}) {
  const tempDir = await fs.mkdtemp(path.join(work, 'session-'));
  const buffer = await zipDirectory(backup);
  const parts = split ? splitBuffer(buffer, Math.max(80, Math.ceil(buffer.length / 2))) : [buffer];
  const files = [];
  for (const [index, part] of parts.entries()) {
    const fileName = parts.length === 1 ? 'BACKUP-old.zip' : `PART${index + 1}-old.zip`;
    const file = path.join(tempDir, fileName);
    await fs.writeFile(file, part);
    files.push({ path: file, fileName, receivedAt: index });
  }
  return { mode: 'save', phase: 'upload', files: split ? files.reverse() : files, tempDir, selectedIds: new Set(), page: 0 };
}

test('restore save merges selected old backup media and overwrites only save data', async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-save-test-'));
  try {
    const backup = path.join(work, 'backup');
    const current = path.join(work, 'current');
    const oldMedia = path.join(backup, 'saved-messages', '1-report', '001.png');
    const currentMedia = path.join(current, 'saved-messages', '7-report', '001.png');
    await fs.mkdir(path.dirname(oldMedia), { recursive: true });
    await fs.mkdir(path.dirname(currentMedia), { recursive: true });
    await fs.writeFile(oldMedia, 'backup photo');
    await fs.writeFile(currentMedia, 'current photo');
    await fs.writeFile(path.join(backup, 'saved-messages.json'), JSON.stringify({ nextId: 3, items: [
      { id: 1, title: 'Report', entries: [{ kind: 'media', path: '/old/device/data/saved-messages/1-report/001.png', messageType: 'imageMessage' }] },
      { id: 2, title: 'Other', entries: [{ kind: 'text', text: 'second backup save' }] }
    ] }));
    await fs.writeFile(path.join(current, 'saved-messages.json'), JSON.stringify({ nextId: 8, items: [
      { id: 7, title: 'Report', entries: [{ kind: 'media', path: currentMedia, messageType: 'imageMessage' }] }
    ] }));
    await fs.writeFile(path.join(current, 'notes.json'), '{"keep":true}');

    const restore = new RestoreSessions();
    const merge = await backupSession(work, backup, { split: true });
    assert.equal((await restore.prepareSaved(merge)).count, 2);
    merge.selectedIds.add(1);
    merge.restoreMode = 'merge';
    assert.deepEqual(await restore.restoreSaved(merge, { dataDir: current }), { restored: 1, total: 2, mode: 'merge' });
    const merged = JSON.parse(await fs.readFile(path.join(current, 'saved-messages.json'), 'utf8'));
    assert.deepEqual(merged.items.map((item) => [item.id, item.title]), [[7, 'Report'], [8, 'Report (backup)']]);
    assert.equal(await fs.readFile(currentMedia, 'utf8'), 'current photo');
    assert.equal(await fs.readFile(merged.items[1].entries[0].path, 'utf8'), 'backup photo');
    assert.equal(await fs.readFile(path.join(current, 'notes.json'), 'utf8'), '{"keep":true}');

    const overwrite = await backupSession(work, backup);
    await restore.prepareSaved(overwrite);
    overwrite.selectedIds.add(2);
    overwrite.restoreMode = 'overwrite';
    assert.deepEqual(await restore.restoreSaved(overwrite, { dataDir: current }), { restored: 1, total: 1, mode: 'overwrite' });
    const replaced = JSON.parse(await fs.readFile(path.join(current, 'saved-messages.json'), 'utf8'));
    assert.deepEqual(replaced.items.map((item) => [item.id, item.title]), [[2, 'Other']]);
    assert.equal(replaced.items[0].entries[0].text, 'second backup save');
    assert.equal(await fs.readFile(path.join(current, 'notes.json'), 'utf8'), '{"keep":true}');
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test('restore save leaves current data intact when selected backup media is absent', async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-save-missing-'));
  try {
    const backup = path.join(work, 'backup');
    const current = path.join(work, 'current');
    await fs.mkdir(backup);
    await fs.mkdir(current);
    await fs.writeFile(path.join(backup, 'saved-messages.json'), JSON.stringify({ items: [
      { id: 1, title: 'Lost', entries: [{ kind: 'media', path: '/old/data/saved-messages/lost/001.png' }] }
    ] }));
    const original = JSON.stringify({ nextId: 2, items: [{ id: 1, title: 'Keep', entries: [{ kind: 'text', text: 'safe' }] }] });
    await fs.writeFile(path.join(current, 'saved-messages.json'), original);
    const restore = new RestoreSessions();
    const session = await backupSession(work, backup);
    await restore.prepareSaved(session);
    session.selectedIds.add(1);
    session.restoreMode = 'overwrite';
    await assert.rejects(() => restore.restoreSaved(session, { dataDir: current }), /tidak ada dalam backup/);
    assert.equal(await fs.readFile(path.join(current, 'saved-messages.json'), 'utf8'), original);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test('restore save rejects incomplete multipart ZIP before showing choices', async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-save-parts-'));
  try {
    const backup = path.join(work, 'backup');
    await fs.mkdir(backup);
    await fs.writeFile(path.join(backup, 'saved-messages.json'), JSON.stringify({ items: [
      { id: 1, title: 'One', entries: [{ kind: 'text', text: 'test' }] }
    ] }));
    const restore = new RestoreSessions();
    const session = await backupSession(work, backup, { split: true });
    session.files.pop();
    await assert.rejects(() => restore.prepareSaved(session), /Part backup harus lengkap/);
    assert.equal(session.phase, 'upload');
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});
