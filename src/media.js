import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns';
import { fileTypeFromBuffer } from 'file-type';
import mime from 'mime-types';
import { downloadMediaMessage, getContentType } from 'baileys';
import { makeTempPath } from './config.js';
import { extractQuotedMessage, firstUrl, unwrapMessage } from './text.js';

try {
  dns.setDefaultResultOrder?.('ipv4first');
} catch {
  // Older Node builds may not support changing DNS result order.
}

const silentDownloadLogger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {}
};

const MEDIA_TYPES = new Set(['imageMessage', 'videoMessage', 'documentMessage', 'stickerMessage', 'audioMessage']);
const MEDIA_DOWNLOAD_TIMEOUT_MS = 25_000;
const MEDIA_DOWNLOAD_RETRIES = 1;
const MEDIA_DOWNLOAD_RETRY_BASE_MS = 600;
const DEFAULT_WA_MEDIA_HOST = 'mmg.whatsapp.net';
const URL_MEDIA_MAX_BYTES = 80 * 1024 * 1024;
const URL_MEDIA_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.mov', '.mkv', '.webm', '.avif',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'
]);

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

export function extractQuotedViewOnceMessage(message) {
  const quoted = extractQuotedMessage(message);
  return quoted && isViewOnceMediaMessage(quoted) ? quoted : null;
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
  const buffer = await downloadMediaBuffer(sock, found);
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

async function downloadMediaBuffer(sock, found) {
  let message = found.message;
  let reuploaded = false;
  let lastError = null;
  const hosts = mediaDownloadHosts(sock, found.node);

  for (const host of [null, ...hosts]) {
    for (let attempt = 0; attempt <= MEDIA_DOWNLOAD_RETRIES; attempt += 1) {
      try {
        return await downloadMediaMessage(
          message,
          'buffer',
          mediaDownloadOptions(host),
          {
            logger: silentDownloadLogger,
            reuploadRequest: async (msg) => {
              if (!canRequestMediaReupload(sock, msg)) throw new Error('Media WhatsApp perlu reupload, tapi socket tidak mendukungnya.');
              reuploaded = true;
              return sock.updateMediaMessage(msg);
            }
          }
        );
      } catch (error) {
        lastError = error;

        if (!reuploaded && shouldRequestMediaReupload(error) && canRequestMediaReupload(sock, message)) {
          try {
            message = await sock.updateMediaMessage(message);
            reuploaded = true;
            await delay(MEDIA_DOWNLOAD_RETRY_BASE_MS);
            continue;
          } catch (reuploadError) {
            lastError = reuploadError;
          }
        }

        if (!isRetryableMediaDownloadError(error)) throw improveMediaDownloadError(error);
        if (attempt < MEDIA_DOWNLOAD_RETRIES) {
          await delay(MEDIA_DOWNLOAD_RETRY_BASE_MS * (attempt + 1));
        }
      }
    }
  }

  throw improveMediaDownloadError(lastError);
}

function mediaDownloadOptions(host) {
  return {
    ...(host ? { host } : {}),
    options: {
      signal: AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT_MS)
    }
  };
}

function mediaDownloadHosts(sock, node) {
  const implicitHost = hostFromUrl(node?.url) || DEFAULT_WA_MEDIA_HOST;
  const hosts = [];
  if (typeof sock?.getMediaHost === 'function') addHost(hosts, sock.getMediaHost());
  addHost(hosts, DEFAULT_WA_MEDIA_HOST);
  return hosts.filter((host) => host !== implicitHost);
}

function addHost(hosts, host) {
  const clean = String(host || '').trim().toLowerCase();
  if (clean && !hosts.includes(clean)) hosts.push(clean);
}

