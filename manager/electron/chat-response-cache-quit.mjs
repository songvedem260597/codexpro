const DEFAULT_RENDERER_FLUSH_TIMEOUT_MS = 1000;
const DEFAULT_MAIN_FLUSH_TIMEOUT_MS = 1200;

export function createChatResponseCacheQuitCoordinator({
  listRenderers,
  sendFlushRequest,
  flushMainCache,
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
  now = () => Date.now()
}) {
  if (typeof listRenderers !== "function") throw new Error("Cache quit coordinator requires listRenderers().");
  if (typeof sendFlushRequest !== "function") throw new Error("Cache quit coordinator requires sendFlushRequest().");
  if (typeof flushMainCache !== "function") throw new Error("Cache quit coordinator requires flushMainCache().");

  let sequence = 0;
  const pendingRequests = new Map();

  function settleRequest(requestId) {
    const request = pendingRequests.get(requestId);
    if (!request || request.pendingIds.size) return;
    pendingRequests.delete(requestId);
    request.resolve({
      requestId,
      expected: request.expected,
      acknowledged: request.acknowledged,
      failedToSend: request.failedToSend,
      timedOut: false,
      durationMs: Math.max(0, now() - request.startedAt)
    });
  }

  function acknowledge(senderId, payload = {}) {
    const requestId = String(payload?.requestId || "");
    const request = pendingRequests.get(requestId);
    const normalizedSenderId = Number(senderId) || 0;
    if (!request || !request.pendingIds.has(normalizedSenderId)) return false;
    request.pendingIds.delete(normalizedSenderId);
    request.acknowledged += 1;
    settleRequest(requestId);
    return true;
  }

  async function requestRendererFlush(timeoutMs = DEFAULT_RENDERER_FLUSH_TIMEOUT_MS) {
    const renderers = (Array.isArray(listRenderers()) ? listRenderers() : [])
      .map((renderer) => ({ id: Number(renderer?.id) || 0, renderer }))
      .filter(({ id, renderer }) => id > 0 && renderer);
    if (!renderers.length) {
      return { requestId: "", expected: 0, acknowledged: 0, failedToSend: 0, timedOut: false, durationMs: 0 };
    }

    const requestId = `cache_flush_${now().toString(36)}_${(++sequence).toString(36)}`;
    let timeoutHandle = 0;
    const completed = new Promise((resolve) => {
      pendingRequests.set(requestId, {
        resolve,
        expected: renderers.length,
        acknowledged: 0,
        failedToSend: 0,
        pendingIds: new Set(renderers.map(({ id }) => id)),
        startedAt: now()
      });
    });

    for (const { id, renderer } of renderers) {
      try {
        sendFlushRequest(renderer, { requestId, timeoutMs: Math.max(1, Number(timeoutMs) || DEFAULT_RENDERER_FLUSH_TIMEOUT_MS) });
      } catch {
        const request = pendingRequests.get(requestId);
        if (!request) continue;
        request.failedToSend += 1;
        request.pendingIds.delete(id);
      }
    }
    settleRequest(requestId);

    if (!pendingRequests.has(requestId)) return completed;
    const timeout = new Promise((resolve) => {
      timeoutHandle = setTimer(() => {
        const request = pendingRequests.get(requestId);
        pendingRequests.delete(requestId);
        resolve({
          requestId,
          expected: request?.expected || renderers.length,
          acknowledged: request?.acknowledged || 0,
          failedToSend: request?.failedToSend || 0,
          timedOut: true,
          durationMs: Math.max(0, now() - (request?.startedAt || now()))
        });
      }, Math.max(1, Number(timeoutMs) || DEFAULT_RENDERER_FLUSH_TIMEOUT_MS));
    });
    const result = await Promise.race([completed, timeout]);
    if (timeoutHandle) clearTimer(timeoutHandle);
    return result;
  }

  async function flushBeforeQuit({
    rendererTimeoutMs = DEFAULT_RENDERER_FLUSH_TIMEOUT_MS,
    mainTimeoutMs = DEFAULT_MAIN_FLUSH_TIMEOUT_MS
  } = {}) {
    const renderer = await requestRendererFlush(rendererTimeoutMs);
    let main;
    try {
      main = await flushMainCache({ timeoutMs: Math.max(1, Number(mainTimeoutMs) || DEFAULT_MAIN_FLUSH_TIMEOUT_MS) });
    } catch (error) {
      main = {
        flushed: false,
        timedOut: false,
        error: String(error?.message || error || "Cache flush failed")
      };
    }
    return {
      renderer,
      main,
      flushed: renderer.timedOut !== true && main?.flushed === true,
      timedOut: renderer.timedOut === true || main?.timedOut === true
    };
  }

  return { acknowledge, requestRendererFlush, flushBeforeQuit };
}
