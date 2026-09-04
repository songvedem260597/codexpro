import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TASK_NO_MEANINGFUL_PROGRESS_MS, detectTaskHangCandidates, createTaskHangTracker } from "../electron/task-hang-tracker.mjs";

const taskId = "cpt_aaaaaaaaaaaaaaaaaaaaaaaa";
const conversationId = "6a99b06d-8240-83ec-aac1-ba4d74f507a3";
const baseNow = Date.parse("2026-09-04T02:00:00+07:00");

function profile(overrides = {}, tabOverrides = {}) {
  return {
    profile_id: "profile-one",
    label: "Chrome test",
    current_task_id: taskId,
    current_task_title: "Test task hang tracking",
    current_task_conversation_id: conversationId,
    busy_since: new Date(baseNow - 20_000).toISOString(),
    activity: "working",
    busy_request_count: 1,
    conversation_tabs: [{
      id: 123,
      title: "Task test",
      url: `https://chatgpt.com/c/${conversationId}`,
      busy: true,
      settling: false,
      network_state: "failed",
      network_status_code: 0,
      network_error: "net::ERR_FAILED",
      network_last_completed_at: new Date(baseNow).toISOString(),
      connection_interrupted: true,
      message_delivery_timed_out: false,
      long_task_watchdog_hung: false,
      ...tabOverrides
    }],
    ...overrides
  };
}

const networkCandidate = detectTaskHangCandidates([profile()], baseNow)[0];
assert.equal(networkCandidate.source, "network", "transport failures must be classified as network hangs");
assert.equal(networkCandidate.task_id, taskId);
assert.equal(networkCandidate.recoverable, true, "a task with a stable Task ID must be eligible for checkpoint continuation");
const noConversationCandidate = detectTaskHangCandidates([profile({ current_task_conversation_id: "" }, { url: "https://chatgpt.com/" })], baseNow)[0];
assert.equal(noConversationCandidate.recoverable, true, "checkpoint task recovery must not require a ChatGPT conversation id");

const openAiCandidate = detectTaskHangCandidates([profile({
  rate_limit_incident_count: 2,
  rate_limit_latest_at: new Date(baseNow - 1_000).toISOString(),
  rate_limit_latest_message: "ChatGPT HTTP 429 Too Many Requests: /backend-api/conversations/x",
  rate_limit_latest_status_code: 429,
  rate_limit_latest_task_id: taskId
}, {
  network_status_code: 429,
  network_error: "",
  connection_interrupted: false,
  rate_limit_incident_count: 2,
  rate_limit_latest_at: new Date(baseNow - 1_000).toISOString(),
  rate_limit_latest_message: "ChatGPT HTTP 429 Too Many Requests",
  rate_limit_latest_status_code: 429,
  rate_limit_latest_task_id: taskId
})], baseNow)[0];
assert.equal(openAiCandidate.source, "openai", "HTTP 429 must be tracked as an OpenAI hang cause");
assert.equal(openAiCandidate.status_code, 429);
const messageStreamCandidate = detectTaskHangCandidates([profile({}, {
  network_state: "completed",
  network_error: "",
  connection_interrupted: false,
  message_stream_error: true,
  network_status_code: 200
})], baseNow)[0];
assert.equal(messageStreamCandidate.source, "openai", "Error in message stream must be tracked as an OpenAI hang cause");
assert.match(messageStreamCandidate.message, /Error in message stream/, "message-stream incidents must preserve the ChatGPT failure reason");

assert.equal(detectTaskHangCandidates([profile({}, {
  network_state: "generating",
  network_error: "",
  connection_interrupted: false,
  network_status_code: 200
})], baseNow).length, 0, "healthy generation must not create a hang incident");

