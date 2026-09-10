#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  CLOUDFLARED_VERSION,
  cloudflaredReleaseAsset,
  cloudflaredReleaseUrl,
  readCloudflaredAssetResponse,
  verifyCloudflaredAsset
} from './cloudflared-release.mjs';
import {
  CODEXPRO_AUDITOR_AGENT,
  CODEXPRO_EXPLORE_AGENT,
  CODEXPRO_ORCHESTRATOR_AGENT,
  CODEXPRO_SCOUT_ORCHESTRATOR_AGENT,
  GEMINI_SCOUT_AGENT,
  inspectOpenCodeScoutCapability
} from './opencode-subagents.mjs';
import {
  inspectCodexProAuditorCapability,
  inspectGeminiScoutAvailability,
  inspectOpenCodeRuntime,
  runOpenCodeModelProbe,
  runVerifiedGeminiScout,
  runVerifiedOpenCodeInvestigation
} from './opencode-subagent-runner.mjs';
import { createAnalysisCli } from './analysis-cli.mjs';
import { labelValue, paint, printBox, statusLine, usage } from './cli-presentation.mjs';
import {
  configuredProjectRoots,
  effectiveWriteMode,
  expandHome,
  optionalChoice,
  optionalWriteOption,
  optionBool,
  optionValue,
  parseArgs,
  realDir,
  resolveCodexDir,
  resolveConfigPath,
  validateChoice,
  writeOption
} from './cli-options.mjs';
import {
  bashSessionOptions,
  bashTranscriptOption,
  codexSessionsOption,
  toolCardsCliArgs,
  toolCardsProfileEntry
} from './cli-runtime-options.mjs';
import {
  commandAvailable,
  commandAvailableFromRoot,
  commandExists,
  commandPaths,
  executableFileExists,
  isPathLike,
  isWindowsBatchFile,
  isWindowsCommandCandidate,
  resolveAgentCommand,
  resolveCodexCommand,
  resolveExecutablePath
} from './cli-executables.mjs';
import { createHandoffRuntimeLauncher } from './handoff-runtime-launcher.mjs';
import { cloudflaredOutputLevel, createRuntimeLifecycleLogger } from './runtime-lifecycle-log.mjs';
import { superviseQuickTunnel } from './quick-tunnel-supervisor.mjs';
import {
  clearRuntimeConnection,
  codexProHome,
  deleteWorkspaceProfile,
  listWorkspaceProfiles,
  loadWorkspaceProfile,
  readJsonFile,
  reusableProfilePayload,
  sanitizedProfile,
  saveRuntimeConnection,
  saveWorkspaceProfile
} from './workspace-profile-store.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let runtimeLifecycleLogger = null;

