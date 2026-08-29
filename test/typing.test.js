import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TypingController } from '../src/typing.js';

test('typing controller persists targets and pauses all targets on stop', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'irobot-typing-'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, 'typing-state.json');
  const presence = [];
  const sock = {
    async sendPresenceUpdate(type, jid) {
      presence.push({ type, jid });
    }
  };

  const controller = new TypingController({ filePath, refreshMs: 60_000 });
  await controller.load();
  controller.attach(sock);
  await controller.add({ jid: '628123456789@s.whatsapp.net', name: 'Kontak' });
  await controller.add({ jid: '120363000000000000@g.us', name: 'Grup Tes' });

  assert.deepEqual(controller.snapshot().map((target) => target.jid), [
    '628123456789@s.whatsapp.net',
    '120363000000000000@g.us'
  ]);
  assert.equal(presence.filter((item) => item.type === 'composing').length, 2);

  controller.detach();
  const restored = new TypingController({ filePath, refreshMs: 60_000 });
  await restored.load();
  assert.equal(restored.snapshot().length, 2);
  restored.attach(sock);
  const stopped = await restored.stopAll();

  assert.equal(stopped.length, 2);
  assert.deepEqual(restored.snapshot(), []);
  assert.deepEqual(
    presence.filter((item) => item.type === 'paused').map((item) => item.jid).sort(),
    ['120363000000000000@g.us', '628123456789@s.whatsapp.net'].sort()
  );

  const saved = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.deepEqual(saved.targets, []);
});

test('typing controller deduplicates an existing target', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'irobot-typing-'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const controller = new TypingController({
    filePath: path.join(tempDir, 'typing-state.json'),
    refreshMs: 60_000
  });
  await controller.load();

  const first = await controller.add({ jid: '628123456789@s.whatsapp.net', name: 'Nama Lama' });
  const second = await controller.add({ jid: '628123456789@s.whatsapp.net', name: 'Nama Baru' });

  assert.equal(first.added, true);
  assert.equal(second.added, false);
  assert.equal(controller.snapshot().length, 1);
  assert.equal(controller.snapshot()[0].name, 'Nama Baru');
});
