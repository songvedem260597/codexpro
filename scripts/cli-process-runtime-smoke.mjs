import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createCliProcessRuntime } from './cli-process-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timer = () => ({ unref() {} });
function child(pid = 1) {
  const value = new EventEmitter();
  value.stdout = new EventEmitter();
  value.stderr = new EventEmitter();
  value.pid = pid;
  value.killed = false;
  value.killCalls = [];
  value.kill = (signal) => { value.killCalls.push(signal); return true; };
  return value;
}

const ports = createCliProcessRuntime();
assert.equal(ports.normalizePort(1), '1');
assert.equal(ports.normalizePort('65535'), '65535');
assert.equal(ports.normalizePort('0005'), '5');
for (const value of [0, -1, 65536, 1.5, 'bad']) assert.throws(() => ports.normalizePort(value), new Error(`Invalid port: ${value}`));
const blocker = net.createServer();
await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(0, '127.0.0.1', resolve); });
const usedPort = blocker.address().port;
try {
  await assert.rejects(ports.assertPortAvailable('127.0.0.1', usedPort), new Error(ports.portInUseHelp('127.0.0.1', usedPort)));
} finally {
  await new Promise((resolve) => blocker.close(resolve));
}
await ports.assertPortAvailable('127.0.0.1', usedPort);

const normal = createCliProcessRuntime({ runtime: { isWindowsBatchFile: () => false, process: { platform: 'linux', env: {}, stdout: process.stdout, stderr: process.stderr } } });
assert.deepEqual(normal.processInvocation('/usr/bin/node', ['--version']), { command: '/usr/bin/node', args: ['--version'] });
const windows = createCliProcessRuntime({ runtime: { isWindowsBatchFile: (value) => /\.(cmd|bat)$/i.test(value), process: { platform: 'win32', env: { ComSpec: 'cmd-test.exe' }, stdout: process.stdout, stderr: process.stderr } } });
assert.equal(windows.quoteWindowsCmdArg('100%\nready'), '"100%% ready"');
const batch = windows.processInvocation('C:\\Program Files\\tool.cmd', ['a b', '100%', 'say"hi']);
assert.equal(batch.command, 'cmd-test.exe');
assert.deepEqual(batch.args.slice(0, 5), ['/d', '/q', '/v:off', '/s', '/c']);
assert.equal(batch.args[5], '""C:\\Program Files\\tool.cmd" "a b" "100%%" "say""hi""');
assert.equal(batch.windowsVerbatimArguments, true);
assert.equal(batch.killTree, true);

const syncCalls = [];
const sync = createCliProcessRuntime({ runtime: { spawnSync: (command, args, options) => { syncCalls.push({ command, args, options }); return { status: 0 }; }, isWindowsBatchFile: () => false, process: { platform: 'linux', env: {}, stdout: process.stdout, stderr: process.stderr } } });
sync.spawnSyncPortable('tool', ['arg'], { cwd: root, shell: true, windowsVerbatimArguments: false, stdio: 'ignore' });
assert.equal(syncCalls[0].options.cwd, root);
assert.equal(syncCalls[0].options.stdio, 'ignore');
assert.equal(syncCalls[0].options.shell, false);
assert.equal(syncCalls[0].options.windowsVerbatimArguments, undefined);
assert.equal('windowsHide' in syncCalls[0].options, false);
const winSyncCalls = [];
const winSync = createCliProcessRuntime({ runtime: { spawnSync: (command, args, options) => { winSyncCalls.push({ command, args, options }); return { status: 0 }; }, isWindowsBatchFile: () => true, process: { platform: 'win32', env: { ComSpec: 'cmd-test.exe' }, stdout: process.stdout, stderr: process.stderr } } });
winSync.spawnSyncPortable('tool.cmd', ['arg'], { stdio: 'pipe' });
assert.equal(winSyncCalls[0].command, 'cmd-test.exe');
assert.equal(winSyncCalls[0].options.windowsVerbatimArguments, true);
assert.equal(winSyncCalls[0].options.windowsHide, true);