function logRuntimeLifecycle(action, message, details = {}, level = 'info') {
  if (!runtimeLifecycleLogger) return null;
  try {
    return runtimeLifecycleLogger.append(action, message, details, level);
  } catch (error) {
    console.error(`[codexpro-lifecycle-log] ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;
}

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function profileSummary(profile) {
  if (!profile?.tunnel) return '';
  if (profile.tunnel === 'ngrok' && profile.hostname) return `Saved ngrok URL: ${profile.hostname}`;
  if (profile.tunnel === 'cloudflare-named' && profile.hostname) return `Saved Cloudflare URL: ${profile.hostname}`;
  if (profile.tunnel === 'tailscale' && profile.hostname) return `Saved Tailscale Funnel URL: ${profile.hostname}`;
  if (profile.tunnel === 'cloudflare') return 'Saved Cloudflare quick-tunnel setup';
  if (profile.tunnel === 'none') return 'Saved local-only setup';
  return '';
}

function profileOneLine(profile, index = 0) {
  const prefix = index ? `${index}. ` : '';
  const tunnel = profile.tunnel ?? 'cloudflare';
  const host = profile.hostname ? ` -> ${profile.hostname}` : '';
  const port = profile.port ? ` :${profile.port}` : '';
  return `${prefix}${profile.root}  ${tunnel}${host}${port}`;
}

function printSavedProfileHint(profile) {
  const summary = profileSummary(profile);
  if (!summary) return;
  printBox('Saved setup found', [
    summary,
    'From this folder, future launches only need: codexpro start',
    'Use codexpro setup when you want to change the port, mode, tool mode, tunnel, hostname, or token.'
  ]);
}








function managerMaxSubagentsSetting() {
  try {
    const settings = readJsonFile(path.join(codexProHome(), 'manager-settings.json'));
    return numberOption(settings?.maxSubagents, 1, 1, 1);
  } catch {
    return 1;
  }
}



function stableToken(existing = '') {
  return existing || randomBytes(24).toString('hex');
}

function cloudflaredBinName() {
  return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

function localCloudflaredPath() {
  return path.join(codexProHome(), 'bin', cloudflaredBinName());
}

function findFileByName(root, fileName) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name === fileName) return fullPath;
    if (entry.isDirectory()) {
      const found = findFileByName(fullPath, fileName);
      if (found) return found;
    }
  }
  return '';
}

async function downloadFile(url, destination, asset) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'codexpro-launcher' }
  });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  const buffer = await readCloudflaredAssetResponse(response, asset);
  verifyCloudflaredAsset(asset, buffer);
  fs.writeFileSync(destination, buffer, { mode: 0o755 });
}

function verifyCloudflared(binaryPath) {
  const result = spawnSyncPortable(binaryPath, ['--version'], {
    stdio: 'ignore',
    timeout: 15000
  });
  if (result.status !== 0) {
    throw new Error(`Downloaded cloudflared, but ${binaryPath} --version failed.`);
  }
}

async function installCloudflaredLocal() {
  const asset = cloudflaredReleaseAsset();
  const installPath = localCloudflaredPath();
  const binDir = path.dirname(installPath);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codexpro-cloudflared-'));
  const url = cloudflaredReleaseUrl(asset);

  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  console.error(`[codexpro] Installing cloudflared locally: ${installPath}`);
  console.error(`[codexpro] Downloading verified Cloudflare release ${CLOUDFLARED_VERSION}: ${asset.file}`);

  try {
    if (asset.archive) {
      const archivePath = path.join(tmpRoot, asset.file);
      const extractDir = path.join(tmpRoot, 'extract');
      fs.mkdirSync(extractDir, { recursive: true });
      await downloadFile(url, archivePath, asset);
      const tar = spawnSync('tar', ['-xzf', archivePath, '-C', extractDir], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false
      });
      if (tar.status !== 0) {
        throw new Error(`Failed to extract ${asset.file}: ${tar.stderr || tar.stdout || `exit ${tar.status}`}`);
      }
      const extracted = findFileByName(extractDir, 'cloudflared');
      if (!extracted) throw new Error(`Could not find cloudflared inside ${asset.file}`);
      fs.copyFileSync(extracted, installPath);
    } else {
      const tmpBinary = path.join(tmpRoot, cloudflaredBinName());
      await downloadFile(url, tmpBinary, asset);
      fs.copyFileSync(tmpBinary, installPath);
    }

    if (process.platform !== 'win32') fs.chmodSync(installPath, 0o755);
    verifyCloudflared(installPath);
    console.error('[codexpro] cloudflared installed successfully.');
    return installPath;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function resolveCloudflared(args) {
  const explicit = args.cloudflared ?? process.env.CLOUDFLARED_BIN ?? '';
  if (explicit) {
    const resolved = isPathLike(explicit) ? resolveExecutablePath(explicit) : explicit;
    if (commandAvailable(resolved)) {
      verifyCloudflared(resolved);
      return resolved;
    }
    throw new Error(`cloudflared was not found at ${explicit}. Remove --cloudflared, install it, or pass a valid path.`);
  }

  if (!args.installCloudflared && commandExists('cloudflared')) {
    try {
      verifyCloudflared('cloudflared');
      return 'cloudflared';
    } catch (error) {
      console.error(`[codexpro] cloudflared in PATH failed --version; trying local install. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const localPath = localCloudflaredPath();
  if (!args.installCloudflared && executableFileExists(localPath)) {
    try {
      verifyCloudflared(localPath);
      return localPath;
    } catch (error) {
      if (args.noInstallCloudflared) return localPath;
      console.error(`[codexpro] Existing ${localPath} failed --version; reinstalling. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (args.noInstallCloudflared) return '';
  return installCloudflaredLocal();
}

function verifyNgrok(binaryPath) {
  const result = spawnSyncPortable(binaryPath, ['version'], {
    stdio: 'ignore',
    timeout: 15000
  });
  if (result.status !== 0) {
    throw new Error(`ngrok was found, but ${binaryPath} version failed. Run ngrok version to inspect it.`);
  }
}

function resolveNgrok(args) {
  const explicit = args.ngrok ?? process.env.NGROK_BIN ?? '';
  if (explicit) {
    const resolved = isPathLike(explicit) ? resolveExecutablePath(explicit) : explicit;
    if (commandAvailable(resolved)) {
      verifyNgrok(resolved);
      return resolved;
    }
    throw new Error(`ngrok was not found at ${explicit}. Install ngrok, add it to PATH, or pass --ngrok <path>.`);
  }

  if (commandExists('ngrok')) {
    verifyNgrok('ngrok');
    return 'ngrok';
  }

  throw new Error('ngrok was not found on PATH. Install it with Homebrew, winget, apt, or from https://ngrok.com/download, then run ngrok config add-authtoken <token>.');
}

function verifyTailscale(binaryPath) {
  const result = spawnSyncPortable(binaryPath, ['version'], {
    stdio: 'ignore',
    timeout: 15000
  });
  if (result.status !== 0) {
    throw new Error(`tailscale was found, but ${binaryPath} version failed. Run tailscale version to inspect it.`);
  }
}

function resolveTailscale(args) {
  const explicit = args.tailscale ?? process.env.TAILSCALE_BIN ?? '';
  if (explicit) {
    const resolved = isPathLike(explicit) ? resolveExecutablePath(explicit) : explicit;
    if (commandAvailable(resolved)) {
      verifyTailscale(resolved);
      return resolved;
    }
    throw new Error(`tailscale was not found at ${explicit}. Install Tailscale, add it to PATH, or pass --tailscale <path>.`);
  }

  if (commandExists('tailscale')) {
    verifyTailscale('tailscale');
    return 'tailscale';
  }

  throw new Error('tailscale was not found on PATH. Install Tailscale and enable Funnel, then run codexpro tailscale --hostname your-device.your-tailnet.ts.net.');
}

function ngrokConfigPath(root, args, profile = {}) {
  const configPath = optionValue(args, profile, 'ngrokConfig', ['NGROK_CONFIG', 'CODEXPRO_NGROK_CONFIG'], '');
  return resolveConfigPath(root, configPath);
}

function runHelperScript(scriptName, args) {
  const scriptPath = path.join(projectRoot, 'scripts', scriptName);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: projectRoot,
    env: { ...process.env, CODEXPRO_CALLER_CWD: process.cwd() },
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(url, token, timeoutMs = 15000) {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (res.ok) return await res.json();
      lastError = `${res.status} ${await res.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}. Last error: ${lastError}`);
}

function portInUseHelp(host, port) {
  return [
    `Local port ${port} is already in use on ${host}.`,
    '',
    'If you want two repositories running at the same time, each one needs its own local port.',
    '',
    'Example:',
    '  repo A: codexpro setup  -> port 8787 -> hostname A',
    '  repo B: codexpro setup  -> port 8788 -> hostname B',
    '',
    'For quick tunnels you can also start the second repo with:',
    '  codexpro start --port 8788',
    '',
    'Stable public hostnames also cannot be shared by two running repositories at once.'
  ].join('\n');
}

function normalizePort(port) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort <= 0 || numericPort > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }
  return String(numericPort);
}

async function assertPortAvailable(host, port) {
  const numericPort = Number(normalizePort(port));
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
        reject(new Error(portInUseHelp(host, port)));
        return;
      }
      reject(error);
    });
    server.once('listening', () => {
      server.close(() => resolve());
    });
    server.listen(numericPort, host);
  });
}

const spawnedChildren = new Set();

function spawnLogged(name, command, args, options = {}) {
  const { verbose = false, ...spawnOptions } = options;
  const invocation = processInvocation(command, args);
  const child = spawn(invocation.command, invocation.args, {
    ...spawnOptions,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    ...(process.platform === 'win32' ? { windowsHide: true } : {})
  });
  child.codexproKillTree = Boolean(invocation.killTree);
  child.codexproExpectedExit = false;
  const logLines = [];
  const record = (stream, streamName, chunk) => {
    const text = redactForLog(String(chunk));
    const lines = text.split(/\r?\n/).filter(Boolean);
    logLines.push(...lines.map((line) => `[${name}] ${line}`));
    while (logLines.length > 120) logLines.shift();
    if (name === 'cloudflared') {
      for (const line of lines) {
        const level = cloudflaredOutputLevel(line);
        if (!level) continue;
        logRuntimeLifecycle('child-output', `cloudflared ${streamName}`, {
          child_name: name,
          child_pid: child.pid ?? null,
          stream: streamName,
          line
        }, level);
      }
    }
    if (verbose) stream.write(`[${name}] ${text}`);
  };
  child.codexproLogTail = () => logLines.join('\n');
  spawnedChildren.add(child);
  logRuntimeLifecycle('child-spawn', `${name} process started`, {
    child_name: name,
    child_pid: child.pid ?? null,
    executable: path.basename(String(command || '')),
    cwd: spawnOptions.cwd || '',
    expected_exit: false
  });
  child.stdout.on('data', (chunk) => record(process.stdout, 'stdout', chunk));
  child.stderr.on('data', (chunk) => record(process.stderr, 'stderr', chunk));
  child.on('error', (error) => {
    logRuntimeLifecycle('child-error', `${name} process emitted an error`, {
      child_name: name,
      child_pid: child.pid ?? null,
      error,
      output_tail: child.codexproLogTail()
    }, 'error');
  });
  child.on('exit', (code, signal) => {
    spawnedChildren.delete(child);
    logRuntimeLifecycle('child-exit', `${name} process exited`, {
      child_name: name,
      child_pid: child.pid ?? null,
      exit_code: code,
      signal: signal || '',
      expected_exit: child.codexproExpectedExit === true,
      output_tail: child.codexproLogTail()
    }, child.codexproExpectedExit ? 'info' : 'error');
    if (verbose) console.error(`[${name}] exited code=${code} signal=${signal}`);
  });
  return child;
}

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
    const timer = setTimeout(() => reject(new Error('Timed out waiting for cloudflared public URL.')), timeoutMs);
    timer.unref();
    const onData = (chunk) => {
      const text = String(chunk);
      buffer += text;
      const match = buffer.match(re);
      const tunnelUrl = match?.find(isQuickTunnelUrl);
      if (tunnelUrl) {
        clearTimeout(timer);
        resolve(tunnelUrl);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`cloudflared exited before a URL was found, code=${code}`));
    });
  });
}

function waitForTunnelStartup(child, label, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
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
    timer = setTimeout(() => settle(resolve), timeoutMs);
    timer.unref();
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function outboundProxyFromEnv(env = process.env) {
  return env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || env.HTTP_PROXY || env.http_proxy || '';
}

function requestQuickTunnelViaCurl(proxyUrl) {
  const args = ['--silent', '--show-error', '--fail', '--max-time', '30'];
  if (proxyUrl) args.push('--proxy', proxyUrl);
  args.push('-X', 'POST', 'https://api.trycloudflare.com/tunnel');
  const curlCommand = process.platform === 'win32'
    ? commandPaths('curl').find(isWindowsCommandCandidate) || 'curl'
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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codexpro-cloudflare-quick-'));
  const credentialsPath = path.join(tmpRoot, 'credentials.json');
  fs.writeFileSync(credentialsPath, JSON.stringify({
    AccountTag: tunnel.accountTag,
    TunnelSecret: tunnel.secret,
    TunnelID: tunnel.id
  }, null, 2), { mode: 0o600 });
  return { tmpRoot, credentialsPath };
}

function killProcess(child) {
  if (!child || child.killed) return;
  child.codexproExpectedExit = true;
  if (child.codexproKillTree && child.pid) {
    const result = spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    });
    if (!result.error && result.status === 0) return;
  }
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    if (!child.killed) {
      try { child.kill('SIGKILL'); } catch {}
    }
  }, 1500).unref();
}

function cleanupChildren() {
  for (const child of spawnedChildren) killProcess(child);
}

function watchHiddenLauncherParent() {
  if (process.platform !== 'win32' || process.env.CODEXPRO_HIDDEN_LAUNCHER !== '1') return;
  const launcherPid = process.ppid;
  const timer = setInterval(() => {
    try {
      process.kill(launcherPid, 0);
    } catch {
      clearInterval(timer);
      cleanupChildren();
      process.exit(0);
    }
  }, 500);
  timer.unref();
}

function endpointWithToken(endpoint, token) {
  if (!token) return endpoint;
  const url = new URL(endpoint);
  url.searchParams.set('codexpro_token', token);
  return url.toString();
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

function readTokenFile(filePath) {
  const resolved = path.resolve(expandHome(filePath));
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`Token path is not a regular file: ${resolved}`);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`Token file permissions are too broad: ${resolved}. Run chmod 600 ${resolved}.`);
  }
  const token = fs.readFileSync(resolved, 'utf8').trim();
  if (!token) throw new Error(`Token file is empty: ${resolved}`);
  return token;
}

function normalizeMode(args) {
  const mode = args.mode ?? process.env.CODEXPRO_MODE ?? 'agent';
  if (!['agent', 'handoff', 'pro'].includes(mode)) {
    throw new Error('--mode must be agent, handoff, or pro');
  }
  return mode;
}

function copyToClipboard(text) {
  const attempts = [];
  if (process.platform === 'darwin') attempts.push(['pbcopy', []]);
  else if (process.platform === 'win32') attempts.push(['cmd', ['/c', 'clip']]);
  else {
    attempts.push(['wl-copy', []]);
    attempts.push(['xclip', ['-selection', 'clipboard']]);
    attempts.push(['xsel', ['--clipboard', '--input']]);
  }

  for (const [command, args] of attempts) {
    const exists = command === 'cmd' || commandExists(command);
    if (!exists) continue;
    const result = spawnSync(command, args, {
      input: text,
      encoding: 'utf8',
      stdio: ['pipe', 'ignore', 'ignore'],
      shell: false
    });
    if (result.status === 0) return { ok: true, command };
  }
  return { ok: false, command: '' };
}

function openUrl(url) {
  const command =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  const [bin, args] = command;
  if (bin !== 'cmd' && !commandExists(bin)) return false;
  const result = spawnSync(bin, args, { stdio: 'ignore', shell: false });
  return result.status === 0;
}

function waitForProcessExit(child) {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
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

function numberOption(value, fallback, min, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function shellCommandPreview(parts) {
  return parts.map((part) => {
    const text = String(part);
    if (/^[A-Za-z0-9_./:@=+-]+$/.test(text)) return text;
    return `'${text.replace(/'/g, "'\\''")}'`;
  }).join(' ');
}

function redactForLog(value) {
  return String(value)
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_SECRET]')
    .replace(/\b(?:sk-ant-[A-Za-z0-9_-]{10,}|gh[opsru]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9_-]{20,})\b/g, '[REDACTED_SECRET]')
    .replace(/\b(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED_SECRET]')
    .replace(/([?&](?:codexpro_token|token|access_token|auth_token|api[_-]?key)=)[^&\s"'`<>]{8,}/gi, '$1[REDACTED_SECRET]')
    .replace(/(["']?[A-Za-z0-9_]{0,64}(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Za-z0-9_]{0,64}["']?\s*:\s*)(?:"[^"\r\n]{12,512}"|'[^'\r\n]{12,512}'|`[^`\r\n]{12,512}`|[A-Za-z0-9_./+=-]{20,512})/gi, '$1[REDACTED_SECRET]')
    .replace(/\b[A-Za-z0-9_]{0,64}(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Za-z0-9_]{0,64}\s*=\s*(?:"[^"\r\n]{12,512}"|'[^'\r\n]{12,512}'|`[^`\r\n]{12,512}`|[A-Za-z0-9_./+=-]{20,512})/gi, (match) => {
      const index = match.indexOf('=');
      return index < 0 ? '[REDACTED_SECRET]' : `${match.slice(0, index).trimEnd()}= [REDACTED_SECRET]`;
    });
}

function redactEnvObject(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)/i.test(key)
      ? '<redacted>'
      : redactForLog(String(value));
  }
  return out;
}

function quoteWindowsCmdArg(value) {
  const text = String(value).replace(/\r?\n/g, ' ').replace(/%/g, '%%');
  if (!text) return '""';
  return `"${text.replace(/"/g, '""')}"`;
}

function processInvocation(command, args) {
  if (!isWindowsBatchFile(command)) return { command, args };
  const commandLine = `"${[quoteWindowsCmdArg(command), ...args.map(quoteWindowsCmdArg)].join(' ')}"`;
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/q', '/v:off', '/s', '/c', commandLine],
    windowsVerbatimArguments: true,
    killTree: true
  };
}

function spawnSyncPortable(command, args, options = {}) {
  const invocation = processInvocation(command, args);
  return spawnSync(invocation.command, invocation.args, {
    ...options,
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    ...(process.platform === 'win32' ? { windowsHide: true } : {})
  });
}

function createConnectorDetails(endpoint, token, localBase = '') {
  const serverUrl = endpointWithToken(endpoint, token);
  return {
    endpoint,
    token,
    serverUrl,
    localStatusUrl: localBase ? endpointWithToken(`${localBase}/`, token) : '',
    chatgptSettingsUrl: 'https://chatgpt.com/#settings/Connectors'
  };
}

function printCreateAppFields(details) {
  console.log('Create App fields:');
  console.log('');
  console.log('  Name: CodexPro');
  console.log('  Description: Local coding workspace bridge for ChatGPT.');
  console.log('  Connection: Server URL');
  console.log(`  Server URL: ${details.serverUrl}`);
  console.log('  Authentication: No Authentication / None');
  console.log('');
  if (details.token) {
    console.log('If your ChatGPT UI supports custom headers instead, you can use:');
    console.log('');
    console.log(`  Authorization: Bearer ${details.token}`);
  } else {
    console.log('Authorization: disabled');
  }
}

function printConnectorBlock(endpoint, token, options = {}) {
  const details = createConnectorDetails(endpoint, token, options.localBase ?? '');
  const { serverUrl } = details;
  const publicHttps = serverUrl.startsWith('https://');
  const shouldCopy = !options.headless && (options.copyUrl === true || (options.copyUrl !== false && publicHttps));
  const copied = shouldCopy ? copyToClipboard(serverUrl) : { ok: false, command: '' };
  const opened = !options.headless && options.openChatgpt ? openUrl(details.chatgptSettingsUrl) : false;

  const mode = options.mode ?? 'agent';
  const modeTitle = mode === 'agent' ? 'Agent' : mode === 'handoff' ? 'Handoff' : 'Pro planning';
  console.log('');
  console.log(paint('bold', 'CodexPro ready'));
  if (options.root) console.log(`  Workspace  ${options.root}`);
  console.log(`  Mode       ${modeTitle}  tools=${options.toolMode ?? 'standard'}  write=${options.write ?? 'workspace'}  bash=${options.bash ?? 'safe'}`);
  console.log(`  Transcript bash=${options.bashTranscript ?? 'compact'}`);
  if (options.codexSessions && options.codexSessions !== 'off') console.log(`  Codex      sessions=${options.codexSessions}`);
  if (options.bashSession) console.log(`  Bash       session=${options.bashSession}${options.requireBashSession ? ' required' : ''}`);
  console.log(`  Connector  ${publicHttps ? 'public HTTPS' : 'local HTTP'}`);
  if (copied.ok) {
    console.log(`  URL        copied with ${copied.command}`);
    console.log(`  Server URL ${serverUrl}`);
  } else if (shouldCopy) {
    console.log('  URL        copy failed; copy manually:');
    console.log(serverUrl);
  } else if (options.copyUrl === false && publicHttps) {
    console.log('  URL        not copied; press c to copy or u to show');
  } else if (!publicHttps) {
    console.log('  URL        local HTTP only');
    console.log(serverUrl);
  }
  if (options.openChatgpt && !options.headless) {
    statusLine(opened ? 'ok' : 'warn', opened ? 'Opened ChatGPT connector settings' : 'Could not open ChatGPT automatically');
  }
  console.log('');
  if (options.connectionTest) {
    console.log(paint('bold', 'Connection test'));
    console.log('  1. In ChatGPT, open Settings -> Plugins and create a development plugin.');
    console.log('  2. Paste the Server URL above and choose Authentication: No Authentication.');
    console.log('  3. Watch this terminal for: [CodexPro] POST /mcp received');
    console.log('');
    console.log('  No POST /mcp     ChatGPT or the tunnel did not reach CodexPro.');
    console.log('  POST /mcp -> 401 The full Server URL, including codexpro_token, was not used.');
    console.log('  POST /mcp -> 2xx The MCP connection reached CodexPro successfully.');
    console.log('');
  }
  if (options.headless) {
    console.log(`CODEXPRO_READY ${serverUrl}`);
  } else {
    console.log('Next: press Enter to open ChatGPT, paste the copied Server URL, choose Authentication: None.');
    console.log('Keys: Enter open | c copy | o status | h help | q quit');
  }
  return { ...details, copied, opened, mode, toolMode: options.toolMode ?? 'standard' };
}

function printControlHelp() {
  console.log('');
  console.log('Controls');
  console.log('  Enter  open ChatGPT connector settings in your browser');
  console.log('  c      copy Server URL again');
  console.log('  u      print Server URL only');
  console.log('  o      open local setup/status page');
  console.log('  p      print Create App fields');
  console.log('  m      print mode help');
  console.log('  h      show controls');
  console.log('  q      stop CodexPro');
  console.log('');
}

function printModeHelp() {
  console.log('');
  console.log('Modes');
  console.log('  codexpro start                 agent mode: read/write/edit/apply_patch/search/bash');
  console.log('  codexpro start --no-bash       agent mode without ChatGPT-triggered shell commands');
  console.log('  codexpro start --bash-session main --require-bash-session');
  console.log('  codexpro start --mode handoff  planning-only .ai-bridge handoff');
  console.log('  codexpro start --mode pro      export context for models without MCP tools');
  console.log('  codexpro start --tool-mode minimal   expose only the tight coding loop');
  console.log('  codexpro start --tool-mode full      expose every advanced compatibility tool');
  console.log('');
}

function printStableUrlHelp() {
  console.log('');
  console.log('Stable URL setup');
  console.log('');
  console.log('Quick tunnels change every restart. ChatGPT apps should use a stable URL.');
  console.log('');
  console.log('One-time Cloudflare setup with your domain:');
  console.log('  codexpro install-cloudflared');
  console.log('  ~/.codexpro/bin/cloudflared tunnel login');
  console.log('  ~/.codexpro/bin/cloudflared tunnel create codexpro');
  console.log('  ~/.codexpro/bin/cloudflared tunnel route dns codexpro codexpro.example.com');
  console.log('');
  console.log('Daily start:');
  console.log('  codexpro stable --hostname codexpro.example.com --tunnel-name codexpro --token keep-this-stable-token');
  console.log('');
  console.log('Ngrok alternative with a reserved domain:');
  console.log('  ngrok config add-authtoken <your-ngrok-token>');
  console.log('  codexpro ngrok --hostname your-domain.ngrok-free.dev --token keep-this-stable-token');
  console.log('');
  console.log('Tailscale Funnel alternative:');
  console.log('  tailscale funnel 8787');
  console.log('  codexpro tailscale --hostname your-device.your-tailnet.ts.net --token keep-this-stable-token');
  console.log('');
}

function compareMajorVersion(version, minimumMajor) {
  const major = Number(String(version).split('.')[0]);
  return Number.isFinite(major) && major >= minimumMajor;
}

function browserOpenCommand() {
  if (process.platform === 'darwin') return commandExists('open') ? 'open' : '';
  if (process.platform === 'win32') return 'cmd start';
  return commandExists('xdg-open') ? 'xdg-open' : '';
}

function clipboardCommand() {
  if (process.platform === 'darwin') return commandExists('pbcopy') ? 'pbcopy' : '';
  if (process.platform === 'win32') return 'clip';
  for (const command of ['wl-copy', 'xclip', 'xsel']) {
    if (commandExists(command)) return command;
  }
  return '';
}

function localOrPathCommand(command, localPath) {
  if (command && commandAvailable(command)) return command;
  if (localPath && executableFileExists(localPath)) return localPath;
  return '';
}

function doctorLine(status, label, detail = '') {
  const marker = status === 'ok' ? paint('green', 'OK') : status === 'warn' ? paint('yellow', 'WARN') : paint('red', 'FAIL');
  console.log(`${marker} ${label.padEnd(18)} ${detail}`);
}

async function runDoctor(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return;
  }

  const root = realDir(args.root ?? process.env.CODEXPRO_ROOT ?? process.cwd());
  const profile = args.noProfile ? {} : loadWorkspaceProfile(root);
  const effectiveArgs = { ...profile, ...args };
  const tunnel = optionValue(args, profile, 'tunnel', ['CODEXPRO_TUNNEL'], 'cloudflare');
  const host = optionValue(args, profile, 'host', ['CODEXPRO_HOST'], '127.0.0.1');
  const port = String(optionValue(args, profile, 'port', ['CODEXPRO_PORT'], '8787'));
  const mode = optionValue(args, profile, 'mode', ['CODEXPRO_MODE'], 'agent');
  const bash = optionValue(args, profile, 'bash', ['CODEXPRO_BASH_MODE'], 'safe');
  const rawWrite = optionValue(args, profile, 'write', ['CODEXPRO_WRITE_MODE'], mode === 'agent' ? 'workspace' : 'handoff');
  let write = String(rawWrite);
  let writeError = '';
  try {
    write = effectiveWriteMode(mode, rawWrite);
  } catch (error) {
    writeError = error instanceof Error ? error.message : String(error);
  }
  const toolMode = optionValue(args, profile, 'toolMode', ['CODEXPRO_TOOL_MODE'], 'standard');
  const stableHostname = args.hostname
    ?? args.url
    ?? process.env.CODEXPRO_PUBLIC_HOSTNAME
    ?? process.env.CODEXPRO_HOSTNAME
    ?? process.env.NGROK_DOMAIN
    ?? profile.hostname
    ?? '';
  const httpPath = path.join(projectRoot, 'dist', 'http.js');
  const serverPath = path.join(projectRoot, 'dist', 'server.js');
  const cloudflaredPath = localOrPathCommand(
    effectiveArgs.cloudflared ?? process.env.CLOUDFLARED_BIN ?? 'cloudflared',
    localCloudflaredPath()
  );
  const ngrokPath = localOrPathCommand(effectiveArgs.ngrok ?? process.env.NGROK_BIN ?? 'ngrok', '');
  const tailscalePath = localOrPathCommand(effectiveArgs.tailscale ?? process.env.TAILSCALE_BIN ?? 'tailscale', '');
  const clipboard = clipboardCommand();
  const browser = browserOpenCommand();
  const opencodeCommand = resolveAgentCommand('opencode');
  const piCommand = resolveAgentCommand('pi');
  const codexCommand = resolveCodexCommand();
  const checks = [];

  function record(status, label, detail) {
    checks.push(status);
    doctorLine(status, label, detail);
  }

  console.log('');
  printBox('CodexPro doctor', [
    labelValue('Workspace', root),
    labelValue('Mode', `${mode}  tools=${toolMode}  write=${write}  bash=${bash}`),
    labelValue('Tunnel', tunnel),
    ...(stableHostname ? [labelValue('Hostname', stableHostname)] : []),
    ...(profile.profilePath ? [labelValue('Profile', profile.profilePath)] : [])
  ]);

  record(compareMajorVersion(process.versions.node, 20) ? 'ok' : 'fail', 'Node', `v${process.versions.node} (requires >=20)`);
  record(fs.existsSync(httpPath) && fs.existsSync(serverPath) ? 'ok' : 'fail', 'Build artifacts', fs.existsSync(httpPath) ? 'dist ready' : 'missing dist/http.js; run npm install && npm run build');
  record(fs.existsSync(path.join(projectRoot, 'package.json')) ? 'ok' : 'fail', 'Package root', projectRoot);
  record(profile.profilePath ? 'ok' : 'warn', 'Saved profile', profile.profilePath ? profileSummary(profile) || profile.profilePath : 'none for this workspace');
  record(['agent', 'handoff', 'pro'].includes(mode) ? 'ok' : 'fail', 'Mode', ['agent', 'handoff', 'pro'].includes(mode) ? mode : '--mode must be agent, handoff, or pro');
  record(['off', 'safe', 'full'].includes(bash) ? 'ok' : 'fail', 'Bash mode', ['off', 'safe', 'full'].includes(bash) ? bash : '--bash must be off, safe, or full');
  record(!writeError && ['off', 'handoff', 'workspace'].includes(write) ? 'ok' : 'fail', 'Write mode', writeError || write);
  record(['minimal', 'standard', 'full'].includes(toolMode) ? 'ok' : 'fail', 'Tool mode', ['minimal', 'standard', 'full'].includes(toolMode) ? toolMode : '--tool-mode must be minimal, standard, or full');
  record(clipboard ? 'ok' : 'warn', 'Clipboard', clipboard || 'not found; URL will be printed for manual copy');
  record(browser ? 'ok' : 'warn', 'Browser open', browser || 'not found; open ChatGPT manually');
  const openCodeAvailable = commandAvailableFromRoot(opencodeCommand, root);
  record(openCodeAvailable ? 'ok' : 'warn', 'OpenCode agent', openCodeAvailable ? opencodeCommand : 'not found; install opencode-ai to use --agent opencode');
  record(commandAvailableFromRoot(piCommand, root) ? 'ok' : 'warn', 'Pi agent', commandAvailableFromRoot(piCommand, root) ? piCommand : 'not found; install @mariozechner/pi-coding-agent to use --agent pi');
  record(commandAvailableFromRoot(codexCommand, root) ? 'ok' : 'warn', 'Codex agent', commandAvailableFromRoot(codexCommand, root) ? codexCommand : 'not found; install Codex CLI to use --agent codex');

  if (openCodeAvailable) {
    const openCodeConfigDir = path.join(projectRoot, '.opencode');
    const capability = inspectOpenCodeRuntime(opencodeCommand, root, openCodeConfigDir);
    record(capability.ready ? 'ok' : 'warn', 'OC subagents', capability.ready
      ? `${CODEXPRO_ORCHESTRATOR_AGENT} -> ${CODEXPRO_EXPLORE_AGENT}`
      : capability.reasons.join('; '));
    record(capability.subagentDepth >= 1 ? 'ok' : 'warn', 'OC child depth', `subagent_depth=${capability.subagentDepth}`);
    record('ok', 'OC handoff cap', `max_subagents=${numberOption(args.maxSubagents ?? process.env.CODEXPRO_MAX_SUBAGENTS ?? managerMaxSubagentsSetting(), managerMaxSubagentsSetting(), 1, 1)} (Manager setting)`);
    record(capability.taskPermission === 'allow' ? 'ok' : 'warn', 'OC Task access', `${CODEXPRO_EXPLORE_AGENT}: ${capability.taskPermission || 'not allowed'}`);
    record(capability.explorerEdit === 'deny' && capability.explorerBash === 'deny' && capability.explorerTask === 'deny' ? 'ok' : 'warn', 'OC child safety', `edit=${capability.explorerEdit || '?'} bash=${capability.explorerBash || '?'} task=${capability.explorerTask || '?'}`);

    const auditorCapability = inspectCodexProAuditorCapability(opencodeCommand, root, openCodeConfigDir);
    record(auditorCapability.ready ? 'ok' : 'warn', 'OC native audit', auditorCapability.ready ? CODEXPRO_AUDITOR_AGENT : auditorCapability.reason);

    const scoutCapability = inspectOpenCodeRuntime(opencodeCommand, root, openCodeConfigDir, { inspector: inspectOpenCodeScoutCapability });
    record(scoutCapability.ready ? 'ok' : 'warn', 'OC Gemini scout', scoutCapability.ready
      ? `${CODEXPRO_SCOUT_ORCHESTRATOR_AGENT} -> ${GEMINI_SCOUT_AGENT}`
      : scoutCapability.reasons.join('; '));
    record(
      scoutCapability.childPermissions?.read === 'deny' &&
      scoutCapability.childPermissions?.bash === 'deny' &&
      scoutCapability.childPermissions?.task === 'deny' &&
      scoutCapability.childPermissions?.webfetch === 'allow' &&
      scoutCapability.childPermissions?.websearch === 'allow'
        ? 'ok'
        : 'warn',
      'OC scout safety',
      `read=${scoutCapability.childPermissions?.read || '?'} bash=${scoutCapability.childPermissions?.bash || '?'} task=${scoutCapability.childPermissions?.task || '?'} webfetch=${scoutCapability.childPermissions?.webfetch || '?'} websearch=${scoutCapability.childPermissions?.websearch || '?'}`
    );
    const scoutAvailability = inspectGeminiScoutAvailability(opencodeCommand, root, openCodeConfigDir);
    record(scoutAvailability.ready ? 'ok' : 'warn', 'OC scout candidate', scoutAvailability.ready
      ? `${scoutAvailability.selectedModel} (catalog + credential; use --live-scout-check for end-to-end verification)`
      : scoutAvailability.reason);

    const selectedModel = String(args.model ?? capability.model ?? '').trim();
    const modelList = spawnSyncPortable(opencodeCommand, ['models'], { cwd: root, encoding: 'utf8', maxBuffer: 2_000_000, env: { ...process.env, NO_COLOR: '1' } });
    const modelListed = Boolean(selectedModel && modelList.status === 0 && String(modelList.stdout || '').split(/\r?\n/).some((line) => line.trim() === selectedModel));
    record(modelListed ? 'ok' : 'warn', 'OC model', selectedModel ? `${selectedModel}${modelListed ? '' : ' (not found in model catalog)'}` : 'no model selected or configured');

    const provider = selectedModel.includes('/') ? selectedModel.split('/')[0] : '';
    const authList = spawnSyncPortable(opencodeCommand, ['auth', 'list'], { cwd: root, encoding: 'utf8', maxBuffer: 200_000, env: { ...process.env, NO_COLOR: '1' } });
    const authText = String(authList.stdout || '');
    const providerCredentialVisible = provider === 'opencode' || Boolean(provider && authList.status === 0 && authText.toLowerCase().includes(provider.toLowerCase()));
    record(providerCredentialVisible ? 'ok' : 'warn', 'OC provider auth', provider ? (providerCredentialVisible ? `${provider}${provider === 'opencode' ? ' built-in' : ' credential visible'}` : `${provider}: no saved credential visible`) : 'provider unknown');

    if (args.liveAgentCheck) {
      const probe = await runOpenCodeModelProbe({ command: opencodeCommand, root, configDir: openCodeConfigDir, model: selectedModel });
      record(probe.ok ? 'ok' : 'fail', 'OC live model', probe.ok ? `${selectedModel || 'default'} responded in ${probe.durationMs} ms` : probe.reason);
    } else {
      record('warn', 'OC live model', 'not called; use --live-agent-check to verify provider/model end-to-end');
    }

    if (args.liveSubagentCheck) {
      const liveSubagent = await runVerifiedOpenCodeInvestigation({
        command: opencodeCommand,
        root,
        configDir: openCodeConfigDir,
        model: selectedModel,
        planText: 'Read package.json and report the exact package name plus the file path used as evidence. Do not modify anything.',
        timeoutMs: 120_000,
        maxOutputBytes: 120_000
      });
      record(liveSubagent.verified ? 'ok' : 'fail', 'OC live child', liveSubagent.verified ? `${liveSubagent.childSessionId}; files=${liveSubagent.filesInspected.join(', ') || '(none reported)'}` : liveSubagent.fallbackReason);
    } else {
      record('warn', 'OC live child', 'not called; use --live-subagent-check to require a real Task child session');
    }

    if (args.liveScoutCheck) {
      const liveScout = await runVerifiedGeminiScout({
        command: opencodeCommand,
        root,
        configDir: openCodeConfigDir,
        model: selectedModel,
        planText: 'Verify from official OpenCode documentation how subagent_depth controls child-agent nesting and report the source URL. This is an external documentation verification task; do not inspect workspace files.',
        timeoutMs: 90_000,
        probeTimeoutMs: 12_000,
        maxOutputBytes: 120_000
      });
      record(liveScout.verified ? 'ok' : 'fail', 'OC live scout', liveScout.verified
        ? `${liveScout.childSessionId}; model=${liveScout.childModel}; tools=${liveScout.childToolNames.join(', ') || '(none)'}`
        : liveScout.fallbackReason);
    }
  }

  try {
    await assertPortAvailable(host, port);
    record('ok', 'Local port', `${host}:${port} available`);
  } catch (error) {
    record('fail', 'Local port', error instanceof Error ? error.message.split('\n')[0] : String(error));
  }

  if (tunnel === 'none') {
    record('ok', 'Tunnel', 'local-only mode');
  } else if (tunnel === 'cloudflare') {
    record(cloudflaredPath ? 'ok' : 'warn', 'cloudflared', cloudflaredPath || 'missing now; codexpro start can auto-install unless --no-install-cloudflared is used');
  } else if (tunnel === 'cloudflare-named') {
    record(stableHostname ? 'ok' : 'fail', 'Hostname', stableHostname || 'required for Cloudflare stable mode');
    record(cloudflaredPath ? 'ok' : 'warn', 'cloudflared', cloudflaredPath || 'missing now; run codexpro install-cloudflared or pass --cloudflared');
    record(
      optionValue(args, profile, 'tunnelName', ['CLOUDFLARE_TUNNEL_NAME', 'CODEXPRO_TUNNEL_NAME'], '') ||
        optionValue(args, profile, 'cloudflareTokenFile', ['CLOUDFLARE_TUNNEL_TOKEN_FILE', 'CODEXPRO_CLOUDFLARE_TUNNEL_TOKEN_FILE'], '') ||
        optionValue(args, profile, 'cloudflareConfig', ['CLOUDFLARE_TUNNEL_CONFIG', 'CODEXPRO_CLOUDFLARE_CONFIG'], '') ||
        optionValue(args, profile, 'cloudflareToken', ['CLOUDFLARE_TUNNEL_TOKEN', 'CODEXPRO_CLOUDFLARE_TUNNEL_TOKEN'], '')
        ? 'ok'
        : 'fail',
      'Cloudflare setup',
      'needs tunnel name, config, token file, or tunnel token'
    );
  } else if (tunnel === 'ngrok') {
    record(stableHostname ? 'ok' : 'fail', 'Hostname', stableHostname || 'required for ngrok mode');
    record(ngrokPath ? 'ok' : 'fail', 'ngrok', ngrokPath || 'not found on PATH; install ngrok and run ngrok config add-authtoken <token>');
  } else if (tunnel === 'tailscale') {
    record(stableHostname ? 'ok' : 'fail', 'Hostname', stableHostname || 'required for Tailscale Funnel mode');
    record(tailscalePath ? 'ok' : 'fail', 'tailscale', tailscalePath || 'not found on PATH; install Tailscale and enable Funnel');
  } else {
    record('fail', 'Tunnel', `unknown tunnel mode: ${tunnel}`);
  }

  const failures = checks.filter((status) => status === 'fail').length;
  const warnings = checks.filter((status) => status === 'warn').length;
  console.log('');
  if (failures) {
    statusLine('warn', `${failures} blocker${failures === 1 ? '' : 's'} and ${warnings} warning${warnings === 1 ? '' : 's'} found.`);
    process.exitCode = 1;
    return;
  }
  statusLine('ok', warnings ? `Ready with ${warnings} warning${warnings === 1 ? '' : 's'}.` : 'Ready.');
}

