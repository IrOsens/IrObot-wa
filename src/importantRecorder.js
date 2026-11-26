import { getContentType } from 'baileys';
import { getMessageText, unwrapMessage } from './text.js';

export const IMPORTANT_MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const PROFILE_REFRESH_MS = 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 3000;

const REVOKE = 0;
const MESSAGE_EDIT = 14;

const toNumber = (value) => {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value.toNumber === 'function') return value.toNumber();
  return Number(value) || 0;
};

const messageTs = (message) => {
  const seconds = toNumber(message.messageTimestamp);
  return seconds ? seconds * 1000 : Date.now();
};

function contextOf(content) {
  for (const value of Object.values(content || {})) {
    if (value && typeof value === 'object' && value.contextInfo) return value.contextInfo;
  }
  return null;
}

function quotedOf(content) {
  const info = contextOf(content);
  if (!info?.stanzaId || !info.quotedMessage) return null;
  const quoted = unwrapMessage(info.quotedMessage);
  const type = getContentType(quoted || {});
  return {
    id: info.stanzaId,
    sender: info.participant || '',
    text: getMessageText({ message: quoted }).slice(0, 200),
    kind: kindOf(type, quoted?.[type])
  };
}

function kindOf(type, node) {
  switch (type) {
    case 'conversation':
    case 'extendedTextMessage': return 'text';
    case 'imageMessage': return 'image';
    case 'videoMessage': return node?.gifPlayback ? 'gif' : 'video';
    case 'ptvMessage': return 'video';
    case 'audioMessage': return node?.ptt ? 'voice' : 'audio';
    case 'stickerMessage': return 'sticker';
    case 'documentMessage': return 'document';
    case 'locationMessage':
    case 'liveLocationMessage': return 'location';
    case 'contactMessage':
    case 'contactsArrayMessage': return 'contact';
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3': return 'poll';
    default: return 'other';
  }
}

const MEDIA_KINDS = new Set(['image', 'video', 'gif', 'audio', 'voice', 'sticker', 'document']);

function isViewOnce(raw) {
  return Boolean(raw?.viewOnceMessage || raw?.viewOnceMessageV2 || raw?.viewOnceMessageV2Extension);
}

// Turns one Baileys message into a stored event, or null for things the UI does not show.
export function normalizeMessage(message) {
  const chat = message?.key?.remoteJid;
  if (!chat || !message.message) return null;
  if (chat.endsWith('@broadcast') || chat.endsWith('@newsletter')) return null;
  const fromMe = Boolean(message.key.fromMe);
  const sender = fromMe ? 'me' : (message.key.participant || chat);
  const senderAlt = fromMe ? '' : (message.key.participantAlt || message.key.remoteJidAlt || '');
  const ts = messageTs(message);
  const base = { chat, ts, sender, senderAlt, fromMe, pushName: fromMe ? '' : (message.pushName || '') };

  const raw = message.message;
  const editWrapper = raw.editedMessage?.message?.protocolMessage;
  const protocol = editWrapper || raw.protocolMessage;
  if (protocol) {
    if (protocol.type === REVOKE && protocol.key?.id) return { ...base, t: 'del', id: protocol.key.id };
    if ((protocol.type === MESSAGE_EDIT || editWrapper) && protocol.key?.id && protocol.editedMessage) {
      return { ...base, t: 'edit', id: protocol.key.id, text: getMessageText({ message: protocol.editedMessage }) };
    }
    return null;
  }
  if (raw.reactionMessage) {
    const reaction = raw.reactionMessage;
    if (!reaction.key?.id) return null;
    return { ...base, t: 'react', id: reaction.key.id, emoji: reaction.text || '' };
  }

  const content = unwrapMessage(raw);
  const type = getContentType(content || {});
  if (!type || ['senderKeyDistributionMessage', 'messageContextInfo'].includes(type)) return null;
  const node = content[type] || {};
  const kind = kindOf(type, node);
  const event = {
    ...base,
    t: 'msg',
    id: message.key.id,
    kind,
    text: getMessageText(message) || '',
    quoted: quotedOf(content),
    viewOnce: isViewOnce(raw) || Boolean(node.viewOnce) || undefined,
    forwarded: Boolean(contextOf(content)?.isForwarded) || undefined
  };
  if (MEDIA_KINDS.has(kind)) {
    event.media = {
      mimetype: node.mimetype || '',
      fileName: node.fileName || '',
      size: toNumber(node.fileLength),
      seconds: toNumber(node.seconds) || undefined,
      width: toNumber(node.width) || undefined,
      height: toNumber(node.height) || undefined,
      animated: node.isAnimated || undefined,
      sound: kind === 'sticker' && node.soundAudio ? true : undefined,
      soundSeconds: kind === 'sticker' ? toNumber(node.soundAudio?.seconds) || undefined : undefined
    };
  }
  if (kind === 'location') {
    event.location = {
      lat: Number(node.degreesLatitude) || 0,
      lng: Number(node.degreesLongitude) || 0,
      name: node.name || node.address || ''
    };
  }
  if (kind === 'contact') {
    const list = type === 'contactsArrayMessage' ? (node.contacts || []) : [node];
    event.contacts = list.map((item) => ({
      name: item.displayName || '',
      phone: (String(item.vcard || '').match(/waid=(\d+)/) || [])[1] || ''
    }));
    if (!event.text) event.text = event.contacts.map((item) => item.name).join(', ');
  }
  if (kind === 'poll') {
    event.text = node.name || event.text;
    event.poll = (node.options || []).map((item) => item.optionName).filter(Boolean);
  }
  if (kind === 'other') event.text = event.text || `[${type}]`;
  return event;
}