const logs = [];
const spawned = [];
const loggedChild = child(4321);
const logged = createCliProcessRuntime({
  logRuntimeLifecycle: (...args) => logs.push(args),
  redactForLog: (value) => String(value).replaceAll('SECRET', '[REDACTED]'),
  cloudflaredOutputLevel: (line) => line.includes('WRN') ? 'warn' : null,
  runtime: { spawn: (command, args, options) => { spawned.push({ command, args, options }); return loggedChild; }, isWindowsBatchFile: () => false, process: { platform: 'linux', env: {}, stdout: process.stdout, stderr: process.stderr }, setTimeout: () => timer() }
});
const proc = logged.spawnLogged('cloudflared', '/tmp/cloudflared', ['tunnel'], { cwd: root });
assert(logged.spawnedChildren.has(proc));
assert.deepEqual(spawned[0].options.stdio, ['ignore', 'pipe', 'pipe']);
proc.stdout.emit('data', `${Array.from({ length: 130 }, (_, i) => `line-${i + 1}`).join('\n')}\n`);
proc.stderr.emit('data', 'WRN SECRET\n');
const tail = proc.codexproLogTail().split('\n');
assert.equal(tail.length, 120);
assert.equal(tail[0], '[cloudflared] line-12');
assert.equal(tail.at(-1), '[cloudflared] WRN [REDACTED]');
assert.equal(logs.find(([action]) => action === 'child-output')[3], 'warn');
const exited = logged.waitForProcessExit(proc);
logged.killProcess(proc);
assert.equal(proc.codexproExpectedExit, true);
assert.deepEqual(proc.killCalls, ['SIGTERM']);
proc.emit('exit', 0, null);
assert.deepEqual(await exited, { code: 0, signal: null });
assert(!logged.spawnedChildren.has(proc));
const exitLog = logs.find(([action]) => action === 'child-exit');
assert.equal(exitLog[2].expected_exit, true);
assert.equal(exitLog[3], 'info');

const taskkillCalls = [];
const tree = createCliProcessRuntime({ runtime: { spawnSync: (command, args, options) => { taskkillCalls.push({ command, args, options }); return { status: 0, error: null }; }, setTimeout: () => timer() } });
const treeChild = child(9876);
treeChild.codexproKillTree = true;
tree.spawnedChildren.add(treeChild);
tree.cleanupChildren();
assert.deepEqual(taskkillCalls[0], { command: 'taskkill.exe', args: ['/pid', '9876', '/t', '/f'], options: { stdio: 'ignore', windowsHide: true } });
assert.deepEqual(treeChild.killCalls, []);
let delayed;
const fallback = createCliProcessRuntime({ runtime: { setTimeout: (callback, ms) => (delayed = { callback, ms, unref() {} }) } });
const fallbackChild = child(11);
fallback.killProcess(fallbackChild);
assert.deepEqual(fallbackChild.killCalls, ['SIGTERM']);
assert.equal(delayed.ms, 1500);
delayed.callback();
assert.deepEqual(fallbackChild.killCalls, ['SIGTERM', 'SIGKILL']);

let now = 0;
let attempt = 0;
const healthCalls = [];
const health = createCliProcessRuntime({ runtime: { now: () => now, fetch: async (url, options) => { healthCalls.push({ url, options }); attempt += 1; if (attempt === 1) throw new Error('offline'); if (attempt === 2) return { ok: false, status: 503, text: async () => 'warming' }; return { ok: true, json: async () => ({ ready: true }) }; }, setTimeout: (callback, ms) => { now += ms; callback(); return timer(); } } });
assert.deepEqual(await health.waitForHealth('http://127.0.0.1/healthz', 'token-1', 1000), { ready: true });
assert.equal(healthCalls.length, 3);
assert.deepEqual(healthCalls[0].options.headers, { Authorization: 'Bearer token-1' });
assert.equal(now, 500);
let timeoutNow = 0;
const timeout = createCliProcessRuntime({ runtime: { now: () => timeoutNow, fetch: async () => { throw new Error('still offline'); }, setTimeout: (callback, ms) => { timeoutNow += ms; callback(); return timer(); } } });
await assert.rejects(timeout.waitForHealth('http://127.0.0.1/healthz', '', 500), new Error('Timed out waiting for http://127.0.0.1/healthz. Last error: still offline'));
assert.equal(timeoutNow, 500);

const cliSource = await fs.readFile(path.join(root, 'scripts', 'codexpro.mjs'), 'utf8');
const moduleSource = await fs.readFile(path.join(root, 'scripts', 'cli-process-runtime.mjs'), 'utf8');
const packageSource = await fs.readFile(path.join(root, 'package.json'), 'utf8');
assert.match(moduleSource, /from '\.\/cli-executables\.mjs';/);
assert.match(cliSource, /from '\.\/cli-process-runtime\.mjs';/);
assert.match(cliSource, /createCliTunnelExecutables\(\{ spawnSyncPortable \}\)/);
assert.match(cliSource, /from '\.\/cli-tunnel-runtime\.mjs';/);
for (const name of ['sleep', 'waitForHealth', 'portInUseHelp', 'normalizePort', 'assertPortAvailable', 'quoteWindowsCmdArg', 'processInvocation', 'spawnSyncPortable', 'spawnLogged', 'waitForProcessExit', 'killProcess', 'cleanupChildren', 'watchHiddenLauncherParent']) assert(!cliSource.includes(`function ${name}(`), `${name} still implemented in codexpro.mjs`);
assert(!cliSource.includes('const spawnedChildren = new Set()'));
assert.match(packageSource, /node scripts\/cli-process-runtime-smoke\.mjs/);
console.log('✓ CLI process runtime smoke test passed');
