import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

async function reserveFreePort() {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  assert.ok(port > 0, "a temporary browser bridge port must be allocated");
  return port;
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-flight-recorder-smoke-"));
const port = await reserveFreePort();
process.env.CODEXPRO_HOME = home;
process.env.CODEXPRO_BROWSER_EXTENSION_BRIDGE_PORT = String(port);

const bridge = await import(`../dist/browserExtensionBridge.js?flight-recorder-smoke=${Date.now()}`);
assert.equal(bridge.BROWSER_EXTENSION_BRIDGE_PORT, port, "the smoke bridge must use its isolated test port");

const state = bridge.ensureBrowserExtensionBridge();
if (!state.server.listening) await once(state.server, "listening");

const origin = "chrome-extension://flight-recorder-smoke";
const profileId = "flight-recorder-smoke-profile";
const taskId = "cpt_flight_recorder_smoke";
const taskTitle = "Smoke flight recorder endpoint";
const baseUrl = `http://127.0.0.1:${port}`;

async function post(endpoint, body) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "origin": origin,
      "x-codexpro-extension": "profile-bridge-v1"
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  assert.equal(response.ok, true, `${endpoint} failed: ${JSON.stringify(payload)}`);
  return payload;
}

try {
  await post("/register", {
    profile: {
      id: profileId,
      enabled: true,
      email: "flight-recorder-smoke@local.invalid",
      label: "Flight Recorder Smoke",
      version: "0.0.0-smoke"
    }
  });

  bridge.setBrowserExtensionProfileTask(profileId, taskId, taskTitle);

  const commandPromise = bridge.runBrowserExtensionCommand("check_chatgpt", { target_id: 77 }, profileId);
  const polled = await post("/poll", {
    profile: {
      id: profileId,
      enabled: true,
      label: "Flight Recorder Smoke",
      version: "0.0.0-smoke"
    }
  });
  assert.equal(polled.command?.action, "check_chatgpt", "the isolated extension poll must receive the queued command");
  assert.equal(polled.command?.args?.profile_id, profileId, "queued commands must carry their profile id into the recorder context");
  assert.equal(polled.command?.args?.task_id, taskId, "queued commands must carry their task id into the recorder context");
  assert.equal(polled.command?.args?.task_title, taskTitle, "queued commands must carry their task title into the recorder context");

  await post("/result", {
    profile: { id: profileId, enabled: true, label: "Flight Recorder Smoke", version: "0.0.0-smoke" },
    command_id: polled.command.id,
    result: { ok: true, smoke: true }
  });
  const commandResult = await commandPromise;
  assert.equal(commandResult.smoke, true, "the queued command must still complete normally after metadata injection");

  const at = new Date().toISOString();
  const incidentResponse = await post("/flight-recorder", {
    profile: {
      id: profileId,
      enabled: true,
      email: "flight-recorder-smoke@local.invalid",
      label: "Flight Recorder Smoke",
      version: "0.0.0-smoke"
    },
    incident: {
      id: "flight-recorder-smoke-incident",
      at,
      at_ms: Date.parse(at),
      reason: "cdp",
      kind: "Runtime.exceptionThrown",
      message: "Synthetic renderer exception",
      profile_id: profileId,
      tab_id: 77,
      window_id: 9,
      conversation_id: "",
      task_id: "",
      task_title: "",
      command_id: polled.command.id,
      action: "check_chatgpt",
      url: "https://chatgpt.com/c/12345678-abcd",
      event: { event: "Runtime.exceptionThrown", text: "Synthetic renderer exception" },
      events: [
        { event: "Network.requestWillBeSent", method: "POST", url: "https://chatgpt.com/backend-api/conversation" },
        { event: "Runtime.exceptionThrown", text: "Synthetic renderer exception" }
      ]
    }
  });
  assert.equal(incidentResponse.incident_id, "flight-recorder-smoke-incident", "the bridge must acknowledge the persisted incident id");

  const logFallbackAt = new Date(Date.now() + 1).toISOString();
  await post("/flight-recorder", {
    profile: { id: profileId, enabled: true, label: "Flight Recorder Smoke", version: "0.0.0-smoke" },
    incident: {
      id: "flight-recorder-rate-limit-log-fallback",
      at: logFallbackAt,
      at_ms: Date.parse(logFallbackAt),
      reason: "cdp",
      kind: "Log.entryAdded",
      message: "Failed to load resource: the server responded with a status of 429 ()",
      profile_id: profileId,
      tab_id: 77,
      window_id: 9,
      conversation_id: "12345678-abcd",
      task_id: "",
      task_title: "",
      command_id: polled.command.id,
      action: "read_chat_response",
      url: "https://chatgpt.com/c/12345678-abcd",
      event: { event: "Log.entryAdded", level: "error", text: "Failed to load resource: the server responded with a status of 429 ()", url: "https://chatgpt.com/backend-api/conversations/12345678-abcd" },
      events: []
    }
  });

  const consoleFallbackAt = new Date(Date.now() + 2).toISOString();
  await post("/flight-recorder", {
    profile: { id: profileId, enabled: true, label: "Flight Recorder Smoke", version: "0.0.0-smoke" },
    incident: {
      id: "flight-recorder-rate-limit-console-fallback",
      at: consoleFallbackAt,
      at_ms: Date.parse(consoleFallbackAt),
      reason: "cdp",
      kind: "Runtime.consoleAPICalled",
      message: "RequestError: Too many requests",
      profile_id: profileId,
      tab_id: 77,
      window_id: 9,
      conversation_id: "12345678-abcd",
      task_id: "",
      task_title: "",
      command_id: polled.command.id,
      action: "read_chat_response",
      url: "https://chatgpt.com/c/12345678-abcd",
      event: { event: "Runtime.consoleAPICalled", level: "error", text: "RequestError: Too many requests" },
      events: []
    }
  });

  const rateLimitAt = new Date(Date.now() + 3).toISOString();
  const rateLimitResponse = await post("/flight-recorder", {
    profile: {
      id: profileId,
      enabled: true,
      email: "flight-recorder-smoke@local.invalid",
      label: "Flight Recorder Smoke",
      version: "0.0.0-smoke"
    },
    incident: {
      id: "flight-recorder-rate-limit",
      at: rateLimitAt,
      at_ms: Date.parse(rateLimitAt),
      reason: "rate_limit",
      kind: "Network.responseReceived",
      message: "ChatGPT HTTP 429 Too Many Requests: /backend-api/f/conversation",
      profile_id: profileId,
      tab_id: 77,
      window_id: 9,
      conversation_id: "12345678-abcd",
      task_id: "",
      task_title: "",
      command_id: polled.command.id,
      action: "send_chat_request",
      url: "https://chatgpt.com/c/12345678-abcd",
      event: {
        event: "Network.responseReceived",
        status: 429,
        request_id: "cdp-request-429",
        response_request_id: "server-request-429",
        retry_after: "2",
        endpoint: "/backend-api/f/conversation",
        url: "https://chatgpt.com/backend-api/f/conversation"
      },
      events: [
        { event: "Network.requestWillBeSent", request_id: "cdp-request-429", method: "POST", url: "https://chatgpt.com/backend-api/f/conversation" },
        { event: "Network.responseReceived", request_id: "cdp-request-429", status: 429, url: "https://chatgpt.com/backend-api/f/conversation" }
      ]
    }
  });
  assert.equal(rateLimitResponse.incident_id, "flight-recorder-rate-limit", "the bridge must acknowledge the dedicated 429 incident");

  const profile = bridge.listBrowserExtensionProfiles().find((item) => item.profile_id === profileId);
  assert.ok(profile, "the synthetic profile must remain visible after the incident post");
  assert.equal(profile.flight_recorder_incident_count, 4, "profile status must surface every recorder incident including console/log 429 fallbacks");
  assert.equal(profile.flight_recorder_latest_kind, "Network.responseReceived", "profile status must surface the latest recorder incident kind");
  assert.equal(profile.flight_recorder_latest_message, "ChatGPT HTTP 429 Too Many Requests: /backend-api/f/conversation", "profile status must surface the latest 429 incident message");
  assert.equal(profile.rate_limit_incident_count, 3, "profile status must count direct plus console/log fallback ChatGPT rate-limit incidents");
  assert.equal(profile.rate_limit_latest_status_code, 429, "profile status must expose the 429 status code");
  assert.equal(profile.rate_limit_latest_endpoint, "/backend-api/f/conversation", "profile status must expose the rate-limited endpoint");
  assert.equal(profile.rate_limit_latest_request_id, "cdp-request-429", "profile status must expose the CDP request id for correlation");
  assert.equal(profile.rate_limit_latest_response_request_id, "server-request-429", "profile status must expose the server request id when available");
  assert.equal(profile.rate_limit_latest_retry_after, "2", "profile status must expose Retry-After when ChatGPT sends it");
  assert.equal(profile.rate_limit_latest_task_id, taskId, "rate-limit status must be correlated back to the active CodexPro task");
  assert.equal(profile.rate_limit_latest_conversation_id, "12345678-abcd", "rate-limit status must be correlated to the affected conversation");



  const logPath = path.join(home, "browser-flight-recorder.jsonl");
  assert.equal(fs.existsSync(logPath), true, "the flight recorder must write a durable JSONL file");
  const lines = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 4, "the isolated smoke run must persist generic, fallback, and direct 429 recorder incidents");
  const persisted = JSON.parse(lines[0]);
  assert.equal(persisted.id, "flight-recorder-smoke-incident");
  assert.equal(persisted.profile_id, profileId);
  assert.equal(persisted.task_id, taskId, "the bridge must backfill a missing incident task id from profile task state");
  assert.equal(persisted.task_title, taskTitle, "the bridge must backfill a missing incident task title from profile task state");
  assert.equal(persisted.tab_id, 77);
  assert.equal(persisted.events.length, 2, "the durable snapshot must include the bounded pre-incident event context");

  const persistedLogFallback = JSON.parse(lines[1]);
  assert.equal(persistedLogFallback.id, "flight-recorder-rate-limit-log-fallback");
  assert.equal(persistedLogFallback.reason, "rate_limit", "old-worker Log.entryAdded 429 incidents must be normalized by the bridge");
  assert.equal(persistedLogFallback.event.status, 429);
  assert.equal(persistedLogFallback.event.endpoint, "/backend-api/conversations/12345678-abcd");
  assert.equal(persistedLogFallback.event.rate_limit_fallback_source, "Log.entryAdded");

  const persistedConsoleFallback = JSON.parse(lines[2]);
  assert.equal(persistedConsoleFallback.id, "flight-recorder-rate-limit-console-fallback");
  assert.equal(persistedConsoleFallback.reason, "rate_limit", "old-worker Runtime.consoleAPICalled Too many requests incidents must be normalized by the bridge");
  assert.equal(persistedConsoleFallback.event.status, 429);
  assert.equal(persistedConsoleFallback.event.rate_limit_fallback_source, "Runtime.consoleAPICalled");

  const persistedRateLimit = JSON.parse(lines[3]);
  assert.equal(persistedRateLimit.id, "flight-recorder-rate-limit");
  assert.equal(persistedRateLimit.reason, "rate_limit");
  assert.equal(persistedRateLimit.task_id, taskId, "the bridge must backfill task correlation on 429 incidents too");
  assert.equal(persistedRateLimit.event.status, 429);
  assert.equal(persistedRateLimit.event.retry_after, "2");

  const rateLimitLogPath = path.join(home, "chatgpt-rate-limit.jsonl");
  assert.equal(fs.existsSync(rateLimitLogPath), true, "ChatGPT 429 incidents must also be written to the dedicated investigation log");
  const rateLimitLines = fs.readFileSync(rateLimitLogPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
  assert.equal(rateLimitLines.length, 3, "the dedicated rate-limit log must contain direct plus console/log fallback incidents and nothing else");
  const dedicatedLogFallback = JSON.parse(rateLimitLines[0]);
  assert.equal(dedicatedLogFallback.id, "flight-recorder-rate-limit-log-fallback");
  assert.equal(dedicatedLogFallback.event.status, 429);
  assert.equal(dedicatedLogFallback.event.rate_limit_fallback_source, "Log.entryAdded");
  const dedicatedConsoleFallback = JSON.parse(rateLimitLines[1]);
  assert.equal(dedicatedConsoleFallback.id, "flight-recorder-rate-limit-console-fallback");
  assert.equal(dedicatedConsoleFallback.event.status, 429);
  assert.equal(dedicatedConsoleFallback.event.rate_limit_fallback_source, "Runtime.consoleAPICalled");
  const dedicatedRateLimit = JSON.parse(rateLimitLines[2]);
  assert.equal(dedicatedRateLimit.id, "flight-recorder-rate-limit");
  assert.equal(dedicatedRateLimit.event.endpoint, "/backend-api/f/conversation");
  assert.equal(dedicatedRateLimit.event.response_request_id, "server-request-429");

  console.log("✓ Browser flight-recorder bridge smoke test passed");
} finally {
  bridge.setBrowserExtensionProfileTask(profileId, "", "");
  if (state.server.listening) {
    await new Promise((resolve) => state.server.close(() => resolve()));
  }
  fs.rmSync(home, { recursive: true, force: true });
}
