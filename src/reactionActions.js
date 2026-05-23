import { sameJid, tryNormalizeJid } from './phone.js';

export const CONFIRM_REACTIONS = new Set(['👍', '❤️', '✅']);
export const CANCEL_REACTIONS = new Set(['❌', '👎', '❎']);

export class ReactionActionStore {
  constructor({ ttlMs = 60 * 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.actions = new Map();
  }

  register(messageKey, action) {
    const key = reactionTargetKey(messageKey);
    if (!key || !action?.actorJid) return null;
    const item = {
      ...action,
      key,
      actorJid: tryNormalizeJid(action.actorJid) || action.actorJid,
      createdAt: Date.now(),
      expiresAt: Date.now() + (action.ttlMs || this.ttlMs)
    };
    this.actions.set(key, item);
    return item;
  }

  get(messageKey, actorJid) {
    this.cleanupExpired();
    const item = this.actions.get(reactionTargetKey(messageKey));
    if (!item) return null;
    if (!sameJid(item.actorJid, actorJid)) return null;
    if (item.expiresAt <= Date.now()) {
      this.actions.delete(item.key);
      return null;
    }
    return item;
  }

  delete(messageKey) {
    return this.actions.delete(reactionTargetKey(messageKey));
  }

  clearScope(scope) {
    for (const [key, item] of this.actions.entries()) {
      if (item.scope === scope) this.actions.delete(key);
    }
  }

  cleanupExpired() {
    const now = Date.now();
    for (const [key, item] of this.actions.entries()) {
      if (item.expiresAt <= now) this.actions.delete(key);
    }
  }
}

export function reactionTargetKey(messageKey) {
  const jid = messageKey?.remoteJid;
  const id = messageKey?.id;
  if (!jid || !id) return '';
  return `${jid}:${id}`;
}

export function reactionIntent(emoji) {
  const text = String(emoji || '').trim();
  if (CONFIRM_REACTIONS.has(text)) return 'confirm';
  if (CANCEL_REACTIONS.has(text)) return 'cancel';
  return null;
}
