import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { PDF_DEFAULT_FILE_NAME, PDF_SESSION_TIMEOUT_MS, makeTempPath } from './config.js';
import { cleanupFiles, downloadAnyMessageMedia, downloadMessageMedia, isImageFile, isOfficeFile, isPdfFile } from './media.js';
import { formatBytes, runTool } from './tools.js';

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const PDF_SIZE_RE = /^(.*?),\s*(\d+(?:\.\d+)?)\s*([kmgt]?b)$/i;
const IMAGE_COMPRESSION_ATTEMPTS = [
  { forceJpeg: true, quality: 88, maxDimension: 2200 },
  { forceJpeg: true, quality: 76, maxDimension: 1800 },
  { forceJpeg: true, quality: 62, maxDimension: 1400 },
  { forceJpeg: true, quality: 48, maxDimension: 1000 },
  { forceJpeg: true, quality: 34, maxDimension: 800 },
  { forceJpeg: true, quality: 24, maxDimension: 600 }
];

export class PdfSessions {
  constructor(tools) {
    this.tools = tools;
    this.sessions = new Map();
  }

  start(jid, fileName = '', options = {}) {
    const old = this.end(jid);
    if (old) this.cleanup(old).catch(() => {});
    const opts = typeof fileName === 'object' && fileName ? fileName : { ...options, fileName };
    const session = {
      jid,
      actorJid: opts.actorJid || jid,
      fileName: normalizePdfFileName(opts.fileName),
      maxSizeBytes: Number.isInteger(opts.maxSizeBytes) && opts.maxSizeBytes > 0 ? opts.maxSizeBytes : null,
      split: opts.split === true,
      files: [],
      nextOrder: 1,
      startedAt: Date.now(),
      timer: setTimeout(() => {
        const expired = this.end(jid);
        this.cleanup(expired).catch(() => {});
      }, PDF_SESSION_TIMEOUT_MS)
    };
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

  async add(sock, message, order = null) {
    const session = this.sessions.get(message.key.remoteJid);
    if (!session) return null;
    const media = await downloadMessageMedia(sock, message, 'pdf-item');
    if (!media) return null;
    try {
      const item = this.pushMedia(session, media, order);
      if (item?.skipped) await cleanupFiles([media.path]);
      return item;
    } catch (error) {
      await cleanupFiles([media.path]);
      throw error;
    }
  }

  async addAny(sock, message, order = null) {
    const session = this.sessions.get(message.key.remoteJid);
    if (!session) return null;
    const media = await downloadAnyMessageMedia(sock, message, 'pdf-item');
    if (!media) return null;
    try {
      const item = this.pushMedia(session, media, order);
      if (item?.skipped) await cleanupFiles([media.path]);
      return item;
    } catch (error) {
      await cleanupFiles([media.path]);
      throw error;
    }
  }

  pushMedia(session, media, order = null) {
    const support = pdfMediaSupport(media);
    if (!support.supported) {
      return {
        skipped: true,
        fileName: media.fileName || path.basename(media.path),
        reason: support.reason
      };
    }
    const resolvedOrder = resolvePdfOrder(session, order);
    const item = {
      order: resolvedOrder,
      path: media.path,
      mimetype: media.mimetype,
      fileName: media.fileName || path.basename(media.path),
      addedAt: Date.now()
    };
    session.files.push(item);
    session.nextOrder = Math.max(session.nextOrder, resolvedOrder + 1);
    return item;
  }

  end(jid, actorJid = null) {
    const session = this.sessions.get(jid);
    if (!session) return null;
    if (actorJid && session.actorJid !== actorJid) return null;
    clearTimeout(session.timer);
    this.sessions.delete(jid);
    return session;
  }

  async cleanup(session) {
    await cleanupFiles(session?.files?.map((file) => file.path) || []);
  }

  async build(session) {
    if (!session?.files?.length) throw new Error('Belum ada file untuk dibuat PDF.');
    if (session.maxSizeBytes) return this.buildWithinSize(session);
    return this.buildPdfBuffer(session);
  }

  async buildSplit(session) {
    if (!session?.files?.length) throw new Error('Belum ada file untuk dibuat PDF.');
    const ordered = orderedSessionFiles(session);
    const files = [];
    for (const [index, item] of ordered.entries()) {
      const singleSession = { ...session, files: [item], maxSizeBytes: session.maxSizeBytes };
      const buffer = session.maxSizeBytes ? await this.buildWithinSize(singleSession) : await this.buildPdfBuffer(singleSession);
      files.push({
        buffer,
        fileName: splitPdfFileName(session.fileName, item, index + 1)
      });
    }
    return files;
  }

  async buildWithinSize(session) {
    const normal = await this.buildPdfBuffer(session);
    if (normal.length <= session.maxSizeBytes) return normal;

    const ordered = orderedSessionFiles(session);
    if (ordered.some((item) => !isImageFile(item.path, item.mimetype))) {
      throw new Error(`PDF ${formatBytes(normal.length)} melebihi batas ${formatBytes(session.maxSizeBytes)}. Kompres otomatis hanya mendukung sesi yang berisi gambar.`);
    }

    let smallest = normal;
    for (const imageOptions of IMAGE_COMPRESSION_ATTEMPTS) {
      const compressed = await this.buildPdfBuffer(session, { imageOptions });
      if (compressed.length < smallest.length) smallest = compressed;
      if (compressed.length <= session.maxSizeBytes) return compressed;
    }
    throw new Error(`PDF masih ${formatBytes(smallest.length)} setelah kompres, melebihi batas ${formatBytes(session.maxSizeBytes)}.`);
  }

  async buildPdfBuffer(session, options = {}) {
    const temp = [];
    try {
      const pdfPaths = [];
      const ordered = orderedSessionFiles(session);
      for (const item of ordered) {
        if (isPdfFile(item.path, item.mimetype)) {
          pdfPaths.push(item.path);
          continue;
        }
        if (isImageFile(item.path, item.mimetype)) {
          const out = makeTempPath('image-pdf', '.pdf');
          temp.push(out);
          await fs.writeFile(out, await imageToPdf(item.path, options.imageOptions));
          pdfPaths.push(out);
          continue;
        }
        if (isOfficeFile(item.path, item.mimetype)) {
          if (!this.tools.office) throw new Error('LibreOffice/soffice belum tersedia untuk konversi file Office.');
          const outDir = path.dirname(item.path);
          await runTool(this.tools.office, ['--headless', '--convert-to', 'pdf', '--outdir', outDir, item.path]);
          const out = path.join(outDir, `${path.basename(item.path, path.extname(item.path))}.pdf`);
          temp.push(out);
          pdfPaths.push(out);
          continue;
        }
        throw new Error(`Format file belum didukung untuk PDF: ${item.fileName}`);
      }

      const merged = await PDFDocument.create();
      for (const pdfPath of pdfPaths) {
        const source = await PDFDocument.load(await fs.readFile(pdfPath));
        const pages = await merged.copyPages(source, source.getPageIndices());
        pages.forEach((page) => merged.addPage(page));
      }
      return Buffer.from(await merged.save());
    } finally {
      await cleanupFiles(temp);
    }
  }
}

export function normalizePdfFileName(value) {
  const raw = String(value || defaultPdfBaseName()).trim() || defaultPdfBaseName();
  const safe = raw
    .replace(/\.pdf$/i, '')
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${safe || defaultPdfBaseName()}.pdf`;
}

export function defaultPdfBaseName(date = new Date(), botName = PDF_DEFAULT_FILE_NAME) {
  const shifted = new Date(date.getTime() + WIB_OFFSET_MS);
  const day = shifted.getUTCDate();
  const month = shifted.getUTCMonth() + 1;
  const year = shifted.getUTCFullYear();
  const time = [
    shifted.getUTCHours(),
    shifted.getUTCMinutes(),
    shifted.getUTCSeconds()
  ].map((part) => String(part).padStart(2, '0')).join('');
  return `${day}_${month}_${year}_${time}_${botName || 'IrOBot'}`;
}

export function parsePdfStartArgs(rawArgs) {
  const raw = String(rawArgs || '').trim();
  if (!raw) return { fileName: '', maxSizeBytes: null, split: false };
  const split = /^split(?:\s+|$)/i.test(raw);
  let body = split ? raw.replace(/^split\s*/i, '').trim() : raw;
  let maxSizeBytes = null;
  const maxMatch = body.match(/(?:^|\s)max\s+(\d+(?:\.\d+)?\s*[kmgt]?b)\s*$/i);
  if (maxMatch) {
    maxSizeBytes = parsePdfSizeLimit(maxMatch[1]);
    body = body.slice(0, maxMatch.index).trim();
  }
  if (!body) return { fileName: '', maxSizeBytes, split };
  const match = body.match(PDF_SIZE_RE);
  if (!match) return { fileName: body, maxSizeBytes, split };
  return {
    fileName: match[1].trim(),
    maxSizeBytes: maxSizeBytes || parsePdfSizeLimit(`${match[2]}${match[3]}`),
    split
  };
}

export function parsePdfSizeLimit(input) {
  const match = String(input || '').trim().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?b)$/i);
  if (!match) throw new Error('Format maksimal ukuran PDF tidak valid. Contoh: 1MB.');
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error('Maksimal ukuran PDF harus angka positif.');
  const unit = match[2].toLowerCase();
  const multipliers = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
    tb: 1024 * 1024 * 1024 * 1024
  };
  return Math.floor(value * multipliers[unit]);
}

export function parsePdfOrderText(text) {
  const trimmed = String(text || '').trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const order = Number(trimmed);
  return Number.isInteger(order) && order > 0 ? order : null;
}

function resolvePdfOrder(session, order) {
  if (Number.isInteger(order) && order > 0) {
    const existing = session.files.find((file) => file.order === order);
    if (existing) {
      throw new Error(`Urutan PDF #${order} sudah terisi oleh ${existing.fileName}. Media ini tidak ditambahkan.`);
    }
    return order;
  }

  const used = new Set(session.files.map((file) => file.order));
  let next = session.nextOrder || 1;
  while (used.has(next)) next += 1;
  return next;
}

