import fs from 'node:fs/promises';
import path from 'node:path';
import { COMMAND_ACCESS_FILE } from './config.js';

export const PUBLIC_COMMANDS = new Set(['s', 'smeme', 'rs']);

const DEFAULT_ACCESS = {
  all: false,
  chats: {}
};

export class CommandAccessStore {
  constructor(filePath = COMMAND_ACCESS_FILE) {
    this.filePath = filePath;
    this.data = { ...DEFAULT_ACCESS, chats: {} };
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      this.data = normalizeAccess(parsed);
    } catch {
      this.data = { ...DEFAULT_ACCESS, chats: {} };
      await this.save();
    }
    return this.data;
  }

  canUse(commandName, jid) {
    if (!PUBLIC_COMMANDS.has(String(commandName || '').toLowerCase())) return false;
    if (this.data.all) return true;
    return Boolean(jid && this.data.chats?.[jid]);
  }

  async setHere(jid, enabled) {
    if (!jid) throw new Error('Chat target tidak valid.');
    if (enabled) this.data.chats[jid] = true;
    else delete this.data.chats[jid];
    await this.save();
    return this.snapshot();
  }

  async setAll(enabled) {
    this.data.all = Boolean(enabled);
    if (!enabled) this.data.chats = {};
    await this.save();
    return this.snapshot();
  }

  snapshot() {
    return {
      all: Boolean(this.data.all),
      chats: { ...this.data.chats },
      chatCount: Object.keys(this.data.chats || {}).length
    };
  }

  async save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(normalizeAccess(this.data), null, 2)}\n`);
  }
}

export function parseAllowArgs(args) {
  const [scopeRaw, enabledRaw] = args;
  const scope = String(scopeRaw || '').toLowerCase();
  if (!['here', 'all'].includes(scope)) throw new Error('Format: ,allow here|all true|false');
  const enabledText = String(enabledRaw || '').toLowerCase();
  if (!['true', 'false'].includes(enabledText)) throw new Error('Format: ,allow here|all true|false');
  return {
    scope,
    enabled: enabledText === 'true'
  };
}

function normalizeAccess(value) {
  const chats = {};
  if (value?.chats && typeof value.chats === 'object' && !Array.isArray(value.chats)) {
    for (const [jid, enabled] of Object.entries(value.chats)) {
      if (jid && enabled === true) chats[jid] = true;
    }
  }
  return {
    all: value?.all === true,
    chats
  };
}