function normalizeSetupChoice(value, allowed, fallback) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  const match = allowed.find((item) => item === normalized || item.startsWith(normalized));
  return match ?? fallback;
}

async function ask(rl, question, fallback = '') {
  const suffix = fallback ? ` ${paint('dim', `[${fallback}]`)}` : '';
  const hint = fallback ? `${paint('dim', '> Enter to proceed with default')}\n` : '';
  const answer = await rl.question(`${paint('cyan', '?')} ${question}${suffix}\n${hint}> `);
  return answer.trim() || fallback;
}

function tunnelChoiceFromProfile(profile, fallback = 'cloudflare') {
  if (profile?.tunnel === 'ngrok') return 'ngrok';
  if (profile?.tunnel === 'cloudflare-named') return 'stable';
  if (profile?.tunnel === 'tailscale') return 'tailscale';
  if (profile?.tunnel === 'none') return 'local';
  if (profile?.tunnel === 'cloudflare') return 'cloudflare';
  return fallback;
}

function tunnelModeFromChoice(choice) {
  if (choice === 'quick' || choice === 'cloudflare') return 'cloudflare';
  if (choice === 'stable') return 'cloudflare-named';
  if (choice === 'tailscale') return 'tailscale';
  if (choice === 'local') return 'none';
  return choice;
}

