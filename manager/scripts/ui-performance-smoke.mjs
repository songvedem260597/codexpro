import assert from "node:assert/strict";
import { mergeBrowserProfilePayload, mergeRuntimeStatus, sameProjectList } from "../src/ui-performance.js";

const previous = [{
  profile_id: "profile-a",
  connected: true,
  activity: "idle",
  last_seen: "2026-08-30T11:00:00.000Z",
  conversation_tabs: [{ id: 1, busy: false }],
  current_workspace_repo: "owner/repo"
}];

const heartbeatOnly = [{
  profile_id: "profile-a",
  connected: true,
  activity: "idle",
  last_seen: "2026-08-30T11:00:01.000Z",
  conversation_tabs: [{ id: 1, busy: false }]
}];

const heartbeatMerge = mergeBrowserProfilePayload(previous, heartbeatOnly);
assert.equal(heartbeatMerge, previous, "heartbeat-only profile changes must preserve array identity");
assert.equal(heartbeatMerge[0], previous[0], "heartbeat-only profile changes must preserve profile identity");
assert.equal(heartbeatMerge[0].current_workspace_repo, "owner/repo", "manager-enriched fields must be preserved");

let heartbeatState = previous;
let heartbeatPublications = 0;
for (let index = 0; index < 1000; index += 1) {
  const next = mergeBrowserProfilePayload(heartbeatState, [{ ...heartbeatOnly[0], last_seen: `2026-08-30T11:${String(index % 60).padStart(2, "0")}:01.000Z` }]);
  if (next !== heartbeatState) heartbeatPublications += 1;
  heartbeatState = next;
}
assert.equal(heartbeatPublications, 0, "1000 heartbeat-only updates must not publish UI state changes");

const working = [{ ...heartbeatOnly[0], activity: "working" }];
const workingMerge = mergeBrowserProfilePayload(previous, working);
assert.notEqual(workingMerge, previous, "meaningful profile changes must publish a new array");
assert.equal(workingMerge[0].activity, "working");
assert.equal(workingMerge[0].current_workspace_repo, "owner/repo");

const projects = [{ root: "C:/repo", name: "repo" }];
assert.equal(sameProjectList(projects, [{ root: "C:/repo", name: "repo" }]), true);
assert.equal(sameProjectList(projects, [{ root: "C:/repo", name: "repo-2" }]), false);

const lastGoodStatus = {
  checkedAt: "2026-08-31T16:29:30.000Z",
  local: { ok: true },
  browserProfiles: previous,
  workers: [{ worker_id: "chrome:profile-a", worker_type: "browser" }],
  workerSources: [{ worker_id: "chrome:profile-a", source: "browser" }],
  workerJobs: [{ job_id: "job-a", status: "completed" }],
  workerSnapshotAvailable: true,
  workerJobsAvailable: true
};
const timedOutStatus = {
  checkedAt: "2026-08-31T16:30:06.000Z",
  local: { ok: false, error: "The operation was aborted due to timeout" },
  browserProfiles: [],
  workers: [],
  workerSources: [],
  workerJobs: [],
  workerSnapshotAvailable: false,
  workerJobsAvailable: false
};
const staleMerge = mergeRuntimeStatus(lastGoodStatus, timedOutStatus);
assert.equal(staleMerge.local.ok, false, "health state must still report the current MCP timeout");
assert.equal(staleMerge.browserProfiles, previous, "a transient timeout must preserve the last good profiles");
assert.equal(staleMerge.workers, lastGoodStatus.workers, "a transient timeout must preserve the last good workers");
assert.equal(staleMerge.workerJobs, lastGoodStatus.workerJobs, "failed history reads must preserve prior job history");
assert.equal(staleMerge.workerSnapshotStale, true, "preserved worker data must be marked stale");
assert.equal(staleMerge.workerSnapshotStaleSince, timedOutStatus.checkedAt);

const secondTimeout = mergeRuntimeStatus(staleMerge, {
  ...timedOutStatus,
  checkedAt: "2026-08-31T16:30:36.000Z"
});
assert.equal(secondTimeout.workerSnapshotStaleSince, timedOutStatus.checkedAt, "repeated timeouts must preserve the first stale timestamp");

const authoritativeEmpty = mergeRuntimeStatus(secondTimeout, {
  ...timedOutStatus,
  checkedAt: "2026-08-31T16:31:06.000Z",
  local: { ok: true },
  workerSnapshotAvailable: true,
  workerJobsAvailable: true
});
assert.deepEqual(authoritativeEmpty.browserProfiles, [], "a successful authoritative empty snapshot must clear disconnected profiles");
assert.deepEqual(authoritativeEmpty.workers, [], "a successful authoritative empty snapshot must clear disconnected workers");
assert.equal(authoritativeEmpty.workerSnapshotStale, false, "a successful refresh must clear the stale marker");
assert.equal(authoritativeEmpty.workerSnapshotStaleSince, "");

console.log("UI performance smoke OK");
