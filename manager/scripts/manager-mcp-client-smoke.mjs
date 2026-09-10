import assert from "node:assert/strict";

import { createMcpCausalTelemetry } from "../electron/mcp-causal-telemetry.mjs";
import { createManagerMcpClient } from "../electron/mcp/manager-mcp-client.mjs";

function jsonResponse(payload, { status = 200, sessionId = "", contentType = "application/json" } = {}) {
  return new Response(payload === undefined ? "" : JSON.stringify(payload), {
    status,
    headers: {
      "content-type": contentType,
      ...(sessionId ? { "mcp-session-id": sessionId } : {})
    }
  });
}

function sseResponse(events, { status = 200, sessionId = "" } = {}) {
  return new Response(events.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join(""), {
    status,
    headers: {
      "content-type": "text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {})
    }
  });
}

function requestRecord(url, init = {}) {
  return {
    url: String(url),
    method: String(init.method || "GET"),
    headers: Object.fromEntries(new Headers(init.headers || {}).entries()),
    body: init.body ? JSON.parse(String(init.body)) : null,
    signal: init.signal
  };
}

const calls = [];
const diagnostics = [];
const allowedChecks = [];
const timeouts = [];
const lifecycle = [];
const causalTelemetry = createMcpCausalTelemetry();
let toolCallIndex = 0;

const fetchImpl = async (url, init = {}) => {
  const record = requestRecord(url, init);
  calls.push(record);
  if (record.method === "DELETE") return new Response("", { status: 204 });
  const body = record.body || {};
  if (body.method === "initialize") {
    return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }, { sessionId: "manager-session-1" });
  }
  if (body.method === "notifications/initialized") return jsonResponse(undefined, { status: 202 });
  if (body.method === "tools/call") {
    toolCallIndex += 1;
    if (body.params?.name === "json_tool") {
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { mode: "json", index: toolCallIndex } } });
    }
    if (body.params?.name === "sse_tool") {
      return sseResponse([
        { jsonrpc: "2.0", id: body.id, result: { structuredContent: { mode: "sse-first", index: toolCallIndex } } },
        { jsonrpc: "2.0", id: body.id, result: { structuredContent: { mode: "sse-second" } } }
      ]);
    }
    if (body.params?.name === "error_tool") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          isError: true,
          content: [{ type: "text", text: "fallback tool failure" }],
          structuredContent: {
            error: {
              name: "FixtureMcpError",
              code: "FIXTURE_TOOL_ERROR",
              message: "structured tool failure",
              details: { fixture: true }
            }
          }
        }
      });
    }
  }
  throw new Error(`Unexpected fake fetch request: ${record.method} ${body.method || ""}`);
};

const client = createManagerMcpClient({
  managerVersion: "9.8.7-smoke",
  diagnostic: (...args) => diagnostics.push(args),
  diagnosticAllowed: (key, intervalMs) => {
    allowedChecks.push({ key, intervalMs });
    return true;
  },
  causalTelemetry,
  emitCausalTelemetry: (stage, call, force = false) => lifecycle.push({ stage, call: causalTelemetry.snapshot(call), force }),
  fetchImpl,
  timeoutSignal: (timeoutMs) => {
    timeouts.push(timeoutMs);
    return new AbortController().signal;
  }
});

const session = await client.openLocalMcpSession(
  { port: 8793 },
  "fixture-token",
  {
    caller: "get_profile_response",
    response_read_id: "response-read-42",
    runtime_freshness_iteration_id: "freshness-7"
  }
);
assert.equal(session.url, "http://127.0.0.1:8793/mcp");
assert.equal(session.sessionId, "manager-session-1");
assert.equal(session.nextId, 2);
assert.equal(typeof session.phaseTimings.initialize_ms, "number");
assert.equal(typeof session.phaseTimings.initialized_notification_ms, "number");
assert.equal(typeof session.phaseTimings.open_total_ms, "number");
assert.equal(session.causalTelemetryCall.response_read_id, "response-read-42");
assert.equal(session.causalTelemetryCall.runtime_freshness_iteration_id, "freshness-7");

assert.equal(calls[0].method, "POST");
assert.equal(calls[0].url, "http://127.0.0.1:8793/mcp");
assert.equal(calls[0].headers.authorization, "Bearer fixture-token");
assert.equal(calls[0].headers.connection, "close");
assert.equal(calls[0].headers["mcp-session-id"], undefined);
assert.equal(calls[0].body.jsonrpc, "2.0");
assert.equal(calls[0].body.id, 1);
assert.equal(calls[0].body.method, "initialize");
assert.equal(calls[0].body.params.protocolVersion, "2025-06-18");
assert.deepEqual(calls[0].body.params.capabilities, {});
assert.deepEqual(calls[0].body.params.clientInfo, { name: "CodexPro Manager", version: "9.8.7-smoke" });
assert.equal(calls[1].body.method, "notifications/initialized");
assert.equal(calls[1].headers["mcp-session-id"], "manager-session-1");

const jsonResult = await client.localMcpToolInSession(session, "json_tool", { action: "json" }, 4321);
assert.deepEqual(jsonResult, { mode: "json", index: 1 });
assert.equal(calls[2].body.id, 2);
assert.equal(calls[2].headers["mcp-session-id"], "manager-session-1");
assert.equal(session.nextId, 3);

