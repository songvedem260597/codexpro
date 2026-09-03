import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectTaskHangCandidates, createTaskHangTracker } from "../electron/task-hang-tracker.mjs";

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
assert.equal(networkCandidate.recoverable, true, "a task with stable task/conversation ids must be eligible for continuation");

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

assert.equal(detectTaskHangCandidates([profile({}, {
  network_state: "generating",
  network_error: "",
  connection_interrupted: false,
  network_status_code: 200
})], baseNow).length, 0, "healthy generation must not create a hang incident");

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
assert.match(main, /async function continueTaskAfterHang\(incident\)[\s\S]*?forceContinuation: true[\s\S]*?taskId,[\s\S]*?conversationId,[\s\S]*?targetTab/, "close-and-continue must force a continuation while preserving the current task id and exact tab");
assert.match(main, /onContinueAfterHang=\{\(incident\) => void continueTaskAfterHang\(incident\)\}/, "Control Center must receive the continuation handler");
assert.match(electronMain, /createTaskHangTracker\(\{ home: codexProHome \}\)/, "Manager must persist task hang incidents under CodexPro home");
assert.match(electronMain, /taskHangTracker\.reconcile\(browserProfiles\)/, "runtime status must reconcile hang state from live browser profiles");
assert.match(electronMain, /browserProfileSnapshot\.available[\s\S]*?\? taskHangTracker\.reconcile\(browserProfiles\)[\s\S]*?: taskHangTracker\.snapshot\(\)/, "a temporary profile snapshot outage must preserve active hang incidents instead of falsely resolving them");
assert.match(electronMain, /taskHangIncidents: taskHangTracking\.incidents[\s\S]*?taskHangSummary: taskHangTracking\.summary/, "runtime status must expose hang incidents and aggregate statistics");

console.log("✓ Control Center task hang management smoke test passed");
