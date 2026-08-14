import fs from 'node:fs/promises';
import path from 'node:path';
import { getContentType } from 'baileys';
import { cleanupFiles, downloadMessageMedia } from './media.js';
import { getMessageText, unwrapMessage } from './text.js';

export function isRecorderNotice(entry) {
  return entry.kind === 'text' && /^Direkam \(\d+ item\)\.$/.test(String(entry.text || '').trim());
}

export function visibleRecordedEntries(entries = []) {
  return entries.filter((entry) => !isRecorderNotice(entry));
}

export function serializeValue(value) {
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { __type: 'Buffer', data: Buffer.from(value).toString('base64') };
  }
  if (Array.isArray(value)) return value.map(serializeValue);
  if (typeof value.toJSON === 'function' && value.constructor?.name !== 'Object') return serializeValue(value.toJSON());
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined && typeof item !== 'function')
        .map(([key, item]) => [key, serializeValue(item)])
    );
  }
  return String(value);
}

export function reviveValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (value.__type === 'Buffer' && typeof value.data === 'string') return Buffer.from(value.data, 'base64');
  if (Array.isArray(value)) return value.map(reviveValue);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reviveValue(item)]));
}

function numberLike(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  if (typeof value.toNumber === 'function') return value.toNumber();
  if (typeof value.low === 'number') return value.low;
  return Number(value);
}

function pollContent(node) {
  const values = (node.options || [])
    .map((option) => option.optionName || option.name)
    .filter(Boolean);
  if (!node.name || !values.length) return null;
  return {
    name: node.name,
    values,
    selectableCount: numberLike(node.selectableOptionsCount || node.selectableCount) || 1
  };
}

function eventContent(node) {
  const start = numberLike(node.startTime);
  if (!node.name || !start) return null;
  const end = numberLike(node.endTime);
  return {
    name: node.name,
    description: node.description || undefined,
    startTime: start,
    endTime: end || undefined,
    location: node.location ? serializeValue(node.location) : undefined,
    call: node.joinLink?.includes('video') ? 'video' : undefined,
    isCancelled: node.isCanceled ?? undefined,
    isScheduleCall: node.isScheduleCall ?? undefined,
    extraGuestsAllowed: node.extraGuestsAllowed ?? undefined
  };
}

function fallbackEntry(messageType, node, text) {
  return {
    kind: 'unsupported',
    messageType: messageType || 'unknown',
    text: text || '',
    data: serializeValue(node || {})
  };
}

function serializeNonMedia(message, text) {
  const content = unwrapMessage(message?.message);
  const type = getContentType(content || {});
  const node = type ? content[type] : null;

  if (!type) return null;
  if (type === 'reactionMessage') return null;
  if (type === 'conversation' || type === 'extendedTextMessage') {
    return text ? { kind: 'text', text } : null;
  }
  if (type === 'locationMessage' || type === 'liveLocationMessage') {
    return { kind: 'location', location: serializeValue(node), live: type === 'liveLocationMessage' };
  }
  if (type === 'contactMessage') {
    return {
      kind: 'contact',
      displayName: node.displayName || node.vcard || 'Contact',
      contact: serializeValue(node)
    };
  }
  if (type === 'contactsArrayMessage') {
    return {
      kind: 'contacts',
      displayName: node.displayName || 'Contacts',
      contacts: serializeValue(node.contacts || [])
    };
  }
  if (['pollCreationMessage', 'pollCreationMessageV2', 'pollCreationMessageV3', 'pollCreationMessageV5'].includes(type)) {
    const poll = pollContent(node);
    return poll ? { kind: 'poll', poll } : fallbackEntry(type, node, text);
  }
  if (type === 'eventMessage') {
    const event = eventContent(node);
    return event ? { kind: 'event', event } : fallbackEntry(type, node, text);
  }
  if (text) return { kind: 'text', text };
  return fallbackEntry(type, node, text);
}

export async function recordMessageEntry(sock, message, prefix = 'recorded-item') {
  const media = await downloadMessageMedia(sock, message, prefix);
  const text = getMessageText(message).trim();

  if (media) {
    const entry = {
      kind: 'media',
      tempPath: media.path,
      mimetype: media.mimetype,
      fileName: media.fileName || path.basename(media.path),
      messageType: media.type,
      caption: text,
      isAnimated: Boolean(media.node?.isAnimated)
    };
    return { entry, tempFile: media.path, type: 'media' };
  }

  const entry = serializeNonMedia(message, text);
  if (!entry) return null;
  return { entry, tempFile: null, type: entry.kind };
}

