import { COMMAND_PREFIX } from './config.js';

export function tokenize(input) {
  const tokens = [];
  const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match;
  while ((match = regex.exec(input))) {
    const raw = match[1] ?? match[2] ?? match[3] ?? '';
    tokens.push(raw.replace(/\\(["'])/g, '$1'));
  }
  return tokens;
}

export function parseCommand(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith(COMMAND_PREFIX)) return null;
  const body = trimmed.slice(COMMAND_PREFIX.length).trim();
  if (!body) return null;
  const [name, ...rest] = tokenize(body);
  const rawArgs = body.slice(name.length).trim();
  return { name: name.toLowerCase(), args: rest, rawArgs };
}

export function getMessageText(message) {
  const content = unwrapMessage(message?.message);
  if (!content) return '';
  if (content.conversation) return content.conversation;
  if (content.extendedTextMessage?.text) return content.extendedTextMessage.text;
  if (content.imageMessage?.caption) return content.imageMessage.caption;
  if (content.videoMessage?.caption) return content.videoMessage.caption;
  if (content.documentMessage?.caption) return content.documentMessage.caption;
  if (content.buttonsResponseMessage?.selectedButtonId) return content.buttonsResponseMessage.selectedButtonId;
  if (content.templateButtonReplyMessage?.selectedId) return content.templateButtonReplyMessage.selectedId;
  if (content.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
    return parseNativeFlowButtonText(content.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
  }
  return '';
}

function parseNativeFlowButtonText(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed.id || parsed.button_id || parsed.buttonId || '';
  } catch {
    return '';
  }
}

export function unwrapMessage(message) {
  if (!message) return null;
  if (message.ephemeralMessage?.message) return unwrapMessage(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return unwrapMessage(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return unwrapMessage(message.viewOnceMessageV2.message);
  if (message.viewOnceMessageV2Extension?.message) return unwrapMessage(message.viewOnceMessageV2Extension.message);
  if (message.documentWithCaptionMessage?.message) return unwrapMessage(message.documentWithCaptionMessage.message);
  return message;
}

export function extractQuotedMessage(message) {
  const content = unwrapMessage(message?.message);
  const node = Object.values(content || {}).find((value) => value?.contextInfo?.quotedMessage);
  if (!node) return null;
  return {
    key: {
      remoteJid: message.key.remoteJid,
      id: node.contextInfo.stanzaId,
      participant: node.contextInfo.participant
    },
    message: node.contextInfo.quotedMessage
  };
}

export function firstUrl(text) {
  const match = String(text || '').match(/https?:\/\/[^\s"'<>]+/i);
  return match ? match[0] : null;
}

export function escapeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}