assert.equal(TASK_NO_MEANINGFUL_PROGRESS_MS, 10 * 60_000, "running tasks must be allowed ten minutes without meaningful progress before stall recovery");
const staleProgressAt = baseNow - TASK_NO_MEANINGFUL_PROGRESS_MS - 1_000;
const stalledJob = {
  job_id: taskId,
  worker_id: "profile-one",
  status: "running",
  started_at: new Date(staleProgressAt - 60_000).toISOString(),
  updated_at: new Date(staleProgressAt).toISOString(),
  last_progress_at: new Date(staleProgressAt).toISOString()
};
const stalledCandidate = detectTaskHangCandidates([profile({ busy_since: new Date(staleProgressAt).toISOString() }, {
  network_state: "generating",
  network_error: "",
  connection_interrupted: false,
  network_status_code: 200,
  network_last_started_at: new Date(staleProgressAt).toISOString(),
  network_last_completed_at: "",
  network_stream_updated_at: new Date(staleProgressAt).toISOString()
})], baseNow, [stalledJob])[0];
assert.equal(stalledCandidate.source, "stalled", "a running task with no meaningful progress past the threshold must become a stalled incident");
assert.equal(stalledCandidate.no_meaningful_progress, true);
assert.equal(stalledCandidate.recoverable, true);
const freshProgressJob = { ...stalledJob, updated_at: new Date(baseNow - 1_000).toISOString(), last_progress_at: new Date(baseNow - 1_000).toISOString() };
assert.equal(detectTaskHangCandidates([profile({}, {
  network_state: "generating",
  network_error: "",
  connection_interrupted: false,
  network_status_code: 200,
  network_last_started_at: new Date(baseNow - 1_000).toISOString(),
  network_last_completed_at: "",
  network_stream_updated_at: new Date(baseNow - 1_000).toISOString()
})], baseNow, [freshProgressJob]).length, 0, "recent worker or stream progress must suppress false stall recovery");
const noTabStalled = detectTaskHangCandidates([profile({
  busy_since: new Date(staleProgressAt).toISOString(),
  current_task_conversation_id: "",
  conversation_tabs: []
})], baseNow, [stalledJob])[0];
assert.equal(noTabStalled?.source, "stalled", "checkpoint stall detection must survive a missing ChatGPT tab/conversation");
assert.equal(noTabStalled?.tab_id, 0);

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-task-hang-"));
let now = baseNow;
const tracker = createTaskHangTracker({ home: tempHome, now: () => now });
try {
  let snapshot = tracker.reconcile([profile()]);
  assert.equal(snapshot.summary.active_count, 1);
  assert.equal(snapshot.summary.total_count, 1);
  assert.equal(snapshot.incidents[0].occurrence, 1);
  now += 12_000;
  snapshot = tracker.reconcile([profile({}, { network_last_completed_at: new Date(baseNow).toISOString() })]);
  assert.ok(snapshot.incidents[0].duration_ms >= 12_000, "active hang duration must grow while the failure remains");

  snapshot = tracker.reconcile([profile({ activity: "idle", busy_request_count: 0 }, {
    busy: false,
    network_state: "completed",
    network_error: "",
    connection_interrupted: false,
    network_status_code: 200
  })]);
  assert.equal(snapshot.summary.active_count, 0, "incident must resolve when the task recovers");
  assert.equal(snapshot.summary.total_count, 1);
  assert.ok(snapshot.incidents[0].duration_ms >= 12_000);

  now += 5_000;
  snapshot = tracker.reconcile([profile({}, { network_last_completed_at: new Date(now).toISOString() })]);
  assert.equal(snapshot.summary.total_count, 2, "a later hang of the same task must increment the hang count");
  assert.equal(snapshot.incidents[0].occurrence, 2);
  assert.equal(fs.existsSync(tracker.storePath), true, "hang history must persist across Manager sessions");
  const reloadedTracker = createTaskHangTracker({ home: tempHome, now: () => now });
  const reloadedSnapshot = reloadedTracker.snapshot();
  assert.equal(reloadedSnapshot.summary.total_count, 2, "a fresh Manager tracker must reload persisted hang history");
  assert.equal(reloadedSnapshot.incidents[0].occurrence, 2, "persisted occurrence counters must survive Manager restart");

  const stalledTracker = createTaskHangTracker({ home: path.join(tempHome, "stalled"), now: () => baseNow });
  const stalledProfile = profile({ busy_since: new Date(staleProgressAt).toISOString() }, {
    network_state: "generating",
    network_error: "",
    connection_interrupted: false,
    network_status_code: 200,
    network_last_started_at: new Date(staleProgressAt).toISOString(),
    network_last_completed_at: "",
    network_stream_updated_at: new Date(staleProgressAt).toISOString()
  });
  let stalledSnapshot = stalledTracker.reconcile([stalledProfile], [stalledJob]);
  assert.equal(stalledSnapshot.incidents[0]?.source, "stalled");
  stalledSnapshot = stalledTracker.reconcile([stalledProfile], [stalledJob]);
  assert.equal(stalledSnapshot.incidents[0]?.source, "stalled", "reconciling an existing stalled incident must not downgrade it to network");
  assert.equal(stalledSnapshot.summary.stalled_count, 1);
} finally {
  fs.rmSync(tempHome, { recursive: true, force: true });
}