// Records everything a worker with the "important" service sees, in the background.
export class ImportantRecorder {
  constructor({ store, downloadMedia, fetchImpl = fetch, logger = null, maxMediaBytes = IMPORTANT_MAX_MEDIA_BYTES }) {
    this.store = store;
    this.downloadMedia = downloadMedia;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.maxMediaBytes = maxMediaBytes;
    this.recent = new Map();
    this.profileChecks = new Map();
    this.queues = new Map();
  }

  warn(message, meta) {
    this.logger?.warn?.(message, meta)?.catch?.(() => {});
  }

  queue(workerId, task) {
    const run = (this.queues.get(workerId) || Promise.resolve()).then(task).catch((error) => this.warn('Important record failed', { worker: workerId, error: error.message }));
    this.queues.set(workerId, run);
    return run;
  }

  seen(workerId, key) {
    let set = this.recent.get(workerId);
    if (!set) this.recent.set(workerId, set = new Set());
    if (set.has(key)) return true;
    set.add(key);
    if (set.size > RECENT_LIMIT) set.delete(set.values().next().value);
    return false;
  }

  // event is the messages.upsert payload. Never throws; returns a promise for tests.
  record(workerId, sock, event) {
    if (!['notify', 'append'].includes(event?.type)) return Promise.resolve();
    const messages = (event.messages || []).map((message) => ({ message, normalized: normalizeMessage(message) })).filter((item) => item.normalized);
    if (!messages.length) return Promise.resolve();
    return this.queue(workerId, async () => {
      for (const { message, normalized } of messages) {
        const key = `${normalized.t}:${normalized.chat}:${normalized.id}:${normalized.ts}:${normalized.emoji || ''}`;
        if (this.seen(workerId, key)) continue;
        // Logging switched off for this chat in the Web UI: store nothing (no media either).
        if (await this.store.isPaused?.(workerId, normalized.chat)) continue;
        await this.saveOne(workerId, sock, message, normalized);
      }
    });
  }

  async saveOne(workerId, sock, message, event) {
    if (event.pushName && event.sender !== 'me') await this.store.setContact(workerId, event.sender, event.pushName);
    if (event.media) {
      if (event.media.size && event.media.size > this.maxMediaBytes) {
        event.media.skipped = 'terlalu besar';
      } else {
        try {
          const downloaded = await this.downloadMedia(sock, message);
          if (downloaded?.buffer) {
            event.media.id = await this.store.saveMedia(workerId, event.ts, downloaded.buffer);
            event.media.mimetype = event.media.mimetype || downloaded.mimetype || '';
            event.media.size = event.media.size || downloaded.buffer.length;
            if (downloaded.audio?.buffer) {
              event.media.audioId = await this.store.saveMedia(workerId, event.ts, downloaded.audio.buffer);
              event.media.sound = true;
            }
          }
        } catch (error) {
          event.media.skipped = 'gagal diunduh';
          this.warn('Important media download failed', { worker: workerId, error: error.message });
        }
      }
    }
    const phone = await this.phoneFor(sock, event.chat, event.chat.endsWith('@lid') ? message.key.remoteJidAlt : null);
    if (phone) await this.store.updateChat(workerId, event.chat, { phone });
    await this.store.append(workerId, event);
    this.refreshProfile(workerId, sock, event.chat).catch(() => {});
  }

  async phoneFor(sock, jid, alt) {
    if (!jid) return '';
    if (jid.endsWith('@s.whatsapp.net')) return jid.split('@')[0].split(':')[0];
    if (alt?.endsWith('@s.whatsapp.net')) return alt.split('@')[0].split(':')[0];
    if (!jid.endsWith('@lid')) return '';
    try {
      const pn = await sock?.signalRepository?.lidMapping?.getPNForLID?.(jid);
      return pn ? String(pn).split('@')[0].split(':')[0] : '';
    } catch {
      return '';
    }
  }

  // Profile picture and group name, at most once a day per chat.
  async refreshProfile(workerId, sock, jid, { force = false } = {}) {
    if (!sock || !jid) return;
    const key = `${workerId}:${jid}`;
    const last = this.profileChecks.get(key) || 0;
    if (!force && Date.now() - last < PROFILE_REFRESH_MS) return;
    this.profileChecks.set(key, Date.now());
    const chat = await this.store.chat(workerId, jid);
    if (!force && chat?.profileAt && Date.now() - chat.profileAt < PROFILE_REFRESH_MS) return;
    const patch = { profileAt: Date.now() };
    if (jid.endsWith('@g.us')) {
      try {
        const meta = await sock.groupMetadata(jid);
        if (meta?.subject) patch.name = meta.subject;
        patch.members = Array.isArray(meta?.participants) ? meta.participants.length : undefined;
        patch.description = meta?.desc ? String(meta.desc).slice(0, 500) : undefined;
      } catch { /* not a member anymore */ }
    }
    try {
      const url = await sock.profilePictureUrl(jid, 'image');
      if (url) {
        const response = await this.fetch(url);
        if (response.ok) patch.avatarId = await this.store.saveAvatar(workerId, jid, Buffer.from(await response.arrayBuffer()));
      }
    } catch { /* no picture or hidden by privacy */ }
    await this.store.updateChat(workerId, jid, patch);
  }

  async rememberContacts(workerId, contacts = []) {
    for (const contact of contacts || []) {
      const name = contact?.name || contact?.notify || contact?.verifiedName;
      if (!contact?.id || !name) continue;
      await this.store.setContact(workerId, contact.id, name);
      if (contact.lid && contact.lid !== contact.id) await this.store.setContact(workerId, contact.lid, name);
    }
  }
}
