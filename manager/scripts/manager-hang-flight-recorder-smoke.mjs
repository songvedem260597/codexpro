import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createManagerHangFlightRecorder,
  MANAGER_HANG_CHECKPOINT_INTERVAL_MS,
  MANAGER_HANG_INCIDENT_RETENTION,
  MANAGER_HANG_ROLLING_HISTORY_MS,
  MANAGER_HANG_SAMPLE_INTERVAL_MS
} from "../electron/manager-hang-flight-recorder.mjs";

const roots = [];
const makeRoot = async (label) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `codexpro-manager-hang-${label}-`));
  roots.push(root);
  return root;
};

function harness(root, overrides = {}) {
  let wall = 1_700_000_000_000;
  let mono = 10_000;
  let peak = 0;
  const state = {
    mcp: null,
    reads: null,
    browser: null,
    runtime: null,
    context: []
  };
  const diagnostics = [];
  const recorder = createManagerHangFlightRecorder({
    home: root,
    now: () => wall,
    monotonicNow: () => mono,
    eventLoopPeakMs: () => peak,
    sampleIntervalMs: 250,
    rollingHistoryMs: 1_000,
    checkpointIntervalMs: 500,
    softSustainMs: 500,
    mcpOldMs: 1_000,
    responseReadOldMs: 1_000,
    runtimeStaleMs: 1_000,
    browserStallMs: 1_000,
    diagnostic: (...args) => diagnostics.push(args),
    samplers: {
      mcp: () => state.mcp,
      responseReads: () => state.reads,
      browserStream: () => state.browser,
      runtime: () => state.runtime,
      context: () => state.context
    },
    ...overrides
  });
  return {
    recorder,
    state,
    diagnostics,
    tick(ms) {
      wall += ms;
      mono += ms;
    },
    setPeak(value) {
      peak = value;
    },
    wall: () => wall
  };
}

