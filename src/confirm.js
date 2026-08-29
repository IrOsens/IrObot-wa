export class PendingConfirmStore {
  constructor({ ttlMs = 60 * 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.pending = new Map();
  }

  set(jid, actorOrAction, maybeAction = null) {
    const actorJid = maybeAction ? actorOrAction : jid;
    const action = maybeAction || actorOrAction;
    if (!jid || !action?.execute) throw new Error('Pending confirm action tidak valid.');
    const item = {
      ...action,
      jid,
      actorJid,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs
    };
    this.pending.set(confirmKey(jid, actorJid), item);
    return item;
  }

  get(jid, actorJid = jid) {
    const key = confirmKey(jid, actorJid);
    const item = this.pending.get(key);
    if (!item) return null;
    if (item.expiresAt <= Date.now()) {
      this.pending.delete(key);
      return null;
    }
    return item;
  }

  take(jid, actorJid = jid) {
    const key = confirmKey(jid, actorJid);
    const item = this.get(jid, actorJid);
    if (item) this.pending.delete(key);
    return item;
  }

  cancel(jid, actorJid = jid) {
    return this.pending.delete(confirmKey(jid, actorJid));
  }

  count() {
    this.cleanupExpired();
    return this.pending.size;
  }

  cleanupExpired() {
    const now = Date.now();
    for (const [jid, item] of this.pending.entries()) {
      if (item.expiresAt <= now) this.pending.delete(jid);
    }
  }
}

function confirmKey(jid, actorJid) {
  return `${jid}:${actorJid || jid}`;
}
