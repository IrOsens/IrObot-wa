import QRCode from 'qrcode';
import sharp from 'sharp';
import { QR_SESSION_TIMEOUT_MS, makeTempPath } from './config.js';
import { cleanupFiles, downloadMessageMedia, mediaNode } from './media.js';
import { runTool } from './tools.js';

export const QR_STYLES = new Set(['square', 'dot', 'rounded']);
export const QR_BACKGROUND_COLORS = Object.freeze({
  white: '#ffffff',
  black: '#000000',
  red: '#ff0000',
  blue: '#0000ff',
  green: '#008000',
  yellow: '#ffff00',
  purple: '#800080',
  orange: '#ffa500'
});

const QR_OUTPUT_SIZE = 1024;
const QR_QUIET_ZONE_MODULES = 4;
const QR_ICON_SIZE_RATIO = 0.18;
const QR_ICON_GUARD_RATIO = 0.225;

export function parseQrArgs(rawArgs = '') {
  let rest = String(rawArgs || '').trim();
  let style = 'square';
  let background = QR_BACKGROUND_COLORS.white;
  let styleSeen = false;
  let backgroundSeen = false;

  while (rest) {
    const match = rest.match(/^(\S+)(?:\s+|$)/);
    if (!match) break;
    const token = match[1];
    const separator = token.indexOf('=');
    if (separator < 1) break;
    const key = token.slice(0, separator).toLowerCase();
    const value = token.slice(separator + 1);

    if (key === 'style') {
      if (styleSeen) throw new Error('Opsi style hanya boleh ditulis satu kali.');
      style = normalizeQrStyle(value);
      styleSeen = true;
    } else if (key === 'bg') {
      if (backgroundSeen) throw new Error('Opsi bg hanya boleh ditulis satu kali.');
      background = normalizeQrBackground(value);
      backgroundSeen = true;
    } else {
      break;
    }
    rest = rest.slice(match[0].length).trimStart();
  }

  return {
    style,
    background,
    text: rest.trim()
  };
}

export function normalizeQrStyle(value) {
  const style = String(value || '').trim().toLowerCase();
  if (!QR_STYLES.has(style)) {
    throw new Error(`Style QR harus salah satu: ${[...QR_STYLES].join(', ')}.`);
  }
  return style;
}

export function normalizeQrBackground(value) {
  const color = String(value || '').trim().toLowerCase();
  if (QR_BACKGROUND_COLORS[color]) return QR_BACKGROUND_COLORS[color];
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
  throw new Error(`Background QR harus white, black, red, blue, green, yellow, purple, orange, atau #RRGGBB.`);
}