const controlCenter = fs.readFileSync(new URL("../src/control-center.jsx", import.meta.url), "utf8");
const controlStyles = fs.readFileSync(new URL("../src/control-center.css", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
const electronMain = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");

assert.match(controlCenter, /Lỗi mạng \/ OpenAI làm treo task/, "Control Center must expose a dedicated task-hang management section");
assert.match(controlCenter, /Tổng số lần treo[\s\S]*?Tổng thời gian treo/, "hang management must show counts and duration statistics");
assert.match(controlCenter, /Đóng tab \+ tiếp tục task/, "active hang rows must offer an explicit close-and-continue action");
assert.match(controlCenter, /onRecover\(profile, \{ conversationId: incident\.conversation_id, targetTab \}\)/, "same-tab recovery must target the exact incident conversation/tab");
assert.match(controlCenter, /onContinueAfterHang\(incident\)/, "continuation action must be delegated to the existing recovery path");
assert.match(controlStyles, /\.control-hang-row\.is-active\.is-openai/, "OpenAI hangs must have a distinct active incident state");
assert.match(main, /taskHangIncidents[\s\S]*?no_meaningful_progress[\s\S]*?continueTaskFromCheckpoint\(profile, taskId,[\s\S]*?automatic: true/, "Auto Recovery must continue stale running tasks from checkpoints without reopening the old conversation");
const checkpointRecoveryStart = main.indexOf("async function continueTaskFromCheckpoint(profile, taskId, options = {})");
const hangContinuationStart = main.indexOf("async function continueTaskAfterHang(incident)");
const checkpointRecovery = main.slice(checkpointRecoveryStart, hangContinuationStart);
const hangContinuation = main.slice(hangContinuationStart, main.indexOf("async function stopControlTask", hangContinuationStart));
assert.match(checkpointRecovery, /api\.resumeProfileTask\(\{[\s\S]*?profileId[\s\S]*?taskId: normalizedTaskId[\s\S]*?hangRecovery: true/, "checkpoint recovery must resume the exact Task ID in a new recovery chat");
assert.match(checkpointRecovery, /recoverProfileChat\([\s\S]*?discardOnly: true/, "old stuck tab must be discarded only after checkpoint recovery creates the new chat");
assert.match(hangContinuation, /continueTaskFromCheckpoint\(profile, taskId, \{/, "Control Center hang continuation must delegate to checkpoint recovery");
assert.doesNotMatch(hangContinuation, /recoverProfileTab\(/, "Control Center hang continuation must not route through transcript/conversation recovery");
assert.match(main, /onContinueAfterHang=\{\(incident\) => void continueTaskAfterHang\(incident\)\}/, "Control Center must receive the continuation handler");
assert.match(electronMain, /createTaskHangTracker\(\{ home: codexProHome \}\)/, "Manager must persist task hang incidents under CodexPro home");
assert.match(electronMain, /taskHangTracker\.reconcile\(taskBrowserProfiles,\s*workerJobs\)/, "runtime status must reconcile hang state from source-changing Tasks with worker progress for stall detection");
assert.match(electronMain, /browserProfileSnapshot\.available && workerJobSnapshot\.available[\s\S]*?\? taskHangTracker\.reconcile\(taskBrowserProfiles,\s*workerJobs\)[\s\S]*?: taskHangTracker\.snapshot\(\)/, "a temporary profile or worker-job snapshot outage must preserve active hang incidents instead of falsely resolving them");
assert.match(electronMain, /taskHangIncidents: taskHangTracking\.incidents[\s\S]*?taskHangSummary: taskHangTracking\.summary/, "runtime status must expose hang incidents and aggregate statistics");

console.log("✓ Control Center task hang management smoke test passed");
