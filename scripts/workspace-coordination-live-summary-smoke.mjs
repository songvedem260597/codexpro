import assert from "node:assert/strict";
import { summarizeLiveWorkspaceTasks } from "../dist/workspaceCoordination.js";

const terminalConflict = { status: "failed", integration_status: "conflict", stale_base: false };
const terminalFailed = { status: "completed", integration_status: "failed", stale_base: false };
const runningConflict = { status: "running", integration_status: "conflict", stale_base: false };
const runningStale = { status: "running", integration_status: "idle", stale_base: true };
const runningClean = { status: "running", integration_status: "idle", stale_base: false };

assert.deepEqual(
  summarizeLiveWorkspaceTasks([terminalConflict, terminalFailed]),
  { active_task_count: 0, conflict_count: 0 },
  "terminal recovery/history tasks must not contribute to live overview counters"
);
assert.deepEqual(
  summarizeLiveWorkspaceTasks([runningConflict]),
  { active_task_count: 1, conflict_count: 1 },
  "running integration conflicts must stay live"
);
assert.deepEqual(
  summarizeLiveWorkspaceTasks([runningStale]),
  { active_task_count: 1, conflict_count: 1 },
  "running stale-base tasks must stay live conflicts"
);
assert.deepEqual(
  summarizeLiveWorkspaceTasks([runningClean, terminalConflict, terminalFailed]),
  { active_task_count: 1, conflict_count: 0 },
  "terminal history must not inflate mixed live counters"
);

console.log("workspace coordination live backend summary smoke passed");
