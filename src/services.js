import os from 'node:os';
import { runTool } from './tools.js';

export const TAILSCALE_HOSTNAME = 'minipc.nyala-duck.ts.net';

const SERVICE_NAMES = new Map([
  [22, 'SSH'],
  [53, 'DNS'],
  [80, 'HTTP web'],
  [139, 'NetBIOS/Samba'],
  [443, 'HTTPS web'],
  [445, 'SMB/Samba'],
  [631, 'IPP printing'],
  [3000, 'Web app'],
  [3001, 'Web app'],
  [5000, 'Web app/API'],
  [5678, 'Web app/API'],
  [8000, 'HTTP web'],
  [8080, 'HTTP web'],
  [8443, 'HTTPS web'],
  [8765, 'Web app'],
  [9090, 'Web admin/API'],
  [9443, 'HTTPS web'],
  [9999, 'Web app']
]);

export async function listOpenServices({ hostname = TAILSCALE_HOSTNAME, runner = runTool } = {}) {
  const [socketResult, addresses] = await Promise.all([
    runner('ss', ['-lntupH']),
    getLocalAddresses()
  ]);
  const sockets = parseSsOutput(socketResult.stdout || '');
  return {
    hostname,
    addresses,
    sockets: sockets.map((socket) => ({
      ...socket,
      service: SERVICE_NAMES.get(socket.port) || 'Unknown service',
      access: accessAddresses(socket.localAddress, socket.port, addresses, hostname)
    }))
  };
}

export function parseSsOutput(output) {
  const sockets = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || !['tcp', 'udp'].includes(fields[0])) continue;
    const endpoint = parseEndpoint(fields[4]);
    if (!endpoint || endpoint.port < 1) continue;
    sockets.push({ protocol: fields[0].toUpperCase(), state: fields[1], localAddress: endpoint.address, port: endpoint.port });
  }
  return sockets;
}

export function formatServices(result) {
  const lines = [
    'Open services / port listener',
    `Tailscale: ${result.hostname}`,
    `IP lokal: ${result.addresses.filter((item) => item.kind === 'local').map((item) => item.address).join(', ') || 'tidak terdeteksi'}`,
    ''
  ];
  if (!result.sockets.length) {
    lines.push('Tidak ada port listener yang terdeteksi.');
    return lines.join('\n');
  }

  for (const socket of result.sockets) {
    const access = socket.access.length ? socket.access.join(', ') : socket.localAddress;
    lines.push(`${socket.protocol} ${socket.port} - ${socket.service}`);
    lines.push(`  Bind: ${socket.localAddress} | Akses: ${access}`);
  }
  lines.push('', 'Catatan: URL web memakai http/https sesuai service; SSH gunakan ssh; Samba gunakan \\IP\share atau smb://IP/share.');
  return lines.join('\n');
}

async function getLocalAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (entry.internal || entry.family !== 'IPv4' || /^(docker|br-|veth)/i.test(name)) continue;
      addresses.push({ address: entry.address, name, kind: /^tailscale/i.test(name) ? 'tailscale' : 'local' });
    }
  }
  return addresses;
}

function parseEndpoint(value) {
  const text = String(value || '').replace(/%[^\]]+(?=\])/, '');
  const ipv6 = text.match(/^\[([^\]]+)\]:(\d+)$/);
  if (ipv6) return { address: ipv6[1], port: Number(ipv6[2]) };
  const separator = text.lastIndexOf(':');
  if (separator < 1) return null;
  const port = Number(text.slice(separator + 1));
  if (!Number.isInteger(port)) return null;
  return { address: text.slice(0, separator), port };
}

function accessAddresses(bindAddress, port, addresses, hostname) {
  if (bindAddress === '127.0.0.1' || bindAddress === '::1') return ['localhost'];
  const isWildcard = ['0.0.0.0', '::'].includes(bindAddress);
  const matched = isWildcard
    ? addresses.map((item) => item.address)
    : addresses.filter((item) => item.address === bindAddress).map((item) => item.address);
  const result = [...matched];
  if (isWildcard || addresses.some((item) => item.address === bindAddress && item.kind === 'tailscale')) {
    result.push(hostname);
  }
  return [...new Set(result)].map((address) => formatAccess(address, port));
}

function formatAccess(address, port) {
  if (port === 22) return `ssh://${address}:22`;
  if (port === 139 || port === 445) return `smb://${address}`;
  if ([443, 8443, 9443].includes(port)) return `https://${address}:${port}`;
  if ([80, 3000, 3001, 5000, 5678, 8000, 8080, 8765, 9090, 9999].includes(port)) return `http://${address}:${port}`;
  return `${address}:${port}`;
}
