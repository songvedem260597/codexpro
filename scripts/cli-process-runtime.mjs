import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { isWindowsBatchFile } from './cli-executables.mjs';

export function createCliProcessRuntime({
  logRuntimeLifecycle = () => null,
  redactForLog = (value) => String(value),
  cloudflaredOutputLevel = () => null,
  runtime = {}
} = {}) {
  const processRuntime = runtime.process ?? process;
  const spawnFn = runtime.spawn ?? spawn;
  const spawnSyncFn = runtime.spawnSync ?? spawnSync;
  const netRuntime = runtime.net ?? net;
  const fetchFn = runtime.fetch ?? ((...args) => globalThis.fetch(...args));
  const nowFn = runtime.now ?? Date.now;
  const setTimeoutFn = runtime.setTimeout ?? setTimeout;
  const setIntervalFn = runtime.setInterval ?? setInterval;
  const clearIntervalFn = runtime.clearInterval ?? clearInterval;
  const isWindowsBatchFileFn = runtime.isWindowsBatchFile ?? isWindowsBatchFile;
  const spawnedChildren = new Set();

  async function sleep(ms) {
    await new Promise((resolve) => setTimeoutFn(resolve, ms));
  }

  async function waitForHealth(url, token, timeoutMs = 15000) {
    const started = nowFn();
    let lastError = '';
    while (nowFn() - started < timeoutMs) {
      try {
        const res = await fetchFn(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
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
      const server = netRuntime.createServer();
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

  function quoteWindowsCmdArg(value) {
    const text = String(value).replace(/\r?\n/g, ' ').replace(/%/g, '%%');
    if (!text) return '""';
    return `"${text.replace(/"/g, '""')}"`;
  }

  function processInvocation(command, args) {
    if (!isWindowsBatchFileFn(command)) return { command, args };
    const commandLine = `"${[quoteWindowsCmdArg(command), ...args.map(quoteWindowsCmdArg)].join(' ')}"`;
    return {
      command: processRuntime.env.ComSpec || 'cmd.exe',
      args: ['/d', '/q', '/v:off', '/s', '/c', commandLine],
      windowsVerbatimArguments: true,
      killTree: true
    };
  }

  function spawnSyncPortable(command, args, options = {}) {
    const invocation = processInvocation(command, args);
    return spawnSyncFn(invocation.command, invocation.args, {
      ...options,
      shell: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      ...(processRuntime.platform === 'win32' ? { windowsHide: true } : {})
    });
  }

  function spawnLogged(name, command, args, options = {}) {
    const { verbose = false, ...spawnOptions } = options;
    const invocation = processInvocation(command, args);
    const child = spawnFn(invocation.command, invocation.args, {
      ...spawnOptions,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      ...(processRuntime.platform === 'win32' ? { windowsHide: true } : {})
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
    child.stdout.on('data', (chunk) => record(processRuntime.stdout, 'stdout', chunk));
    child.stderr.on('data', (chunk) => record(processRuntime.stderr, 'stderr', chunk));
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

  function waitForProcessExit(child) {
    return new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
  }

  function killProcess(child) {
    if (!child || child.killed) return;
    child.codexproExpectedExit = true;
    if (child.codexproKillTree && child.pid) {
      const result = spawnSyncFn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true
      });
      if (!result.error && result.status === 0) return;
    }
    try { child.kill('SIGTERM'); } catch {}
    setTimeoutFn(() => {
      if (!child.killed) {
        try { child.kill('SIGKILL'); } catch {}
      }
    }, 1500).unref();
  }

  function cleanupChildren() {
    for (const child of spawnedChildren) killProcess(child);
  }

  function watchHiddenLauncherParent() {
    if (processRuntime.platform !== 'win32' || processRuntime.env.CODEXPRO_HIDDEN_LAUNCHER !== '1') return;
    const launcherPid = processRuntime.ppid;
    const timer = setIntervalFn(() => {
      try {
        processRuntime.kill(launcherPid, 0);
      } catch {
        clearIntervalFn(timer);
        cleanupChildren();
        processRuntime.exit(0);
      }
    }, 500);
    timer.unref();
  }

  return {
    sleep,
    waitForHealth,
    portInUseHelp,
    normalizePort,
    assertPortAvailable,
    spawnedChildren,
    quoteWindowsCmdArg,
    processInvocation,
    spawnSyncPortable,
    spawnLogged,
    waitForProcessExit,
    killProcess,
    cleanupChildren,
    watchHiddenLauncherParent
  };
}
