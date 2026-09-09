import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import webp from 'node-webpmux';
import { DATA_DIR, DEFAULT_STICKER_AUTHOR, DEFAULT_STICKER_TITLE } from './config.js';
import { buildStickerExif } from './sticker.js';
import { UserInputError } from './errors.js';

const CANVAS = 512;
const TEXT_INSET = 52;
const TEXT_AREA = CANVAS - TEXT_INSET * 2;

const ALIGNS = { justify: 'justify', 'kiri-kanan': 'justify', left: 'left', kiri: 'left', right: 'right', kanan: 'right', center: 'center', tengah: 'center' };
export function parseTextSticker(input) {
  let text = String(input || '').trim();
  let align = 'left';
  const match = text.match(/^align=(\S+)(?:\s+|$)/i);
  if (match) {
    align = ALIGNS[match[1].toLowerCase()];
    if (!align) throw new UserInputError('Alignment: justify, left, right, center (kiri-kanan, kiri, kanan, tengah).');
    text = text.slice(match[0].length).trim();
  }
  if (!text) throw new UserInputError('Format: ,stext [align=justify|left|right|center] <teks>');
  if (text.length > 10000) throw new UserInputError('Teks terlalu panjang; maksimal 10.000 karakter.');
  return { text, align };
}
const escapeMarkup = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export async function makeTextSticker({ text, align = 'left', fontfile = path.join(DATA_DIR, 'fonts', 'arial.ttf') }) {
  await fs.access(fontfile).catch(() => { throw new Error('Font Arial belum tersedia. Jalankan npm run setup:font.'); });
  const words = [...new Set(text.match(/\S+/gu) || [])];
  const markup = text.split(/(\s+)/u).map((part) => /\S/u.test(part)
    ? `<span allow_breaks="false" insert_hyphens="false">${escapeMarkup(part)}</span>` : part).join('');
  const measureWord = async (word, size) => (await sharp({ text: {
    text: escapeMarkup(word), font: `Arial ${size}`, fontfile, wrap: 'none', dpi: 72
  } }).metadata()).width;
  const render = async (size) => sharp({ text: {
    text: `<span foreground="black">${markup}</span>`, font: `Arial ${size}`, fontfile,
    width: TEXT_AREA, wrap: 'word', rgba: true, dpi: 72,
    align: align === 'justify' ? 'left' : align, justify: align === 'justify'
  } }).png().toBuffer({ resolveWithObject: true });
  let low = 8, high = Math.min(TEXT_AREA, Math.max(8, Math.ceil(1600 / Math.sqrt([...text].length)))), chosen;
  while (low <= high) {
    const size = Math.floor((low + high) / 2);
    let result;
    try {
      let wordFits = true;
      for (const word of words) if (await measureWord(word, size) > TEXT_AREA) { wordFits = false; break; }
      if (!wordFits) { high = size - 1; continue; }
      result = await render(size);
    } catch (error) {
      if (/size of the input|too big|exceeds pixel limit/.test(error.message)) { high = size - 1; continue; }
      throw error;
    }
    if (result.info.height <= TEXT_AREA && result.info.width <= TEXT_AREA) { chosen = { ...result, size }; low = size + 1; }
    else high = size - 1;
  }
  if (!chosen) throw new UserInputError('Teks tidak muat di stiker pada font 8 px. Pendekkan teks.');
  const left = align === 'right' ? CANVAS - TEXT_INSET - chosen.info.width
    : align === 'center' ? Math.floor((CANVAS - chosen.info.width) / 2) : TEXT_INSET;
  const textLayer = await sharp({ create: { width: CANVAS, height: CANVAS, channels: 4, background: '#00000000' } })
    .composite([{ input: chosen.data, left, top: Math.floor((CANVAS - chosen.info.height) / 2) }]).png().toBuffer();
  // Soften the text at quarter resolution, keeping the rounded card edges clean.
  const smallText = await sharp(textLayer).resize(128, 128).png().toBuffer();
  const softText = await sharp(smallText).resize(CANVAS, CANVAS, { kernel: 'linear' }).blur(1.2).png().toBuffer();
  const card = Buffer.from('<svg width="512" height="512"><rect x="16" y="16" width="480" height="480" rx="18" fill="white"/></svg>');
  const buffer = await sharp(card).composite([{ input: softText }])
    .webp({ quality: 19, alphaQuality: 100, effort: 4 }).toBuffer();
  const sticker = new webp.Image();
  await sticker.load(buffer);
  sticker.exif = buildStickerExif(DEFAULT_STICKER_AUTHOR, DEFAULT_STICKER_TITLE);
  return { buffer: await sticker.save(null), fontSize: chosen.size, textHeight: chosen.info.height };
}