const sseResult = await client.localMcpToolInSession(session, "sse_tool", { action: "sse" }, 5432);
assert.deepEqual(sseResult, { mode: "sse-first", index: 2 }, "Manager SSE transport must return the first usable event payload");
assert.equal(calls[3].body.id, 3);
assert.equal(session.nextId, 4);

await assert.rejects(
  () => client.localMcpToolInSession(session, "error_tool", { action: "error" }, 6543),
  (error) => {
    assert.equal(error.name, "FixtureMcpError");
    assert.equal(error.code, "FIXTURE_TOOL_ERROR");
    assert.equal(error.message, "structured tool failure");
    assert.deepEqual(error.details, { fixture: true });
    return true;
  }
);
assert.equal(calls[4].body.id, 4);
assert.equal(session.nextId, 5);
assert.equal(session.phaseTimings.tool_call_count, 3);
assert.equal(typeof session.phaseTimings.tool_call_ms, "number");
assert.ok(session.phaseTimings.tool_call_ms >= 0);

await client.closeLocalMcpSession(session);
const closeCall = calls.at(-1);
assert.equal(closeCall.method, "DELETE");
assert.equal(closeCall.headers.authorization, "Bearer fixture-token");
assert.equal(closeCall.headers.connection, "close");
assert.equal(closeCall.headers["mcp-session-id"], "manager-session-1");
assert.deepEqual(timeouts, [15000, 15000, 4321, 5432, 6543, 3000]);

assert.equal(lifecycle[0].stage, "open_started");
assert.equal(lifecycle[1].stage, "initialized");
assert.equal(lifecycle.filter((event) => event.stage === "tool_completed").length, 3);
assert.equal(lifecycle.at(-2).stage, "close_started");
assert.equal(lifecycle.at(-1).stage, "close_completed");
assert.equal(lifecycle[0].call.caller, "get_profile_response");
assert.equal(lifecycle[0].call.response_read_id, "response-read-42");
assert.equal(lifecycle[0].call.runtime_freshness_iteration_id, "freshness-7");
assert.equal(causalTelemetry.counters().MCP_INITIALIZE_IN_FLIGHT, 0);
assert.equal(causalTelemetry.counters().MCP_SESSIONS_IN_FLIGHT, 0);
assert.ok(diagnostics.some((entry) => entry[1] === "mcp" && entry[2] === "tool" && entry[4]?.action === "json_tool:json"));

const httpClient = createManagerMcpClient({
  managerVersion: "smoke",
  diagnostic: () => {},
  diagnosticAllowed: () => true,
  causalTelemetry: createMcpCausalTelemetry(),
  fetchImpl: async () => jsonResponse({ error: { message: "payload failure" } }),
  timeoutSignal: () => new AbortController().signal
});
await assert.rejects(
  () => httpClient.mcpRequest("http://127.0.0.1:8793/mcp", "", { jsonrpc: "2.0", id: 8, method: "fixture" }),
  /payload failure/
);

const statusClient = createManagerMcpClient({
  managerVersion: "smoke",
  diagnostic: () => {},
  diagnosticAllowed: () => true,
  causalTelemetry: createMcpCausalTelemetry(),
  fetchImpl: async () => jsonResponse({}, { status: 503 }),
  timeoutSignal: () => new AbortController().signal
});
await assert.rejects(
  () => statusClient.mcpRequest("http://127.0.0.1:8793/mcp", "", { jsonrpc: "2.0", id: 9, method: "fixture" }),
  /MCP HTTP 503/
);

const closeDiagnostics = [];
const closeLifecycle = [];
const closeCalls = [];
const closeTelemetry = createMcpCausalTelemetry();
const closeFailureClient = createManagerMcpClient({
  managerVersion: "close-smoke",
  diagnostic: (...args) => closeDiagnostics.push(args),
  diagnosticAllowed: () => true,
  causalTelemetry: closeTelemetry,
  emitCausalTelemetry: (stage) => closeLifecycle.push(stage),
  timeoutSignal: () => new AbortController().signal,
  fetchImpl: async (url, init = {}) => {
    const record = requestRecord(url, init);
    closeCalls.push(record);
    if (record.method === "DELETE") throw new Error("synthetic close failure");
    const body = record.body || {};
    if (body.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }, { sessionId: "close-session" });
    if (body.method === "notifications/initialized") return jsonResponse(undefined, { status: 202 });
    if (body.method === "tools/call") return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { ok: true } } });
    throw new Error("unexpected close-failure request");
  }
});
const closeFailureSession = await closeFailureClient.openLocalMcpSession({ port: 8793 }, "close-token");
await assert.doesNotReject(() => closeFailureClient.closeLocalMcpSession(closeFailureSession));
assert.ok(closeDiagnostics.some((entry) => entry[4]?.action === "close-mcp-session"));
assert.deepEqual(closeLifecycle.slice(-2), ["close_started", "close_completed"]);

const oneShotResult = await closeFailureClient.localMcpTool({ port: 8793 }, "close-token", "one_shot", { action: "run" });
assert.deepEqual(oneShotResult, { ok: true });
await new Promise((resolve) => setImmediate(resolve));
assert.ok(closeCalls.some((call) => call.method === "DELETE"), "localMcpTool must still trigger fire-and-forget session close");

console.log("manager-mcp-client-smoke: ok");
