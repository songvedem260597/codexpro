function clean(value, max = 240) {
  return String(value ?? "").trim().slice(0, max);
}

function streamKey(update) {
  const profileId = clean(update?.profile_id, 180);
  const conversationId = clean(update?.conversation_id, 180);
  return profileId && conversationId ? `${profileId}:${conversationId}` : "";
}

function streamRevision(update) {
  return {
    recordId: Math.max(0, Number(update?.record_id) || 0),
    revision: Math.max(0, Number(update?.revision) || 0),
    updatedAt: Date.parse(clean(update?.updated_at, 80)) || 0
  };
}

export function browserStreamUpdateIsNewer(previous, incoming) {
  if (!previous) return true;
  const left = streamRevision(previous);
  const right = streamRevision(incoming);
  if (left.recordId && right.recordId && left.recordId !== right.recordId) return right.recordId > left.recordId;
  if (left.recordId === right.recordId && left.revision !== right.revision) return right.revision > left.revision;
  if (left.updatedAt !== right.updatedAt) return right.updatedAt >= left.updatedAt;
  return right.revision >= left.revision;
}

export function createBrowserStreamIpcCoordinator({
  send,
  ackTimeoutMs = 2_500,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = () => Date.now(),
  onTimeout
} = {}) {
  if (typeof send !== "function") throw new TypeError("browser stream IPC coordinator requires send(payload)");
  const pending = new Map();
  let inFlight = null;
  let sequence = 0;
  let paused = false;
  let destroyed = false;
  const counters = {
    sourceEvents: 0,
    sends: 0,
    acknowledgements: 0,
    payloadBytes: 0,
    timeouts: 0,
    maxInFlight: 0,
    maxPendingKeys: 0,
    startedAt: Number(now()) || Date.now()
  };

  const rememberLatest = (update) => {
    const key = streamKey(update);
    if (!key) return false;
    const previous = pending.get(key);
    if (!browserStreamUpdateIsNewer(previous, update)) return false;
    pending.set(key, update);
    counters.maxPendingKeys = Math.max(counters.maxPendingKeys, pending.size);
    return true;
  };

  const clearInFlightTimer = () => {
    if (inFlight?.timer) clearTimeoutFn(inFlight.timer);
    if (inFlight) inFlight.timer = null;
  };

  const recoverTimedOutBatch = (timedOutBatch) => {
    for (const update of timedOutBatch.updates) rememberLatest(update);
    counters.timeouts += 1;
    onTimeout?.({ sequence: timedOutBatch.sequence, pendingKeys: pending.size, timeoutMs: ackTimeoutMs });
  };

  const flush = () => {
    if (destroyed || paused || inFlight || !pending.size) return false;
    const updates = [...pending.values()];
    pending.clear();
    const batchSequence = ++sequence;
    const payload = { type: "browser-stream", sequence: batchSequence, updates };
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    const batch = {
      sequence: batchSequence,
      updates,
      payloadBytes,
      sentAt: Number(now()) || Date.now(),
      timer: null
    };
    inFlight = batch;
    counters.sends += 1;
    counters.payloadBytes += payloadBytes;
    counters.maxInFlight = Math.max(counters.maxInFlight, 1);
    try {
      send(payload);
    } catch (error) {
      inFlight = null;
      for (const update of updates) rememberLatest(update);
      throw error;
    }
    batch.timer = setTimeoutFn(() => {
      if (destroyed || inFlight?.sequence !== batchSequence) return;
      clearInFlightTimer();
      const timedOutBatch = inFlight;
      inFlight = null;
      recoverTimedOutBatch(timedOutBatch);
      flush();
    }, Math.max(250, Number(ackTimeoutMs) || 2_500));
    batch.timer?.unref?.();
    return true;
  };

  return {
    queue(updates) {
      if (destroyed) return;
      for (const update of Array.isArray(updates) ? updates : []) {
        const key = streamKey(update);
        if (!key) continue;
        counters.sourceEvents += 1;
        rememberLatest(update);
      }
      flush();
    },
    acknowledge(value) {
      const ackSequence = Math.max(0, Number(value) || 0);
      if (!inFlight || ackSequence !== inFlight.sequence) return false;
      clearInFlightTimer();
      inFlight = null;
      counters.acknowledgements += 1;
      flush();
      return true;
    },
    pause({ requeueInFlight = true } = {}) {
      if (destroyed) return;
      const current = inFlight;
      clearInFlightTimer();
      inFlight = null;
      if (requeueInFlight && current) {
        for (const update of current.updates) rememberLatest(update);
      }
      paused = true;
    },
    resume() {
      if (destroyed) return false;
      paused = false;
      return flush();
    },
    reset({ dropPending = true } = {}) {
      clearInFlightTimer();
      inFlight = null;
      paused = false;
      if (dropPending) pending.clear();
    },
    destroy() {
      destroyed = true;
      paused = true;
      clearInFlightTimer();
      inFlight = null;
      pending.clear();
    },
    flush,
    state() {
      return {
        destroyed,
        paused,
        sequence,
        inFlightSequence: inFlight?.sequence || 0,
        inFlightUpdates: inFlight?.updates || [],
        pendingKeys: pending.size,
        pending: new Map(pending)
      };
    },
    metrics() {
      return {
        ...counters,
        inFlight: inFlight ? 1 : 0,
        pendingKeys: pending.size,
        currentSequence: sequence,
        now: Number(now()) || Date.now()
      };
    }
  };
}
