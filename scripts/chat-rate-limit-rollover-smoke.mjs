import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CHAT_HISTORY_RATE_LIMIT_ROLLOVER_THRESHOLD,
  chatHistoryRateLimitRecoveryCandidate
} from "../manager/src/chat-recovery-policy.js";

const worker = readFileSync(new URL("../chrome-extension/service-worker.js", import.meta.url), "utf8");
const manager = readFileSync(new URL("../manager/src/main.jsx", import.meta.url), "utf8");
const managerMain = readFileSync(new URL("../manager/electron/main.mjs", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../src/browserExtensionBridge.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

const taskId = "cpt_1234567890abcdef12345678";
const conversationId = "12345678-abcd-1234-abcd-1234567890ab";
const profile = {
  profile_id: "chrome-rate-limit",
  connected: true,
  activity: "working",
  current_task_id: taskId,
  current_task_conversation_id: conversationId
};

assert.equal(CHAT_HISTORY_RATE_LIMIT_ROLLOVER_THRESHOLD, 3, "three consecutive throttled canonical reads must trigger recovery");
assert.equal(chatHistoryRateLimitRecoveryCandidate({
  profile,
  jobs: [{ job_id: taskId, worker_id: profile.profile_id, status: "running" }],
  response: {
    conversationId,
    repoTaskId: taskId,
    awaitingAssistant: true,
    canonicalRateLimited: true,
    canonicalRateLimitCount: 2
  }
}), null, "one transient burst must stay in cooldown instead of moving the task");

assert.deepEqual(chatHistoryRateLimitRecoveryCandidate({
  profile,
  jobs: [{ job_id: taskId, worker_id: profile.profile_id, status: "running" }],
  response: {
    conversationId,
    repoTaskId: taskId,
    awaitingAssistant: true,
    canonicalRateLimited: true,
    canonicalRateLimitCount: 3
  }
}), { profileId: profile.profile_id, conversationId, taskId, reason: "chatgpt_history_rate_limited" }, "a running task must move after the bounded 429 threshold");

assert.equal(chatHistoryRateLimitRecoveryCandidate({
  profile: { ...profile, activity: "idle" },
  jobs: [{ job_id: taskId, worker_id: profile.profile_id, status: "completed" }],
  response: {
    conversationId,
    repoTaskId: taskId,
    awaitingAssistant: false,
    canonicalRateLimited: true,
    canonicalRateLimitCount: 9
  }
}), null, "opening throttled history for a completed task must never create a continuation chat");

assert.match(worker, /function canonicalRateLimitBackoffMs[\s\S]*CANONICAL_RATE_LIMIT_MAX_BACKOFF_MS/, "worker must implement capped 429 backoff");
assert.match(worker, /async function readCanonicalConversationForTab[\s\S]*canonicalReadStatesByConversation/, "all canonical callers must share a conversation single-flight/cooldown");
assert.match(worker, /canonical_rate_limited:true[\s\S]*canonical_rate_limit_count/, "unopened 429 must be returned as transient structured state");
assert.match(worker, /const activityAnchor=current\.busy[\s\S]*current\.busy_since/, "failed probes must not keep canonical busy alive forever");
assert.match(worker, /function resetChatTabDocumentEpoch[\s\S]*realtimeNetworkStreamsByTab\.delete\(tabId\)[\s\S]*chatCanonicalActivityByTab\.delete\(tabId\)[\s\S]*changeInfo\?\.status==='loading'\)resetChatTabDocumentEpoch\(tabId\)/, "same-URL reloads must discard the previous document's realtime and canonical epochs");

assert.match(manager, /chatHistoryRateLimitRecoveryCandidate[\s\S]*forceContinuation: true/, "Manager must automatically move a throttled running task to a continuation chat");
assert.match(manager, /previousTaskId: recoveryTaskId[\s\S]*taskMode: recoveryTaskId \? "recovery" : "new"/, "recovery rollover must preserve the logical Task ID");
assert.match(managerMain, /const recoveryRequested = payload\?\.taskMode === "recovery"/, "backend must distinguish recovery from a new FIFO task");
assert.match(managerMain, /repo_task_mode: recoveryAccepted \? "recovery"/, "backend result must report recovery ownership explicitly");
assert.match(managerMain, /action: "rebind_profile_task"[\s\S]*task_id: taskId[\s\S]*conversation_id: recoveryConversationId/, "backend must atomically rebind the running task after the new conversation ACK");
assert.match(managerMain, /const taskText = recoveryAccepted[\s\S]*"@CodexPro"[\s\S]*không gọi begin_repo_task lần nữa/i, "the continuation chat must activate CodexPro without beginning a second logical task");
assert.match(bridge, /export function rebindBrowserExtensionProfileTaskConversation[\s\S]*profileTaskIds\.get\(id\) !== normalizedTaskId[\s\S]*profileTaskConversationIds\.set\(id, normalizedConversationId\)/, "bridge must reject stale task ownership before changing the persisted conversation binding");
assert.match(server, /args\.action === "rebind_profile_task"[\s\S]*\["prepared", "running"\][\s\S]*rebindBrowserExtensionProfileTaskConversation/, "server must only rebind a durable active task owned by the selected profile");
assert.ok(server.indexOf('if (args.action === "rebind_profile_task")') < server.indexOf('const useExtension = args.browser !== "dedicated"'), "server must handle recovery rebinding locally before dispatching extension commands");
assert.match(server, /const conversationOwnsTask = Boolean\(taskBinding[\s\S]*taskBinding\.taskId === args\.task_id[\s\S]*terminalOutcome && conversationOwnsTask[\s\S]*worker_job_finalization_skipped = "conversation_rebound"/, "a late terminal response from the abandoned conversation must not finalize the rebound task");

console.log("chat-rate-limit-rollover-smoke: ok");
