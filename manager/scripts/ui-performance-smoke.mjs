import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EMPTY_BROWSER_PROFILE_GRACE_MS, mergeBrowserProfilePayload, mergeRuntimeStatus, normalizeTerminalMessageStreamProfiles, sameProjectList, stabilizeEmptyBrowserProfileSnapshot } from "../src/ui-performance.js";

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

const emptyStartedAt = Date.parse("2026-08-30T11:00:10.000Z");
const transientEmpty = stabilizeEmptyBrowserProfileSnapshot(previous, [], { nowMs: emptyStartedAt });
assert.equal(transientEmpty.profiles, previous, "the first all-empty snapshot must preserve the last good worker cards");
assert.equal(transientEmpty.preserved, true);
assert.equal(transientEmpty.emptySinceMs, emptyStartedAt);
assert.equal(transientEmpty.retryAfterMs, EMPTY_BROWSER_PROFILE_GRACE_MS);

const explicitlyDisabled = stabilizeEmptyBrowserProfileSnapshot(previous, [], {
  nowMs: emptyStartedAt,
  removedProfileIds: ["profile-a"]
});
assert.deepEqual(explicitlyDisabled.profiles, [], "an explicitly disabled profile must bypass the transient empty grace");
assert.equal(explicitlyDisabled.preserved, false);
assert.equal(explicitlyDisabled.emptySinceMs, 0);

const recoveredBeforeGrace = stabilizeEmptyBrowserProfileSnapshot(previous, heartbeatOnly, {
  nowMs: emptyStartedAt + 5_000,
  emptySinceMs: transientEmpty.emptySinceMs
});
assert.equal(recoveredBeforeGrace.preserved, false, "a recovered heartbeat must immediately clear the empty-snapshot gate");
assert.equal(recoveredBeforeGrace.emptySinceMs, 0);

const confirmedEmpty = stabilizeEmptyBrowserProfileSnapshot(previous, [], {
  nowMs: emptyStartedAt + EMPTY_BROWSER_PROFILE_GRACE_MS,
  emptySinceMs: transientEmpty.emptySinceMs
});
assert.deepEqual(confirmedEmpty.profiles, [], "an all-empty snapshot that survives the grace period must clear disconnected workers");
assert.equal(confirmedEmpty.preserved, false);

const terminalTaskId = "cpt_111111111111111111111111";
const terminalConversationId = "terminal-chat-1234";
const terminalProfiles = [{
  profile_id: "profile-terminal",
  connected: true,
  activity: "settling",
  busy_request_count: 0,
  busy_since: "2026-09-04T21:00:00.000Z",
  current_task_id: terminalTaskId,
  current_task_conversation_id: terminalConversationId,
  conversation_tabs: [{
    id: 88,
    url: `https://chatgpt.com/c/${terminalConversationId}`,
    busy: false,
    settling: true,
    message_stream_error: true,
    activity_text: "Lỗi luồng phản hồi · đang chuyển sang chat mới",
    network_state: "completed",
    network_stream_in_progress: false
  }]
}];
const terminalJobs = [{ job_id: terminalTaskId, worker_id: "profile-terminal", status: "completed", completion_confirmed: true }];
const normalizedTerminalProfiles = normalizeTerminalMessageStreamProfiles(terminalProfiles, terminalJobs);
assert.notEqual(normalizedTerminalProfiles, terminalProfiles, "terminal message-stream cleanup must publish a corrected profile snapshot");
assert.equal(normalizedTerminalProfiles[0].activity, "idle", "a terminal task must not leave its profile in settling");
assert.equal(normalizedTerminalProfiles[0].busy_since, "", "terminal settling cleanup must clear the stale busy timestamp");
assert.equal(normalizedTerminalProfiles[0].conversation_tabs[0].settling, false, "a terminal message-stream banner must not keep the tab settling");
assert.equal(normalizedTerminalProfiles[0].conversation_tabs[0].message_stream_error, false, "a terminal message-stream banner must stop participating in active recovery state");
assert.equal(normalizedTerminalProfiles[0].conversation_tabs[0].terminal_message_stream_error, true, "the raw terminal message-stream condition must remain available for diagnostics");
assert.equal(normalizedTerminalProfiles[0].conversation_tabs[0].terminal_message_stream_task_id, terminalTaskId);
assert.equal(normalizedTerminalProfiles[0].conversation_tabs[0].terminal_message_stream_activity_text, "Lỗi luồng phản hồi · đang chuyển sang chat mới");

