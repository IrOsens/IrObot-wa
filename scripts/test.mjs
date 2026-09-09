import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iro-tests-'));
try {
  const tests = (await fs.readdir(path.join(root, 'test'))).filter((name) => name.endsWith('.test.js')).map((name) => path.join(root, 'test', name));
  const child = spawn(process.execPath, ['--test', ...tests], { cwd: dir, stdio: 'inherit' });
  process.exitCode = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
} finally { await fs.rm(dir, { recursive: true, force: true }); }