function orderedSessionFiles(session) {
  return [...session.files].sort((a, b) => a.order - b.order || a.addedAt - b.addedAt);
}

function splitPdfFileName(sessionFileName, item, index) {
  const base = String(sessionFileName || PDF_DEFAULT_FILE_NAME)
    .replace(/\.pdf$/i, '')
    .trim() || PDF_DEFAULT_FILE_NAME;
  const source = String(item?.fileName || `item-${index}`)
    .replace(/\.[^.]+$/i, '')
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || `item-${index}`;
  return normalizePdfFileName(`${base}-${String(index).padStart(2, '0')}-${source}`);
}

function pdfMediaSupport(media) {
  const fileName = media?.fileName || media?.path || 'media';
  const mimetype = media?.mimetype || '';
  const sourcePath = media?.path || fileName;
  const ext = path.extname(fileName || media?.path || '').toLowerCase();
  if (media?.type === 'audioMessage' || /^audio\//i.test(mimetype)) {
    return { supported: false, reason: 'audio tidak bisa dijadikan halaman PDF.' };
  }
  if (media?.type === 'videoMessage' || /^video\//i.test(mimetype)) {
    return { supported: false, reason: 'video tidak bisa dijadikan halaman PDF.' };
  }
  if (ext === '.gif' || /gif/i.test(mimetype)) {
    return { supported: false, reason: 'GIF/animasi tidak didukung untuk PDF.' };
  }
  if (media?.node?.isAnimated) {
    return { supported: false, reason: 'sticker atau WebP animasi tidak didukung untuk PDF.' };
  }
  if (isPdfFile(sourcePath, mimetype) || isPdfFile(fileName, mimetype)) return { supported: true };
  if (isImageFile(sourcePath, mimetype) || isImageFile(fileName, mimetype)) return { supported: true };
  if (isOfficeFile(sourcePath, mimetype) || isOfficeFile(fileName, mimetype)) return { supported: true };
  return { supported: false, reason: 'format file belum didukung untuk PDF.' };
}

