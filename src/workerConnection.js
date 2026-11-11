import pino from 'pino';
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } from 'baileys';

let cachedVersion = null;

async function baileysVersion() {
  if (!cachedVersion) cachedVersion = (await fetchLatestBaileysVersion()).version;
  return cachedVersion;
}

// One WhatsApp connection for a worker (or a pairing attempt) with automatic reconnect.
export class WorkerConnection {
  constructor({ authDir, logger, label, handlers = {} }) {
    this.authDir = authDir;
    this.logger = logger;
    this.label = label;
    this.handlers = handlers;
    this.sock = null;
    this.connected = false;
    this.stopped = false;
    this.reconnectTimer = null;
  }

  async start() {
    if (this.stopped) return;
    const { state: authState, saveCreds } = await useMultiFileAuthState(this.authDir);
    const sock = makeWASocket({
      auth: authState,
      version: await baileysVersion(),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      logger: pino({ level: 'silent' }),
      browser: ['IrOBot Worker', 'Chrome', '1.0.0']
    });
    this.sock = sock;

    let inputQueue = Promise.resolve();
    const enqueue = (handler, value) => {
      if (!handler) return;
      inputQueue = inputQueue
        .then(() => handler(value))
        .catch((error) => this.logger.error('Worker handler failed', { worker: this.label, error: error.message }));
    };

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', (event) => enqueue(this.handlers.onMessages, event));
    sock.ev.on('messages.reaction', (updates) => enqueue(this.handlers.onReactions, updates));
    sock.ev.on('connection.update', (update) => this.onConnectionUpdate(sock, update));
  }

  async onConnectionUpdate(sock, update) {
    if (sock !== this.sock) return;
    const { connection, lastDisconnect, qr } = update;
    try {
      if (qr && this.handlers.onQr) await this.handlers.onQr(qr, sock);
      if (connection === 'open') {
        this.connected = true;
        await this.logger.info('Worker connected', { worker: this.label });
        if (this.handlers.onOpen) await this.handlers.onOpen(sock);
      }
      if (connection === 'close') {
        this.connected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          this.stopped = true;
          await this.logger.warn('Worker logged out', { worker: this.label });
          if (this.handlers.onLoggedOut) await this.handlers.onLoggedOut();
          return;
        }
        if (this.handlers.onClose) await this.handlers.onClose();
        if (this.stopped) return;
        // restartRequired comes right after a QR scan, so reconnect immediately in that case.
        const delayMs = statusCode === DisconnectReason.restartRequired ? 0 : 3000;
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.start().catch((error) => this.logger.error('Worker reconnect failed', { worker: this.label, error: error.message }));
        }, delayMs);
      }
    } catch (error) {
      await this.logger.error('Worker connection handler failed', { worker: this.label, error: error.message });
    }
  }

  isRegistered() {
    return Boolean(this.sock?.authState?.creds?.me?.id);
  }

  stop() {
    this.stopped = true;
    this.connected = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.sock?.end?.(undefined);
  }

  async logout() {
    this.stopped = true;
    try {
      await this.sock?.logout?.();
    } catch (error) {
      await this.logger.warn('Worker logout failed', { worker: this.label, error: error.message });
    }
    this.stop();
  }
}
