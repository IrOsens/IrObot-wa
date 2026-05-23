import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { makeTempPath } from './config.js';
import { cleanupFiles } from './media.js';
import { runTool } from './tools.js';

export async function pdfToImages(pdfPath, tools = {}, options = {}) {
  const pageCount = await getPdfPageCount(pdfPath);
  const maxPages = Math.min(pageCount, options.maxPages || 50);
  const images = [];
  const temp = [];

  try {
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const converted = await renderPdfPageWithSharp(pdfPath, pageIndex).catch(() => null);
      if (converted) {
        images.push(converted);
        temp.push(converted.path);
        continue;
      }
      break;
    }

    if (images.length === maxPages) return images.map((item) => ({ ...item, cleanupPaths: [...temp] }));
    await cleanupFiles(temp.splice(0));

    const fallback = await renderPdfWithTool(pdfPath, tools, maxPages);
    return fallback.map((item) => ({ ...item, cleanupPaths: fallback.map((file) => file.path) }));
  } catch (error) {
    await cleanupFiles(temp);
    throw error;
  }
}

async function getPdfPageCount(pdfPath) {
  const pdf = await PDFDocument.load(await fs.readFile(pdfPath));
  return pdf.getPageCount();
}

async function renderPdfPageWithSharp(pdfPath, pageIndex) {
  const out = makeTempPath(`pdf-page-${pageIndex + 1}`, '.png');
  await sharp(pdfPath, { page: pageIndex, density: 160 })
    .png()
    .toFile(out);
  return {
    path: out,
    fileName: `page-${String(pageIndex + 1).padStart(3, '0')}.png`,
    page: pageIndex + 1,
    mimetype: 'image/png'
  };
}

async function renderPdfWithTool(pdfPath, tools, maxPages) {
  if (tools?.pdftoppm) return renderPdfWithPdftoppm(pdfPath, tools.pdftoppm, maxPages);
  if (tools?.magick) return renderPdfWithMagick(pdfPath, tools.magick, maxPages);
  throw new Error('Konversi PDF ke image butuh dukungan PDF di sharp, Poppler pdftoppm, atau ImageMagick magick.');
}

async function renderPdfWithPdftoppm(pdfPath, command, maxPages) {
  const prefix = makeTempPath('pdf-page', '');
  await runTool(command, ['-png', '-r', '160', '-f', '1', '-l', String(maxPages), pdfPath, prefix]);
  const dir = path.dirname(prefix);
  const base = path.basename(prefix);
  const entries = await fs.readdir(dir);
  const files = entries
    .filter((name) => name.startsWith(base) && name.toLowerCase().endsWith('.png'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return files.map((name, index) => ({
    path: path.join(dir, name),
    fileName: `page-${String(index + 1).padStart(3, '0')}.png`,
    page: index + 1,
    mimetype: 'image/png'
  }));
}

async function renderPdfWithMagick(pdfPath, command, maxPages) {
  const outPrefix = makeTempPath('pdf-page', '');
  const outPattern = `${outPrefix}-%03d.png`;
  await runTool(command, ['-density', '160', `${pdfPath}[0-${maxPages - 1}]`, outPattern]);
  const dir = path.dirname(outPattern);
  const prefix = path.basename(outPrefix);
  const entries = await fs.readdir(dir);
  const files = entries
    .filter((name) => name.startsWith(prefix) && name.toLowerCase().endsWith('.png'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return files.map((name, index) => ({
    path: path.join(dir, name),
    fileName: `page-${String(index + 1).padStart(3, '0')}.png`,
    page: index + 1,
    mimetype: 'image/png'
  }));
}
