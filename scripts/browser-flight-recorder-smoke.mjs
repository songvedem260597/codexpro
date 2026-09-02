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

  const profile = bridge.listBrowserExtensionProfiles().find((item) => item.profile_id === profileId);
  assert.ok(profile, "the synthetic profile must remain visible after the incident post");
  assert.equal(profile.flight_recorder_incident_count, 1, "profile status must surface the recorder incident count");
  assert.equal(profile.flight_recorder_latest_kind, "Runtime.exceptionThrown", "profile status must surface the latest incident kind");
  assert.equal(profile.flight_recorder_latest_message, "Synthetic renderer exception", "profile status must surface the latest incident message");

  const logPath = path.join(home, "browser-flight-recorder.jsonl");
  assert.equal(fs.existsSync(logPath), true, "the flight recorder must write a durable JSONL file");
  const lines = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, "the isolated smoke run must persist exactly one recorder incident");
  const persisted = JSON.parse(lines[0]);
  assert.equal(persisted.id, "flight-recorder-smoke-incident");
  assert.equal(persisted.profile_id, profileId);
  assert.equal(persisted.task_id, taskId, "the bridge must backfill a missing incident task id from profile task state");
  assert.equal(persisted.task_title, taskTitle, "the bridge must backfill a missing incident task title from profile task state");
  assert.equal(persisted.tab_id, 77);
  assert.equal(persisted.events.length, 2, "the durable snapshot must include the bounded pre-incident event context");

  console.log("✓ Browser flight-recorder bridge smoke test passed");
} finally {
  bridge.setBrowserExtensionProfileTask(profileId, "", "");
  if (state.server.listening) {
    await new Promise((resolve) => state.server.close(() => resolve()));
  }
  fs.rmSync(home, { recursive: true, force: true });
}
