import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeBrowserProfilePayload, mergeRuntimeStatus } from "../src/ui-performance.js";

const profile = {
  profile_id: "profile-a",
  connected: true,
  activity: "idle",
  last_seen: "2026-09-11T14:00:00.000Z",
  conversation_tabs: [{ id: 1, busy: false }]
};
const integrationBusyMessage = "Không thể tiếp tục: WORKSPACE_TASK_RESUME_INTEGRATION_BUSY: finish the active integration before resuming.";

const blocked = mergeRuntimeStatus(null, {
  checkedAt: "2026-09-11T14:00:00.000Z",
  browserProfiles: [{
    ...profile,
    task_recovery_state: "blocked",
    task_recovery_message: integrationBusyMessage,
    task_recovery_task_id: "cpt_busy",
    task_recovery_attempt: 1
  }],
  workerJobs: [{ job_id: "cpt_busy", worker_id: "profile-a", status: "running" }],
  workerSnapshotAvailable: true,
  workerJobsAvailable: true
});
assert.equal(blocked.browserProfiles[0].task_recovery_state, "blocked", "active integration-busy recovery state must remain current");
assert.equal(blocked.browserProfiles[0].task_recovery_message, integrationBusyMessage, "active integration-busy must remain visible");
assert.equal(blocked.browserProfiles[0].activity, "idle", "error presentation must not change worker activity");

const ready = mergeRuntimeStatus(blocked, {
  checkedAt: "2026-09-11T14:00:05.000Z",
  browserProfiles: [{ ...profile, last_seen: "2026-09-11T14:00:05.000Z" }],
  workerJobs: [],
  workerSnapshotAvailable: true,
  workerJobsAvailable: true
});
assert.equal(ready.browserProfiles[0].activity, "idle", "new ready snapshot must preserve idle activity");
assert.equal(ready.browserProfiles[0].task_recovery_state, "", "authoritative ready state must clear stale recovery state");
assert.equal(ready.browserProfiles[0].task_recovery_message, "", "authoritative ready state must clear stale integration-busy message");
assert.deepEqual(ready.workerJobs, [], "renderer cleanup must not invent or mutate task execution state");

const olderPartial = mergeBrowserProfilePayload(ready.browserProfiles, [{
  ...profile,
  last_seen: "2026-09-11T14:00:01.000Z"
}]);
assert.equal(olderPartial[0].task_recovery_message, "", "older partial worker update must not resurrect the cleared message");
assert.equal(olderPartial[0].activity, "idle", "older partial update must not change worker activity rendering");

const currentFailureMessage = "Không thể tiếp tục: worker có nhiều task running cùng lúc, không thể chọn owner an toàn.";
const currentFailure = mergeRuntimeStatus(ready, {
  checkedAt: "2026-09-11T14:00:10.000Z",
  browserProfiles: [{
    ...profile,
    last_seen: "2026-09-11T14:00:10.000Z",
    task_recovery_state: "blocked",
    task_recovery_message: currentFailureMessage,
    task_recovery_task_id: "",
    task_recovery_attempt: 0
  }],
  workerJobs: [],
  workerSnapshotAvailable: true,
  workerJobsAvailable: true
});
assert.equal(currentFailure.browserProfiles[0].task_recovery_state, "blocked", "current non-transient failure must remain active");
assert.equal(currentFailure.browserProfiles[0].task_recovery_message, currentFailureMessage, "current non-transient failure must not be hidden");

const managerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cardSource = fs.readFileSync(path.join(managerRoot, "src", "features", "profiles", "browser-profiles-section.jsx"), "utf8");
assert.match(cardSource, /taskRecoveryMessage\s*&&[\s\S]{0,180}profile-task-recovery is-\$\{taskRecoveryState/, "worker card must continue rendering a current recovery error with its state tone");

console.log("Worker card transient error smoke OK");
