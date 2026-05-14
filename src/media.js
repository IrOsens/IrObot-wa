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
  const cleanUrl = url.split('?')[0].split('#')[0];
  const ext = path.extname(cleanUrl).toLowerCase();
  if (!URL_MEDIA_EXTS.has(ext)) return null;
  const response = await fetch(url, {
    headers: { 'user-agent': 'iro-wabot/1.0' }
  });
  if (!response.ok) throw new Error(`Download URL gagal: HTTP ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  const saved = await saveBufferToTemp(Buffer.from(arrayBuffer), prefix, ext);
  return { ...saved, fileName: path.basename(cleanUrl), url };
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
