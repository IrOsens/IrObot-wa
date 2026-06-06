import dgram from 'node:dgram';
import { WOL_BROADCAST_ADDRESS, WOL_FILE, WOL_PORT } from './config.js';
import { readCollection, renumberCollection, writeCollection } from './namedStore.js';

export function normalizeMac(input) {
  const hex = String(input || '').replace(/[^a-fA-F0-9]/g, '').toUpperCase();
  if (hex.length !== 12) throw new Error('MAC address tidak valid. Contoh: AA:BB:CC:DD:EE:FF');
  return hex.match(/.{2}/g).join(':');
}

export async function sendWakeOnLan(mac, options = {}) {
  const normalized = normalizeMac(mac);
  const macBytes = Buffer.from(normalized.replace(/:/g, ''), 'hex');
  const packet = Buffer.alloc(6 + 16 * macBytes.length, 0xff);
  for (let i = 6; i < packet.length; i += macBytes.length) macBytes.copy(packet, i);

  const port = Number(options.port || WOL_PORT);
  const address = options.broadcastAddress || WOL_BROADCAST_ADDRESS;
  await new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', (error) => {
      socket.close();
      reject(error);
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, 0, packet.length, port, address, (error) => {
        socket.close();
        if (error) reject(error);
        else resolve();
      });
    });
  });
  return normalized;
}

export async function handleWolCommand(command) {
  if (!command.args.length || command.args[0].toLowerCase() === 'list') return formatWolList((await readCollection(WOL_FILE)).items);

  const action = command.args[0].toLowerCase();
  if (action === 'add' || action === 'save') {
    if (!command.args[1]) throw new Error(wolFormat());
    const mac = normalizeMac(command.args[1]);
    const store = await readCollection(WOL_FILE);
    const exists = store.items.find((item) => item.mac === mac);
    if (exists) throw new Error(`MAC ${mac} sudah tersimpan sebagai #${exists.id}.`);
    const item = {
      id: store.nextId++,
      title: mac,
      mac,
      createdAt: new Date().toISOString()
    };
    store.items.push(item);
    await writeCollection(WOL_FILE, store);
    return `WOL #${item.id} ${item.mac} tersimpan.`;
  }

  if (action === 'del') {
    const query = command.args[1];
    if (!query) throw new Error(wolFormat());
    const store = await readCollection(WOL_FILE);
    const item = findWol(store.items, query);
    if (!item) throw new Error(`WOL "${query}" tidak ditemukan.`);
    store.items = store.items.filter((candidate) => candidate.id !== item.id);
    renumberCollection(store);
    await writeCollection(WOL_FILE, store);
    return `WOL #${item.id} ${item.mac} dihapus.`;
  }

  if (action === 'wake') {
    const query = command.args[1];
    if (!query) throw new Error(wolFormat());
    const store = await readCollection(WOL_FILE);
    const saved = findWol(store.items, query);
    const mac = saved?.mac || normalizeMac(query);
    await sendWakeOnLan(mac);
    return `Magic packet terkirim ke ${mac}.`;
  }

  const store = await readCollection(WOL_FILE);
  const saved = findWol(store.items, command.args[0]);
  const mac = saved?.mac || normalizeMac(command.args[0]);
  await sendWakeOnLan(mac);
  return `Magic packet terkirim ke ${mac}.`;
}

export async function listWol() {
  return (await readCollection(WOL_FILE)).items;
}

function findWol(items, query) {
  const text = String(query || '').trim();
  const id = Number(text);
  if (Number.isInteger(id)) return items.find((item) => item.id === id) || null;
  let mac = null;
  try {
    mac = normalizeMac(text);
  } catch {
    return null;
  }
  return items.find((item) => item.mac === mac) || null;
}

function formatWolList(items) {
  if (!items.length) return 'Belum ada MAC WOL tersimpan.';
  return items.map((item) => `#${item.id} - ${item.mac}`).join('\n');
}

function wolFormat() {
  return [
    'Format WOL:',
    ',wol list',
    ',wol add <mac>',
    ',wol wake <id|mac>',
    ',wol del <id|mac>'
  ].join('\n');
}