function hasExplicitTunnelInput(args) {
  return Boolean(
    args.tunnel ||
    args.noProfile ||
    process.env.CODEXPRO_TUNNEL
  );
}

async function collectTunnelPreference(rl, defaults, profile, options = {}) {
  const defaultTunnel = options.defaultTunnel ?? tunnelChoiceFromProfile(profile, 'cloudflare');
  const tunnelAnswer = await ask(rl, 'Tunnel: cloudflare, ngrok, tailscale, stable, or local?', defaultTunnel);
  const tunnelChoice = normalizeSetupChoice(tunnelAnswer, ['cloudflare', 'quick', 'ngrok', 'tailscale', 'stable', 'local'], defaultTunnel);
  const tunnel = tunnelModeFromChoice(tunnelChoice);
  let hostname = '';
  let tunnelName = '';
  let ngrokConfig = '';
  let cloudflareConfig = '';
  let cloudflareTokenFile = '';

  if (tunnel === 'ngrok') {
    hostname = await ask(
      rl,
      'Ngrok domain or URL, without /mcp',
      optionValue(defaults, profile, 'hostname', ['CODEXPRO_PUBLIC_HOSTNAME', 'CODEXPRO_HOSTNAME', 'NGROK_DOMAIN'], '')
    );
    if (!hostname) throw new Error('Ngrok setup needs your reserved domain, for example name.ngrok-free.dev.');
    hostname = normalizePublicHostname(hostname);
    ngrokConfig = optionValue(defaults, profile, 'ngrokConfig', ['NGROK_CONFIG', 'CODEXPRO_NGROK_CONFIG'], '');
  } else if (tunnel === 'cloudflare-named') {
    hostname = await ask(
      rl,
      'Stable Cloudflare hostname, without /mcp',
      optionValue(defaults, profile, 'hostname', ['CODEXPRO_PUBLIC_HOSTNAME', 'CODEXPRO_HOSTNAME'], '')
    );
    if (!hostname) throw new Error('Stable public URL setup needs a real hostname, for example codexpro.yourdomain.com.');
    hostname = normalizePublicHostname(hostname);
    tunnelName = await ask(rl, 'Cloudflare tunnel name', optionValue(defaults, profile, 'tunnelName', ['CODEXPRO_TUNNEL_NAME', 'CLOUDFLARE_TUNNEL_NAME'], 'codexpro'));
    cloudflareConfig = optionValue(defaults, profile, 'cloudflareConfig', ['CODEXPRO_CLOUDFLARE_CONFIG', 'CLOUDFLARE_TUNNEL_CONFIG'], '');
    cloudflareTokenFile = optionValue(defaults, profile, 'cloudflareTokenFile', ['CODEXPRO_CLOUDFLARE_TUNNEL_TOKEN_FILE', 'CLOUDFLARE_TUNNEL_TOKEN_FILE'], '');
  } else if (tunnel === 'tailscale') {
    hostname = await ask(
      rl,
      'Tailscale Funnel hostname, without /mcp',
      optionValue(defaults, profile, 'hostname', ['CODEXPRO_PUBLIC_HOSTNAME', 'CODEXPRO_HOSTNAME', 'TAILSCALE_FUNNEL_HOSTNAME'], '')
    );
    if (!hostname) throw new Error('Tailscale setup needs your Funnel hostname, for example machine.tailnet.ts.net.');
    hostname = normalizePublicHostname(hostname);
  }

  return {
    tunnel,
    hostname,
    tunnelName,
    ngrokConfig,
    cloudflareConfig,
    cloudflareTokenFile
  };
}

function applyTunnelPreferenceToArgs(args, preference) {
  args.tunnel = preference.tunnel;
  if (preference.hostname) args.hostname = preference.hostname;
  if (preference.tunnelName) args.tunnelName = preference.tunnelName;
  if (preference.ngrokConfig) args.ngrokConfig = preference.ngrokConfig;
  if (preference.cloudflareConfig) args.cloudflareConfig = preference.cloudflareConfig;
  if (preference.cloudflareTokenFile) args.cloudflareTokenFile = preference.cloudflareTokenFile;
}

function profileFromPreference(root, args, profile, preference) {
  const mode = optionValue(args, profile, 'mode', ['CODEXPRO_MODE'], 'agent');
  const port = String(optionValue(args, profile, 'port', ['CODEXPRO_PORT'], '8787'));
  const bash = optionValue(args, profile, 'bash', ['CODEXPRO_BASH_MODE'], '');
  const bashTranscript = bashTranscriptOption(args, profile);
  const codexSessions = codexSessionsOption(args, profile);
  const codexDir = optionValue(args, profile, 'codexDir', ['CODEXPRO_CODEX_DIR'], '');
  const { bashSession, requireBashSession } = bashSessionOptions(args, profile);
  const write = optionalWriteOption(args, profile, mode);
  const toolMode = optionValue(args, profile, 'toolMode', ['CODEXPRO_TOOL_MODE'], '');
  const widgetDomain = optionValue(args, profile, 'widgetDomain', ['CODEXPRO_WIDGET_DOMAIN'], '');
  const existingToken = optionValue(args, profile, 'token', ['CODEXPRO_HTTP_TOKEN', 'CODEBASE_BRIDGE_HTTP_TOKEN'], '');
  const token = preference.tunnel === 'none' ? existingToken : stableToken(existingToken);
  const allowedRoots = configuredProjectRoots(root, args, profile);
  return {
    port,
    mode,
    tunnel: preference.tunnel,
    ...(preference.hostname ? { hostname: preference.hostname } : {}),
    ...(preference.tunnelName ? { tunnelName: preference.tunnelName } : {}),
    ...(preference.ngrokConfig ? { ngrokConfig: preference.ngrokConfig } : {}),
    ...(preference.cloudflareConfig ? { cloudflareConfig: preference.cloudflareConfig } : {}),
    ...(preference.cloudflareTokenFile ? { cloudflareTokenFile: preference.cloudflareTokenFile } : {}),
    ...(token ? { token } : {}),
    ...(bash ? { bash } : {}),
    ...(bashTranscript !== 'compact' ? { bashTranscript } : {}),
    ...(codexSessions !== 'off' ? { codexSessions } : {}),
    ...(codexDir ? { codexDir } : {}),
    ...(bashSession ? { bashSession } : {}),
    ...(requireBashSession ? { requireBashSession: true } : {}),
    ...(write ? { write } : {}),
    ...(toolMode ? { toolMode } : {}),
    ...(widgetDomain ? { widgetDomain } : {}),
    ...toolCardsProfileEntry(args, profile),
    ...(allowedRoots.length ? { allowedRoots } : {}),
    ...(args.noInstallCloudflared ? { noInstallCloudflared: true } : {}),
    root
  };
}

async function maybeConfigureFirstRun(root, args, profile) {
  if (profile.profilePath || args.headless || !process.stdin.isTTY || !process.stdout.isTTY || process.env.CI || hasExplicitTunnelInput(args)) {
    return profile;
  }

  const reusableProfiles = listWorkspaceProfiles().filter((item) => item.root !== root);
  if (reusableProfiles.length) {
    const shown = reusableProfiles.slice(0, 9);
    printBox('Saved setups', [
      'No saved settings exist for this workspace, but CodexPro found saved setups from other workspaces.',
      ...shown.map((item, index) => profileOneLine(item, index + 1)),
      'Use a number to reuse one here, or type new to choose a fresh tunnel.'
    ]);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await ask(rl, 'Use saved setup number, or new?', shown.length === 1 ? '1' : 'new');
      const normalized = answer.trim().toLowerCase();
      const selectedIndex = Number(normalized);
      if (Number.isInteger(selectedIndex) && selectedIndex >= 1 && selectedIndex <= shown.length) {
        const selected = shown[selectedIndex - 1];
        const payload = reusableProfilePayload(selected, {
          port: String(optionValue(args, selected, 'port', ['CODEXPRO_PORT'], selected.port ?? '8787')),
          mode: optionValue(args, selected, 'mode', ['CODEXPRO_MODE'], selected.mode ?? 'agent')
        });
        const savedPath = saveWorkspaceProfile(root, payload);
        statusLine('ok', `Saved workspace settings from ${selected.root}: ${savedPath}`);
        return loadWorkspaceProfile(root);
      }
    } finally {
      rl.close();
    }
  }

  printBox('First run setup', [
    'No saved tunnel preference exists for this workspace.',
    'Choose once now. CodexPro will reuse this choice on future codexpro start runs until you change or delete it with codexpro settings.'
  ]);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const preference = await collectTunnelPreference(rl, args, profile, { defaultTunnel: 'cloudflare' });
    applyTunnelPreferenceToArgs(args, preference);
    const saveAnswer = await ask(rl, 'Save this as the default for this workspace?', 'yes');
    if (!['n', 'no'].includes(saveAnswer.trim().toLowerCase())) {
      const savedPath = saveWorkspaceProfile(root, profileFromPreference(root, args, profile, preference));
      statusLine('ok', `Saved workspace settings: ${savedPath}`);
      return loadWorkspaceProfile(root);
    }
    return profileFromPreference(root, args, profile, preference);
  } finally {
    rl.close();
  }
}

function commandPreview(args) {
  return shellCommandPreview(['codexpro', ...args]);
}

