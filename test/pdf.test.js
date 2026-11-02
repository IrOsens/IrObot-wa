import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { PDFDocument, degrees } from 'pdf-lib';
import { PdfSessions, parsePdfStartArgs, parsePdfSizeLimit, padPdfToSize } from '../src/pdf.js';
import { detectTools } from '../src/tools.js';
import { renderPdfPage } from '../src/pdfImages.js';
import { TEMP_DIR } from '../src/config.js';

const sessions = new PdfSessions({});
const pdfTempArtifacts = async () => (await fs.readdir(TEMP_DIR))
  .filter((name) => /^(pdf-page|pdf-resize-page|resize-source|image-pdf)(?:-|\.)/.test(name)).sort();
async function fixture(fn) {
  await fs.mkdir(TEMP_DIR, { recursive: true });
  const dir = await fs.mkdtemp(path.join(TEMP_DIR, 'pdf-test-'));
  try { await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
function session(files, options = {}) {
  return { fileName: 'result.pdf', files: files.map((file, index) => ({ ...file, order: index + 1, addedAt: index })), ...options };
}
async function sourcePdf(dir, count = 1, heavy = false) {
  const pdf = await PDFDocument.create();
  const jpeg = heavy ? await sharp({ create: { width: 600, height: 400, channels: 3, background: '#d95322' } }).png().toBuffer() : null;
  const image = jpeg ? await pdf.embedPng(jpeg) : null;
  for (let i = 0; i < count; i++) {
    const page = pdf.addPage([300 + i, 400 + i]);
    page.drawText(`Page ${i + 1}`, { x: 20, y: 200 });
    if (image) page.drawImage(image, { width: 200, height: 100 });
    if (i % 2) page.setRotation(degrees(90));
    // Deliberately uncompressed drawing streams provide a realistic shrinkable input.
    if (heavy) for (let j = 0; j < 1000; j++) page.drawText(`Compress text ${j * 7919 + i * 104729} and ${j * 6997}`, { x: 20, y: -40 });
  }
  const file = path.join(dir, 'source.pdf');
  await fs.writeFile(file, await pdf.save({ useObjectStreams: false }));
  return { path: file, fileName: 'source.pdf', mimetype: 'application/pdf' };
}

test('PDF flags distinguish names, sizes, and legacy formats', () => {
  assert.deepEqual(parsePdfStartArgs('--target-size 1MB --split --name "split max --target-size"'), {
    fileName: 'split max --target-size', split: true, maxSizeBytes: null, targetSizeBytes: 1048576
  });
  assert.equal(parsePdfStartArgs("--name 'max report' --max-size 0.5KB").maxSizeBytes, 512);
  assert.equal(parsePdfStartArgs('split report max 1MB').split, true);
  assert.equal(parsePdfStartArgs('report,1MB').maxSizeBytes, 1048576);
  for (const raw of ['--max-size 1MB --target-size 2MB', '--max-size 1MB --max-size 2MB', '--wat 1MB', '--name', '--name --split', '--max-size zero', '--target-size 101MB', '--split report max 1MB', '--name "unclosed', '--name "x"y', '--target-size 0B']) {
    assert.throws(() => parsePdfStartArgs(raw), undefined, raw);
  }
  for (const size of ['0.1B', '999999999999999TB']) assert.throws(() => parsePdfSizeLimit(size));
});

test('PDF padding reaches exact byte count with valid pages, including 1 and 2 byte gaps', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage();
  const bytes = Buffer.from(await pdf.save());
  for (const extra of [0, 1, 2, 100000]) {
    const padded = await padPdfToSize(bytes, bytes.length + extra);
    assert.equal(padded.length, bytes.length + extra);
    assert.equal((await PDFDocument.load(padded)).getPageCount(), 1);
  }
  await assert.rejects(padPdfToSize(bytes, bytes.length - 1));
  await assert.rejects(padPdfToSize(bytes, 101 * 1048576));
});

test('max keeps small PDFs small; target enlarges; split applies target to each output', async () => fixture(async (dir) => {
  const file = await sourcePdf(dir);
  const max = session([file], { maxSizeBytes: 20000 });
  const normal = await sessions.buildPdfBuffer(max);
  const capped = await sessions.build(max);
  assert.equal(capped.length, normal.length);
  assert.equal(max.rasterized, false);
  const enlarged = await sessions.build(session([file], { targetSizeBytes: 20000 }));
  assert.equal(enlarged.length, 20000);
  const split = await sessions.buildSplit(session([file, file], { targetSizeBytes: 20000 }));
  assert.equal(split.length, 2);
  for (const output of split) assert.equal(output.buffer.length, 20000);
}));

test('image compression preserves dimensions and rejects impossible targets', async () => fixture(async (dir) => {
  const pixels = Buffer.alloc(500 * 400 * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 31 + (i >> 8)) % 256;
  const file = path.join(dir, 'image.png');
  await sharp(pixels, { raw: { width: 500, height: 400, channels: 3 } }).png().toFile(file);
  const item = { path: file, fileName: 'image.png', mimetype: 'image/png' };
  const output = await sessions.build(session([item], { targetSizeBytes: 15000 }));
  assert.equal(output.length, 15000);
  assert.deepEqual((await PDFDocument.load(output)).getPage(0).getSize(), { width: 500, height: 400 });
  await assert.rejects(sessions.build(session([item], { maxSizeBytes: 1 })), /belum memenuhi/);
}));

test('PDF renderer failure cleans temporary files and corrupted PDFs fail', async () => fixture(async (dir) => {
  const file = await sourcePdf(dir);
  const before = await pdfTempArtifacts();
  if (!sharp.format.pdf.input.file) {
    await assert.rejects(sessions.build(session([file], { maxSizeBytes: 1 })), /gagal dirender/);
    assert.deepEqual(await pdfTempArtifacts(), before);
  }
  await fs.writeFile(file.path, 'invalid pdf');
  await assert.rejects(sessions.build(session([file], { maxSizeBytes: 20000 })));
}));

test('real PDF compression preserves all 51 pages, rotation and mixed inputs', async (t) => {
  const tools = await detectTools();
  if (!sharp.format.pdf.input.file && !tools.pdftoppm && !tools.magick) { t.skip('PDF renderer unavailable'); return; }
  await fixture(async (dir) => {
    const runner = new PdfSessions(tools);
    const file = await sourcePdf(dir, 51, true);
    const png = path.join(dir, 'extra.png');
    await sharp({ create: { width: 80, height: 60, channels: 3, background: 'blue' } }).png().toFile(png);
    const input = session([file, { path: png, mimetype: 'image/png', fileName: 'extra.png' }], { targetSizeBytes: 250000 });
    assert.ok((await runner.buildPdfBuffer(input)).length > input.targetSizeBytes);
    const before = await pdfTempArtifacts();
    const output = await runner.build(input);
    assert.equal(output.length, input.targetSizeBytes);
    assert.equal(input.rasterized, true);
    const pdf = await PDFDocument.load(output);
    assert.equal(pdf.getPageCount(), 52);
    assert.deepEqual(pdf.getPage(0).getSize(), { width: 300, height: 400 });
    assert.deepEqual(pdf.getPage(1).getSize(), { width: 401, height: 301 });
    assert.deepEqual(pdf.getPage(51).getSize(), { width: 80, height: 60 });
    assert.deepEqual(await pdfTempArtifacts(), before);
    const resultPath = path.join(dir, 'result.pdf');
    await fs.writeFile(resultPath, output);
    const rendered = await renderPdfPage(resultPath, 51, tools);
    try {
      const { data } = await sharp(rendered.path).resize(1, 1).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.ok(data[2] > 200 && data[0] < 30 && data[1] < 30, 'last page remains the blue image');
    } finally { await fs.rm(rendered.directory, { recursive: true, force: true }); }
    for (const extra of [1, 2]) {
      await fs.writeFile(resultPath, await padPdfToSize(output, output.length + extra));
      const checked = await renderPdfPage(resultPath, 0, tools);
      await fs.rm(checked.directory, { recursive: true, force: true });
    }
  });
});