async function imageToPdf(imagePath, options = {}) {
  const input = await fs.readFile(imagePath);
  if (options?.forceJpeg) return compressedImageToPdf(input, options);

  const metadata = await sharp(input).metadata();
  const pdf = await PDFDocument.create();
  const width = metadata.width || 595;
  const height = metadata.height || 842;
  let image;

  if (metadata.format === 'jpeg' || metadata.format === 'jpg') {
    image = await pdf.embedJpg(input);
  } else {
    const png = await sharp(input).png().toBuffer();
    image = await pdf.embedPng(png);
  }

  const page = pdf.addPage([width, height]);
  page.drawImage(image, { x: 0, y: 0, width, height });
  return Buffer.from(await pdf.save());
}

async function compressedImageToPdf(input, options = {}) {
  let pipeline = sharp(input).rotate();
  if (options.maxDimension) {
    pipeline = pipeline.resize({
      width: options.maxDimension,
      height: options.maxDimension,
      fit: 'inside',
      withoutEnlargement: true
    });
  }
  const jpeg = await pipeline
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: options.quality || 75, mozjpeg: true })
    .toBuffer();
  const metadata = await sharp(jpeg).metadata();
  const pdf = await PDFDocument.create();
  const image = await pdf.embedJpg(jpeg);
  const width = metadata.width || 595;
  const height = metadata.height || 842;
  const page = pdf.addPage([width, height]);
  page.drawImage(image, { x: 0, y: 0, width, height });
  return Buffer.from(await pdf.save());
}