const runningTerminalCandidate = normalizeTerminalMessageStreamProfiles(terminalProfiles, [{ ...terminalJobs[0], status: "running", completion_confirmed: false }]);
assert.equal(runningTerminalCandidate, terminalProfiles, "an unfinished task must keep live message-stream recovery untouched");
const activeGenerationCandidate = normalizeTerminalMessageStreamProfiles([{ ...terminalProfiles[0], conversation_tabs: [{ ...terminalProfiles[0].conversation_tabs[0], network_state: "generating", network_stream_in_progress: true }] }], terminalJobs);
assert.equal(activeGenerationCandidate[0].conversation_tabs[0].settling, true, "terminal metadata must never mask a newer active generation");

const historicalTaskId = "cpt_222222222222222222222222";
const historicalTerminal = normalizeTerminalMessageStreamProfiles([{ ...terminalProfiles[0], current_task_id: "cpt_333333333333333333333333", current_task_conversation_id: "new-chat-5678", conversation_tabs: [{ ...terminalProfiles[0].conversation_tabs[0], url: "https://chatgpt.com/c/old-chat-1234", flight_recorder_latest_task_id: historicalTaskId }] }], [{ job_id: historicalTaskId, worker_id: "profile-terminal", status: "completed" }]);
assert.equal(historicalTerminal[0].conversation_tabs[0].settling, false, "a stale old tab must use flight-recorder task ownership to clear terminal settling");

const mergedTerminalStatus = mergeRuntimeStatus(null, {
  browserProfiles: terminalProfiles,
  workerJobs: terminalJobs,
  workerSnapshotAvailable: true,
  workerJobsAvailable: true
});
assert.equal(mergedTerminalStatus.browserProfiles[0].activity, "idle", "authoritative status refreshes must normalize terminal message-stream settling before render");
assert.equal(mergedTerminalStatus.browserProfiles[0].conversation_tabs[0].terminal_message_stream_error, true);

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

const managerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererSource = fs.readFileSync(path.join(managerRoot, "src", "main.jsx"), "utf8");
const mainProcessSource = fs.readFileSync(path.join(managerRoot, "electron", "main.mjs"), "utf8");
assert.match(rendererSource, /onBrowserProfiles\?\.\(\(payload\) => \{[\s\S]*?normalizeTerminalMessageStreamProfiles\(incomingProfiles, current\.workerJobs\)/, "realtime profile events must normalize terminal message-stream settling before they can overwrite corrected status");
assert.match(rendererSource, /const responseMemoryCache = useRef\(new Map\(\)\)/, "recent chat transcripts must stay in renderer memory for instant revisit");
assert.match(rendererSource, /function prefetchProfileResponseCaches\(profile\)/, "recent chat transcript caches must be prefetched before selection");
assert.match(rendererSource, /responseMemoryCache\.current\.has\(key\)[\s\S]{0,180}await getResponseCacheEntry/, "chat hydration must use the synchronous renderer-memory path before IPC");
assert.match(rendererSource, /loadResponseMarkdownModule\(\)[\s\S]{0,80}\}, 120\)/, "heavy Markdown rendering code must warm shortly after app mount");
assert.match(mainProcessSource, /let managerChatCacheIndex = null;/, "main process must keep a chat-cache lookup index");
assert.match(mainProcessSource, /if \(managerChatCacheEntries && managerChatCacheIndex\) return managerChatCacheEntries;/, "main process must avoid rereading the cache file after warmup");
assert.match(mainProcessSource, /setImmediate\(\(\) => readManagerChatCache\(\)\)/, "main process must warm the persistent chat cache after window creation");
assert.match(mainProcessSource, /insideRepository: true/, "project discovery must inspect direct child folders of a Git repo for nested projects");
assert.match(mainProcessSource, /if \(item\.insideRepository\) continue;/, "nested project discovery must stop after one bounded child level");

console.log("UI performance smoke OK");
