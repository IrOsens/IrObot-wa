import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { PDF_SESSION_TIMEOUT_MS, makeTempPath } from './config.js';
import { cleanupFiles, downloadAnyMessageMedia, downloadMessageMedia, isImageFile, isOfficeFile, isPdfFile } from './media.js';
import { runTool } from './tools.js';

export class PdfSessions {
  constructor(tools) {
    this.tools = tools;
    this.sessions = new Map();
  }

  start(jid) {
    const old = this.end(jid);
    if (old) this.cleanup(old).catch(() => {});
    const session = {
      jid,
      files: [],
      startedAt: Date.now(),
      timer: setTimeout(() => this.end(jid), PDF_SESSION_TIMEOUT_MS)
    };
    this.sessions.set(jid, session);
    return session;
  }

  has(jid) {
    return this.sessions.has(jid);
  }

  async add(sock, message, order = null) {
    const session = this.sessions.get(message.key.remoteJid);
    if (!session) return null;
    const media = await downloadMessageMedia(sock, message, 'pdf-item');
    if (!media) return null;
    session.files.push({
      order: Number.isInteger(order) ? order : session.files.length + 1,
      path: media.path,
      mimetype: media.mimetype,
      fileName: media.fileName || path.basename(media.path)
    });
    return session.files.at(-1);
  }

  async addAny(sock, message, order = null) {
    const session = this.sessions.get(message.key.remoteJid);
    if (!session) return null;
    const media = await downloadAnyMessageMedia(sock, message, 'pdf-item');
    if (!media) return null;
    session.files.push({
      order: Number.isInteger(order) ? order : session.files.length + 1,
      path: media.path,
      mimetype: media.mimetype,
      fileName: media.fileName || path.basename(media.path)
    });
    return session.files.at(-1);
  }

  end(jid) {
    const session = this.sessions.get(jid);
    if (!session) return null;
    clearTimeout(session.timer);
    this.sessions.delete(jid);
    return session;
  }

  async cleanup(session) {
    await cleanupFiles(session?.files?.map((file) => file.path) || []);
  }

  async build(session) {
    if (!session?.files?.length) throw new Error('Belum ada file untuk dibuat PDF.');
    const temp = [];
    try {
      const pdfPaths = [];
      const ordered = [...session.files].sort((a, b) => a.order - b.order);
      for (const item of ordered) {
        if (isPdfFile(item.path, item.mimetype)) {
          pdfPaths.push(item.path);
          continue;
        }
        if (isImageFile(item.path, item.mimetype)) {
          const out = makeTempPath('image-pdf', '.pdf');
          temp.push(out);
          await fs.writeFile(out, await imageToPdf(item.path));
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

async function imageToPdf(imagePath) {
  const input = await fs.readFile(imagePath);
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
