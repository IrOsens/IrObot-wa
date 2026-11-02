import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { state, onMessageUpsert, onMessagesReaction, maybeForwardReactedViewOnce } from '../src/index.js';

test('reacted view-once forwards once to target, skips other messages, and cleans media', async () => {
  const jid = 'viewonce-send-test@g.us';
  const previous = { chatDirectory: state.chatDirectory, viewOnceCache: state.viewOnceCache,
    forwardedViewOnceReactions: state.forwardedViewOnceReactions };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewonce-reaction-'));
  try {
    const source = { key: { remoteJid: jid, id: 'vo-1', fromMe: false },
      message: { viewOnceMessageV2: { message: { imageMessage: { viewOnce: true, mimetype: 'image/jpeg' } } } } };
    state.viewOnceCache = new previous.viewOnceCache.constructor();
    state.viewOnceCache.remember(source);
    state.forwardedViewOnceReactions = new Set();
    state.chatDirectory = { findByName: () => 'target@g.us' };
    const downloads = [];
    const sends = [];
    const options = {
      downloadMedia: async (_sock, message) => {
        downloads.push(message);
        const file = path.join(dir, `media-${downloads.length}.jpg`);
        await fs.writeFile(file, 'image fixture');
        return { path: file, type: 'imageMessage', mimetype: 'image/jpeg' };
      },
      sendMedia: async (target, media) => { sends.push({ target, media }); }
    };
    const update = (id, text, fromMe) => ({ key: { remoteJid: jid, id }, reaction: { text, key: { fromMe } } });
    assert.equal(await maybeForwardReactedViewOnce(update('vo-1', '🌈', false), options), false);
    assert.equal(await maybeForwardReactedViewOnce(update('not-vo', '🌈', true), options), false);
    assert.equal(await maybeForwardReactedViewOnce(update('vo-1', '', true), options), false);
    assert.equal(await maybeForwardReactedViewOnce(update('vo-1', '🌈', true), options), true);
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].key.id, 'vo-1');
    assert.equal(sends[0].target, 'target@g.us');
    await assert.rejects(fs.access(sends[0].media.path), { code: 'ENOENT' });
    assert.equal(await maybeForwardReactedViewOnce(update('vo-1', '🫶', true), options), true);
    assert.equal(sends.length, 1, 'later reaction does not resend same source');
  } finally {
    Object.assign(state, previous);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('arbitrary owner reaction selects the exact cached view-once message only', async () => {
  const jid = 'viewonce-test@g.us';
  const original = { sock: state.sock, chatDirectory: state.chatDirectory, viewOnceCache: state.viewOnceCache };
  let lookedUp = 0;
  try {
    state.sock = { user: { id: '628222222222@s.whatsapp.net' }, sendMessage: async () => { throw new Error('unexpected send'); } };
    state.chatDirectory = { remember: () => {}, findByName: () => { lookedUp++; return null; } };
    const { constructor: Cache } = original.viewOnceCache;
    state.viewOnceCache = new Cache();
    const source = (id) => ({ key: { remoteJid: jid, participant: '628111111111@s.whatsapp.net', id, fromMe: false }, message: { viewOnceMessageV2: { message: { imageMessage: { viewOnce: true, mimetype: 'image/jpeg' } } } } });
    await onMessageUpsert({ messages: [source('one'), source('two')] });
    assert.equal(state.viewOnceCache.findByKey({ remoteJid: jid, id: 'one' })?.key?.id, 'one');
    assert.equal(state.viewOnceCache.findByKey({ remoteJid: jid, id: 'other' }), null);
    const reaction = (id, fromMe) => ({ key: { remoteJid: jid, id }, reaction: { text: '🎮', key: { remoteJid: jid, fromMe } } });
    await onMessagesReaction([reaction('one', false), reaction('missing', true)]);
    assert.equal(lookedUp, 0);
    await onMessagesReaction([reaction('one', true)]);
    assert.equal(lookedUp, 1, 'any emoji by owner on exact view-once reaches forwarding destination');
  } finally {
    Object.assign(state, original);
  }
});
