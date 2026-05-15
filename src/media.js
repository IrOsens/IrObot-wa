import fs from 'node:fs/promises';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import mime from 'mime-types';
import { downloadMediaMessage, getContentType } from 'baileys';
import { makeTempPath } from './config.js';
import { extractQuotedMessage, firstUrl, unwrapMessage } from './text.js';

const silentDownloadLogger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {}
};

const MEDIA_TYPES = new Set(['imageMessage', 'videoMessage', 'documentMessage', 'stickerMessage', 'audioMessage']);
const URL_MEDIA_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.mov', '.mkv', '.webm',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'
]);
const URL_PAGE_HOSTS = new Set(['tenor.com', 'www.tenor.com']);

export function mediaNode(message) {
  const content = unwrapMessage(message?.message);
  const type = getContentType(content || {});
  if (!MEDIA_TYPES.has(type)) return null;
  return { type, node: content[type], message: { ...message, message: content } };
}

export function quotedMediaNode(message) {
  const quoted = extractQuotedMessage(message);
  return quoted ? mediaNode(quoted) : null;
}

export function isViewOnceMediaMessage(message) {
  const raw = message?.message;
  const found = mediaNode(message);
  if (!raw || !found) return false;
  return hasViewOnceEnvelope(raw) || Boolean(found.node?.viewOnce);
}

function hasViewOnceEnvelope(content) {
  if (!content) return false;
  if (content.viewOnceMessage?.message) return true;
  if (content.viewOnceMessageV2?.message) return true;
  if (content.viewOnceMessageV2Extension?.message) return true;
  if (content.ephemeralMessage?.message) return hasViewOnceEnvelope(content.ephemeralMessage.message);
  if (content.documentWithCaptionMessage?.message) return hasViewOnceEnvelope(content.documentWithCaptionMessage.message);
  return false;
}

export function isLikelyAnimated(media) {
  const mimetype = media?.mimetype || '';
  const fileName = media?.fileName || '';
  return /video|gif/i.test(mimetype) || /\.(gif|mp4|mov|mkv|webm)$/i.test(fileName);
}

export function isOfficeFile(filePath, mimetype = '') {
  const ext = path.extname(filePath).toLowerCase();
  return ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp'].includes(ext)
    || /word|excel|spreadsheet|presentation|officedocument|msword|powerpoint/i.test(mimetype);
}

export function isPdfFile(filePath, mimetype = '') {
  return path.extname(filePath).toLowerCase() === '.pdf' || mimetype === 'application/pdf';
}

export function isImageFile(filePath, mimetype = '') {
  return /\.(png|jpe?g|webp)$/i.test(filePath) || /^image\/(png|jpe?g|webp)$/i.test(mimetype);
}

export async function saveBufferToTemp(buffer, prefix, fallbackExt = '') {
  const detected = await fileTypeFromBuffer(buffer).catch(() => null);
  const ext = detected?.ext ? `.${detected.ext}` : fallbackExt;
  const filePath = makeTempPath(prefix, ext);
  await fs.writeFile(filePath, buffer);
  return {
    path: filePath,
    mimetype: detected?.mime || mime.lookup(ext) || 'application/octet-stream',
    ext
  };
}

export async function downloadMessageMedia(sock, message, prefix = 'media') {
  const found = mediaNode(message);
  if (!found) return null;
  const buffer = await downloadMediaMessage(
    found.message,
    'buffer',
    {},
    { logger: silentDownloadLogger, reuploadRequest: sock.updateMediaMessage }
  );
  const fileName = found.node.fileName || '';
  const fallbackExt = path.extname(fileName) || `.${mime.extension(found.node.mimetype || '') || 'bin'}`;
  const saved = await saveBufferToTemp(buffer, prefix, fallbackExt);
  return {
    ...saved,
    type: found.type,
    fileName,
    sourceMessage: found.message,
    node: found.node
  };
}

export async function downloadAnyMessageMedia(sock, message, prefix = 'media') {
  const quoted = extractQuotedMessage(message);
  if (quoted && mediaNode(quoted)) return downloadMessageMedia(sock, quoted, prefix);
  return downloadMessageMedia(sock, message, prefix);
}

export async function downloadQuotedOrOwnMedia(sock, message, prefix = 'media') {
  const quoted = extractQuotedMessage(message);
  if (quoted && mediaNode(quoted)) return downloadMessageMedia(sock, quoted, prefix);
  return downloadMessageMedia(sock, message, prefix);
}

export async function downloadUrlMedia(text, prefix = 'url') {
  const url = firstUrl(text);
  if (!url) return null;
  return downloadUrlMediaFile(url, prefix);
}

