import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileTypeFromBuffer } from 'file-type';
import { runTool } from './tools.js';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'importantWeb');
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8']
};
const COOKIE = 'iw_session';
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store'
};
const MAX_BODY = 16 * 1024;
const RETRY_BIND_MS = 60_000;

export async function tailscaleIp() {
  try {
    const { stdout } = await runTool('tailscale', ['ip', '-4'], { timeout: 5000 });
    return stdout.split(/\s+/).find((item) => /^100\.\d+\.\d+\.\d+$/.test(item)) || null;
  } catch {
    return null;
  }
}

function parseCookies(header = '') {
  const result = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0) result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

function send(res, status, body, headers = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': typeof body === 'string' || Buffer.isBuffer(body) ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': buffer.length,
    ...headers
  });
  res.end(buffer);
}

const json = (res, status, value, headers) => send(res, status, value, headers);

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Bad JSON'), { status: 400 }); }
}

// Sends a decrypted buffer; supports Range so audio/video can seek on every browser.
async function sendBinary(req, res, buffer, { fileName = '', download = false } = {}) {
  const type = (await fileTypeFromBuffer(buffer).catch(() => null))?.mime || 'application/octet-stream';
  const headers = { ...SECURITY_HEADERS, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400' };
  if (download || fileName) headers['Content-Disposition'] = `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(fileName || 'file')}`;
  const range = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : buffer.length - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : buffer.length - 1;
    start = Math.max(0, start);
    end = Math.min(buffer.length - 1, end);
    if (start > end) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${buffer.length}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${buffer.length}`, 'Content-Length': end - start + 1 });
    res.end(buffer.subarray(start, end + 1));
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': buffer.length });
  res.end(buffer);
}

// The Web UI for workers with the "important" service. Listens on the Tailscale IP only.
export class ImportantWeb {
  constructor({ auth, store, workers, port = 8790, host = '', logger = null, resolveHost = tailscaleIp, exportSticker = null }) {
    this.exportSticker = exportSticker;
    this.auth = auth;
    this.store = store;
    this.workers = workers;
    this.port = port;
    this.fixedHost = host;
    this.logger = logger;
    this.resolveHost = resolveHost;
    this.server = null;
    this.host = null;
    this.clients = new Set();
    this.retryTimer = null;
    this.static = new Map();
    this.onStoreEvent = (payload) => this.broadcast('message', payload);
    this.onStorePurge = (payload) => this.broadcast('purge', payload);
  }

  get url() { return this.host ? `http://${this.host}:${this.port}` : null; }
  get running() { return Boolean(this.server?.listening); }

  log(level, message, meta) {
    this.logger?.[level]?.(message, meta)?.catch?.(() => {});
  }

  async start() {
    if (this.server || this.retryTimer) return;
    const host = this.fixedHost || await this.resolveHost();
    if (!host) {
      this.log('warn', 'Important Web UI waiting for Tailscale IP');
      this.retryTimer = setTimeout(() => { this.retryTimer = null; this.start().catch(() => {}); }, RETRY_BIND_MS);
      this.retryTimer.unref?.();
      return;
    }
    for (const [file] of Object.values(STATIC_FILES)) {
      if (!this.static.has(file)) this.static.set(file, await fs.readFile(path.join(STATIC_DIR, file)));
    }
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Server error' });
        else res.destroy();
        if (!error.status) this.log('error', 'Important Web UI request failed', { error: error.message });
      });
    });
    server.requestTimeout = 60_000;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, host, () => { server.off('error', reject); resolve(); });
    }).catch((error) => {
      this.log('error', 'Important Web UI failed to listen', { host, port: this.port, error: error.message });
      this.retryTimer = setTimeout(() => { this.retryTimer = null; this.start().catch(() => {}); }, RETRY_BIND_MS);
      this.retryTimer.unref?.();
      throw error;
    });
    this.server = server;
    this.host = host;
    this.store.on('event', this.onStoreEvent);
    this.store.on('purge', this.onStorePurge);
    this.log('info', 'Important Web UI listening', { url: this.url });
  }

  async stop() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.store.off('event', this.onStoreEvent);
    this.store.off('purge', this.onStorePurge);
    for (const client of this.clients) client.end();
    this.clients.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise((resolve) => server.close(() => resolve()));
  }

  // Called after ,worker key reset: open live streams belong to logged-out sessions.
  dropSessions() {
    for (const client of this.clients) client.end();
    this.clients.clear();
  }

  broadcast(type, payload) {
    if (!this.workers.isImportant(payload.workerId)) return;
    const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.clients) {
      if (!this.auth.check(client.token)) { client.end(); this.clients.delete(client); continue; }
      client.write(data);
    }
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const pathname = url.pathname;
    if (req.method === 'GET' && STATIC_FILES[pathname]) {
      const [file, type] = STATIC_FILES[pathname];
      send(res, 200, this.static.get(file), { 'Content-Type': type });
      return;
    }
    if (pathname === '/favicon.ico') { res.writeHead(204, SECURITY_HEADERS); res.end(); return; }
    if (!pathname.startsWith('/api/')) { json(res, 404, { error: 'Not found' }); return; }

    // Writes must come from this page (blocks cross-site form posts on top of SameSite).
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) { json(res, 403, { error: 'Origin ditolak' }); return; }
      if (req.headers['x-requested-with'] !== 'iw') { json(res, 403, { error: 'Header tidak valid' }); return; }
    }

    const ip = req.socket.remoteAddress || 'unknown';
    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await readJson(req);
      if (!this.auth.hasKey()) { json(res, 409, { error: 'Key belum dibuat. Ketik ,worker key di WhatsApp.' }); return; }
      const result = await this.auth.login(body.key, ip);
      if (result.retryAfter) { json(res, 429, { error: `Terlalu banyak percobaan. Coba lagi ${Math.ceil(result.retryAfter / 60)} menit lagi.` }); return; }
      if (!result.token) { json(res, 401, { error: 'Key salah.' }); return; }
      json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${result.maxAge}` });
      return;
    }

    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!this.auth.check(token)) { json(res, 401, { error: 'Belum login.' }); return; }

    if (pathname === '/api/logout' && req.method === 'POST') {
      await this.auth.logout(token);
      json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
      return;
    }
    if (pathname === '/api/workers' && req.method === 'GET') {
      json(res, 200, { workers: await this.workers.list() });
      return;
    }
    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      const client = res;
      client.token = token;
      this.clients.add(client);
      const ping = setInterval(() => client.write(': ping\n\n'), 25_000);
      req.on('close', () => { clearInterval(ping); this.clients.delete(client); });
      return;
    }

    const match = pathname.match(/^\/api\/w\/(\d+)\/(.+)$/);
    if (!match) { json(res, 404, { error: 'Not found' }); return; }
    const workerId = Number(match[1]);
    const rest = match[2];
    if (!this.workers.isImportant(workerId)) { json(res, 404, { error: 'Worker tidak memakai service important.' }); return; }

    if (rest === 'avatar' && req.method === 'GET') {
      const buffer = await this.workers.avatar(workerId);
      if (!buffer) { json(res, 404, { error: 'Tidak ada foto' }); return; }
      await sendBinary(req, res, buffer);
      return;
    }
    if (rest === 'chats' && req.method === 'GET') {
      const [chats, contacts] = await Promise.all([this.store.chats(workerId), this.store.contacts(workerId)]);
      json(res, 200, { chats, contacts });
      return;
    }
    const messages = rest.match(/^chats\/([^/]+)\/messages$/);
    if (messages && req.method === 'GET') {
      const before = Number(url.searchParams.get('before')) || Infinity;
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 60));
      const jid = decodeURIComponent(messages[1]);
      const [list, chat] = await Promise.all([this.store.messages(workerId, jid, { before, limit }), this.store.chat(workerId, jid)]);
      json(res, 200, { messages: list, chat, hasMore: list.length >= limit });
      return;
    }
    // Plain-text export of one chat, downloaded as a .txt file.
    const exported = rest.match(/^chats\/([^/]+)\/export$/);
    if (exported && req.method === 'GET') {
      const jid = decodeURIComponent(exported[1]);
      const worker = (await this.workers.list()).find((item) => item.id === workerId);
      const { title, text } = await this.store.exportText(workerId, jid, { meName: worker?.name || '' });
      const safe = String(title || 'chat').replace(/[^\p{L}\p{N} _.-]+/gu, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'chat';
      const body = Buffer.from(text, 'utf8');
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': body.length,
        'Content-Disposition': `attachment; filename="chat-${safe}.txt"; filename*=UTF-8''${encodeURIComponent(`chat-${safe}.txt`)}`
      });
      res.end(body);
      return;
    }
    // Turn recording of one chat on or off.
    const logging = rest.match(/^chats\/([^/]+)\/logging$/);
    if (logging && req.method === 'PUT') {
      const body = await readJson(req);
      const chat = await this.store.setLogging(workerId, decodeURIComponent(logging[1]), Boolean(body.enabled));
      json(res, 200, { ok: true, logging: !chat.paused });
      return;
    }
    const media = rest.match(/^media\/([A-Za-z0-9_-]+)$/);
    if (media && req.method === 'GET') {
      const buffer = await this.store.readMedia(workerId, media[1]);
      if (!buffer) { json(res, 404, { error: 'Media tidak ada' }); return; }
      await sendBinary(req, res, buffer, { fileName: url.searchParams.get('name') || '', download: url.searchParams.get('download') === '1' });
      return;
    }
    // /sticker/<stickerMediaId>[?audio=<audioMediaId>] -> mp4 (with sound), gif (animated) or png.
    const sticker = rest.match(/^sticker\/([A-Za-z0-9_-]+)$/);
    if (sticker && req.method === 'GET') {
      if (!this.exportSticker) { json(res, 501, { error: 'Konversi stiker tidak tersedia' }); return; }
      const image = await this.store.readMedia(workerId, sticker[1]);
      if (!image) { json(res, 404, { error: 'Stiker tidak ada' }); return; }
      const audioId = url.searchParams.get('audio');
      const audio = audioId ? await this.store.readMedia(workerId, audioId) : null;
      const result = await this.exportSticker(image, audio);
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': result.mimetype,
        'Content-Length': result.buffer.length,
        'Content-Disposition': `attachment; filename="sticker-${sticker[1].slice(-8)}.${result.ext}"`
      });
      res.end(result.buffer);
      return;
    }
    const avatar = rest.match(/^avatar\/([a-f0-9]{40})$/);
    if (avatar && req.method === 'GET') {
      const buffer = await this.store.readAvatar(workerId, avatar[1]);
      if (!buffer) { json(res, 404, { error: 'Tidak ada foto' }); return; }
      await sendBinary(req, res, buffer);
      return;
    }
    if (rest === 'data' && req.method === 'DELETE') {
      await this.store.purgeAll(workerId);
      json(res, 200, { ok: true });
      return;
    }
    if (rest === 'settings' && req.method === 'GET') {
      json(res, 200, { retention7d: this.workers.retention(workerId), usage: await this.store.usage(workerId) });
      return;
    }
    if (rest === 'retention' && req.method === 'PUT') {
      const body = await readJson(req);
      await this.workers.setRetention(workerId, Boolean(body.enabled));
      if (body.enabled) await this.store.purgeOlderThan(workerId, 7);
      json(res, 200, { ok: true, retention7d: Boolean(body.enabled) });
      return;
    }
    json(res, 404, { error: 'Not found' });
  }
}
