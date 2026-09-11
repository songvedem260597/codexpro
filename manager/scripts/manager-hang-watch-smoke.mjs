import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readManagerHangWatchDiagnostics } from "../electron/manager-hang-watch-diagnostics.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-hang-watch-"));
const recorderDir = path.join(root, "manager-hang-flight-recorder");
const incidentDir = path.join(recorderDir, "incidents");
const fixedNow = Date.parse("2026-09-11T15:00:10.000Z");

function snapshot(overrides = {}) {
  return {
    timestamp: "2026-09-11T15:00:09.000Z",
    wall_time_ms: fixedNow - 1_000,
    process: { pid: 1234, cpu_utilization_percent: 12.5, rss: 256 * 1024 * 1024, heap_used: 80 * 1024 * 1024 },
    event_loop: { timer_drift_ms: 4, peak_delay_ms: 18 },
    renderer: { responsive: true, last_unresponsive_at: "", last_responsive_at: "2026-09-11T15:00:08.000Z" },
    mcp: { initialize_in_flight: 0, session_tool_in_flight: 1, oldest_in_flight_age_ms: 250 },
    response_reads: { in_flight: 1, queued: 0, oldest_read_age_ms: 300 },
    browser_stream: { in_flight: 0, backlog: 0, last_progress_age_ms: 100 },
    runtime: { health_known: true, local_ok: true, health_age_ms: 500, child_pids: [4321, 4322] },
    context: [{ profile_id: "profile-a", task_id: "cpt_aaaaaaaaaaaaaaaaaaaaaaaa", conversation_id: "conv-a" }],
    ...overrides
  };
}

function incident(id, options = {}) {
  const detectedAt = options.detectedAt || "2026-09-11T14:59:00.000Z";
  return {
    schema_version: 1,
    incident_id: id,
    detected_at_ms: Date.parse(detectedAt),
    detected_at: detectedAt,
    likely_started_at: detectedAt,
    active_signals: options.signals || ["renderer_unresponsive"],
    correlations: [{ profile_id: "profile-a", task_id: "cpt_aaaaaaaaaaaaaaaaaaaaaaaa", conversation_id: "conv-a" }],
    pre_freeze_snapshots: options.evidence || [snapshot()],
    current_snapshot: options.current || snapshot({ renderer: { responsive: false } }),
    peak_event_loop_delay_ms: 2400,
    oldest_mcp_age_ms: 61000,
    oldest_response_read_age_ms: 62000,
    renderer_state: { responsive: options.recovered === true },
    recovered: options.recovered === true,
    recovered_at: options.recovered === true ? "2026-09-11T14:59:05.000Z" : "",
    duration_ms: options.recovered === true ? 5000 : null,
    final_snapshot: options.recovered === true ? snapshot() : null
  };
}

async function writeCheckpoint(snapshots = [snapshot()], extra = {}) {
  await fs.mkdir(recorderDir, { recursive: true });
  await fs.writeFile(path.join(recorderDir, "checkpoint.json"), JSON.stringify({
    schema_version: 1,
    manager_pid: 1234,
    written_at: "2026-09-11T15:00:09.000Z",
    sample_interval_ms: 2000,
    snapshots,
    active_incident: null,
    ...extra
  }), "utf8");
}

async function writeIncident(value, order = 1) {
  await fs.mkdir(incidentDir, { recursive: true });
  await fs.writeFile(path.join(incidentDir, `${String(order).padStart(13, "0")}-${value.incident_id}.json`), JSON.stringify(value), "utf8");
}

