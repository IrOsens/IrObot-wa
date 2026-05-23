import fs from 'node:fs/promises';
import path from 'node:path';
import { BOT_STATE_FILE } from './config.js';

const DEFAULT_STATE = {
  enabled: true,
  updatedAt: null
};

export class BotStateStore {
  constructor(filePath = BOT_STATE_FILE) {
    this.filePath = filePath;
    this.data = { ...DEFAULT_STATE };
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      this.data = normalizeState(parsed);
    } catch {
      this.data = { ...DEFAULT_STATE };
      await this.save();
    }
    return this.snapshot();
  }

  isEnabled() {
    return this.data.enabled !== false;
  }

  async setEnabled(enabled) {
    this.data.enabled = Boolean(enabled);
    this.data.updatedAt = new Date().toISOString();
    await this.save();
    return this.snapshot();
  }

  snapshot() {
    return {
      enabled: this.isEnabled(),
      updatedAt: this.data.updatedAt || null
    };
  }

  async save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(normalizeState(this.data), null, 2)}\n`);
  }
}

function normalizeState(value) {
  return {
    enabled: value?.enabled !== false,
    updatedAt: value?.updatedAt || null
  };
}
