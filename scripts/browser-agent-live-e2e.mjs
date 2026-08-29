import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const mcpUrl = process.env.CODEXPRO_MCP_URL || "http://127.0.0.1:8793/mcp";
const tokenFile = process.env.CODEXPRO_HTTP_TOKEN_FILE || path.join(os.homedir(), ".codexpro", "http-token");
const token = (await readFile(tokenFile, "utf8")).trim();
let sessionId = "";
let requestId = 0;

function parseMcpPayload(text) {
  const data = String(text || "").split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
  return JSON.parse(data || text || "{}");
}

async function mcpRequest(method, params = {}, timeoutMs = 120_000) {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...(method.startsWith("notifications/") ? {} : { id: ++requestId }), method, params }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  assert.equal(response.ok, true, `MCP HTTP ${response.status}`);
  sessionId = response.headers.get("mcp-session-id") || sessionId;
  const payload = parseMcpPayload(await response.text());
  if (payload.error) throw new Error(payload.error.message || "MCP request failed");
  return payload.result || {};
}

async function browserControl(args, timeoutMs = 120_000) {
  const normalizedArgs = { ...args, ...(args.target_id !== undefined ? { target_id: String(args.target_id) } : {}) };
  const result = await mcpRequest("tools/call", { name: "browser_control", arguments: normalizedArgs }, timeoutMs);
  if (result.isError) {
    const error = result.structuredContent?.error;
    throw new Error(typeof error === "object" ? error.message : result.content?.[0]?.text || String(error));
  }
  const structured = result.structuredContent || {};
  const image = result.content?.find((item) => item.type === "image");
  return image ? { ...structured, image_base64: String(image.data || "") } : structured;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

const fixture = http.createServer((req, res) => {
  if (req.url === "/ping") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><html><body>
    <main id="app">
      <label>Message <input aria-label="Message" placeholder="Message"></label>
      <button aria-label="Rerender">Rerender</button>
      <button aria-label="Close Soon">Close Soon</button>
      <output aria-live="polite">ready</output>
    </main>
    <script>
      document.querySelector('[aria-label="Rerender"]').onclick=()=>{
        const old=document.querySelector('[aria-label="Message"]');
        const next=old.cloneNode();next.value=old.value;old.replaceWith(next);
        document.querySelector('output').textContent='rerendered';
        console.info('codexpro-e2e-rerender');fetch('/ping?token=must-redact');
      };
      document.querySelector('[aria-label="Close Soon"]').onclick=()=>setTimeout(()=>window.close(),150);
    </script>
  </body></html>`);
});
await new Promise((resolve, reject) => fixture.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
const fixturePort = fixture.address().port;
const openedTabs = new Set();
let selectedProfileId = "";

try {
  await mcpRequest("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "CodexPro browser live E2E", version: "1.0" } });
  await mcpRequest("notifications/initialized");
  const listed = await browserControl({ action: "list_profiles" });
  const requestedProfileId = String(process.env.CODEXPRO_E2E_PROFILE_ID || "").trim();
  const profile = (requestedProfileId ? (listed.profiles || []).find((item) => item.profile_id === requestedProfileId && item.connected) : null)
    || (listed.profiles || []).find((item) => item.connected && item.activity === "idle")
    || (listed.profiles || []).find((item) => item.connected);
  assert.ok(profile?.profile_id, "No connected Chrome profile is available for live E2E");
  selectedProfileId = profile.profile_id;
  const baseArgs = { profile_id: profile.profile_id };
  const opened = await browserControl({ ...baseArgs, action: "open_tab", url: `http://127.0.0.1:${fixturePort}/` });
  openedTabs.add(opened.target_id);
  assert.equal(opened.background, true, "fixture tab must open in the background");
  await browserControl({ ...baseArgs, action: "wait_for", target_id: opened.target_id, role: "textbox", name: "Message", timeout_ms: 10_000 });

  const firstSnapshot = await browserControl({ ...baseArgs, action: "snapshot", target_id: opened.target_id, max_chars: 4_000 });
  const firstInput = firstSnapshot.elements.find((item) => item.role === "textbox" && item.name.includes("Message"));
  assert.match(firstInput?.ref || "", /^@e\d+$/);

  const screenshot = await browserControl({ ...baseArgs, action: "screenshot", target_id: opened.target_id });
  assert.equal(screenshot.background_capture, true);
  assert.ok(String(screenshot.image_base64 || "").length > 1_000);

  const steps = Array.from({ length: 50 }, (_, index) => index % 2 === 0
    ? { action: "type", role: "textbox", name: "Message", text: `batch-${index}` }
    : { action: "inspect_element", role: "textbox", name: "Message" });
  const batchStarted = performance.now();
  const batch = await browserControl({ ...baseArgs, action: "batch", target_id: opened.target_id, steps }, 180_000);
  const batchMs = performance.now() - batchStarted;
  assert.equal(batch.step_count, 50);

  const [concurrentA, concurrentB] = await Promise.all([
    browserControl({ ...baseArgs, action: "type", target_id: opened.target_id, role: "textbox", name: "Message", text: "concurrent-a" }),
    browserControl({ ...baseArgs, action: "type", target_id: opened.target_id, role: "textbox", name: "Message", text: "concurrent-b" })
  ]);
  assert.equal(concurrentA.ok, true);
  assert.equal(concurrentB.ok, true);

  const traced = await browserControl({ ...baseArgs, action: "click", target_id: opened.target_id, role: "button", name: "Rerender", trace: true, trace_ms: 500 });
  assert.ok(traced.cdp_trace?.events?.some((item) => item.event === "Runtime.consoleAPICalled"));
  assert.ok(traced.cdp_trace?.events?.some((item) => item.event === "Network.requestWillBeSent"));
  assert.ok(traced.cdp_trace.events.every((item) => !String(item.url || "").includes("must-redact")));
  const delta = await browserControl({ ...baseArgs, action: "snapshot", target_id: opened.target_id, delta: true, max_chars: 4_000 });
  assert.equal(delta.delta, true);
  assert.ok(delta.removed_refs.includes(firstInput.ref), "React-style replacement must invalidate the old semantic ref");

  const latencies = [];
  for (let index = 0; index < 12; index += 1) {
    const started = performance.now();
    await browserControl({ ...baseArgs, action: "snapshot", target_id: opened.target_id, delta: true, max_chars: 2_000 });
    latencies.push(performance.now() - started);
  }

  const closing = await browserControl({ ...baseArgs, action: "open_tab", url: `http://127.0.0.1:${fixturePort}/` });
  openedTabs.add(closing.target_id);
  await browserControl({ ...baseArgs, action: "wait_for", target_id: closing.target_id, role: "button", name: "Close Soon", timeout_ms: 10_000 });
  let closeInterrupted = false;
  try {
    await browserControl({ ...baseArgs, action: "batch", target_id: closing.target_id, steps: [
      { action: "click", role: "button", name: "Close Soon" },
      { action: "wait_for", selector: "#never", timeout_ms: 5_000 }
    ] }, 15_000);
  } catch {
    closeInterrupted = true;
  }
  assert.equal(closeInterrupted, true, "closing a tab mid-action must fail promptly instead of hanging");
  openedTabs.delete(closing.target_id);

  await browserControl({ ...baseArgs, action: "close_tab", target_id: opened.target_id });
  openedTabs.delete(opened.target_id);
  const reopened = await browserControl({ ...baseArgs, action: "open_tab", url: `http://127.0.0.1:${fixturePort}/` });
  openedTabs.add(reopened.target_id);
  await browserControl({ ...baseArgs, action: "wait_for", target_id: reopened.target_id, role: "textbox", name: "Message", timeout_ms: 10_000 });
  const reconnected = await browserControl({ ...baseArgs, action: "screenshot", target_id: reopened.target_id });
  assert.equal(reconnected.persistent_debugger, true, "a new tab must reconnect its CDP session");

  console.log(JSON.stringify({
    ok: true,
    profile_id: profile.profile_id,
    worker: profile.extension_version,
    background: true,
    batch_steps: batch.step_count,
    batch_ms: Math.round(batchMs),
    snapshot_p50_ms: Math.round(percentile(latencies, 0.5)),
    snapshot_p95_ms: Math.round(percentile(latencies, 0.95)),
    concurrent_calls: 2,
    react_rerender_delta: true,
    tab_close_interrupted: true,
    cdp_reconnected: true
  }, null, 2));
} finally {
  if (selectedProfileId) for (const targetId of openedTabs) await browserControl({ action: "close_tab", profile_id: selectedProfileId, target_id: targetId }).catch(() => {});
  fixture.closeAllConnections?.();
  await new Promise((resolve) => fixture.close(resolve));
}