export async function persistRecordedEntries(entries, dir) {
  await fs.mkdir(dir, { recursive: true });
  const persisted = [];
  for (const [index, entry] of entries.entries()) {
    if (entry.kind !== 'media') {
      persisted.push(entry);
      continue;
    }
    const ext = path.extname(entry.tempPath || '') || path.extname(entry.fileName || '') || '.bin';
    const dest = path.join(dir, `${String(index + 1).padStart(3, '0')}${ext}`);
    await fs.copyFile(entry.tempPath, dest);
    persisted.push({
      kind: 'media',
      path: dest,
      mimetype: entry.mimetype,
      fileName: entry.fileName,
      messageType: entry.messageType,
      caption: entry.caption,
      isAnimated: entry.isAnimated
    });
  }
  return persisted;
}

export async function cleanupRecordedTempEntries(entries = []) {
  await cleanupFiles(entries.filter((entry) => entry.kind === 'media').map((entry) => entry.tempPath));
}

async function sendUnsupported(sock, jid, entry) {
  const body = JSON.stringify(entry.data || {}, null, 2);
  const summary = [
    `Pesan tersimpan bertipe ${entry.messageType}, belum bisa dikirim ulang native.`,
    entry.text ? `Teks: ${entry.text}` : '',
    body && body.length <= 2500 ? body : ''
  ].filter(Boolean).join('\n\n');
  if (body.length > 2500) {
    await sock.sendMessage(jid, {
      document: Buffer.from(body),
      mimetype: 'application/json',
      fileName: `saved-${entry.messageType}.json`,
      caption: summary || `Fallback JSON untuk ${entry.messageType}`
    });
    return;
  }
  await sock.sendMessage(jid, { text: summary || `Pesan bertipe ${entry.messageType} tersimpan sebagai fallback.` });
}

async function sendMediaEntry(sock, jid, entry) {
  const buffer = await fs.readFile(entry.path);
  if (entry.messageType === 'imageMessage') {
    await sock.sendMessage(jid, { image: buffer, mimetype: entry.mimetype, caption: entry.caption || undefined });
  } else if (entry.messageType === 'videoMessage') {
    await sock.sendMessage(jid, { video: buffer, mimetype: entry.mimetype, caption: entry.caption || undefined });
  } else if (entry.messageType === 'audioMessage') {
    await sock.sendMessage(jid, { audio: buffer, mimetype: entry.mimetype });
  } else if (entry.messageType === 'stickerMessage') {
    await sock.sendMessage(jid, { sticker: buffer, isAnimated: entry.isAnimated || undefined });
  } else {
    await sock.sendMessage(jid, {
      document: buffer,
      mimetype: entry.mimetype || 'application/octet-stream',
      fileName: entry.fileName || path.basename(entry.path),
      caption: entry.caption || undefined
    });
  }
}

export async function sendRecordedEntries(sock, jid, entries = []) {
  for (const entry of visibleRecordedEntries(entries)) {
    if (entry.kind === 'text') {
      await sock.sendMessage(jid, { text: entry.text });
    } else if (entry.kind === 'media') {
      await sendMediaEntry(sock, jid, entry);
    } else if (entry.kind === 'location') {
      await sock.sendMessage(jid, { location: reviveValue(entry.location) });
    } else if (entry.kind === 'contact') {
      await sock.sendMessage(jid, {
        contacts: { displayName: entry.displayName || 'Contact', contacts: [reviveValue(entry.contact)] }
      });
    } else if (entry.kind === 'contacts') {
      await sock.sendMessage(jid, {
        contacts: { displayName: entry.displayName || 'Contacts', contacts: reviveValue(entry.contacts || []) }
      });
    } else if (entry.kind === 'poll') {
      await sock.sendMessage(jid, { poll: entry.poll });
    } else if (entry.kind === 'event') {
      const event = {
        ...entry.event,
        startDate: new Date(entry.event.startTime * 1000),
        endDate: entry.event.endTime ? new Date(entry.event.endTime * 1000) : undefined,
        location: entry.event.location ? reviveValue(entry.event.location) : undefined
      };
      delete event.startTime;
      delete event.endTime;
      await sock.sendMessage(jid, { event });
    } else {
      await sendUnsupported(sock, jid, entry);
    }
  }
}
