import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createCliTunnelRuntime } from './cli-tunnel-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeChild(pid = 1) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = pid;
  return child;
}

function timerHarness() {
  const timers = [];
  const cleared = [];
  return {
    timers,
    cleared,
    runtime: {
      setTimeout(callback, ms) {
        const timer = { callback, ms, unrefCalled: false, unref() { this.unrefCalled = true; } };
        timers.push(timer);
        return timer;
      },
      clearTimeout(timer) {
        cleared.push(timer);
      }
    }
  };
}

const baseDeps = {
  waitForHealth: async () => ({ ok: true }),
  waitForProcessExit: () => new Promise(() => {}),
  spawnSyncPortable: () => ({ status: 0, stdout: '', stderr: '' })
};

{
  const timers = timerHarness();
  const runtime = createCliTunnelRuntime({ ...baseDeps, runtime: timers.runtime });
  const child = makeChild();
  const pending = runtime.waitForCloudflareUrl(child);
  child.stdout.emit('data', 'INF public URL https://alpha-123.trycloudflare.com ready\n');
  assert.equal(await pending, 'https://alpha-123.trycloudflare.com');
  assert.equal(timers.timers[0].ms, 45000);
  assert.equal(timers.timers[0].unrefCalled, true);
  assert.equal(timers.cleared[0], timers.timers[0]);
}

{
  const timers = timerHarness();
  const runtime = createCliTunnelRuntime({ ...baseDeps, runtime: timers.runtime });
  const child = makeChild();
  const pending = runtime.waitForCloudflareUrl(child, 321);
  child.stderr.emit('data', 'ERR route https://stderr-test.trycloudflare.com\n');
  assert.equal(await pending, 'https://stderr-test.trycloudflare.com');
  assert.equal(timers.timers[0].ms, 321);
}

{
  const timers = timerHarness();
  const runtime = createCliTunnelRuntime({ ...baseDeps, runtime: timers.runtime });
  const child = makeChild();
  const pending = runtime.waitForCloudflareUrl(child, 9);
  child.stdout.emit('data', 'https://api.trycloudflare.com\n');
  timers.timers[0].callback();
  await assert.rejects(pending, new Error('Timed out waiting for cloudflared public URL.'));
}

{
  const timers = timerHarness();
  const runtime = createCliTunnelRuntime({ ...baseDeps, runtime: timers.runtime });
  const child = makeChild();
  const pending = runtime.waitForCloudflareUrl(child);
  child.emit('exit', 17);
  await assert.rejects(pending, new Error('cloudflared exited before a URL was found, code=17'));
}

{
  const timers = timerHarness();
  const runtime = createCliTunnelRuntime({ ...baseDeps, runtime: timers.runtime });
  const child = makeChild();
  const pending = runtime.waitForTunnelStartup(child, 'cloudflared');
  assert.equal(child.listenerCount('exit'), 1);
  assert.equal(child.listenerCount('error'), 1);
  assert.equal(timers.timers[0].ms, 1000);
  assert.equal(timers.timers[0].unrefCalled, true);
  timers.timers[0].callback();
  await pending;
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('error'), 0);
}

{
  const timers = timerHarness();
  const runtime = createCliTunnelRuntime({ ...baseDeps, runtime: timers.runtime });
  const child = makeChild();
  child.codexproLogTail = () => '[cloudflared] recent output';
  const pending = runtime.waitForTunnelStartup(child, 'cloudflared', 50);
  child.emit('exit', 2, 'SIGTERM');
  await assert.rejects(pending, new Error('cloudflared exited before startup completed, code=2 signal=SIGTERM\n\nRecent cloudflared output:\n[cloudflared] recent output'));
}

{
  const timers = timerHarness();
  const runtime = createCliTunnelRuntime({ ...baseDeps, runtime: timers.runtime });
  const child = makeChild();
  child.codexproLogTail = () => 'tail';
  const pending = runtime.waitForTunnelStartup(child, 'ngrok', 50);
  child.emit('error', new Error('spawn failed'));
  await assert.rejects(pending, new Error('ngrok failed before startup completed: spawn failed\n\nRecent ngrok output:\ntail'));
}