export function qrForegroundForBackground(background) {
  const hex = normalizeQrBackground(background);
  const channels = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)]
    .map((part) => Number.parseInt(part, 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const luminance = (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  return blackContrast >= whiteContrast ? '#000000' : '#ffffff';
}

export async function makeQrCode(text, options = {}) {
  const payload = String(text || '');
  if (!payload.trim()) throw new Error('Pesan untuk isi QR wajib diisi.');
  const style = normalizeQrStyle(options.style || 'square');
  const background = normalizeQrBackground(options.background || 'white');
  const foreground = qrForegroundForBackground(background);
  let qr;
  try {
    qr = QRCode.create(payload, { errorCorrectionLevel: 'H' });
  } catch (error) {
    throw new Error(`Pesan terlalu panjang atau tidak bisa dibuat menjadi QR: ${error.message}`);
  }

  const svg = renderQrSvg(qr.modules, { style, background, foreground });
  let image = await sharp(Buffer.from(svg)).resize(QR_OUTPUT_SIZE, QR_OUTPUT_SIZE).png().toBuffer();
  if (options.iconMedia) {
    image = await compositeQrIcon(image, options.iconMedia, {
      background,
      tools: options.tools || {}
    });
  }
  return image;
}

export function qrIconSupport(message) {
  const found = mediaNode(message);
  if (!found) return { hasMedia: false, supported: false, reason: '' };
  const mimetype = String(found.node?.mimetype || '').toLowerCase();
  const fileName = String(found.node?.fileName || '').toLowerCase();
  const image = found.type === 'imageMessage' || /^image\//.test(mimetype);
  const gifVideo = found.type === 'videoMessage' && Boolean(found.node?.gifPlayback);
  const gifFile = mimetype === 'image/gif' || /\.gif$/i.test(fileName);
  if (image || gifVideo || gifFile) return { hasMedia: true, supported: true, reason: '' };
  return {
    hasMedia: true,
    supported: false,
    reason: 'Ikon QR hanya mendukung gambar atau GIF.'
  };
}

export async function downloadQrIcon(sock, message, prefix = 'qr-icon') {
  const support = qrIconSupport(message);
  if (!support.hasMedia) return null;
  if (!support.supported) throw new Error(support.reason);
  return downloadMessageMedia(sock, message, prefix);
}

export class QrSessions {
  constructor({ timeoutMs = QR_SESSION_TIMEOUT_MS } = {}) {
    this.timeoutMs = timeoutMs;
    this.sessions = new Map();
  }

  start(jid, options = {}) {
    const old = this.end(jid);
    if (old) this.cleanup(old).catch(() => {});
    const session = {
      jid,
      actorJid: options.actorJid || jid,
      style: normalizeQrStyle(options.style || 'square'),
      background: normalizeQrBackground(options.background || 'white'),
      items: [],
      progressKey: null,
      startedAt: Date.now(),
      timer: setTimeout(() => {
        const expired = this.end(jid);
        this.cleanup(expired).catch(() => {});
      }, this.timeoutMs)
    };
    session.timer.unref?.();
    this.sessions.set(jid, session);
    return session;
  }

  has(jid) {
    return this.sessions.has(jid);
  }

  get(jid) {
    return this.sessions.get(jid) || null;
  }

  count() {
    return this.sessions.size;
  }

  isActor(jid, actorJid) {
    const session = this.sessions.get(jid);
    return !session || !actorJid || session.actorJid === actorJid;
  }

  async add(sock, message, text) {
    const session = this.sessions.get(message.key.remoteJid);
    if (!session) return null;
    const payload = String(text || '').trim();
    if (!payload) throw new Error('Pesan/caption wajib diisi agar bisa menjadi isi QR. Sesi tetap aktif.');
    let iconMedia = null;
    try {
      iconMedia = await downloadQrIcon(sock, message, 'qr-session-icon');
      const item = {
        text: payload,
        iconMedia,
        sourceMessage: message,
        addedAt: Date.now()
      };
      session.items.push(item);
      return item;
    } catch (error) {
      await cleanupFiles([iconMedia?.path]);
      throw error;
    }
  }

  end(jid, actorJid = null) {
    const session = this.sessions.get(jid);
    if (!session) return null;
    if (actorJid && session.actorJid !== actorJid) return null;
    clearTimeout(session.timer);
    this.sessions.delete(jid);
    return session;
  }

  async cancel(jid, actorJid = null) {
    const session = this.end(jid, actorJid);
    if (!session) return false;
    await this.cleanup(session);
    return true;
  }

  async cleanup(session) {
    await cleanupFiles(session?.items?.map((item) => item.iconMedia?.path) || []);
  }
}

function renderQrSvg(modules, { style, background, foreground }) {
  const size = modules.size;
  const total = size + (QR_QUIET_ZONE_MODULES * 2);
  const shapes = [];
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (!modules.get(row, column)) continue;
      const x = column + QR_QUIET_ZONE_MODULES;
      const y = row + QR_QUIET_ZONE_MODULES;
      const finder = isFinderModule(row, column, size);
      if (style === 'dot' && !finder) {
        shapes.push(`<circle cx="${x + 0.5}" cy="${y + 0.5}" r="0.42"/>`);
      } else if (style === 'rounded' && !finder) {
        shapes.push(`<rect x="${x + 0.08}" y="${y + 0.08}" width="0.84" height="0.84" rx="0.24"/>`);
      } else {
        shapes.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`);
      }
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="geometricPrecision">`,
    `<rect width="${total}" height="${total}" fill="${background}"/>`,
    `<g fill="${foreground}">${shapes.join('')}</g>`,
    '</svg>'
  ].join('');
}

function isFinderModule(row, column, size) {
  const top = row < 7;
  const left = column < 7;
  const right = column >= size - 7;
  const bottom = row >= size - 7;
  return (top && left) || (top && right) || (bottom && left);
}

async function compositeQrIcon(qrBuffer, media, { background, tools }) {
  const temporary = [];
  try {
    let inputPath = media.path;
    if (media.type === 'videoMessage' || /^video\//i.test(media.mimetype || '')) {
      if (!tools.ffmpeg) throw new Error('FFmpeg belum tersedia untuk mengambil frame pertama GIF WhatsApp.');
      inputPath = makeTempPath('qr-icon-frame', '.png');
      temporary.push(inputPath);
      await runTool(tools.ffmpeg, ['-y', '-i', media.path, '-frames:v', '1', inputPath]);
    }

    const iconSize = Math.round(QR_OUTPUT_SIZE * QR_ICON_SIZE_RATIO);
    const guardSize = Math.round(QR_OUTPUT_SIZE * QR_ICON_GUARD_RATIO);
    const iconMask = roundedRectSvg(iconSize, Math.round(iconSize * 0.18), '#ffffff');
    const icon = await sharp(inputPath, { animated: false, page: 0 })
      .rotate()
      .resize(iconSize, iconSize, { fit: 'cover' })
      .composite([{ input: Buffer.from(iconMask), blend: 'dest-in' }])
      .png()
      .toBuffer();
    const guard = Buffer.from(roundedRectSvg(guardSize, Math.round(guardSize * 0.18), background));
    const guardOffset = Math.round((QR_OUTPUT_SIZE - guardSize) / 2);
    const iconOffset = Math.round((QR_OUTPUT_SIZE - iconSize) / 2);
    return sharp(qrBuffer)
      .composite([
        { input: guard, left: guardOffset, top: guardOffset },
        { input: icon, left: iconOffset, top: iconOffset }
      ])
      .png()
      .toBuffer();
  } finally {
    await cleanupFiles(temporary);
  }
}

function roundedRectSvg(size, radius, fill) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" fill="${fill}"/></svg>`;
}