function hostFromUrl(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function canRequestMediaReupload(sock, message) {
  return typeof sock?.updateMediaMessage === 'function'
    && Boolean(message?.key?.id)
    && Boolean(mediaNode(message)?.node?.mediaKey);
}

function shouldRequestMediaReupload(error) {
  return [404, 410].includes(mediaErrorStatus(error)) || isRetryableMediaDownloadError(error);
}

function isRetryableMediaDownloadError(error) {
  const status = mediaErrorStatus(error);
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  const text = mediaErrorText(error);
  return /fetch failed|network|timeout|timed? out|aborted|terminated|socket|econnreset|etimedout|enotfound|eai_again|econnrefused|tls|dns/i.test(text);
}

function mediaErrorStatus(error) {
  return Number(error?.status || error?.statusCode || error?.output?.statusCode || error?.cause?.status || 0);
}

function mediaErrorText(error) {
  return [
    error?.message,
    error?.code,
    error?.cause?.message,
    error?.cause?.code,
    error?.cause?.name
  ].filter(Boolean).join(' ');
}

function improveMediaDownloadError(error) {
  const status = mediaErrorStatus(error);
  const detail = mediaErrorText(error) || 'unknown error';
  const message = status
    ? `Gagal mengunduh media WhatsApp setelah retry (HTTP ${status}). Coba kirim ulang media/sticker.`
    : `Gagal mengunduh media WhatsApp setelah retry: ${detail}. Coba kirim ulang media/sticker.`;
  return new Error(message, { cause: error });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function downloadUrlMedia(text, prefix = 'url') {
  const url = firstUrl(text);
  if (!url) return null;
  return downloadUrlMediaFile(url, prefix);
}

async function downloadUrlMediaFile(url, prefix, depth = 0) {
  const cleanUrl = url.split('?')[0].split('#')[0];
  const ext = path.extname(cleanUrl).toLowerCase();
  const response = await fetch(url, {
    headers: {
      accept: 'image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8',
      'user-agent': 'Mozilla/5.0 (compatible; iro-wabot/1.0)'
    }
  });
  if (!response.ok) throw new Error(`Download URL gagal: HTTP ${response.status}`);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > URL_MEDIA_MAX_BYTES) {
    throw new Error(`Download URL gagal: file terlalu besar (${Math.ceil(contentLength / 1024 / 1024)} MB).`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (!buffer.length) throw new Error('Download URL gagal: file kosong.');
  if (buffer.length > URL_MEDIA_MAX_BYTES) {
    throw new Error(`Download URL gagal: file terlalu besar (${Math.ceil(buffer.length / 1024 / 1024)} MB).`);
  }

  const contentType = response.headers.get('content-type') || '';
  const detected = await fileTypeFromBuffer(buffer).catch(() => null);
  if (isHtmlResponse(buffer, contentType, detected)) {
    if (depth >= 2) throw new Error('URL tidak mengarah ke file media langsung.');
    const directUrls = extractDirectMediaUrls(buffer.toString('utf8'), url);
    if (!directUrls.length) throw new Error('URL tersebut halaman HTML dan media langsungnya tidak ditemukan.');
    let lastError = null;
    for (const directUrl of directUrls) {
      try {
        return await downloadUrlMediaFile(directUrl, prefix, depth + 1);
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`Media dari halaman HTML tidak bisa diunduh: ${lastError?.message || 'kandidat media gagal.'}`);
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

function extractDirectMediaUrls(html, baseUrl) {
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
    /"url"\s*:\s*"([^"]+?\.(?:gif|mp4|webm|webp|png|avif|jpe?g)(?:\?[^"]*)?)"/gi,
    /"contentUrl"\s*:\s*"([^"]+)"/gi,
    /"media"\s*:\s*"([^"]+)"/gi,
    /(https?:\\?\/\\?\/[^"'\s<>]+?\.(?:gif|mp4|webm|webp|png|avif|jpe?g)(?:\?[^"'\s<>]*)?)/gi
  ]) {
    while ((match = pattern.exec(html))) candidates.push(match[1]);
  }

  return candidates
    .map((candidate) => normalizeExtractedUrl(candidate, baseUrl))
    .filter(Boolean)
    .filter((candidate, index, array) => array.indexOf(candidate) === index)
    .sort((a, b) => mediaCandidateRank(a) - mediaCandidateRank(b));
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
  const parsed = new URL(url);
  const ext = path.extname(parsed.pathname).toLowerCase();
  const text = parsed.toString().toLowerCase();
  const sizeRank = /nano|tiny|small|preview/.test(text) ? -10 : /medium/.test(text) ? 5 : 0;
  const extRank = ['.mp4', '.webm', '.gif', '.webp', '.png', '.jpg', '.jpeg', '.avif'].indexOf(ext);
  return (extRank >= 0 ? extRank : 99) * 10 + sizeRank;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}
