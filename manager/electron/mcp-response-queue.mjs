function positiveInteger(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizedPriority(value) {
  return value === "interactive" ? "interactive" : "background";
}

export function createMcpResponseQueue(options = {}) {
  const maxConcurrent = positiveInteger(options.maxConcurrent, 2);
  const maxBackgroundConcurrent = Math.min(maxConcurrent, positiveInteger(options.maxBackgroundConcurrent, 1));
  const maxQueued = positiveInteger(options.maxQueued, 64);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const onEvent = typeof options.onEvent === "function" ? options.onEvent : () => {};
  const entries = new Map();
  const queued = [];
  let active = 0;
  let backgroundActive = 0;
  let sequence = 0;

  function snapshot() {
    return {
      active,
      backgroundActive,
      queued: queued.length,
      interactiveQueued: queued.filter((entry) => entry.priority === "interactive").length,
      backgroundQueued: queued.filter((entry) => entry.priority === "background").length
    };
  }

  function emit(type, entry, details = {}) {
    try {
      onEvent({
        type,
        key: entry?.key || "",
        priority: entry?.priority || "background",
        coalesced: Number(entry?.coalesced) || 0,
        ...snapshot(),
        ...details
      });
    } catch {}
  }

  function nextQueuedIndex() {
    const interactiveIndex = queued.findIndex((entry) => entry.priority === "interactive");
    if (interactiveIndex >= 0) return interactiveIndex;
    if (backgroundActive >= maxBackgroundConcurrent) return -1;
    return queued.length ? 0 : -1;
  }

  function finish(entry, error, value) {
    active = Math.max(0, active - 1);
    if (entry.slotPriority === "background") backgroundActive = Math.max(0, backgroundActive - 1);
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    emit(error ? "failed" : "completed", entry, {
      queue_wait_ms: Math.max(0, entry.startedAt - entry.queuedAt),
      duration_ms: Math.max(0, now() - entry.startedAt)
    });
    if (error) entry.reject(error);
    else entry.resolve(value);
    pump();
  }

  function pump() {
    while (active < maxConcurrent) {
      const index = nextQueuedIndex();
      if (index < 0) return;
      const [entry] = queued.splice(index, 1);
      entry.state = "active";
      entry.slotPriority = entry.priority;
      entry.startedAt = now();
      active += 1;
      if (entry.slotPriority === "background") backgroundActive += 1;
      const context = {
        key: entry.key,
        priority: entry.priority,
        queuedAt: entry.queuedAt,
        startedAt: entry.startedAt,
        queueWaitMs: Math.max(0, entry.startedAt - entry.queuedAt),
        activeAtEnqueue: entry.activeAtEnqueue,
        queuedAtEnqueue: entry.queuedAtEnqueue,
        get coalesced() {
          return entry.coalesced;
        }
      };
      emit("started", entry, { queue_wait_ms: context.queueWaitMs });
      Promise.resolve()
        .then(() => entry.task(context))
        .then((value) => finish(entry, null, value), (error) => finish(entry, error));
    }
  }

  function run(key, task, runOptions = {}) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) throw new Error("MCP response queue key is required.");
    if (typeof task !== "function") throw new TypeError("MCP response queue task must be a function.");
    const priority = normalizedPriority(runOptions.priority);
    const existing = entries.get(normalizedKey);
    if (existing) {
      existing.coalesced += 1;
      const priorityUpgraded = existing.state === "queued" && priority === "interactive" && existing.priority !== "interactive";
      if (priorityUpgraded) existing.priority = "interactive";
      emit("coalesced", existing, { requested_priority: priority, priority_upgraded: priorityUpgraded });
      pump();
      return existing.promise;
    }

    if (queued.length >= maxQueued) {
      const error = new Error("MCP response queue is full; retry after the current reads finish.");
      error.code = "MCP_RESPONSE_QUEUE_FULL";
      emit("rejected", { key: normalizedKey, priority, coalesced: 0 }, { error_code: error.code });
      return Promise.reject(error);
    }

    let resolve;
    let reject;
    const promise = new Promise((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    const entry = {
      key: normalizedKey,
      task,
      priority,
      promise,
      resolve,
      reject,
      state: "queued",
      queuedAt: now(),
      startedAt: 0,
      activeAtEnqueue: active,
      queuedAtEnqueue: queued.length,
      coalesced: 0,
      sequence: sequence += 1
    };
    entries.set(normalizedKey, entry);
    queued.push(entry);
    emit("queued", entry);
    pump();
    return promise;
  }

  return { run, snapshot };
}
