import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { commandPaths, isWindowsCommandCandidate } from './cli-executables.mjs';

export function createCliTunnelRuntime({
  waitForHealth,
  waitForProcessExit,
  spawnSyncPortable,
  logRuntimeLifecycle = () => null,
  redactForLog = (value) => String(value),
  executableHelpers = {},
  runtime = {}
} = {}) {
  const processRuntime = runtime.process ?? process;
  const fsRuntime = runtime.fs ?? fs;
  const osRuntime = runtime.os ?? os;
  const setTimeoutFn = runtime.setTimeout ?? setTimeout;
  const clearTimeoutFn = runtime.clearTimeout ?? clearTimeout;
  const commandPathsFn = executableHelpers.commandPaths ?? commandPaths;
  const isWindowsCommandCandidateFn = executableHelpers.isWindowsCommandCandidate ?? isWindowsCommandCandidate;

  function waitForCloudflareUrl(child, timeoutMs = 45000) {
    const re = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/g;
    let buffer = '';
    const isQuickTunnelUrl = (value) => {
      try {
        return new URL(value).hostname !== 'api.trycloudflare.com';
      } catch {
        return false;
      }
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeoutFn(() => reject(new Error('Timed out waiting for cloudflared public URL.')), timeoutMs);
      timer.unref();
      const onData = (chunk) => {
        const text = String(chunk);
        buffer += text;
        const match = buffer.match(re);
        const tunnelUrl = match?.find(isQuickTunnelUrl);
        if (tunnelUrl) {
          clearTimeoutFn(timer);
          resolve(tunnelUrl);
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('exit', (code) => {
        clearTimeoutFn(timer);
        reject(new Error(`cloudflared exited before a URL was found, code=${code}`));
      });
    });
  }

  function waitForTunnelStartup(child, label, timeoutMs = 1000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const cleanup = () => {
        clearTimeoutFn(timer);
        child.off('exit', onExit);
        child.off('error', onError);
      };
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };
      const outputTail = () => {
        const tail = typeof child.codexproLogTail === 'function' ? child.codexproLogTail() : '';
        return tail ? `\n\nRecent ${label} output:\n${tail}` : '';
      };
      const onExit = (code, signal) => {
        settle(reject, new Error(`${label} exited before startup completed, code=${code} signal=${signal}${outputTail()}`));
      };
      const onError = (error) => {
        settle(reject, new Error(`${label} failed before startup completed: ${error instanceof Error ? error.message : String(error)}${outputTail()}`));
      };
      timer = setTimeoutFn(() => settle(resolve), timeoutMs);
      timer.unref();
      child.once('exit', onExit);
      child.once('error', onError);
    });
  }

  function outboundProxyFromEnv(env = processRuntime.env) {
    return env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || env.HTTP_PROXY || env.http_proxy || '';
  }

  function requestQuickTunnelViaCurl(proxyUrl) {
    const args = ['--silent', '--show-error', '--fail', '--max-time', '30'];
    if (proxyUrl) args.push('--proxy', proxyUrl);
    args.push('-X', 'POST', 'https://api.trycloudflare.com/tunnel');
    const curlCommand = processRuntime.platform === 'win32'
      ? commandPathsFn('curl').find(isWindowsCommandCandidateFn) || 'curl'
      : 'curl';
    const result = spawnSyncPortable(curlCommand, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.status !== 0) {
      throw new Error(redactForLog(`Failed to request Cloudflare quick tunnel via curl: ${result.stderr || result.stdout || `exit ${result.status}`}`));
    }

    let body;
    try {
      body = JSON.parse(result.stdout);
    } catch {
      throw new Error('Cloudflare quick tunnel API returned invalid JSON.');
    }

    const tunnel = body?.result;
    if (!body?.success || !tunnel?.id || !tunnel?.hostname || !tunnel?.account_tag || !tunnel?.secret) {
      const errors = Array.isArray(body?.errors) && body.errors.length ? ` ${JSON.stringify(body.errors)}` : '';
      throw new Error(redactForLog(`Cloudflare quick tunnel API did not return usable tunnel credentials.${errors}`));
    }

    return {
      id: String(tunnel.id),
      hostname: normalizePublicHostname(tunnel.hostname),
      accountTag: String(tunnel.account_tag),
      secret: String(tunnel.secret)
    };
  }

  function writeQuickTunnelCredentials(tunnel) {
    const tmpRoot = fsRuntime.mkdtempSync(path.join(osRuntime.tmpdir(), 'codexpro-cloudflare-quick-'));
    const credentialsPath = path.join(tmpRoot, 'credentials.json');
    fsRuntime.writeFileSync(credentialsPath, JSON.stringify({
      AccountTag: tunnel.accountTag,
      TunnelSecret: tunnel.secret,
      TunnelID: tunnel.id
    }, null, 2), { mode: 0o600 });
    return { tmpRoot, credentialsPath };
  }

  function normalizePublicHostname(value) {
    const raw = String(value ?? '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (url.protocol !== 'https:') throw new Error('hostname must use https when a scheme is provided.');
    if (url.search || url.hash) throw new Error('hostname must not include query strings or fragments.');
    if (url.pathname !== '/' && url.pathname !== '/mcp') throw new Error('hostname must be a host, URL root, or /mcp URL.');
    return url.host;
  }

  function publicBaseFromHostname(hostname) {
    return `https://${normalizePublicHostname(hostname)}`;
  }

  function tailscaleFunnelHttpsPort(publicBase) {
    const port = new URL(publicBase).port || '443';
    if (!['443', '8443', '10000'].includes(port)) {
      throw new Error('Tailscale Funnel HTTPS port must be 443, 8443, or 10000.');
    }
    return port;
  }

  async function waitForPublicHealth(publicBase, token, tunnelChild, tunnelLabel = 'tunnel') {
    const health = waitForHealth(`${publicBase}/healthz`, token, 60000);
    const exit = waitForProcessExit(tunnelChild).then(({ code, signal }) => {
      throw new Error(`${tunnelLabel} exited before ${publicBase}/healthz was reachable, code=${code} signal=${signal}`);
    });
    const result = await Promise.race([health, exit]);
    logRuntimeLifecycle('tunnel-ready', `${tunnelLabel} health probe succeeded`, {
      tunnel_name: tunnelLabel,
      tunnel_pid: tunnelChild?.pid ?? null,
      public_origin: (() => {
        try { return new URL(publicBase).origin; } catch { return ''; }
      })()
    });
    return result;
  }

  return {
    waitForCloudflareUrl,
    waitForTunnelStartup,
    outboundProxyFromEnv,
    requestQuickTunnelViaCurl,
    writeQuickTunnelCredentials,
    normalizePublicHostname,
    publicBaseFromHostname,
    tailscaleFunnelHttpsPort,
    waitForPublicHealth
  };
}
