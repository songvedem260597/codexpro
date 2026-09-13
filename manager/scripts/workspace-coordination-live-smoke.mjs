import assert from "node:assert/strict";
import {
  liveCoordinationConflicts,
  liveCoordinationTasks,
  summarizeLiveCoordinationSnapshot
} from "../src/workspace-coordination-live.js";

const terminalConflict = {
  task_id: "cpt_terminal_conflict",
  status: "failed",
  integration_status: "conflict",
  stale_base: false
};
const terminalFailed = {
  task_id: "cpt_terminal_failed",
  status: "completed",
  integration_status: "failed",
  stale_base: false
};
const runningConflict = {
  task_id: "cpt_running_conflict",
  status: "running",
  integration_status: "conflict",
  stale_base: false
};
const runningStale = {
  task_id: "cpt_running_stale",
  status: "running",
  integration_status: "idle",
  stale_base: true
};
const runningClean = {
  task_id: "cpt_running_clean",
  status: "running",
  integration_status: "idle",
  stale_base: false
};

// A — terminal integration conflict is history, not live operational state.
assert.deepEqual(liveCoordinationTasks([terminalConflict]), []);
assert.deepEqual(liveCoordinationConflicts([terminalConflict]), []);

// B — terminal failed integration is history, not a live task.
assert.deepEqual(liveCoordinationTasks([terminalFailed]), []);

// C — a running conflict remains visible and dangerous.
assert.deepEqual(liveCoordinationTasks([runningConflict]).map((task) => task.task_id), [runningConflict.task_id]);
assert.deepEqual(liveCoordinationConflicts([runningConflict]).map((task) => task.task_id), [runningConflict.task_id]);

// D — a running stale-base task remains visible and dangerous.
assert.deepEqual(liveCoordinationTasks([runningStale]).map((task) => task.task_id), [runningStale.task_id]);
assert.deepEqual(liveCoordinationConflicts([runningStale]).map((task) => task.task_id), [runningStale.task_id]);

// E — a repo containing only terminal recovery/history records is live-clean.
const cleanHistoryOnly = summarizeLiveCoordinationSnapshot({
  tasks: [terminalConflict, terminalFailed],
  claims: [],
  integration_queue: []
});
assert.equal(cleanHistoryOnly.task_count, 0);
assert.equal(cleanHistoryOnly.claim_count, 0);
assert.equal(cleanHistoryOnly.queue_count, 0);
assert.equal(cleanHistoryOnly.conflict_count, 0);
assert.equal(cleanHistoryOnly.has_conflict, false);

// F — terminal recovery records do not inflate a mixed live snapshot.
const mixed = summarizeLiveCoordinationSnapshot({
  tasks: [runningClean, terminalConflict, terminalFailed],
  claims: [],
  integration_queue: []
});
assert.equal(mixed.task_count, 1);
assert.deepEqual(mixed.tasks.map((task) => task.task_id), [runningClean.task_id]);
assert.equal(mixed.conflict_count, 0);

console.log("workspace coordination live UI semantics smoke passed");
