(() => {
  const SOURCE = "codexpro-network-stream-v1";
  const MESSAGE_TYPE = "codexpro-network-stream";

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const payload = event.data;
    if (!payload || payload.source !== SOURCE || payload.type !== "stream-update" || !payload.event) return;
    try {
      const result = chrome.runtime.sendMessage({ type: MESSAGE_TYPE, event: payload.event });
      result?.catch?.(() => undefined);
    } catch {
      // Realtime streaming is opportunistic; the normal response poll remains the recovery path.
    }
  });
})();
