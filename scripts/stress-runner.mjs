import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stressPath = path.join(projectRoot, 'scripts', 'stress.mjs');
let runPath = stressPath;
let tempDir;

if (process.platform === 'win32') {
  const source = await fs.readFile(stressPath, 'utf8');
  const marker = 'command: `${JSON.stringify(process.execPath)} -e "';
  if (!source.includes(marker)) {
    throw new Error('Could not locate the Windows bash output stress command.');
  }
  const patched = source.replace(marker, 'command: `& ${JSON.stringify(process.execPath)} -e "');
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-stress-runner-'));
  runPath = path.join(tempDir, 'stress.mjs');
  await fs.writeFile(runPath, patched, 'utf8');
}

const child = spawn(process.execPath, [runPath], {
  cwd: projectRoot,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true
});

const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', (code) => resolve(code ?? 1));
});

if (tempDir) {
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

process.exitCode = exitCode;