try {
  await writeCheckpoint();
  const liveHealthy = { started: true, history: [snapshot()], active_incident: null, checkpoint_interval_ms: 15000 };
  const healthy = await readManagerHangWatchDiagnostics({ codexProHome: root, liveState: liveHealthy, now: () => fixedNow });
  assert.equal(healthy.state, "HEALTHY", "healthy recorder must render HEALTHY");
  assert.equal(healthy.current.renderer_responsive, true);
  assert.equal(healthy.current.mcp_in_flight, 1);
  assert.deepEqual(healthy.current.child_pids, [4321, 4322]);

  const active = incident("mgrhang_active");
  const frozen = await readManagerHangWatchDiagnostics({
    codexProHome: root,
    liveState: { ...liveHealthy, history: [active.current_snapshot], active_incident: active },
    now: () => fixedNow
  });
  assert.equal(frozen.state, "FREEZE_DETECTED", "authoritative active incident must render FREEZE DETECTED");
  assert.equal(frozen.current.renderer_responsive, false);
  assert.equal(frozen.active_incident.state, "ACTIVE");

  const recovered = incident("mgrhang_recovered", { recovered: true });
  await writeIncident(recovered, 2);
  const recoveredData = await readManagerHangWatchDiagnostics({ codexProHome: root, liveState: liveHealthy, incidentId: recovered.incident_id, now: () => fixedNow });
  assert.equal(recoveredData.selected_incident.state, "RECOVERED");
  assert.equal(recoveredData.selected_incident.duration_ms, 5000);
  assert.equal(recoveredData.selected_incident.pre_freeze_evidence.length, 1);
  assert.equal(recoveredData.selected_incident.correlations[0].task_id, "cpt_aaaaaaaaaaaaaaaaaaaaaaaa");

  const missingRoot = path.join(root, "missing");
  const missing = await readManagerHangWatchDiagnostics({ codexProHome: missingRoot, liveState: { started: true, history: [] }, now: () => fixedNow });
  assert.equal(missing.state, "WARNING");
  assert.equal(missing.current, null);
  assert.ok(missing.issues.includes("checkpoint_missing"));

  const corruptRoot = path.join(root, "corrupt");
  await fs.mkdir(path.join(corruptRoot, "manager-hang-flight-recorder", "incidents"), { recursive: true });
  await fs.writeFile(path.join(corruptRoot, "manager-hang-flight-recorder", "checkpoint.json"), "{not-json", "utf8");
  await fs.writeFile(path.join(corruptRoot, "manager-hang-flight-recorder", "incidents", "0000000000001-bad.json"), "{bad", "utf8");
  const corrupt = await readManagerHangWatchDiagnostics({ codexProHome: corruptRoot, liveState: { started: true, history: [] }, now: () => fixedNow });
  assert.equal(corrupt.state, "WARNING");
  assert.ok(corrupt.issues.includes("checkpoint_invalid"));
  assert.ok(corrupt.issues.includes("incident_invalid"));

  for (let index = 0; index < 25; index += 1) await writeIncident(incident(`mgrhang_${index}`, { recovered: true }), 100 + index);
  const bounded = await readManagerHangWatchDiagnostics({ codexProHome: root, liveState: liveHealthy, now: () => fixedNow });
  assert.equal(bounded.recent_incidents.length, 20, "recent incident response must be bounded to 20");

  const uiSource = await fs.readFile(new URL("../src/hang-watch-view.jsx", import.meta.url), "utf8");
  const diagnosticsSource = await fs.readFile(new URL("../src/diagnostics-view.jsx", import.meta.url), "utf8");
  const ipcSource = await fs.readFile(new URL("../electron/ipc/diagnostic-log-ipc.mjs", import.meta.url), "utf8");
  assert.ok(uiSource.includes("getHangWatchDiagnostics"), "Hang Watch must read through Manager API");
  assert.ok(uiSource.includes("Làm mới"), "manual refresh must remain available");
  assert.ok(!uiSource.includes("setInterval"), "Hang Watch must not background poll");
  assert.ok(!uiSource.match(/api\.(?:restart|kill|cancel)|on(?:Restart|Kill|Cancel)|>\s*(?:Restart|Kill|Cancel|Dừng)\s*</i), "Hang Watch must not expose restart/kill/cancel actions");
  assert.ok(diagnosticsSource.includes("<DiagnosticLogView"), "existing Diagnostics log screen must remain mounted in Logs tab");
  assert.ok(diagnosticsSource.includes("Hang Watch"), "Diagnostics must expose Hang Watch tab");
  assert.ok(ipcSource.includes("codexpro:get-hang-watch-diagnostics"));
  assert.ok(!ipcSource.includes("writeFile") && !ipcSource.includes("rm("), "Hang Watch IPC must remain read-only");

  console.log("✓ manager Hang Watch diagnostics smoke passed");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
