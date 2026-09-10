import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createCliTunnelExecutables } from './cli-tunnel-executables.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliSource = await fs.readFile(path.join(projectRoot, 'scripts', 'codexpro.mjs'), 'utf8');
const moduleSource = await fs.readFile(path.join(projectRoot, 'scripts', 'cli-tunnel-executables.mjs'), 'utf8');

const originalEnv = {
  CODEXPRO_HOME: process.env.CODEXPRO_HOME,
  CLOUDFLARED_BIN: process.env.CLOUDFLARED_BIN,
  NGROK_BIN: process.env.NGROK_BIN,
  TAILSCALE_BIN: process.env.TAILSCALE_BIN
};
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-cli-tunnel-executables-'));
process.env.CODEXPRO_HOME = tempRoot;

const available = new Set();
const onPath = new Set();
const executableFiles = new Set();
const verifyFailures = new Set();
const spawnCalls = [];
const spawnSyncPortable = (command, args, options) => {
  spawnCalls.push({ command, args: [...args], options: { ...options } });
  return { status: verifyFailures.has(command) ? 1 : 0 };
};

const tunnelExecutables = createCliTunnelExecutables({
  spawnSyncPortable,
  executableHelpers: {
    commandAvailable: (command) => available.has(command),
    commandExists: (command) => onPath.has(command),
    executableFileExists: (filePath) => executableFiles.has(filePath)
  }
});

const {
  cloudflaredBinName,
  localCloudflaredPath,
  findFileByName,
  verifyCloudflared,
  resolveCloudflared,
  verifyNgrok,
  resolveNgrok,
  verifyTailscale,
  resolveTailscale
} = tunnelExecutables;

