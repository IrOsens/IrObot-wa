import fs from 'node:fs/promises';
import { jidNormalizedUser } from 'baileys';
import { atomicJson } from './storage.js';
import { serializeValue, reviveValue } from './recordedMessages.js';
import { timestampMs } from './changedMessages.js';
import { mediaNode, downloadMessageMedia, cleanupFiles } from './media.js';
import { getMessageText, unwrapMessage } from './text.js';
import { UserInputError } from './errors.js';

export async function resolveStatusAuthor(message, sock) {
  const candidates = [message.key?.participantAlt, message.key?.participant, message.participant].filter(Boolean).map(jidNormalizedUser);
  for (const jid of candidates) if (jid.endsWith('@s.whatsapp.net')) return jid;
  for (const jid of candidates) {
    if (jid.endsWith('@lid')) {
      const pn = await sock?.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) return jidNormalizedUser(pn);
    }
  }
  return candidates[0] || '';
}
export class StatusInbox {
  constructor(file, { now = () => Date.now() } = {}) {
    this.file = file; this.now = now; this.data = { nextId: 1, items: [], revoked: [], replyReceipts: [] }; this.queue = Promise.resolve();
  }
  async load() {
    try { this.data = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.data.revoked ||= [];
    this.data.replyReceipts ||= [];
    this.prune(); return this;
  }
  serial(fn) { const work = this.queue.then(fn); this.queue = work.catch(() => {}); return work; }
  prune() { this.data.revoked = (this.data.revoked || []).filter((item) => item.expiresAt > this.now()); this.data.items = this.data.items.filter((item) => item.expiresAt > this.now() && !item.deleted); }
  async save() { this.prune(); await atomicJson(this.file, this.data); }
  list(author = null) { this.prune(); return this.data.items.filter((item) => !author || item.author === author); }
  receive(message, sock) {
    return this.serial(async () => {
      if (message.key?.remoteJid !== 'status@broadcast' || !message.key?.id) return null;
      const content = unwrapMessage(message.message);
      if (!content || (!mediaNode(message) && !getMessageText(message))) return null;
      const timestamp = timestampMs(message);
      if (timestamp + 86400000 <= this.now()) return null;
      const author = await resolveStatusAuthor(message, sock);
      if (!author) return null;
      this.prune();
      if (this.data.revoked.some((item) => item.id === message.key.id && (!item.participant || item.participant === message.key.participant))) return null;
      const key = `${message.key.participant || author}:${message.key.id}`;
      let item = this.data.items.find((item) => item.key === key);
      if (!item) {
        item = { id: this.data.nextId++, key, author, timestamp, expiresAt: timestamp + 86400000, saved: [] };
        this.data.items.push(item);
      }
      item.author = author; item.message = serializeValue(message);
      await this.save(); return item;
    });
  }
  remove(key) {
    return this.serial(async () => {
      this.data.revoked.push({ id: key.id, participant: key.participant, expiresAt: this.now() + 86400000 });
      for (const item of this.data.items) if (reviveValue(item.message).key?.id === key.id && (!key.participant || reviveValue(item.message).key.participant === key.participant)) item.deleted = true;
      await this.save();
    });
  }
  archiveReply(message, options) {
    return this.serial(async () => {
      const author = await resolveStatusAuthor(message, options.sock);
      if (!author || !message.key?.id) throw new UserInputError('Pengirim/ID status reply tidak tersedia.');
      const receiptKey = `${author}:${message.key.id}:${options.targetKey}`;
      if (this.data.replyReceipts.some((item) => item.key === receiptKey)) return 'saved';
      const item = { author, timestamp: this.now(), timestampSource: 'reply-received', saved: [] };
      await this.writePayload(item, message, options);
      this.data.replyReceipts.push({ key: receiptKey, time: this.now() });
      this.data.replyReceipts = this.data.replyReceipts.filter((item) => item.time > this.now() - 7 * 86400000);
      await this.save(); return 'success';
    });
  }
  archive(id, options) {
    return this.serial(async () => {
      const item = this.list().find((candidate) => candidate.id === Number(id));
      if (!item) return 'expired';
      if (item.saved.includes(options.targetKey)) return 'saved';
      const archive = await this.writePayload(item, reviveValue(item.message), options);
      if (archive?.path) { item.archives ||= {}; item.archives[options.targetKey] = archive; }
      item.saved.push(options.targetKey);
      await this.save(); return 'success';
    });
  }
  async writePayload(item, message, { sock, maxMediaBytes, write }) {
    let media;
    try {
      const found = mediaNode(message);
      if (found) {
        const size = Number(found.node.fileLength || 0);
        if (size > maxMediaBytes) throw new UserInputError('Media status melebihi batas penyimpanan.');
        media = await downloadMessageMedia(sock, message, 'status-save');
        if (!media) throw new Error('Media status tidak dapat dibaca.');
        if ((await fs.stat(media.path)).size > maxMediaBytes) throw new UserInputError('Media status melebihi batas penyimpanan.');
      }
      return await write(item, message, media);
    } finally { await cleanupFiles([media?.path]); }
  }

}
