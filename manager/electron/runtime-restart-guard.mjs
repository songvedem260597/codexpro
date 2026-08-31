export function createRuntimeRestartGuard({ sendCooldownMs = 30_000 } = {}) {
  let activeSendCount = 0;
  let restartPromise = null;
  let restartBlockedUntilMs = 0;

  const snapshot = () => ({
    activeSendCount,
    restartInProgress: Boolean(restartPromise),
    restartBlockedUntilMs
  });

  async function runSend(operation) {
    activeSendCount += 1;
    const pendingRestart = restartPromise;
    try {
      if (pendingRestart) {
        try {
          await pendingRestart;
        } catch {
          // A failed refresh must not make a user send fail before it can reconnect normally.
        }
      }
      return await operation();
    } finally {
      activeSendCount = Math.max(0, activeSendCount - 1);
      restartBlockedUntilMs = Math.max(restartBlockedUntilMs, Date.now() + sendCooldownMs);
    }
  }

  function startRestart(operation, now = Date.now()) {
    if (restartPromise) {
      return { started: false, reason: "restart-in-progress", promise: restartPromise, retryAfterMs: 0 };
    }
    if (activeSendCount > 0) {
      return { started: false, reason: "send-in-flight", promise: null, retryAfterMs: sendCooldownMs };
    }
    if (now < restartBlockedUntilMs) {
      return {
        started: false,
        reason: "send-cooldown",
        promise: null,
        retryAfterMs: Math.max(1, restartBlockedUntilMs - now)
      };
    }

    let trackedPromise;
    trackedPromise = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (restartPromise === trackedPromise) restartPromise = null;
      });
    restartPromise = trackedPromise;
    return { started: true, reason: "", promise: trackedPromise, retryAfterMs: 0 };
  }

  return { runSend, startRestart, snapshot };
}