async function runSetupWizard(argv) {
  if (!process.stdin.isTTY) {
    throw new Error('codexpro setup needs an interactive terminal. Use codexpro start --root /path/to/repo for non-interactive scripts.');
  }
  const defaults = parseArgs(argv);
  const defaultRoot = path.resolve(expandHome(defaults.root ?? process.env.CODEXPRO_ROOT ?? process.cwd()));

  printBox('CodexPro setup', [
    'This wizard prepares a ChatGPT connector for the folder you choose.',
    'Press Enter to accept defaults. Stable tunnel choices are saved per workspace under ~/.codexpro.'
  ]);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const rootInput = await ask(rl, 'Where is your project located?', defaultRoot);
    const root = realDir(rootInput);
    const profile = defaults.noProfile ? {} : loadWorkspaceProfile(root);
    if (profile.profilePath) {
      statusLine('ok', `Loaded saved profile: ${profile.profilePath}`);
      printSavedProfileHint(profile);
    }

    const savedTunnel = optionValue(defaults, profile, 'tunnel', ['CODEXPRO_TUNNEL'], 'cloudflare');
  const defaultTunnel = savedTunnel === 'cloudflare-named'
      ? 'stable'
      : savedTunnel === 'ngrok'
        ? 'ngrok'
        : savedTunnel === 'tailscale'
          ? 'tailscale'
          : savedTunnel === 'none'
            ? 'local'
            : 'quick';
    const defaultPort = String(optionValue(defaults, profile, 'port', ['CODEXPRO_PORT'], '8787'));
    const defaultMode = normalizeSetupChoice(optionValue(defaults, profile, 'mode', ['CODEXPRO_MODE'], 'agent'), ['agent', 'handoff', 'pro'], 'agent');

    const port = normalizePort(await ask(rl, 'Which local port should CodexPro use?', defaultPort));
    const modeAnswer = await ask(rl, 'Mode: agent, handoff, or pro?', defaultMode);
    const mode = normalizeSetupChoice(modeAnswer, ['agent', 'handoff', 'pro'], defaultMode);

    printBox('Public URL', [
      'ChatGPT needs an HTTPS URL it can reach.',
      'quick  = CodexPro creates a Cloudflare quick tunnel for demos and local work.',
      'stable = use your own domain with a Cloudflare named tunnel so the ChatGPT app URL does not change.',
      'ngrok  = use your ngrok free dev domain, for example https://name.ngrok-free.dev.',
      'tailscale = use Tailscale Funnel, for example https://device.tailnet.ts.net.',
      'local  = no tunnel, only useful for local MCP clients that can reach 127.0.0.1.'
    ]);

    const tunnelAnswer = await ask(rl, 'Public access: quick, stable, ngrok, tailscale, or local?', defaultTunnel);
    const tunnelChoice = normalizeSetupChoice(tunnelAnswer, ['quick', 'stable', 'ngrok', 'tailscale', 'local'], defaultTunnel);
    const args = ['start', '--root', root, '--port', port, '--mode', mode];
    const bash = optionValue(defaults, profile, 'bash', ['CODEXPRO_BASH_MODE'], '');
    const bashTranscript = bashTranscriptOption(defaults, profile);
    const codexSessions = codexSessionsOption(defaults, profile);
    const codexDir = optionValue(defaults, profile, 'codexDir', ['CODEXPRO_CODEX_DIR'], '');
    const write = optionalWriteOption(defaults, profile, mode);
    const toolMode = optionalChoice('tool-mode', optionValue(defaults, profile, 'toolMode', ['CODEXPRO_TOOL_MODE'], ''), ['minimal', 'standard', 'full']);
    const widgetDomain = optionValue(defaults, profile, 'widgetDomain', ['CODEXPRO_WIDGET_DOMAIN'], '');
    const toolCardsEntry = toolCardsProfileEntry(defaults, profile);
    if (bash) args.push('--bash', bash);
    if (bashTranscript !== 'compact') args.push('--bash-transcript', bashTranscript);
    if (codexSessions !== 'off') args.push('--codex-sessions', codexSessions);
    if (codexDir) args.push('--codex-dir', codexDir);
    const { bashSession, requireBashSession } = bashSessionOptions(defaults, profile);
    if (bashSession) args.push('--bash-session', bashSession);
    if (requireBashSession) args.push('--require-bash-session');
    if (write) args.push('--write', write);
    if (toolMode) args.push('--tool-mode', toolMode);
    if (widgetDomain) args.push('--widget-domain', widgetDomain);
    args.push(...toolCardsCliArgs(defaults, profile));
    if (defaults.noInstallCloudflared) args.push('--no-install-cloudflared');
    if (defaults.openChatgpt) args.push('--open-chatgpt');
    if (defaults.noCopyUrl) args.push('--no-copy-url');

    let profileTunnel = 'cloudflare';
    let profileHostname = '';
    let profileTunnelName = '';
    let profileNgrokConfig = '';
    let profileCloudflareConfig = '';
    let profileCloudflareTokenFile = '';
    let profileToken = optionValue(defaults, profile, 'token', ['CODEXPRO_HTTP_TOKEN', 'CODEBASE_BRIDGE_HTTP_TOKEN'], '');

    if (tunnelChoice === 'local') {
      profileTunnel = 'none';
      args.push('--tunnel', 'none');
    } else if (tunnelChoice === 'stable') {
      profileTunnel = 'cloudflare-named';
      let hostname = await ask(
        rl,
        'Stable Cloudflare hostname, without /mcp',
        optionValue(defaults, profile, 'hostname', ['CODEXPRO_PUBLIC_HOSTNAME', 'CODEXPRO_HOSTNAME'], '')
      );
      if (!hostname) throw new Error('Stable public URL setup needs a real hostname, for example codexpro.yourdomain.com.');
      hostname = normalizePublicHostname(hostname);
      profileHostname = hostname;
      const tunnelName = await ask(rl, 'Cloudflare tunnel name', optionValue(defaults, profile, 'tunnelName', ['CODEXPRO_TUNNEL_NAME', 'CLOUDFLARE_TUNNEL_NAME'], 'codexpro'));
      profileTunnelName = tunnelName;
      args.push('--tunnel', 'cloudflare-named', '--hostname', hostname, '--tunnel-name', tunnelName);
      profileCloudflareConfig = optionValue(defaults, profile, 'cloudflareConfig', ['CODEXPRO_CLOUDFLARE_CONFIG', 'CLOUDFLARE_TUNNEL_CONFIG'], '');
      profileCloudflareTokenFile = optionValue(defaults, profile, 'cloudflareTokenFile', ['CODEXPRO_CLOUDFLARE_TUNNEL_TOKEN_FILE', 'CLOUDFLARE_TUNNEL_TOKEN_FILE'], '');
      if (profileCloudflareConfig) args.push('--cloudflare-config', profileCloudflareConfig);
      if (profileCloudflareTokenFile) args.push('--cloudflare-token-file', profileCloudflareTokenFile);
    } else if (tunnelChoice === 'ngrok') {
      profileTunnel = 'ngrok';
      let hostname = await ask(
        rl,
        'Ngrok domain or URL, without /mcp',
        optionValue(defaults, profile, 'hostname', ['CODEXPRO_PUBLIC_HOSTNAME', 'CODEXPRO_HOSTNAME', 'NGROK_DOMAIN'], '')
      );
      if (!hostname) throw new Error('Ngrok setup needs your reserved domain, for example name.ngrok-free.dev.');
      hostname = normalizePublicHostname(hostname);
      profileHostname = hostname;
      args.push('--tunnel', 'ngrok', '--hostname', hostname);
      const ngrokConfig = optionValue(defaults, profile, 'ngrokConfig', ['NGROK_CONFIG', 'CODEXPRO_NGROK_CONFIG'], '');
      if (ngrokConfig) {
        profileNgrokConfig = ngrokConfig;
        args.push('--ngrok-config', ngrokConfig);
      }
    } else if (tunnelChoice === 'tailscale') {
      profileTunnel = 'tailscale';
      let hostname = await ask(
        rl,
        'Tailscale Funnel hostname, without /mcp',
        optionValue(defaults, profile, 'hostname', ['CODEXPRO_PUBLIC_HOSTNAME', 'CODEXPRO_HOSTNAME', 'TAILSCALE_FUNNEL_HOSTNAME'], '')
      );
      if (!hostname) throw new Error('Tailscale setup needs your Funnel hostname, for example machine.tailnet.ts.net.');
      hostname = normalizePublicHostname(hostname);
      profileHostname = hostname;
      args.push('--tunnel', 'tailscale', '--hostname', hostname);
    } else {
      profileTunnel = 'cloudflare';
      args.push('--tunnel', 'cloudflare');
    }

    if (profileTunnel !== 'none') {
      profileToken = await ask(rl, 'CodexPro auth token for this workspace', stableToken(profileToken));
      if (profileToken) args.push('--token', profileToken);
    }

    const saveDefault = defaults.noSaveConfig ? 'no' : 'yes';
    const saveAnswer = await ask(rl, 'Save this setup for future runs from this workspace?', saveDefault);
    const shouldSave = !['n', 'no'].includes(saveAnswer.trim().toLowerCase());
    if (shouldSave) {
      const allowedRoots = configuredProjectRoots(root, defaults, profile);
      const savedPath = saveWorkspaceProfile(root, {
        port,
        mode,
        tunnel: profileTunnel,
        ...(profileHostname ? { hostname: profileHostname } : {}),
        ...(profileTunnelName ? { tunnelName: profileTunnelName } : {}),
        ...(profileNgrokConfig ? { ngrokConfig: profileNgrokConfig } : {}),
        ...(profileCloudflareConfig ? { cloudflareConfig: profileCloudflareConfig } : {}),
        ...(profileCloudflareTokenFile ? { cloudflareTokenFile: profileCloudflareTokenFile } : {}),
        ...(profileToken ? { token: profileToken } : {}),
        ...(bash ? { bash } : {}),
        ...(bashTranscript !== 'compact' ? { bashTranscript } : {}),
        ...(codexSessions !== 'off' ? { codexSessions } : {}),
        ...(codexDir ? { codexDir } : {}),
        ...(bashSession ? { bashSession } : {}),
        ...(requireBashSession ? { requireBashSession: true } : {}),
        ...(write ? { write } : {}),
        ...(toolMode ? { toolMode } : {}),
        ...(widgetDomain ? { widgetDomain } : {}),
        ...toolCardsEntry,
        ...(allowedRoots.length ? { allowedRoots } : {}),
        ...(defaults.noInstallCloudflared ? { noInstallCloudflared: true } : {})
      });
      statusLine('ok', `Saved workspace profile: ${savedPath}`);
    }

    const startAnswer = await ask(rl, 'Start CodexPro now?', 'yes');
    const shouldStart = !['n', 'no'].includes(startAnswer.trim().toLowerCase());
    console.log('');
    console.log(paint('bold', 'Command'));
    console.log(`  ${commandPreview(args)}`);
    console.log('');
    if (!shouldStart) {
      console.log('Setup complete. Run the command above when you are ready.');
      return null;
    }
    return args;
  } finally {
    rl.close();
  }
}

function printProfile(root, profile) {
  if (!profile.profilePath) {
    printBox('CodexPro settings', [
      labelValue('Workspace', root),
      'No saved settings for this workspace.',
      'Run codexpro settings set or codexpro setup to save a tunnel preference.'
    ]);
    return;
  }
  const safe = sanitizedProfile(profile);
  printBox('CodexPro settings', [
    labelValue('Workspace', root),
    labelValue('Profile', profile.profilePath),
    labelValue('Tunnel', safe.tunnel ?? 'cloudflare'),
    ...(safe.hostname ? [labelValue('Hostname', safe.hostname)] : []),
    ...(safe.tunnelName ? [labelValue('Tunnel name', safe.tunnelName)] : []),
    ...(safe.ngrokConfig ? [labelValue('Ngrok config', safe.ngrokConfig)] : []),
    ...(safe.cloudflareConfig ? [labelValue('Cloudflare cfg', safe.cloudflareConfig)] : []),
    ...(safe.cloudflareTokenFile ? [labelValue('CF token file', safe.cloudflareTokenFile)] : []),
    ...(safe.port ? [labelValue('Port', safe.port)] : []),
    ...(safe.mode ? [labelValue('Mode', safe.mode)] : []),
    ...(safe.bash ? [labelValue('Bash', safe.bash)] : []),
    ...(safe.write ? [labelValue('Write', safe.write)] : []),
    ...(safe.toolMode ? [labelValue('Tool mode', safe.toolMode)] : []),
    ...(safe.toolCards !== undefined ? [labelValue('Tool cards', safe.toolCards ? 'on' : 'off')] : []),
    labelValue('Bash transcript', safe.bashTranscript ?? 'compact'),
    labelValue('Codex sessions', safe.codexSessions ?? 'off'),
    ...(safe.codexDir ? [labelValue('Codex dir', safe.codexDir)] : []),
    ...(safe.bashSession ? [labelValue('Bash session', `${safe.bashSession}${safe.requireBashSession ? ' required' : ''}`)] : []),
    ...(safe.widgetDomain ? [labelValue('Widget origin', safe.widgetDomain)] : []),
    ...(Array.isArray(safe.allowedRoots) && safe.allowedRoots.length
      ? [labelValue('Projects', safe.allowedRoots.join(', '))]
      : []),
    ...(safe.noInstallCloudflared ? [labelValue('cloudflared', 'manual install only')] : []),
    ...(safe.token ? [labelValue('Token', safe.token)] : []),
    ...(safe.cloudflareToken ? [labelValue('Cloudflare token', safe.cloudflareToken)] : [])
  ]);
}

function printProfileList(profiles = listWorkspaceProfiles()) {
  if (!profiles.length) {
    printBox('CodexPro saved setups', [
      'No saved workspace settings found.',
      'Run codexpro setup or codexpro settings set to create one.'
    ]);
    return;
  }
  printBox('CodexPro saved setups', profiles.slice(0, 50).map((profile, index) => profileOneLine(profile, index + 1)));
}