{
  const runtime = createCliTunnelRuntime({ ...baseDeps });
  const env = {
    HTTPS_PROXY: '1',
    https_proxy: '2',
    ALL_PROXY: '3',
    all_proxy: '4',
    HTTP_PROXY: '5',
    http_proxy: '6'
  };
  assert.equal(runtime.outboundProxyFromEnv(env), '1');
  delete env.HTTPS_PROXY;
  assert.equal(runtime.outboundProxyFromEnv(env), '2');
  delete env.https_proxy;
  assert.equal(runtime.outboundProxyFromEnv(env), '3');
  delete env.ALL_PROXY;
  assert.equal(runtime.outboundProxyFromEnv(env), '4');
  delete env.all_proxy;
  assert.equal(runtime.outboundProxyFromEnv(env), '5');
  delete env.HTTP_PROXY;
  assert.equal(runtime.outboundProxyFromEnv(env), '6');
  delete env.http_proxy;
  assert.equal(runtime.outboundProxyFromEnv(env), '');
}

{
  const calls = [];
  const response = JSON.stringify({
    success: true,
    result: {
      id: 'tunnel-id',
      hostname: 'quick-test.trycloudflare.com',
      account_tag: 'account-tag',
      secret: 'secret-value'
    }
  });
  const runtime = createCliTunnelRuntime({
    waitForHealth: baseDeps.waitForHealth,
    waitForProcessExit: baseDeps.waitForProcessExit,
    spawnSyncPortable(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: response, stderr: '' };
    },
    executableHelpers: {
      commandPaths: () => ['curl.ps1', 'C:\\Windows\\System32\\curl.exe'],
      isWindowsCommandCandidate: (value) => /\.(cmd|bat|exe)$/i.test(value)
    },
    runtime: { process: { platform: 'win32', env: {} } }
  });
  assert.deepEqual(runtime.requestQuickTunnelViaCurl('http://proxy.local:8080'), {
    id: 'tunnel-id',
    hostname: 'quick-test.trycloudflare.com',
    accountTag: 'account-tag',
    secret: 'secret-value'
  });
  assert.equal(calls[0].command, 'C:\\Windows\\System32\\curl.exe');
  assert.deepEqual(calls[0].args, [
    '--silent', '--show-error', '--fail', '--max-time', '30',
    '--proxy', 'http://proxy.local:8080',
    '-X', 'POST', 'https://api.trycloudflare.com/tunnel'
  ]);
  assert.deepEqual(calls[0].options, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

{
  const runtime = createCliTunnelRuntime({
    ...baseDeps,
    spawnSyncPortable: () => ({ status: 0, stdout: 'not-json', stderr: '' })
  });
  assert.throws(() => runtime.requestQuickTunnelViaCurl(''), new Error('Cloudflare quick tunnel API returned invalid JSON.'));
}

{
  const runtime = createCliTunnelRuntime({
    ...baseDeps,
    redactForLog: (value) => String(value).replaceAll('SENSITIVE', '[REDACTED]'),
    spawnSyncPortable: () => ({
      status: 0,
      stdout: JSON.stringify({ success: false, errors: [{ message: 'SENSITIVE' }] }),
      stderr: ''
    })
  });
  assert.throws(
    () => runtime.requestQuickTunnelViaCurl(''),
    new Error('Cloudflare quick tunnel API did not return usable tunnel credentials. [{"message":"[REDACTED]"}]')
  );
}

{
  const runtime = createCliTunnelRuntime({
    ...baseDeps,
    redactForLog: (value) => String(value).replaceAll('SENSITIVE', '[REDACTED]'),
    spawnSyncPortable: () => ({ status: 22, stdout: '', stderr: 'SENSITIVE failure' })
  });
  assert.throws(
    () => runtime.requestQuickTunnelViaCurl(''),
    new Error('Failed to request Cloudflare quick tunnel via curl: [REDACTED] failure')
  );
}

{
  const writes = [];
  let prefix = '';
  const runtime = createCliTunnelRuntime({
    ...baseDeps,
    runtime: {
      fs: {
        mkdtempSync(value) { prefix = value; return path.join(root, 'fake-credential-root'); },
        writeFileSync(filePath, content, options) { writes.push({ filePath, content, options }); }
      },
      os: { tmpdir: () => path.join(root, 'tmp') }
    }
  });
  const result = runtime.writeQuickTunnelCredentials({ id: 'id-1', accountTag: 'acct-1', secret: 'secret-1' });
  assert(prefix.endsWith(`tmp${path.sep}codexpro-cloudflare-quick-`));
  assert.equal(result.tmpRoot, path.join(root, 'fake-credential-root'));
  assert.equal(result.credentialsPath, path.join(root, 'fake-credential-root', 'credentials.json'));
  assert.deepEqual(JSON.parse(writes[0].content), { AccountTag: 'acct-1', TunnelSecret: 'secret-1', TunnelID: 'id-1' });
  assert.deepEqual(writes[0].options, { mode: 0o600 });
}

{
  const runtime = createCliTunnelRuntime({ ...baseDeps });
  assert.equal(runtime.normalizePublicHostname('example.com'), 'example.com');
  assert.equal(runtime.normalizePublicHostname(' https://Example.com/mcp/ '), 'example.com');
  assert.equal(runtime.normalizePublicHostname('https://example.com:8443/mcp'), 'example.com:8443');
  assert.equal(runtime.publicBaseFromHostname('example.com/mcp'), 'https://example.com');
  assert.throws(() => runtime.normalizePublicHostname('http://example.com'), new Error('hostname must use https when a scheme is provided.'));
  assert.throws(() => runtime.normalizePublicHostname('https://example.com?x=1'), new Error('hostname must not include query strings or fragments.'));
  assert.throws(() => runtime.normalizePublicHostname('https://example.com#mcp'), new Error('hostname must not include query strings or fragments.'));
  assert.throws(() => runtime.normalizePublicHostname('https://example.com/other'), new Error('hostname must be a host, URL root, or /mcp URL.'));
  assert.equal(runtime.tailscaleFunnelHttpsPort('https://example.com'), '443');
  assert.equal(runtime.tailscaleFunnelHttpsPort('https://example.com:443'), '443');
  assert.equal(runtime.tailscaleFunnelHttpsPort('https://example.com:8443'), '8443');
  assert.equal(runtime.tailscaleFunnelHttpsPort('https://example.com:10000'), '10000');
  assert.throws(() => runtime.tailscaleFunnelHttpsPort('https://example.com:9443'), new Error('Tailscale Funnel HTTPS port must be 443, 8443, or 10000.'));
}

{
  const healthCalls = [];
  const lifecycle = [];
  const runtime = createCliTunnelRuntime({
    waitForHealth: async (...args) => { healthCalls.push(args); return { healthy: true }; },
    waitForProcessExit: () => new Promise(() => {}),
    spawnSyncPortable: baseDeps.spawnSyncPortable,
    logRuntimeLifecycle: (...args) => lifecycle.push(args)
  });
  const child = makeChild(4567);
  assert.deepEqual(await runtime.waitForPublicHealth('https://public.example:8443', 'token-1', child, 'Tailscale Funnel'), { healthy: true });
  assert.deepEqual(healthCalls[0], ['https://public.example:8443/healthz', 'token-1', 60000]);
  assert.deepEqual(lifecycle[0], [
    'tunnel-ready',
    'Tailscale Funnel health probe succeeded',
    { tunnel_name: 'Tailscale Funnel', tunnel_pid: 4567, public_origin: 'https://public.example:8443' }
  ]);
}

{
  const runtime = createCliTunnelRuntime({
    waitForHealth: () => new Promise(() => {}),
    waitForProcessExit: async () => ({ code: 9, signal: 'SIGTERM' }),
    spawnSyncPortable: baseDeps.spawnSyncPortable
  });
  await assert.rejects(
    runtime.waitForPublicHealth('https://public.example', '', makeChild(), 'cloudflared'),
    new Error('cloudflared exited before https://public.example/healthz was reachable, code=9 signal=SIGTERM')
  );
}

const cliSource = await fs.readFile(path.join(root, 'scripts', 'codexpro.mjs'), 'utf8');
const moduleSource = await fs.readFile(path.join(root, 'scripts', 'cli-tunnel-runtime.mjs'), 'utf8');
const packageSource = await fs.readFile(path.join(root, 'package.json'), 'utf8');
assert.match(moduleSource, /from '\.\/cli-executables\.mjs';/);
assert.match(cliSource, /from '\.\/cli-tunnel-runtime\.mjs';/);
assert.match(cliSource, /createCliTunnelRuntime\(\{/);
assert.match(cliSource, /createCliTunnelExecutables\(\{ spawnSyncPortable \}\)/);
for (const name of [
  'waitForCloudflareUrl',
  'waitForTunnelStartup',
  'outboundProxyFromEnv',
  'requestQuickTunnelViaCurl',
  'writeQuickTunnelCredentials',
  'normalizePublicHostname',
  'publicBaseFromHostname',
  'tailscaleFunnelHttpsPort',
  'waitForPublicHealth'
]) {
  assert(!cliSource.includes(`function ${name}(`), `${name} still implemented in codexpro.mjs`);
}
assert.match(packageSource, /node scripts\/cli-tunnel-runtime-smoke\.mjs/);
assert.match(cliSource, /superviseQuickTunnel/);
assert.match(cliSource, /function ngrokConfigPath\(/);
console.log('✓ CLI tunnel runtime smoke test passed');