try {
  assert.equal(MANAGER_HANG_SAMPLE_INTERVAL_MS, 2_000);
  assert.equal(MANAGER_HANG_ROLLING_HISTORY_MS, 5 * 60_000);
  assert.equal(MANAGER_HANG_CHECKPOINT_INTERVAL_MS, 15_000);
  assert.equal(MANAGER_HANG_INCIDENT_RETENTION, 50);

  const healthyRoot = await makeRoot("healthy");
  const healthy = harness(healthyRoot);
  for (let index = 0; index < 20; index += 1) {
    healthy.recorder.sampleNow();
    healthy.tick(250);
  }
  const healthyState = healthy.recorder.state();
  assert.equal(healthyState.active_incident, null, "healthy sampling must not open an incident");
  assert.ok(healthyState.history.length <= healthyState.max_snapshots, "ring buffer must stay bounded");
  assert.ok(healthyState.history.every((snapshot) => snapshot.wall_time_ms >= healthy.wall() - 1_250), "old snapshots must rotate out of the rolling history");

  const rendererRoot = await makeRoot("renderer");
  const renderer = harness(rendererRoot);
  renderer.recorder.sampleNow();
  renderer.tick(250);
  renderer.recorder.sampleNow();
  const preFreezeCount = renderer.recorder.state().history.length;
  renderer.tick(250);
  renderer.recorder.markRendererUnresponsive();
  const rendererIncident = renderer.recorder.state().active_incident;
  assert.ok(rendererIncident, "renderer unresponsive must open an incident");
  assert.ok(rendererIncident.active_signals.includes("renderer_unresponsive"));
  assert.equal(rendererIncident.pre_freeze_snapshots.length, preFreezeCount, "incident must preserve pre-freeze snapshots");
  const rendererIncidentId = rendererIncident.incident_id;
  renderer.tick(750);
  renderer.recorder.markRendererResponsive();
  assert.equal(renderer.recorder.state().active_incident, null, "renderer recovery must close the active incident");
  await renderer.recorder.drain();
  const rendererFiles = await fs.readdir(renderer.recorder.incidentDirectory);
  assert.equal(rendererFiles.length, 1);
  const rendererPersisted = JSON.parse(await fs.readFile(path.join(renderer.recorder.incidentDirectory, rendererFiles[0]), "utf8"));
  assert.equal(rendererPersisted.incident_id, rendererIncidentId);
  assert.equal(rendererPersisted.recovered, true);
  assert.equal(rendererPersisted.duration_ms, 750, "recovery must record incident duration");
  assert.ok(rendererPersisted.final_snapshot?.renderer?.responsive);

  const gapRoot = await makeRoot("event-loop-gap");
  const gap = harness(gapRoot);
  gap.recorder.sampleNow();
  gap.tick(250);
  gap.setPeak(2_100);
  gap.recorder.sampleNow();
  assert.ok(gap.recorder.state().active_incident?.active_signals.includes("main_event_loop_gap"), "large event-loop delay must open an incident");
  gap.setPeak(0);
  gap.tick(250);
  gap.recorder.sampleNow();
  assert.equal(gap.recorder.state().active_incident, null);
  await gap.recorder.drain();

  const softRoot = await makeRoot("soft-signals");
  const soft = harness(softRoot);
  soft.recorder.sampleNow();
  soft.state.mcp = { session_tool_in_flight: 1, oldest_in_flight_age_ms: 5_000, calls: [{ mcp_call_id: "mcp-old", caller: "get_profile_response", profile_id: "profile-a", conversation_id: "conversation-a", task_id: "cpt_aaaaaaaaaaaaaaaaaaaaaaaa" }] };
  soft.recorder.sampleNow();
  soft.tick(600);
  soft.recorder.sampleNow();
  assert.equal(soft.recorder.state().active_incident, null, "one sustained soft signal must not false-trigger");
  soft.state.reads = { active: 1, oldest_active_age_ms: 5_000, entries: [{ key: "profile-a:conversation-a:dom", state: "active", age_ms: 5_000, profile_id: "profile-a", conversation_id: "conversation-a" }] };
  soft.recorder.sampleNow();
  soft.tick(600);
  soft.recorder.sampleNow();
  const softIncident = soft.recorder.state().active_incident;
  assert.ok(softIncident, "two sustained independent soft signals must open an incident");
  assert.ok(softIncident.active_signals.includes("mcp_request_old"));
  assert.ok(softIncident.active_signals.includes("profile_response_read_old"));
  const softIncidentId = softIncident.incident_id;
  soft.tick(250);
  soft.recorder.sampleNow();
  assert.equal(soft.recorder.state().active_incident?.incident_id, softIncidentId, "active incident must not duplicate every sample");
  soft.state.mcp = null;
  soft.state.reads = null;
  soft.tick(250);
  soft.recorder.sampleNow();
  assert.equal(soft.recorder.state().active_incident, null, "cleared signals must close the incident");
  await soft.recorder.drain();
  const softFiles = await fs.readdir(soft.recorder.incidentDirectory);
  assert.equal(softFiles.length, 1);
  const softPersisted = JSON.parse(await fs.readFile(path.join(soft.recorder.incidentDirectory, softFiles[0]), "utf8"));
  assert.equal(softPersisted.incident_id, softIncidentId);
  assert.equal(softPersisted.recovered, true);
  assert.ok(softPersisted.duration_ms > 0);
  assert.ok(softPersisted.correlations.some((item) => item.profile_id === "profile-a" && item.conversation_id === "conversation-a"));

  const checkpointRoot = await makeRoot("checkpoint");
  const checkpoint = harness(checkpointRoot, { rollingHistoryMs: 300_000, maxCheckpointBytes: 8 * 1024 });
  checkpoint.state.context = Array.from({ length: 12 }, (_, index) => ({
    profile_id: `profile-${index}-${"p".repeat(150)}`,
    task_id: `task-${index}-${"t".repeat(150)}`,
    conversation_id: `conversation-${index}-${"c".repeat(150)}`,
    tab_id: `tab-${index}-${"x".repeat(150)}`
  }));
  for (let index = 0; index < 80; index += 1) {
    checkpoint.recorder.sampleNow();
    checkpoint.tick(250);
  }
  await checkpoint.recorder.flushCheckpoint();
  await checkpoint.recorder.drain();
  const checkpointStat = await fs.stat(checkpoint.recorder.checkpointPath);
  assert.ok(checkpointStat.size <= 8 * 1024, "rolling checkpoint must respect its byte cap");
  const checkpointPayload = JSON.parse(await fs.readFile(checkpoint.recorder.checkpointPath, "utf8"));
  assert.ok(Array.isArray(checkpointPayload.snapshots));
  assert.ok(checkpointPayload.snapshots.length < checkpoint.recorder.state().history.length, "checkpoint must trim old snapshots when byte-bounded");

  const retentionRoot = await makeRoot("retention");
  const retention = harness(retentionRoot, { incidentRetention: 3 });
  for (let index = 0; index < 5; index += 1) {
    retention.setPeak(2_100);
    retention.recorder.sampleNow();
    retention.tick(250);
    retention.setPeak(0);
    retention.recorder.sampleNow();
    retention.tick(1_000);
  }
  await retention.recorder.drain();
  const retainedFiles = (await fs.readdir(retention.recorder.incidentDirectory)).filter((name) => name.endsWith(".json"));
  assert.equal(retainedFiles.length, 3, "incident retention must prune old incidents");

  const persistenceRoot = await makeRoot("persistence-failure");
  const persistence = harness(persistenceRoot, {
    writeAtomic: async () => { throw new Error("synthetic write failure"); }
  });
  await persistence.recorder.flushCheckpoint();
  await persistence.recorder.drain();
  assert.ok(persistence.diagnostics.some((entry) => String(entry[3] || "").includes("persistence failed")), "persistence failure must be swallowed and diagnosed");

  const samplerRoot = await makeRoot("sampler-failure");
  const sampler = harness(samplerRoot, {
    samplers: {
      mcp: () => { throw new Error("synthetic sampler failure"); },
      responseReads: () => null,
      browserStream: () => null,
      runtime: () => null,
      context: () => []
    }
  });
  const samplerSnapshot = sampler.recorder.sampleNow();
  assert.ok(samplerSnapshot, "sampler failure must not abort the recorder sample");
  assert.equal(samplerSnapshot.mcp.session_tool_in_flight, 0);
  assert.equal(sampler.recorder.state().active_incident, null);

  const lifecycleRoot = await makeRoot("lifecycle");
  const timers = new Map();
  let timerSequence = 0;
  const lifecycle = harness(lifecycleRoot, {
    setIntervalFn: (fn, ms) => {
      const handle = { id: ++timerSequence, fn, ms, unref() {} };
      timers.set(handle.id, handle);
      return handle;
    },
    clearIntervalFn: (handle) => timers.delete(handle?.id)
  });
  lifecycle.recorder.start();
  assert.equal(timers.size, 2, "recorder start must create only sample + checkpoint timers");
  lifecycle.recorder.stop();
  assert.equal(timers.size, 0, "recorder stop must clean up both timers");
  await lifecycle.recorder.drain();

  const managerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const recorderSource = await fs.readFile(path.join(managerDir, "electron", "manager-hang-flight-recorder.mjs"), "utf8");
  const mainSource = await fs.readFile(path.join(managerDir, "electron", "main.mjs"), "utf8");
  assert.doesNotMatch(recorderSource, /\b(?:app\.relaunch|process\.kill|child_process|execFile|spawn|stopProfileTask|cancelTask)\b/, "flight recorder must never invoke restart/kill/cancel actions");
  assert.match(mainSource, /managerHangFlightRecorder\.start\(\)/, "Manager startup must start the recorder");
  assert.match(mainSource, /managerHangFlightRecorder\.stop\(\)/, "Manager shutdown must stop the recorder");
  assert.match(mainSource, /win\.on\("unresponsive"[\s\S]*managerHangFlightRecorder\.markRendererUnresponsive\(\)/, "renderer unresponsive must feed the recorder");
  assert.match(mainSource, /win\.on\("responsive"[\s\S]*managerHangFlightRecorder\.markRendererResponsive\(\)/, "renderer responsive must feed recovery");
  assert.match(mainSource, /managerBrowserStreamFlightSampler = browserStreamFlightSampler/, "browser stream metrics must be exposed through an in-memory sampler only");
  assert.match(mainSource, /caller: "get_profile_response"[\s\S]*profile_id: profileId[\s\S]*conversation_id: conversationId/, "MCP response reads must retain existing correlation IDs");

  console.log("manager-hang-flight-recorder-smoke: ok");
} finally {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }).catch(() => {})));
}