function saveSettingsFromArgs(root, args, profile) {
  if (args.cloudflareToken !== undefined) {
    throw new Error('codexpro settings set does not save raw --cloudflare-token. Save it to a local file and use --cloudflare-token-file <path>; start still accepts --cloudflare-token for a single launch.');
  }
  const tunnel = optionValue(args, profile, 'tunnel', ['CODEXPRO_TUNNEL'], profile.tunnel ?? 'cloudflare');
  if (!['none', 'cloudflare', 'cloudflare-named', 'ngrok', 'tailscale'].includes(tunnel)) {
    throw new Error('--tunnel must be none, cloudflare, cloudflare-named, ngrok, or tailscale');
  }
  const needsHostname = tunnel === 'ngrok' || tunnel === 'cloudflare-named' || tunnel === 'tailscale';
  const rawHostname = needsHostname ? (args.hostname ?? args.url ?? profile.hostname ?? '') : '';
  const hostname = needsHostname ? normalizePublicHostname(rawHostname) : String(rawHostname ?? '').trim();
  if (needsHostname && !hostname) {
    throw new Error('--hostname is required for ngrok, cloudflare-named, and tailscale settings.');
  }
  const mode = optionValue(args, profile, 'mode', ['CODEXPRO_MODE'], profile.mode ?? 'agent');
  if (!['agent', 'handoff', 'pro'].includes(mode)) {
    throw new Error('--mode must be agent, handoff, or pro');
  }
  const toolMode = optionalChoice('tool-mode', optionValue(args, profile, 'toolMode', ['CODEXPRO_TOOL_MODE'], profile.toolMode ?? ''), ['minimal', 'standard', 'full']);
  const widgetDomain = optionValue(args, profile, 'widgetDomain', ['CODEXPRO_WIDGET_DOMAIN'], profile.widgetDomain ?? '');
  const port = normalizePort(optionValue(args, profile, 'port', ['CODEXPRO_PORT'], profile.port ?? '8787'));
  const bashTranscript = bashTranscriptOption(args, profile);
  const codexSessions = codexSessionsOption(args, profile);
  const codexDir = optionValue(args, profile, 'codexDir', ['CODEXPRO_CODEX_DIR'], profile.codexDir ?? '');
  const { bashSession, requireBashSession } = bashSessionOptions(args, profile);
  const write = writeOption(args, profile, mode);
  const bash = optionalChoice('bash', optionValue(args, profile, 'bash', ['CODEXPRO_BASH_MODE'], profile.bash ?? ''), ['off', 'safe', 'full']);
  const tunnelName = tunnel === 'cloudflare-named' ? (args.tunnelName ?? profile.tunnelName ?? '') : '';
  const ngrokConfig = tunnel === 'ngrok'
    ? resolveConfigPath(root, optionValue(args, profile, 'ngrokConfig', ['NGROK_CONFIG', 'CODEXPRO_NGROK_CONFIG'], ''))
    : '';
  const cloudflareConfig = tunnel === 'cloudflare-named'
    ? resolveConfigPath(root, optionValue(args, profile, 'cloudflareConfig', ['CODEXPRO_CLOUDFLARE_CONFIG', 'CLOUDFLARE_TUNNEL_CONFIG'], ''))
    : '';
  const cloudflareTokenFile = tunnel === 'cloudflare-named'
    ? resolveConfigPath(root, optionValue(args, profile, 'cloudflareTokenFile', ['CODEXPRO_CLOUDFLARE_TUNNEL_TOKEN_FILE', 'CLOUDFLARE_TUNNEL_TOKEN_FILE'], ''))
    : '';
  const token = tunnel === 'none'
    ? optionValue(args, profile, 'token', ['CODEXPRO_HTTP_TOKEN', 'CODEBASE_BRIDGE_HTTP_TOKEN'], profile.token ?? '')
    : stableToken(optionValue(args, profile, 'token', ['CODEXPRO_HTTP_TOKEN', 'CODEBASE_BRIDGE_HTTP_TOKEN'], profile.token ?? ''));
  const allowedRoots = configuredProjectRoots(root, args, profile);
  const savedPath = saveWorkspaceProfile(root, {
    port,
    mode,
    tunnel,
    ...(hostname ? { hostname } : {}),
    ...(tunnelName ? { tunnelName } : {}),
    ...(ngrokConfig ? { ngrokConfig } : {}),
    ...(cloudflareConfig ? { cloudflareConfig } : {}),
    ...(cloudflareTokenFile ? { cloudflareTokenFile } : {}),
    ...(token ? { token } : {}),
    ...(bash ? { bash } : {}),
    ...(bashTranscript !== 'compact' ? { bashTranscript } : {}),
    ...(codexSessions !== 'off' ? { codexSessions } : {}),
    ...(codexDir ? { codexDir } : {}),
    ...(bashSession ? { bashSession } : {}),
    ...(requireBashSession ? { requireBashSession: true } : {}),
    ...(mode !== 'agent' || args.write !== undefined || profile.write ? { write } : {}),
    ...(toolMode ? { toolMode } : {}),
    ...(widgetDomain ? { widgetDomain } : {}),
    ...toolCardsProfileEntry(args, profile),
    ...(allowedRoots.length ? { allowedRoots } : {}),
    ...(args.noInstallCloudflared ?? profile.noInstallCloudflared ? { noInstallCloudflared: true } : {})
  });
  statusLine('ok', `Saved workspace settings: ${savedPath}`);
  printProfile(root, loadWorkspaceProfile(root));
}

async function chooseReusableProfile(rl, currentRoot, profiles = listWorkspaceProfiles()) {
  const reusable = profiles.filter((item) => item.root !== currentRoot);
  if (!reusable.length) return null;
  printProfileList(reusable);
  const answer = await ask(rl, 'Use saved setup number?', reusable.length === 1 ? '1' : '');
  const selectedIndex = Number(answer.trim());
  if (!Number.isInteger(selectedIndex) || selectedIndex < 1 || selectedIndex > reusable.length) {
    throw new Error('Invalid saved setup number.');
  }
  return reusable[selectedIndex - 1];
}

async function runSettings(argv) {
  const action = argv[0] && !argv[0].startsWith('--') ? argv[0] : '';
  const args = parseArgs(action ? argv.slice(1) : argv);
  if (args.help) {
    usage();
    return;
  }
  const root = realDir(args.root ?? process.env.CODEXPRO_ROOT ?? process.cwd());
  const profile = args.noProfile ? {} : loadWorkspaceProfile(root);

  if (action === 'list' || action === 'ls') {
    printProfileList();
    return;
  }

  if (action === 'show' || (!action && !process.stdin.isTTY)) {
    printProfile(root, profile);
    return;
  }

  if (action === 'delete' || action === 'reset' || action === 'remove') {
    if (!profile.profilePath) {
      statusLine('warn', 'No saved settings exist for this workspace.');
      return;
    }
    if (!args.yes && process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await ask(rl, `Delete saved settings for ${root}?`, 'no');
        if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
          statusLine('warn', 'Settings delete cancelled.');
          return;
        }
      } finally {
        rl.close();
      }
    } else if (!args.yes) {
      throw new Error('Use codexpro settings delete --yes in non-interactive shells.');
    }
    deleteWorkspaceProfile(root);
    statusLine('ok', 'Deleted saved settings for this workspace.');
    return;
  }

  if (action === 'set') {
    saveSettingsFromArgs(root, args, profile);
    return;
  }

  if (action === 'use' || action === 'copy') {
    const fromRoot = args.fromRoot ? realDir(args.fromRoot) : '';
    let source = fromRoot ? loadWorkspaceProfile(fromRoot) : null;
    if (fromRoot && !source.profilePath) {
      throw new Error(`No saved settings found for --from-root ${fromRoot}`);
    }
    if (!source) {
      if (!process.stdin.isTTY) throw new Error('Use --from-root in non-interactive shells.');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        source = await chooseReusableProfile(rl, root);
      } finally {
        rl.close();
      }
    }
    if (!source) {
      statusLine('warn', 'No reusable saved settings found.');
      return;
    }
    const savedPath = saveWorkspaceProfile(root, reusableProfilePayload(source));
    statusLine('ok', `Saved workspace settings from ${source.root}: ${savedPath}`);
    printProfile(root, loadWorkspaceProfile(root));
    return;
  }

  if (action && !['change', 'edit'].includes(action)) {
    throw new Error(`Unknown settings action: ${action}`);
  }

  if (!process.stdin.isTTY) {
    printProfile(root, profile);
    return;
  }

  printProfile(root, profile);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const selected = await ask(rl, 'Action: set, use, delete, show, list, or exit?', profile.profilePath ? 'show' : 'set');
    const normalized = normalizeSetupChoice(selected, ['set', 'use', 'delete', 'show', 'list', 'exit'], profile.profilePath ? 'show' : 'set');
    if (normalized === 'exit') return;
    if (normalized === 'list') {
      printProfileList();
      return;
    }
    if (normalized === 'show') {
      printProfile(root, profile);
      return;
    }
    if (normalized === 'use') {
      const source = await chooseReusableProfile(rl, root);
      if (!source) {
        statusLine('warn', 'No reusable saved settings found.');
        return;
      }
      const savedPath = saveWorkspaceProfile(root, reusableProfilePayload(source));
      statusLine('ok', `Saved workspace settings from ${source.root}: ${savedPath}`);
      printProfile(root, loadWorkspaceProfile(root));
      return;
    }
    if (normalized === 'delete') {
      if (!profile.profilePath) {
        statusLine('warn', 'No saved settings exist for this workspace.');
        return;
      }
      const answer = await ask(rl, `Delete saved settings for ${root}?`, 'no');
      if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
        statusLine('warn', 'Settings delete cancelled.');
        return;
      }
      deleteWorkspaceProfile(root);
      statusLine('ok', 'Deleted saved settings for this workspace.');
      return;
    }

    const preference = await collectTunnelPreference(rl, args, profile);
    const payload = profileFromPreference(root, args, profile, preference);
    const savedPath = saveWorkspaceProfile(root, payload);
    statusLine('ok', `Saved workspace settings: ${savedPath}`);
    printProfile(root, loadWorkspaceProfile(root));
  } finally {
    rl.close();
  }
}

function writeControlPrompt() {
  process.stdout.write('codexpro> ');
}