async function downloadUrlMediaFile(url, prefix, depth = 0) {
  const cleanUrl = url.split('?')[0].split('#')[0];
  const ext = path.extname(cleanUrl).toLowerCase();
  if (!URL_MEDIA_EXTS.has(ext) && !isKnownMediaPage(url)) return null;
  const response = await fetch(url, {
    headers: {
      accept: 'image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8',
      'user-agent': 'Mozilla/5.0 (compatible; iro-wabot/1.0)'
    }
  });
  if (!response.ok) throw new Error(`Download URL gagal: HTTP ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (!buffer.length) throw new Error('Download URL gagal: file kosong.');

  const contentType = response.headers.get('content-type') || '';
  const detected = await fileTypeFromBuffer(buffer).catch(() => null);
  if (isHtmlResponse(buffer, contentType, detected)) {
    if (depth >= 1) throw new Error('URL tidak mengarah ke file media langsung.');
    const directUrl = extractDirectMediaUrl(buffer.toString('utf8'), url);
    if (!directUrl) throw new Error('URL tersebut halaman HTML dan media langsungnya tidak ditemukan.');
    return downloadUrlMediaFile(directUrl, prefix, depth + 1);
  }

  const saved = await saveBufferToTemp(buffer, prefix, bestFallbackExt({ detected, contentType, ext }));
  if (!isSupportedDownloadedMedia(saved)) {
    await cleanupFiles([saved.path]);
    throw new Error(`URL tidak mengarah ke file media yang didukung (${saved.mimetype}).`);
  }
  return { ...saved, fileName: path.basename(cleanUrl) || `url-media${saved.ext}`, url };
}

export async function cleanupFiles(files) {
  await Promise.all(
    files
      .filter(Boolean)
      .map((file) => removeWithRetry(file))
  );
}

async function removeWithRetry(file) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rm(file, { force: true, recursive: false });
      return;
    } catch (error) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) return;
      await new Promise((resolve) => setTimeout(resolve, 250 + attempt * 150));
    }
  }
}

function isKnownMediaPage(url) {
  try {
    const parsed = new URL(url);
    return URL_PAGE_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isHtmlResponse(buffer, contentType, detected) {
  if (/text\/html|application\/xhtml/i.test(contentType)) return true;
  if (detected) return false;
  return buffer.subarray(0, 256).toString('utf8').trimStart().startsWith('<');
}

function bestFallbackExt({ detected, contentType, ext }) {
  if (detected?.ext) return `.${detected.ext}`;
  const fromMime = mime.extension(String(contentType).split(';')[0].trim());
  if (fromMime) return `.${fromMime}`;
  return ext || '.bin';
}

function isSupportedDownloadedMedia(media) {
  const ext = String(media?.ext || '').toLowerCase();
  return URL_MEDIA_EXTS.has(ext) || /^(image|video|application\/pdf|application\/msword|application\/vnd\.|audio)\//i.test(media?.mimetype || '');
}

function extractDirectMediaUrl(html, baseUrl) {
  const candidates = [];
  const metaRe = /<meta\b[^>]*>/gi;
  let match;
  while ((match = metaRe.exec(html))) {
    const tag = match[0];
    const key = attrValue(tag, 'property') || attrValue(tag, 'name') || attrValue(tag, 'itemprop');
    const content = attrValue(tag, 'content');
    if (!key || !content) continue;
    if (/^(og:(image|video)(:secure_url|:url)?|twitter:(image|player:stream)(:src)?|contentUrl)$/i.test(key)) {
      candidates.push(content);
    }
  }

  for (const pattern of [
    /"contentUrl"\s*:\s*"([^"]+)"/gi,
    /"media"\s*:\s*"([^"]+)"/gi,
    /(https?:\\?\/\\?\/[^"'\s<>]+?\.(?:gif|mp4|webp|png|jpe?g)(?:\?[^"'\s<>]*)?)/gi
  ]) {
    while ((match = pattern.exec(html))) candidates.push(match[1]);
  }

  return candidates
    .map((candidate) => normalizeExtractedUrl(candidate, baseUrl))
    .filter(Boolean)
    .filter((candidate, index, array) => array.indexOf(candidate) === index)
    .sort((a, b) => mediaCandidateRank(a) - mediaCandidateRank(b))[0] || null;
}

function attrValue(tag, name) {
  const match = String(tag).match(new RegExp(`\\b${name}\\s*=\\s*(['"])(.*?)\\1`, 'i'));
  return match ? decodeHtml(match[2]) : '';
}

function normalizeExtractedUrl(value, baseUrl) {
  const clean = decodeHtml(String(value || ''))
    .replace(/\\\//g, '/')
    .trim();
  if (!clean) return null;
  try {
    const resolved = new URL(clean, baseUrl);
    if (!/^https?:$/.test(resolved.protocol)) return null;
    const ext = path.extname(resolved.pathname).toLowerCase();
    return URL_MEDIA_EXTS.has(ext) ? resolved.toString() : null;
  } catch {
    return null;
  }
}

function mediaCandidateRank(url) {
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  return ['.gif', '.mp4', '.webp', '.png', '.jpg', '.jpeg'].indexOf(ext) >= 0
    ? ['.gif', '.mp4', '.webp', '.png', '.jpg', '.jpeg'].indexOf(ext)
    : 99;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}
