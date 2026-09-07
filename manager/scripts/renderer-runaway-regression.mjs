import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

import { installResponseAutoPin } from "../src/chat-scroll.js";
import { mergeNetworkStreamTranscript } from "../src/chat-transcript.js";
import { pruneTimestampMap } from "../src/performance-retention.js";
import { mergeBrowserProfilePayload } from "../src/ui-performance.js";

const managerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vite = await createServer({
  root: managerDir,
  appType: "custom",
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true }
});

try {
const viewportModule = await vite.ssrLoadModule("/src/hooks/use-chat-viewport.js");
const sessionModule = await vite.ssrLoadModule("/src/hooks/use-chat-session.js");
const mainSource = fs.readFileSync(path.join(managerDir, "src", "main.jsx"), "utf8");

assert.equal(
  typeof viewportModule.syncTurnAnchorPresentation,
  "function",
  "chat viewport must expose an idempotent turn-anchor presentation helper"
);
assert.equal(
  typeof sessionModule.shouldScheduleGeneratingPoll,
  "function",
  "chat session must expose the generating-poll ownership guard"
);

class CountingClassList {
  constructor() {
    this.values = new Set();
    this.writeCount = 0;
  }
  contains(value) {
    return this.values.has(value);
  }
  add(value) {
    this.writeCount += 1;
    this.values.add(value);
  }
  remove(value) {
    this.writeCount += 1;
    this.values.delete(value);
  }
}

class CountingStyle {
  constructor() {
    this.values = new Map();
    this.writeCount = 0;
  }
  getPropertyValue(name) {
    return this.values.get(name) || "";
  }
  setProperty(name, value) {
    this.writeCount += 1;
    this.values.set(name, String(value));
  }
  removeProperty(name) {
    this.writeCount += 1;
    const previous = this.values.get(name) || "";
    this.values.delete(name);
    return previous;
  }
}

const presentation = { classList: new CountingClassList(), style: new CountingStyle() };
assert.equal(viewportModule.syncTurnAnchorPresentation(presentation, true, "320px"), true);
for (let index = 0; index < 5_000; index += 1) {
  assert.equal(viewportModule.syncTurnAnchorPresentation(presentation, true, "320px"), false);
}
assert.equal(presentation.classList.writeCount, 1, "repeated autopin must not rewrite an unchanged class");
assert.equal(presentation.style.writeCount, 1, "repeated autopin must not rewrite an unchanged style value");
assert.equal(viewportModule.syncTurnAnchorPresentation(presentation, true, "360px"), true);
assert.equal(presentation.classList.writeCount, 1, "anchor-space-only updates must not rewrite the class");
assert.equal(presentation.style.writeCount, 2, "anchor-space changes should write style exactly once");
assert.equal(viewportModule.syncTurnAnchorPresentation(presentation, false), true);
for (let index = 0; index < 5_000; index += 1) {
  assert.equal(viewportModule.syncTurnAnchorPresentation(presentation, false), false);
}
assert.equal(presentation.classList.writeCount, 2, "repeated clear must not rewrite an absent class");
assert.equal(presentation.style.writeCount, 3, "repeated clear must not rewrite an absent style property");

assert.equal(sessionModule.shouldScheduleGeneratingPoll("profile-a", "profile-a"), true);
assert.equal(sessionModule.shouldScheduleGeneratingPoll("", "profile-a"), false, "closed popup must not schedule generating polls");
assert.equal(sessionModule.shouldScheduleGeneratingPoll("profile-b", "profile-a"), false, "background profile must not schedule generating polls");
assert.equal(typeof sessionModule.createCanonicalResponseReadCoordinator, "function", "chat session must expose its canonical response read coordinator");

let canonicalNow = 1_000;
let realCanonicalFetchCount = 0;
let releaseCanonicalFetch;
const canonicalCoordinator = sessionModule.createCanonicalResponseReadCoordinator({ now: () => canonicalNow, maxCooldownMs: 60_000 });
const canonicalRead = () => {
  realCanonicalFetchCount += 1;
  return new Promise((resolve) => { releaseCanonicalFetch = resolve; });
};
const firstCanonicalRead = canonicalCoordinator.run("profile-a:conversation-a", canonicalRead);
const overlappingCanonicalRead = canonicalCoordinator.run("profile-a:conversation-a", canonicalRead);
assert.equal(firstCanonicalRead, overlappingCanonicalRead, "concurrent canonical readers must share one in-flight promise");
await Promise.resolve();
assert.equal(realCanonicalFetchCount, 1, "overlapping canonical readers must issue one real fetch");
releaseCanonicalFetch({
  canonical_rate_limited: true,
  canonical_rate_limit_count: 3,
  canonical_retry_after_ms: 20_000,
  canonical_retry_at: new Date(canonicalNow + 20_000).toISOString()
});
await firstCanonicalRead;
for (let index = 0; index < 2_000; index += 1) {
  const deferred = await canonicalCoordinator.run("profile-a:conversation-a", async () => {
    realCanonicalFetchCount += 1;
    return { canonical_rate_limited: false };
  });
  assert.equal(deferred.canonical_poll_deferred, true, "429 cooldown must defer renderer canonical polling");
}
assert.equal(realCanonicalFetchCount, 1, "REAL_CANONICAL_FETCH_COUNT must not rise during 429 cooldown");
canonicalNow += 19_999;
await canonicalCoordinator.run("profile-a:conversation-a", async () => {
  realCanonicalFetchCount += 1;
  return { canonical_rate_limited: false };
});
assert.equal(realCanonicalFetchCount, 1, "canonical fetch must remain suppressed until cooldown expires");
canonicalNow += 1;
await canonicalCoordinator.run("profile-a:conversation-a", async () => {
  realCanonicalFetchCount += 1;
  return { canonical_rate_limited: false };
});
assert.equal(realCanonicalFetchCount, 2, "canonical fetch may resume exactly when cooldown expires");
for (let index = 0; index < 200; index += 1) {
  await canonicalCoordinator.run(`profile-${index}:conversation-${index}`, async () => ({ canonical_rate_limited: false }));
}
canonicalCoordinator.prune(96);
assert.ok(canonicalCoordinator.size() <= 96, `canonical poll coordinator must stay bounded, got ${canonicalCoordinator.size()}`);

let profiles = [{ profile_id: "profile-a", title: "Worker", state: "idle", last_seen: "0" }];
const initialProfiles = profiles;
for (let index = 1; index <= 2_000; index += 1) {
  profiles = mergeBrowserProfilePayload(profiles, [{ profile_id: "profile-a", title: "Worker", state: "idle", last_seen: String(index) }]);
}
assert.equal(profiles, initialProfiles, "heartbeat-only refreshes must preserve browser profile array identity");

let transcript = Array.from({ length: 140 }, (_, index) => ({ id: `user-${index}`, role: "user", text: `message ${index}` }));
for (let index = 1; index <= 2_000; index += 1) {
  transcript = mergeNetworkStreamTranscript(transcript, {
    conversationId: "conversation-a",
    text: `stream chunk ${index}`
  });
}
assert.ok(transcript.length <= 96, `stream transcript must stay bounded, got ${transcript.length}`);
assert.equal(
  transcript.filter((message) => message?.id === "network-stream-assistant:conversation-a").length,
  1,
  "repeated stream refreshes must update one provisional assistant instead of accumulating messages"
);

const timestamps = new Map();
const now = Date.now();
for (let index = 0; index < 2_000; index += 1) timestamps.set(`conversation-${index}`, now - index);
pruneTimestampMap(timestamps, { now, maxAgeMs: Number.POSITIVE_INFINITY, maxEntries: 128 });
assert.ok(timestamps.size <= 128, `timestamp retention helper must cap cache entries, got ${timestamps.size}`);
assert.match(
  mainSource,
  /networkStreamPushTimes\.current,[\s\S]{0,400}\]\) trimMapEntries\(map, 96\)/,
  "Manager retention sweep must bound networkStreamPushTimes"
);

