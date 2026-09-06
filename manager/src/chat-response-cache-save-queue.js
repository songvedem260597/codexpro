const DEFAULT_COALESCE_MS = 180;
const DEFAULT_FLUSH_TIMEOUT_MS = 1500;

function payloadBytes(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return 0;
  }
}

export function createResponseCacheSaveQueue({
  save,
  coalesceMs = DEFAULT_COALESCE_MS,
  flushTimeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
  setTimer = (callback, delay) => window.setTimeout(callback, delay),
  clearTimer = (timer) => window.clearTimeout(timer),
  now = () => Date.now(),
  onMetrics = () => {}
}) {
  if (typeof save !== "function") throw new Error("Response cache save queue requires save().");

  const pending = new Map();
  let timer = 0;
  let running = false;
  let drainPromise = null;
  let waiters = [];
  const metrics = {
    received: 0,
    coalesced: 0,
    completed: 0,
    failed: 0,
    pending: 0,
    inFlight: 0,
    lastPayloadBytes: 0,
    lastSaveMs: 0,
    maxSaveMs: 0,
    lastFailureAt: 0
  };

  function snapshotMetrics() {
    return { ...metrics, pending: pending.size, inFlight: metrics.inFlight };
  }

  function publishMetrics(reason) {
    try {
      onMetrics({ reason, ...snapshotMetrics() });
    } catch {}
  }

  function settleWaiters() {
    if (running || pending.size || timer) return;
    const current = waiters;
    waiters = [];
    for (const resolve of current) resolve(snapshotMetrics());
  }

  function schedule() {
    if (timer || running || !pending.size) return;
    timer = setTimer(() => {
      timer = 0;
      void drain();
    }, Math.max(0, Number(coalesceMs) || 0));
  }

  async function drain() {
    if (running) return drainPromise;
    if (timer) {
      clearTimer(timer);
      timer = 0;
    }
    running = true;
    drainPromise = (async () => {
      while (pending.size) {
        const [key, item] = pending.entries().next().value;
        pending.delete(key);
        metrics.pending = pending.size;
        metrics.inFlight = 1;
        metrics.lastPayloadBytes = payloadBytes(item.entry);
        const startedAt = now();
        try {
          await save(item.entry);
          metrics.completed += 1;
        } catch (error) {
          metrics.failed += 1;
          metrics.lastFailureAt = now();
          item.onError?.(error);
        } finally {
          const duration = Math.max(0, now() - startedAt);
          metrics.lastSaveMs = duration;
          metrics.maxSaveMs = Math.max(metrics.maxSaveMs, duration);
          metrics.inFlight = 0;
          metrics.pending = pending.size;
        }
      }
    })().finally(() => {
      running = false;
      drainPromise = null;
      publishMetrics("drain");
      if (pending.size) schedule();
      settleWaiters();
    });
    return drainPromise;
  }

  function enqueue(key, entry, { immediate = false, onError } = {}) {
    const normalizedKey = String(key || "");
    if (!normalizedKey) return snapshotMetrics();
    metrics.received += 1;
    if (pending.has(normalizedKey)) metrics.coalesced += 1;
    pending.set(normalizedKey, { entry, onError });
    metrics.pending = pending.size;
    if (immediate) void drain();
    else schedule();
    return snapshotMetrics();
  }

  async function flush({ timeoutMs = flushTimeoutMs, reason = "manual" } = {}) {
    if (timer) {
      clearTimer(timer);
      timer = 0;
    }
    if (pending.size && !running) void drain();
    if (!running && !pending.size) {
      publishMetrics(`flush:${reason}`);
      return { flushed: true, timedOut: false, ...snapshotMetrics() };
    }

    let timeout = 0;
    const completed = new Promise((resolve) => waiters.push(resolve));
    const timeoutPromise = new Promise((resolve) => {
      timeout = setTimer(() => resolve(null), Math.max(1, Number(timeoutMs) || DEFAULT_FLUSH_TIMEOUT_MS));
    });
    const result = await Promise.race([completed, timeoutPromise]);
    if (timeout) clearTimer(timeout);
    const flushed = Boolean(result) && !running && !pending.size;
    publishMetrics(`flush:${reason}${flushed ? "" : ":timeout"}`);
    return { flushed, timedOut: !flushed, ...snapshotMetrics() };
  }

  function stats() {
    return snapshotMetrics();
  }

  function dispose() {
    if (timer) clearTimer(timer);
    timer = 0;
    settleWaiters();
  }

  return { enqueue, flush, stats, dispose };
}
