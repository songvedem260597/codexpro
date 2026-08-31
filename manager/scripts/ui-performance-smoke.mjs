import assert from "node:assert/strict";
import { mergeBrowserProfilePayload, sameProjectList } from "../src/ui-performance.js";

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

console.log("UI performance smoke OK");