let nextFrameId = 0;
const frames = new Map();
let cancelledFrames = 0;
const windowObject = {
  requestAnimationFrame(callback) {
    const id = ++nextFrameId;
    frames.set(id, callback);
    return id;
  },
  cancelAnimationFrame(id) {
    if (frames.delete(id)) cancelledFrames += 1;
  }
};
let mutationObserver = null;
let resizeObserver = null;
class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.disconnected = false;
    mutationObserver = this;
  }
  observe() {}
  disconnect() {
    this.disconnected = true;
  }
}
class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback;
    this.disconnected = false;
    resizeObserver = this;
  }
  observe() {}
  disconnect() {
    this.disconnected = true;
  }
}
const container = { children: [] };
const cleanup = installResponseAutoPin({
  panel: {},
  getContainer: () => container,
  isLocked: () => false,
  scrollToBottom: () => {},
  windowObject,
  MutationObserverClass: FakeMutationObserver,
  ResizeObserverClass: FakeResizeObserver
});
assert.equal(frames.size, 1, "autopin attach should have one pending animation frame");
mutationObserver.callback();
mutationObserver.callback();
assert.equal(frames.size, 1, "repeated observer notifications must coalesce to one pending animation frame");
cleanup();
assert.equal(mutationObserver.disconnected, true, "autopin mutation observer must disconnect on unmount/reopen cleanup");
assert.equal(resizeObserver.disconnected, true, "autopin resize observer must disconnect on unmount/reopen cleanup");
assert.equal(frames.size, 0, "autopin cleanup must cancel the pending animation frame");
assert.ok(cancelledFrames >= 1, "autopin cleanup must cancel scheduled work");

const sessionSource = fs.readFileSync(path.join(managerDir, "src", "hooks", "use-chat-session.js"), "utf8");
assert.match(
  sessionSource,
  /if \(networkState === "generating" \|\| tab\.busy \|\| tab\.settling\) \{\s*if \(!shouldScheduleGeneratingPoll\(chatProfileId, profile\.profile_id\)\) continue;/,
  "generating/activity branch must gate new polls to the currently open popup profile"
);
assert.match(sessionSource, /if \(currentResponse\?\.finalityPending\)/, "finality polling must remain intact");
assert.match(
  sessionSource,
  /if \(networkState !== "completed" \|\| !networkCompletedAt\) continue;[\s\S]*?const canonical = await loadCanonicalResponse\(profile, conversationId\);/,
  "background completion verification must remain intact and use the shared canonical coordinator"
);
assert.match(
  sessionSource,
  /const canonical = await loadCanonicalResponse\(profile, conversationId\);[\s\S]*?canonical_poll_deferred[\s\S]*?canonical_rate_limited/,
  "latest-response polling must obey renderer canonical cooldown before DOM fallback"
);
assert.doesNotMatch(
  sessionSource,
  /openChatAwaitingAssistant, openChatLatestMessageKey\]\);/,
  "message updates must not restart the latest-response poller"
);

console.log("renderer runaway regression passed");
} finally {
  await vite.close();
}
