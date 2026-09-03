export const QUICK_TUNNEL_MAX_RESTARTS = 5;
export const QUICK_TUNNEL_BASE_BACKOFF_MS = 1_000;
export const QUICK_TUNNEL_MAX_BACKOFF_MS = 15_000;

export function quickTunnelRestartDelay(restartNumber, options = {}) {
  const baseMs = Math.max(1, Number(options.baseMs ?? QUICK_TUNNEL_BASE_BACKOFF_MS));
  const maxMs = Math.max(baseMs, Number(options.maxMs ?? QUICK_TUNNEL_MAX_BACKOFF_MS));
  const index = Math.max(0, Math.trunc(Number(restartNumber) || 1) - 1);
  return Math.min(maxMs, baseMs * (2 ** index));
}

export function waitForQuickTunnelTermination(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      finish({
        type: 'exit',
        code: child?.exitCode ?? null,
        signal: child?.signalCode ?? null,
        expected: child?.codexproExpectedExit === true,
        error: null
      });
      return;
    }
    child.once('error', (error) => finish({
      type: 'error',
      code: null,
      signal: null,
      expected: child.codexproExpectedExit === true,
      error
    }));
    child.once('exit', (code, signal) => finish({
      type: 'exit',
      code,
      signal,
      expected: child.codexproExpectedExit === true,
      error: null
    }));
  });
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function terminationMessage(termination) {
  if (termination?.error) return termination.error instanceof Error ? termination.error.message : String(termination.error);
  return `code=${termination?.code ?? 'null'} signal=${termination?.signal ?? 'null'}`;
}

export async function superviseQuickTunnel(options = {}) {
  const startInstance = options.startInstance;
  if (typeof startInstance !== 'function') throw new Error('Quick tunnel supervisor requires startInstance().');
  const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : () => false;
  const sleep = typeof options.sleep === 'function' ? options.sleep : defaultSleep;
  const maxRestarts = Math.max(0, Math.trunc(Number(options.maxRestarts ?? QUICK_TUNNEL_MAX_RESTARTS)));
  let instance = options.initialInstance ?? null;
  let restartCount = 0;
  let lastFailure = null;

  while (!shouldStop()) {
    if (instance?.child) {
      const termination = await waitForQuickTunnelTermination(instance.child);
      if (shouldStop() || termination.expected) {
        return { stopped: true, restartCount, lastFailure };
      }
      lastFailure = new Error(`Cloudflare quick tunnel exited unexpectedly (${terminationMessage(termination)}).`);
      options.onUnexpectedExit?.({ termination, instance, restartCount, error: lastFailure });
      instance = null;
    }

    if (restartCount >= maxRestarts) {
      const suffix = lastFailure ? ` Last failure: ${lastFailure.message}` : '';
      throw new Error(`Cloudflare quick tunnel restart budget exhausted after ${restartCount} restart attempt(s).${suffix}`);
    }

    restartCount += 1;
    const delayMs = quickTunnelRestartDelay(restartCount, options);
    options.onRestartScheduled?.({ restartCount, delayMs, error: lastFailure });
    await sleep(delayMs);
    if (shouldStop()) return { stopped: true, restartCount, lastFailure };

    try {
      instance = await startInstance({ restartCount, previousFailure: lastFailure });
      if (!instance?.child) throw new Error('Quick tunnel restart returned no child process.');
      lastFailure = null;
      await options.onRestartReady?.({ restartCount, instance });
    } catch (error) {
      lastFailure = error instanceof Error ? error : new Error(String(error));
      instance = null;
      options.onRestartFailed?.({ restartCount, error: lastFailure });
    }
  }

  return { stopped: true, restartCount, lastFailure };
}
