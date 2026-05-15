import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const CRC_TABLE = makeCrcTable();

export async function zipDirectory(rootDir) {
  const files = await collectFiles(rootDir);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const input = await fs.readFile(file.absolute);
    const deflated = zlib.deflateRawSync(input, { level: 6 });
    const useStored = deflated.length >= input.length;
    const data = useStored ? input : deflated;
    const method = useStored ? 0 : 8;
    const crc = crc32(input);
    const nameBuffer = Buffer.from(file.relative, 'utf8');
    const local = localHeader(nameBuffer, file.stat.mtime, crc, data.length, input.length, method);
    chunks.push(local, nameBuffer, data);
    central.push(centralHeader(nameBuffer, file.stat.mtime, crc, data.length, input.length, method, offset));
    offset += local.length + nameBuffer.length + data.length;
  }

  const centralOffset = offset;
  const centralBuffer = Buffer.concat(central);
  const end = endOfCentralDirectory(files.length, centralBuffer.length, centralOffset);
  return Buffer.concat([...chunks, centralBuffer, end]);
}

export async function extractZipBuffer(zipBuffer, outDir) {
  const root = path.resolve(outDir);
  await fs.mkdir(root, { recursive: true });
  let offset = 0;
  let extracted = 0;

  while (offset + 4 <= zipBuffer.length) {
    const signature = zipBuffer.readUInt32LE(offset);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50) throw new Error('File restore bukan ZIP valid.');

    const flags = zipBuffer.readUInt16LE(offset + 6);
    if (flags & 0x0008) throw new Error('ZIP dengan data descriptor belum didukung.');
    const method = zipBuffer.readUInt16LE(offset + 8);
    const compressedSize = zipBuffer.readUInt32LE(offset + 18);
    const uncompressedSize = zipBuffer.readUInt32LE(offset + 22);
    const nameLength = zipBuffer.readUInt16LE(offset + 26);
    const extraLength = zipBuffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > zipBuffer.length) throw new Error('ZIP restore terpotong atau rusak.');

    const rawName = zipBuffer.toString('utf8', nameStart, nameStart + nameLength);
    const safeName = normalizeZipPath(rawName);
    const target = path.resolve(root, safeName);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`ZIP restore berisi path tidak aman: ${rawName}`);
    }

    if (safeName.endsWith('/')) {
      await fs.mkdir(target, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const compressed = zipBuffer.subarray(dataStart, dataEnd);
      const output = inflateZipEntry(compressed, method, uncompressedSize);
      await fs.writeFile(target, output);
      extracted += 1;
    }

    offset = dataEnd;
  }

  return extracted;
}

export function splitBuffer(buffer, maxPartBytes) {
  if (buffer.length <= maxPartBytes) return [buffer];
  const parts = [];
  for (let offset = 0; offset < buffer.length; offset += maxPartBytes) {
    parts.push(buffer.subarray(offset, Math.min(offset + maxPartBytes, buffer.length)));
  }
  return parts;
}

async function collectFiles(rootDir, current = rootDir) {
  const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(rootDir, absolute));
    } else if (entry.isFile()) {
      files.push({
        absolute,
        relative: path.relative(rootDir, absolute).replace(/\\/g, '/'),
        stat: await fs.stat(absolute)
      });
    }
  }
  return files;
}

function localHeader(nameBuffer, date, crc, compressedSize, uncompressedSize, method) {
  const { time, day } = dosDateTime(date);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(day, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressedSize, 18);
  header.writeUInt32LE(uncompressedSize, 22);
  header.writeUInt16LE(nameBuffer.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralHeader(nameBuffer, date, crc, compressedSize, uncompressedSize, method, offset) {
  const { time, day } = dosDateTime(date);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(method, 10);
  header.writeUInt16LE(time, 12);
  header.writeUInt16LE(day, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(compressedSize, 20);
  header.writeUInt32LE(uncompressedSize, 24);
  header.writeUInt16LE(nameBuffer.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, nameBuffer]);
}

function endOfCentralDirectory(count, centralSize, centralOffset) {
  const header = Buffer.alloc(22);
  header.writeUInt32LE(0x06054b50, 0);
  header.writeUInt16LE(0, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(count, 8);
  header.writeUInt16LE(count, 10);
  header.writeUInt32LE(centralSize, 12);
  header.writeUInt32LE(centralOffset, 16);
  header.writeUInt16LE(0, 20);
  return header;
}

function inflateZipEntry(buffer, method, expectedSize) {
  if (method === 0) return buffer;
  if (method === 8) {
    const output = zlib.inflateRawSync(buffer);
    if (expectedSize && output.length !== expectedSize) throw new Error('Ukuran hasil unzip tidak sesuai.');
    return output;
  }
  throw new Error(`Metode kompresi ZIP belum didukung: ${method}`);
}

function normalizeZipPath(rawName) {
  const name = String(rawName || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = name.split('/').filter(Boolean);
  if (!parts.length || parts.includes('..')) throw new Error(`ZIP restore berisi path tidak aman: ${rawName}`);
  return parts.join('/') + (name.endsWith('/') ? '/' : '');
}

function dosDateTime(date) {
  const value = date instanceof Date ? date : new Date();
  const year = Math.max(1980, value.getFullYear());
  const day = ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate();
  const time = (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2);
  return { day, time };
}

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[i] = crc >>> 0;
  }
  return table;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