function runControlPanel(details, cleanup = cleanupChildren) {
  if (!process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    return new Promise(() => {
      process.stdin.on('data', (input) => {
        const normalized = String(input).trim().toLowerCase();
        if (normalized === 'q') {
          cleanup();
          process.exit(0);
        }
      });
    });
  }

  writeControlPrompt();

  process.stdin.setEncoding('utf8');
  if (typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise(() => {
    process.stdin.on('data', (key) => {
      if (key === '\u0003') {
        console.log('\nStopping CodexPro...');
        cleanup();
        process.exit(130);
      }
      const normalized = key.toLowerCase();
      if (key === '\r' || key === '\n') {
        const opened = openUrl(details.chatgptSettingsUrl);
        console.log(opened ? '\nOpened ChatGPT connector settings. The Server URL is already copied; paste it into Server URL.' : '\nCould not open ChatGPT automatically.');
        writeControlPrompt();
      } else if (normalized === 'c') {
        const copied = copyToClipboard(details.serverUrl);
        console.log(copied.ok ? `\nServer URL copied with ${copied.command}.` : '\nCould not copy automatically.');
        writeControlPrompt();
      } else if (normalized === 'u') {
        console.log(`\n${details.serverUrl}`);
        writeControlPrompt();
      } else if (normalized === 'o') {
        if (!details.localStatusUrl) {
          console.log('\nNo local status page URL is available for this run.');
        } else {
          const opened = openUrl(details.localStatusUrl);
          console.log(opened ? '\nOpened local CodexPro setup/status page.' : `\nCould not open automatically. Open this URL:\n${details.localStatusUrl}`);
        }
        writeControlPrompt();
      } else if (normalized === 'p') {
        console.log('');
        printCreateAppFields(details);
        console.log('');
        writeControlPrompt();
      } else if (normalized === 'm') {
        printModeHelp();
        console.log('');
        writeControlPrompt();
      } else if (normalized === 'h' || normalized === '?') {
        printControlHelp();
        writeControlPrompt();
      } else if (normalized === 'q') {
        console.log('\nStopping CodexPro...');
        cleanup();
        process.exit(0);
      }
    });
  });
}

function waitForUnexpectedChildExit(child, label, cleanup = cleanupChildren) {
  return new Promise((_, reject) => {
    const fail = (code, signal, error) => {
      cleanup();
      const detail = error
        ? error instanceof Error ? error.message : String(error)
        : `code=${code ?? 'null'} signal=${signal ?? 'null'}`;
      reject(new Error(`${label} exited unexpectedly (${detail}).`));
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      fail(child.exitCode, child.signalCode);
      return;
    }
    child.once('error', (error) => fail(null, null, error));
    child.once('exit', (code, signal) => fail(code, signal));
  });
}

function holdRuntime(server, details, cleanup, headless, tunnelChild = null) {
  const watchers = [waitForUnexpectedChildExit(server, 'CodexPro HTTP runtime', cleanup)];
  if (tunnelChild) watchers.push(waitForUnexpectedChildExit(tunnelChild, 'CodexPro tunnel', cleanup));
  if (!headless) watchers.push(runControlPanel(details, cleanup));
  return Promise.race(watchers);
}

const runAnalysisCli = createAnalysisCli({ projectRoot, parseArgs, realDir });

const { runExecuteHandoff, runWatchHandoff, runLoopHandoff } = createHandoffRuntimeLauncher({
  projectRoot,
  parseArgs,
  usage,
  realDir,
  numberOption,
  shellCommandPreview,
  redactForLog,
  managerMaxSubagentsSetting,
  resolveAgentCommand,
  resolveCodexCommand,
  isWindowsBatchFile,
  processInvocation,
  commandAvailableFromRoot,
  statusLine,
  printBox,
  labelValue,
  ask,
  sleep
});

async function main() {
  watchHiddenLauncherParent();
  let argv = process.argv.slice(2);
  let connectionTest = false;
  if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
    console.log(packageVersion());
    return;
  }
  let subcommand = argv[0];
  if (subcommand === 'inspect' || subcommand === 'review') {
    await runAnalysisCli(subcommand, argv.slice(1));
    return;
  }
  if (subcommand === 'stable-help') {
    printStableUrlHelp();
    return;
  }
  if (subcommand === 'setup' || subcommand === 'onboard') {
    if (argv.includes('--help') || argv[1] === 'help') {
      usage();
      return;
    }
    const setupArgs = await runSetupWizard(argv.slice(1));
    if (!setupArgs) return;
    argv = setupArgs;
    subcommand = argv[0];
  }
  if (subcommand === 'settings' || subcommand === 'config') {
    await runSettings(argv.slice(1));
    return;
  }
  if (subcommand === 'execute-handoff' || subcommand === 'execute' || subcommand === 'run-handoff') {
    await runExecuteHandoff(argv.slice(1));
    return;
  }
  if (subcommand === 'watch-handoff' || subcommand === 'watch') {
    await runWatchHandoff(argv.slice(1));
    return;
  }
  if (subcommand === 'loop-handoff' || subcommand === 'loop') {
    await runLoopHandoff(argv.slice(1));
    return;
  }
  if (subcommand === 'pro-bundle' || subcommand === 'bundle') {
    runHelperScript('pro-bundle.mjs', argv.slice(1));
  }
  if (subcommand === 'pro-apply' || subcommand === 'apply') {
    runHelperScript('pro-apply.mjs', argv.slice(1));
  }
  if (subcommand === 'install-cloudflared') {
    const installArgs = parseArgs(argv.slice(1));
    if (installArgs.help) {
      usage();
      return;
    }
    const installedCloudflared = await installCloudflaredLocal();
    console.log(`cloudflared ready: ${installedCloudflared}`);
    return;
  }
  if (subcommand === 'doctor') {
    await runDoctor(argv.slice(1));
    return;
  }
  if (argv[0] === 'stable') {
    argv.shift();
    argv.unshift('--tunnel', 'cloudflare-named');
  }
  if (argv[0] === 'ngrok') {
    argv.shift();
    argv.unshift('--tunnel', 'ngrok');
  }
  if (argv[0] === 'tailscale') {
    argv.shift();
    argv.unshift('--tunnel', 'tailscale');
  }
  if (argv[0] === 'connection-test') {
    connectionTest = true;
    argv.shift();
  }
  if (argv[0] === 'start' || argv[0] === 'connect') argv.shift();
  if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
    console.log(packageVersion());
    return;
  }
  if (argv[0] === 'help') argv[0] = '--help';
  const args = parseArgs(argv);
  const headless = Boolean(args.headless);
  if (connectionTest) {
    args.mode = 'agent';
    args.toolMode = 'standard';
    args.write = 'off';
    args.bash = 'off';
    args.toolCards = 'off';
    args.logRequests = true;
  }
  if (args.help) {
    usage();
    return;
  }

  const root = realDir(args.root ?? process.env.CODEXPRO_ROOT ?? process.cwd());
  let profile = args.noProfile ? {} : loadWorkspaceProfile(root);
  profile = await maybeConfigureFirstRun(root, args, profile);
  const effectiveArgs = { ...profile, ...args };
  if (profile.profilePath && !args.noProfile) {
    statusLine('ok', `Using saved profile: ${profile.profilePath}`);
    const summary = profileSummary(profile);
    if (summary) statusLine('ok', `${summary}. Future launches from this folder only need: codexpro start`);
  }

  const tunnel = optionValue(args, profile, 'tunnel', ['CODEXPRO_TUNNEL'], 'cloudflare');
  if (!['none', 'cloudflare', 'cloudflare-named', 'ngrok', 'tailscale'].includes(tunnel)) {
    throw new Error('--tunnel must be none, cloudflare, cloudflare-named, ngrok, or tailscale');
  }
  const stableHostname = args.hostname
    ?? args.url
    ?? process.env.CODEXPRO_PUBLIC_HOSTNAME
    ?? process.env.CODEXPRO_HOSTNAME
    ?? process.env.NGROK_DOMAIN
    ?? profile.hostname
    ?? '';
  if (tunnel === 'cloudflare-named' && !stableHostname) {
    printStableUrlHelp();
    throw new Error('--hostname is required with stable URL mode.');
  }
  if (tunnel === 'ngrok' && !stableHostname) {
    throw new Error('--hostname is required with ngrok tunnel mode. Example: codexpro ngrok --hostname your-domain.ngrok-free.dev');
  }
  if (tunnel === 'tailscale' && !stableHostname) {
    throw new Error('--hostname is required with Tailscale Funnel mode. Example: codexpro tailscale --hostname your-device.your-tailnet.ts.net');
  }
  const mode = optionValue(args, profile, 'mode', ['CODEXPRO_MODE'], 'agent');
  if (!['agent', 'handoff', 'pro'].includes(mode)) {
    throw new Error('--mode must be agent, handoff, or pro');
  }

  const allowRoots = [root, ...configuredProjectRoots(root, args, profile)];
  const host = optionValue(args, profile, 'host', ['CODEXPRO_HOST'], '127.0.0.1');
  if (args.noAuth && (tunnel !== 'none' || !isLoopbackHost(host))) {
    throw new Error('--no-auth is only allowed with --tunnel none on a loopback host.');
  }
  const port = String(optionValue(args, profile, 'port', ['CODEXPRO_PORT'], '8787'));
  runtimeLifecycleLogger = createRuntimeLifecycleLogger({ home: codexProHome() });
  logRuntimeLifecycle('launcher-start', 'CodexPro launcher started', {
    parent_pid: process.ppid,
    root,
    port,
    tunnel,
    hidden_launcher: process.env.CODEXPRO_HIDDEN_LAUNCHER === '1',
    version: packageVersion()
  });
  process.once('exit', (exitCode) => {
    logRuntimeLifecycle('launcher-exit', 'CodexPro launcher exited', { exit_code: exitCode }, exitCode === 0 ? 'info' : 'error');
  });
  const bash = optionValue(args, profile, 'bash', ['CODEXPRO_BASH_MODE'], 'safe');
  const bashTranscript = bashTranscriptOption(args, profile);
  const codexSessions = codexSessionsOption(args, profile);
  const codexDir = resolveCodexDir(root, optionValue(args, profile, 'codexDir', ['CODEXPRO_CODEX_DIR'], ''));
  const { bashSession, requireBashSession } = bashSessionOptions(args, profile);
  const write = writeOption(args, profile, mode);
  const toolMode = optionValue(args, profile, 'toolMode', ['CODEXPRO_TOOL_MODE'], 'standard');
  const widgetDomain = optionValue(args, profile, 'widgetDomain', ['CODEXPRO_WIDGET_DOMAIN'], 'https://rebel0789.github.io');
  const toolCards = optionBool(args, profile, 'toolCards', ['CODEXPRO_TOOL_CARDS'], false);
  const browserControl = optionBool(args, profile, 'browserControl', ['CODEXPRO_BROWSER_CONTROL'], false);
  const browserDebugUrl = optionValue(args, profile, 'browserDebugUrl', ['CODEXPRO_BROWSER_DEBUG_URL'], 'http://127.0.0.1:9223');
  validateChoice('bash', bash, ['off', 'safe', 'full']);
  validateChoice('write', write, ['off', 'handoff', 'workspace']);
  validateChoice('tool-mode', toolMode, ['minimal', 'standard', 'full']);

  if (args.token && args.tokenFile) throw new Error('Use either --token or --token-file, not both.');
  let token = args.noAuth
    ? ''
    : args.tokenFile
      ? readTokenFile(args.tokenFile)
      : optionValue(args, profile, 'token', ['CODEXPRO_HTTP_TOKEN', 'CODEBASE_BRIDGE_HTTP_TOKEN'], '');
  if (!token && !args.noAuth) token = stableToken();

  const serverEnv = {
    ...process.env,
    CODEXPRO_ROOT: root,
    CODEXPRO_ALLOWED_ROOTS: allowRoots.join(path.delimiter),
    CODEXPRO_HOST: host,
    CODEXPRO_PORT: port,
    CODEXPRO_BASH_MODE: bash,
    CODEXPRO_BASH_TRANSCRIPT: bashTranscript,
    CODEXPRO_BASH_SESSION_ID: bashSession,
    CODEXPRO_REQUIRE_BASH_SESSION: requireBashSession ? '1' : '0',
    CODEXPRO_CODEX_SESSIONS: codexSessions,
    CODEXPRO_WRITE_MODE: write,
    CODEXPRO_TOOL_MODE: toolMode,
    CODEXPRO_WIDGET_DOMAIN: widgetDomain,
    CODEXPRO_TOOL_CARDS: toolCards ? '1' : '0',
    CODEXPRO_BROWSER_CONTROL: browserControl ? '1' : '0',
    CODEXPRO_BROWSER_DEBUG_URL: browserDebugUrl,
    CODEXPRO_CONNECTION_TEST: connectionTest ? '1' : '0',
    CODEXPRO_MODE: mode,
    CODEXPRO_TUNNEL_MODE: tunnel === 'none' ? '0' : '1',
    CODEXPRO_ALLOW_NO_HTTP_TOKEN: args.noAuth ? '1' : '0'
  };
  // The HTTP process starts before the launcher writes its runtime connection
  // record. Keep the stable public hostname available in the child process so
  // browser-extension setup can always build the profile-specific MCP URL,
  // including immediately after a Windows scheduled-task recovery.
  if (stableHostname) serverEnv.CODEXPRO_PUBLIC_HOSTNAME = stableHostname;
  if (codexDir) serverEnv.CODEXPRO_CODEX_DIR = codexDir;
  if (args.logRequests || process.env.CODEXPRO_LOG_REQUESTS === '1') serverEnv.CODEXPRO_LOG_REQUESTS = '1';
  if (args.allowHome) serverEnv.CODEXPRO_ALLOW_HOME = '1';
  if (token) serverEnv.CODEXPRO_HTTP_TOKEN = token;
  else delete serverEnv.CODEXPRO_HTTP_TOKEN;

  if (args.printEnv) {
    console.log(JSON.stringify(redactEnvObject(serverEnv), null, 2));
  }

  const httpPath = path.join(projectRoot, 'dist', 'http.js');
  if (!fs.existsSync(httpPath)) {
    throw new Error(`Missing ${httpPath}. Run npm install && npm run build first.`);
  }

  await assertPortAvailable(host, port);

  printBox('CodexPro start', [
    labelValue('Workspace', root),
    ...(allowRoots.length > 1 ? [labelValue('Projects', allowRoots.slice(1).join(', '))] : []),
    labelValue('Mode', `${mode}  tools=${toolMode}  write=${write}  bash=${bash}`),
    labelValue('Bash transcript', bashTranscript),
    labelValue('Codex sessions', codexSessions),
    ...(bashSession ? [labelValue('Bash session', `${bashSession}${requireBashSession ? ' required' : ''}`)] : []),
    labelValue('Local URL', `http://${host}:${port}/mcp`),
    labelValue(
      'Tunnel',
      tunnel === 'cloudflare'
        ? 'Cloudflare quick tunnel'
        : tunnel === 'cloudflare-named'
          ? `Cloudflare named tunnel for ${stableHostname}`
          : tunnel === 'ngrok'
            ? `ngrok endpoint for ${stableHostname}`
            : tunnel === 'tailscale'
              ? `Tailscale Funnel endpoint for ${stableHostname}`
              : 'none'
    )
  ]);

  const verboseLogs = Boolean(args.logRequests || process.env.CODEXPRO_LOG_REQUESTS === '1');
  statusLine('wait', 'Starting local MCP server');
  const server = spawnLogged('codexpro', process.execPath, [httpPath], { cwd: projectRoot, env: serverEnv, verbose: verboseLogs });
  let cloudflared;
  let tunnelSupervisorStopRequested = false;
  let cleanupTunnelCredentials = () => {};
  const cleanup = () => {
    tunnelSupervisorStopRequested = true;
    logRuntimeLifecycle('cleanup-requested', 'CodexPro launcher is cleaning up child processes', {
      server_pid: server.pid ?? null,
      tunnel_pid: cloudflared?.pid ?? null
    });
    cleanupTunnelCredentials();
    cleanupChildren();
    clearRuntimeConnection(root);
  };
  process.on('SIGINT', () => {
    logRuntimeLifecycle('launcher-signal', 'CodexPro launcher received SIGINT', { signal: 'SIGINT' }, 'warn');
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    logRuntimeLifecycle('launcher-signal', 'CodexPro launcher received SIGTERM', { signal: 'SIGTERM' }, 'warn');
    cleanup();
    process.exit(143);
  });

  const localBase = `http://${host}:${port}`;
  await waitForHealth(`${localBase}/healthz`, token, 30000);
  logRuntimeLifecycle('local-ready', 'Local MCP health probe succeeded', {
    server_pid: server.pid ?? null,
    host,
    port
  });
  statusLine('ok', `Local MCP ready at ${localBase}/mcp`);
  const runtimeOptions = {
    localBase,
    tunnel,
    mode,
    toolMode,
    write,
    bash,
    bashTranscript,
    codexSessions,
    bashSession,
    requireBashSession,
    toolCards,
    connectionTest,
    runtimePid: server.pid ?? null
  };

  if (tunnel === 'none') {
    if (effectiveArgs.installCloudflared) {
      const installedCloudflared = await resolveCloudflared(effectiveArgs);
      if (installedCloudflared) console.log(`cloudflared ready: ${installedCloudflared}`);
    }
    const details = printConnectorBlock(`${localBase}/mcp`, token, {
      localBase,
      headless,
      copyUrl: args.copyUrl ? true : args.noCopyUrl ? false : undefined,
      openChatgpt: Boolean(args.openChatgpt),
      mode,
      toolMode,
      root,
      write,
      bash,
      bashTranscript,
      codexSessions,
      bashSession,
      requireBashSession,
      connectionTest
    });
    saveRuntimeConnection(root, details, runtimeOptions);
    await holdRuntime(server, details, cleanup, headless);
    return;
  }

  if (tunnel === 'ngrok') {
    const ngrokPath = resolveNgrok(effectiveArgs);
    const publicBase = publicBaseFromHostname(stableHostname);
    const ngrokArgs = ['http', localBase, '--url', publicBase];
    const configPath = ngrokConfigPath(root, args, profile);
    if (configPath) ngrokArgs.push('--config', configPath);
    statusLine('wait', `Opening ngrok endpoint for ${publicBase}`);
    cloudflared = spawnLogged('ngrok', ngrokPath, ngrokArgs, { cwd: root, env: process.env, verbose: verboseLogs });
    try {
      await waitForPublicHealth(publicBase, token, cloudflared, 'ngrok');
    } catch (error) {
      const tail = typeof cloudflared.codexproLogTail === 'function' ? cloudflared.codexproLogTail() : '';
      const hint = [
        '',
        'Ngrok stable domains need one-time setup before this can succeed:',
        '',
        '  ngrok config add-authtoken <your-ngrok-token>',
        '  find your free ngrok dev domain in the ngrok dashboard',
        '  codexpro ngrok --hostname your-domain.ngrok-free.dev --token keep-this-stable-token',
        '',
        'If the domain is already in use, stop the other ngrok process or choose another reserved domain.'
      ].join('\n');
      throw new Error(`${error instanceof Error ? error.message : String(error)}${tail ? `\n\nRecent ngrok output:\n${tail}` : ''}${hint}`);
    }
    const details = printConnectorBlock(`${publicBase}/mcp`, token, {
      localBase,
      headless,
      copyUrl: args.noCopyUrl ? false : true,
      openChatgpt: Boolean(args.openChatgpt),
      mode,
      toolMode,
      root,
      write,
      bash,
      bashTranscript,
      codexSessions,
      bashSession,
      requireBashSession,
      connectionTest
    });
    runtimeOptions.tunnelPid = cloudflared.pid ?? null;
    saveRuntimeConnection(root, details, runtimeOptions);
    await holdRuntime(server, details, cleanup, headless, cloudflared);
    return;
  }

  if (tunnel === 'tailscale') {
    const tailscalePath = resolveTailscale(effectiveArgs);
    const publicBase = publicBaseFromHostname(stableHostname);
    const httpsPort = tailscaleFunnelHttpsPort(publicBase);
    const tailscaleArgs = ['funnel'];
    if (httpsPort !== '443') tailscaleArgs.push(`--https=${httpsPort}`);
    tailscaleArgs.push(localBase);
    statusLine('wait', `Opening Tailscale Funnel for ${publicBase}`);
    cloudflared = spawnLogged('tailscale', tailscalePath, tailscaleArgs, { cwd: root, env: process.env, verbose: verboseLogs });
    try {
      await waitForPublicHealth(publicBase, token, cloudflared, 'Tailscale Funnel');
    } catch (error) {
      const tail = typeof cloudflared.codexproLogTail === 'function' ? cloudflared.codexproLogTail() : '';
      const hint = [
        '',
        'Tailscale Funnel needs one-time setup before this can succeed:',
        '',
        '  install and log in to Tailscale',
        '  enable MagicDNS, HTTPS certificates, and Funnel for this tailnet',
        '  codexpro tailscale --hostname your-device.your-tailnet.ts.net --token keep-this-stable-token',
        '',
        'Funnel exposes this connector publicly. Keep the CodexPro token enabled.'
      ].join('\n');
      throw new Error(`${error instanceof Error ? error.message : String(error)}${tail ? `\n\nRecent tailscale output:\n${tail}` : ''}${hint}`);
    }
    const details = printConnectorBlock(`${publicBase}/mcp`, token, {
      localBase,
      headless,
      copyUrl: args.noCopyUrl ? false : true,
      openChatgpt: Boolean(args.openChatgpt),
      mode,
      toolMode,
      root,
      write,
      bash,
      bashTranscript,
      codexSessions,
      bashSession,
      requireBashSession,
      connectionTest
    });
    runtimeOptions.tunnelPid = cloudflared.pid ?? null;
    saveRuntimeConnection(root, details, runtimeOptions);
    await holdRuntime(server, details, cleanup, headless, cloudflared);
    return;
  }

  const cloudflaredPath = await resolveCloudflared(effectiveArgs);
  if (!cloudflaredPath) {
    console.error('\ncloudflared was not found. The local MCP server is still running.');
    console.error('Install Cloudflare Tunnel, rerun without --no-install-cloudflared, or run with --tunnel none for local clients.');
    console.error('Downloads: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/');
    const details = printConnectorBlock(`${localBase}/mcp`, token, {
      localBase,
      headless,
      copyUrl: args.copyUrl ? true : false,
      openChatgpt: Boolean(args.openChatgpt),
      mode,
      toolMode,
      root,
      write,
      bash,
      bashTranscript,
      codexSessions,
      bashSession,
      requireBashSession,
      connectionTest
    });
    saveRuntimeConnection(root, details, runtimeOptions);
    await holdRuntime(server, details, cleanup, headless);
    return;
  }

  if (tunnel === 'cloudflare') {
    statusLine('wait', 'Opening Cloudflare quick tunnel');
    const proxyUrl = outboundProxyFromEnv(process.env);
    const startQuickTunnelInstance = async () => {
      let child;
      let publicBase = '';
      let cleanupCredentials = () => {};
      try {
        if (proxyUrl) {
          const quickTunnel = requestQuickTunnelViaCurl(proxyUrl);
          const { tmpRoot, credentialsPath } = writeQuickTunnelCredentials(quickTunnel);
          cleanupCredentials = () => fs.rmSync(tmpRoot, { recursive: true, force: true });
          child = spawnLogged('cloudflared', cloudflaredPath, ['tunnel', '--url', localBase, '--credentials-file', credentialsPath, 'run', quickTunnel.id], { cwd: root, env: process.env, verbose: verboseLogs });
          child.once('exit', cleanupCredentials);
          child.once('error', cleanupCredentials);
          await waitForTunnelStartup(child, 'cloudflared');
          publicBase = `https://${quickTunnel.hostname}`;
        } else {
          child = spawnLogged('cloudflared', cloudflaredPath, ['tunnel', '--url', localBase], { cwd: root, env: process.env, verbose: verboseLogs });
          publicBase = await waitForCloudflareUrl(child);
        }
        const healthBase = String(process.env.CODEXPRO_QUICK_TUNNEL_HEALTH_BASE || publicBase).replace(/\/+$/, '');
        await waitForPublicHealth(healthBase, token, child, 'Cloudflare quick tunnel');
        return { child, publicBase, cleanupCredentials };
      } catch (error) {
        if (child) killProcess(child);
        cleanupCredentials();
        throw error;
      }
    };
    const initialInstance = await startQuickTunnelInstance();
    cloudflared = initialInstance.child;
    cleanupTunnelCredentials = initialInstance.cleanupCredentials;
    const publicBase = initialInstance.publicBase;
    const details = printConnectorBlock(`${publicBase}/mcp`, token, {
      localBase,
      headless,
      copyUrl: args.noCopyUrl ? false : true,
      openChatgpt: Boolean(args.openChatgpt),
      mode,
      toolMode,
      root,
      write,
      bash,
      bashTranscript,
      codexSessions,
      bashSession,
      requireBashSession,
      connectionTest
    });
    runtimeOptions.tunnelPid = cloudflared.pid ?? null;
    saveRuntimeConnection(root, details, runtimeOptions);
    const tunnelSupervisor = superviseQuickTunnel({
      initialInstance,
      shouldStop: () => tunnelSupervisorStopRequested,
      startInstance: startQuickTunnelInstance,
      onUnexpectedExit: ({ error, instance }) => {
        statusLine('warn', 'Cloudflare quick tunnel disconnected; scheduling restart');
        logRuntimeLifecycle('tunnel-restart-needed', 'Cloudflare quick tunnel exited unexpectedly', {
          tunnel_pid: instance?.child?.pid ?? null,
          error
        }, 'warn');
      },
      onRestartScheduled: ({ restartCount, delayMs, error }) => {
        logRuntimeLifecycle('tunnel-restart-scheduled', 'Cloudflare quick tunnel restart scheduled', {
          restart_count: restartCount,
          delay_ms: delayMs,
          error
        }, 'warn');
      },
      onRestartReady: ({ restartCount, instance }) => {
        cloudflared = instance.child;
        cleanupTunnelCredentials = instance.cleanupCredentials;
        Object.assign(details, createConnectorDetails(`${instance.publicBase}/mcp`, token, localBase));
        runtimeOptions.tunnelPid = cloudflared.pid ?? null;
        saveRuntimeConnection(root, details, runtimeOptions);
        logRuntimeLifecycle('tunnel-restarted', 'Cloudflare quick tunnel restarted successfully', {
          restart_count: restartCount,
          tunnel_pid: cloudflared.pid ?? null,
          public_origin: instance.publicBase
        });
        statusLine('ok', `Cloudflare quick tunnel restored after restart ${restartCount}`);
        console.log(`  Server URL ${details.serverUrl}`);
        if (headless) console.log(`CODEXPRO_READY ${details.serverUrl}`);
      },
      onRestartFailed: ({ restartCount, error }) => {
        logRuntimeLifecycle('tunnel-restart-failed', 'Cloudflare quick tunnel restart attempt failed', {
          restart_count: restartCount,
          error
        }, 'error');
      }
    }).catch((error) => {
      cleanup();
      throw error;
    });
    await Promise.race([
      holdRuntime(server, details, cleanup, headless),
      tunnelSupervisor
    ]);
    return;
  }

  const publicBase = publicBaseFromHostname(stableHostname);
  const tunnelName = optionValue(args, profile, 'tunnelName', ['CLOUDFLARE_TUNNEL_NAME', 'CODEXPRO_TUNNEL_NAME'], '');
  const cloudflareConfig = resolveConfigPath(root, optionValue(args, profile, 'cloudflareConfig', ['CLOUDFLARE_TUNNEL_CONFIG', 'CODEXPRO_CLOUDFLARE_CONFIG'], ''));
  const cloudflareTokenFile = resolveConfigPath(root, optionValue(args, profile, 'cloudflareTokenFile', ['CLOUDFLARE_TUNNEL_TOKEN_FILE', 'CODEXPRO_CLOUDFLARE_TUNNEL_TOKEN_FILE'], ''));
  const cloudflareToken = optionValue(args, profile, 'cloudflareToken', ['CLOUDFLARE_TUNNEL_TOKEN', 'CODEXPRO_CLOUDFLARE_TUNNEL_TOKEN'], '');

  const cloudflaredProtocol = String(process.env.CODEXPRO_CLOUDFLARED_PROTOCOL ?? 'http2').trim();
  const cloudflaredArgs = ['tunnel'];
  if (cloudflaredProtocol) cloudflaredArgs.push('--protocol', cloudflaredProtocol);
  if (cloudflareConfig) {
    cloudflaredArgs.push('--config', cloudflareConfig, 'run');
    if (tunnelName) cloudflaredArgs.push(tunnelName);
  } else {
    cloudflaredArgs.push('run', '--url', localBase);
    if (cloudflareTokenFile) {
      cloudflaredArgs.push('--token-file', cloudflareTokenFile);
    } else if (cloudflareToken) {
      // Passed to cloudflared through the child environment below.
    } else {
      if (!tunnelName) {
        throw new Error('--tunnel-name, --cloudflare-token, --cloudflare-token-file, or --cloudflare-config is required with --tunnel cloudflare-named.');
      }
      cloudflaredArgs.push(tunnelName);
    }
  }

  statusLine('wait', `Starting Cloudflare named tunnel for ${publicBase}`);
  const cloudflaredEnv = cloudflareToken && !cloudflareTokenFile
    ? { ...process.env, TUNNEL_TOKEN: cloudflareToken }
    : process.env;
  cloudflared = spawnLogged('cloudflared', cloudflaredPath, cloudflaredArgs, { cwd: root, env: cloudflaredEnv, verbose: verboseLogs });
  try {
    await waitForPublicHealth(publicBase, token, cloudflared);
  } catch (error) {
    const tail = typeof cloudflared.codexproLogTail === 'function' ? cloudflared.codexproLogTail() : '';
    const hint = [
      '',
      'Named Cloudflare tunnels need one-time setup before this can succeed:',
      '',
      '  cloudflared tunnel login',
      '  cloudflared tunnel create <tunnel-name>',
      '  cloudflared tunnel route dns <tunnel-name> <hostname>',
      '',
      'Or create a remotely managed tunnel in the Cloudflare dashboard and pass:',
      '',
      '  --cloudflare-token-file ~/.codexpro/cloudflare-tunnel-token',
      '',
      'Quick tunnels do not support a permanent hostname. Use --tunnel cloudflare only for demos.'
    ].join('\n');
    throw new Error(`${error instanceof Error ? error.message : String(error)}${tail ? `\n\nRecent cloudflared output:\n${tail}` : ''}${hint}`);
  }
  const details = printConnectorBlock(`${publicBase}/mcp`, token, {
    localBase,
    headless,
    copyUrl: args.noCopyUrl ? false : true,
    openChatgpt: Boolean(args.openChatgpt),
    mode,
    toolMode,
    root,
    write,
    bash,
    bashTranscript,
    codexSessions,
    bashSession,
    requireBashSession,
    connectionTest
  });
  runtimeOptions.tunnelPid = cloudflared.pid ?? null;
  saveRuntimeConnection(root, details, runtimeOptions);
  await holdRuntime(server, details, cleanup, headless, cloudflared);
}

main().catch((error) => {
  logRuntimeLifecycle('launcher-error', 'CodexPro launcher stopped after an error', { error }, 'error');
  cleanupChildren();
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  if (process.env.CODEXPRO_DEBUG === '1' && error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