try {
  const expectedCloudflaredName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  assert.equal(cloudflaredBinName(), expectedCloudflaredName);
  assert.equal(localCloudflaredPath(), path.join(path.resolve(tempRoot), 'bin', expectedCloudflaredName));

  const nestedDir = path.join(tempRoot, 'nested', 'deeper');
  const nestedCloudflared = path.join(nestedDir, 'cloudflared');
  await fs.mkdir(nestedDir, { recursive: true });
  await fs.writeFile(nestedCloudflared, 'smoke');
  assert.equal(findFileByName(tempRoot, 'cloudflared'), nestedCloudflared);
  assert.equal(findFileByName(tempRoot, 'missing-binary'), '');

  const explicitCloudflared = path.join(tempRoot, 'explicit-cloudflared');
  const envCloudflared = path.join(tempRoot, 'env-cloudflared');
  available.add(path.resolve(explicitCloudflared));
  available.add(path.resolve(envCloudflared));
  process.env.CLOUDFLARED_BIN = envCloudflared;
  assert.equal(await resolveCloudflared({ cloudflared: explicitCloudflared }), path.resolve(explicitCloudflared));
  assert.equal(spawnCalls.at(-1).command, path.resolve(explicitCloudflared));
  assert.deepEqual(spawnCalls.at(-1).args, ['--version']);
  assert.deepEqual(spawnCalls.at(-1).options, { stdio: 'ignore', timeout: 15000 });
  assert.equal(await resolveCloudflared({}), path.resolve(envCloudflared));

  delete process.env.CLOUDFLARED_BIN;
  onPath.add('cloudflared');
  assert.equal(await resolveCloudflared({}), 'cloudflared');
  onPath.delete('cloudflared');

  const localPath = localCloudflaredPath();
  executableFiles.add(localPath);
  assert.equal(await resolveCloudflared({ noInstallCloudflared: true }), localPath);
  verifyFailures.add(localPath);
  assert.equal(await resolveCloudflared({ noInstallCloudflared: true }), localPath);
  verifyFailures.delete(localPath);
  executableFiles.delete(localPath);
  assert.equal(await resolveCloudflared({ noInstallCloudflared: true }), '');
  assert.equal(await resolveCloudflared({ installCloudflared: true, noInstallCloudflared: true }), '');

  const missingCloudflared = path.join(tempRoot, 'missing-cloudflared');
  await assert.rejects(
    resolveCloudflared({ cloudflared: missingCloudflared }),
    new Error(`cloudflared was not found at ${missingCloudflared}. Remove --cloudflared, install it, or pass a valid path.`)
  );

  const explicitNgrok = path.join(tempRoot, 'explicit-ngrok');
  const envNgrok = path.join(tempRoot, 'env-ngrok');
  available.add(path.resolve(explicitNgrok));
  available.add(path.resolve(envNgrok));
  process.env.NGROK_BIN = envNgrok;
  assert.equal(resolveNgrok({ ngrok: explicitNgrok }), path.resolve(explicitNgrok));
  assert.equal(resolveNgrok({}), path.resolve(envNgrok));
  delete process.env.NGROK_BIN;
  onPath.add('ngrok');
  assert.equal(resolveNgrok({}), 'ngrok');
  onPath.delete('ngrok');
  assert.throws(
    () => resolveNgrok({}),
    new Error('ngrok was not found on PATH. Install it with Homebrew, winget, apt, or from https://ngrok.com/download, then run ngrok config add-authtoken <token>.')
  );

  const explicitTailscale = path.join(tempRoot, 'explicit-tailscale');
  const envTailscale = path.join(tempRoot, 'env-tailscale');
  available.add(path.resolve(explicitTailscale));
  available.add(path.resolve(envTailscale));
  process.env.TAILSCALE_BIN = envTailscale;
  assert.equal(resolveTailscale({ tailscale: explicitTailscale }), path.resolve(explicitTailscale));
  assert.equal(resolveTailscale({}), path.resolve(envTailscale));
  delete process.env.TAILSCALE_BIN;
  onPath.add('tailscale');
  assert.equal(resolveTailscale({}), 'tailscale');
  onPath.delete('tailscale');
  assert.throws(
    () => resolveTailscale({}),
    new Error('tailscale was not found on PATH. Install Tailscale and enable Funnel, then run codexpro tailscale --hostname your-device.your-tailnet.ts.net.')
  );

  verifyCloudflared('cloudflared-check');
  verifyNgrok('ngrok-check');
  verifyTailscale('tailscale-check');
  assert.deepEqual(spawnCalls.slice(-3), [
    { command: 'cloudflared-check', args: ['--version'], options: { stdio: 'ignore', timeout: 15000 } },
    { command: 'ngrok-check', args: ['version'], options: { stdio: 'ignore', timeout: 15000 } },
    { command: 'tailscale-check', args: ['version'], options: { stdio: 'ignore', timeout: 15000 } }
  ]);

  verifyFailures.add('bad-cloudflared');
  verifyFailures.add('bad-ngrok');
  verifyFailures.add('bad-tailscale');
  assert.throws(() => verifyCloudflared('bad-cloudflared'), new Error('Downloaded cloudflared, but bad-cloudflared --version failed.'));
  assert.throws(() => verifyNgrok('bad-ngrok'), new Error('ngrok was found, but bad-ngrok version failed. Run ngrok version to inspect it.'));
  assert.throws(() => verifyTailscale('bad-tailscale'), new Error('tailscale was found, but bad-tailscale version failed. Run tailscale version to inspect it.'));

  assert.match(moduleSource, /from '\.\/cli-executables\.mjs';/);
  assert.match(cliSource, /from '\.\/cli-tunnel-executables\.mjs';/);
  assert.match(cliSource, /function ngrokConfigPath\(/);
  for (const name of [
    'cloudflaredBinName',
    'localCloudflaredPath',
    'findFileByName',
    'downloadFile',
    'verifyCloudflared',
    'installCloudflaredLocal',
    'resolveCloudflared',
    'verifyNgrok',
    'resolveNgrok',
    'verifyTailscale',
    'resolveTailscale'
  ]) {
    assert(!cliSource.includes(`function ${name}(`), `${name} still implemented in codexpro.mjs`);
  }
} finally {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log('✓ CLI tunnel executables smoke test passed');
