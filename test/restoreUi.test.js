import test from 'node:test';
import assert from 'node:assert/strict';
import { state, onMessageUpsert } from '../src/index.js';
import { RestoreSessions } from '../src/restore.js';

test('restore save numeric menu supports multi-select, pages, and 0 back', async () => {
  const sent = [];
  let sequence = 0;
  const jid = 'restore-menu@g.us';
  const actorJid = '628123456789@s.whatsapp.net';
  state.sock = {
    user: { id: actorJid },
    sendMessage: async (chat, content) => {
      sent.push(content);
      return { key: { remoteJid: chat, id: `reply-${++sequence}`, fromMe: true } };
    }
  };
  const idle = { has: () => false, finish: async () => null, end: () => null, get: () => null };
  state.saveRecorder = idle;
  state.taskRecorder = idle;
  state.anticall = idle;
  state.qrSessions = idle;
  state.toVideoSessions = idle;
  state.pdfSessions = idle;
  state.restoreSessions = new RestoreSessions();
  state.commandAccess = { canUseAs: () => true, isOpen: () => false, isAdmin: () => false };
  const session = {
    jid, actorJid, mode: 'save', phase: 'scope', selectedIds: new Set(), page: 0,
    savedItems: Array.from({ length: 12 }, (_, index) => ({ id: index + 1, title: `Save ${index + 1}`, entries: [] }))
  };
  state.restoreSessions.sessions.set(jid, session);
  const send = async (value) => onMessageUpsert({ messages: [{
    key: { remoteJid: jid, id: `input-${++sequence}`, fromMe: true },
    message: { conversation: value }
  }] });
  try {
    await send('2');
    assert.equal(session.phase, 'select');
    await send('1');
    await send('11');
    await send('2');
    assert.deepEqual([...session.selectedIds], [1, 12]);
    await send(',end');
    assert.equal(session.phase, 'mode');
    await send('0');
    assert.equal(session.phase, 'select');
    await send('0');
    assert.equal(session.phase, 'scope');
    await send('1');
    assert.equal(session.phase, 'mode');
    assert.equal(session.selectedIds.size, 12);
    await send('0');
    assert.equal(session.phase, 'scope');
    assert.ok(sent.some((item) => item.text?.includes('Halaman berikutnya')));
  } finally {
    state.restoreSessions.sessions.delete(jid);
  }
});
