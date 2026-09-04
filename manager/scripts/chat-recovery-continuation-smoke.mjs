import assert from "node:assert/strict";
import fs from "node:fs";

const normalizeNewlines = (text) => text.replace(/\r\n/g, "\n");
const managerUi = normalizeNewlines(fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8"));
const managerMain = normalizeNewlines(fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8"));
const worker = normalizeNewlines(fs.readFileSync(new URL("../../chrome-extension/service-worker.js", import.meta.url), "utf8"));

const between = (source, start, end) => {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `Missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `Missing end marker: ${end}`);
  return source.slice(from, to);
};

const autoRecovery = between(managerUi, "useEffect(() => {\n    if (!managerSettings.autoRecovery)", "}, [managerSettings.autoRecovery, status?.browserProfiles, status?.workerJobs]);");
assert.match(autoRecovery, /recoverProfileTab\(profile, \{ targetTab, silent: true, automatic: true, hardFailure \}\)/, "auto recovery must use the same guarded continuation pipeline as manual recovery");

const recovery = between(managerUi, "async function recoveryContinuationSnapshot", "async function stopControlTask");
assert.match(recovery, /getChatResponseCache\(\{ profileId, conversationId \}\)/, "recovery must fall back to the persisted transcript cache before abandoning a stuck tab");
assert.match(recovery, /materializeTranscriptMessages\(liveResponse, conversationId\)/, "recovery must preserve the live manager transcript when available");
assert.match(recovery, /newChat: false/, "recovery must first try to reopen the original conversation");
assert.match(recovery, /continuation_reason: "recovery"/, "unrecoverable tabs must roll over through the context handoff path");
assert.match(recovery, /discardOnly: true/, "old stuck tab must be discarded only after the continuation chat is created");
assert.match(recovery, /requestTargetsRef\.current = \{ \.\.\.requestTargetsRef\.current, \[profile\.profile_id\]: conversationId \}/, "successful same-conversation recovery must keep the original conversation selected");

const responseCache = between(managerMain, "function retainRecentManagerChatCacheEntries", "function readManagerChatCache");
assert.match(responseCache, /MAX_CHAT_CACHE_ENTRIES_PER_PROFILE/, "persistent manager cache must be capped per profile");
assert.match(responseCache, /deduped\.slice\(-MAX_CHAT_CACHE_ENTRIES_PER_PROFILE\)/, "persistent manager cache must retain only three recent conversations per profile");
const cachedRead = between(managerMain, "function managerChatCacheResponse", "async function inspectThroughMcp");
assert.match(cachedRead, /managerRecentChatCacheUsable/, "Manager must recognize a complete cached recent conversation when its Chrome tab is closed");
assert.match(cachedRead, /cache_hit:\s*true/, "reopening a cached recent conversation must bypass the live ChatGPT response load");
assert.match(cachedRead, /response_source:\s*"manager_recent_chat_cache"/, "cached response reads must expose their source explicitly");

const taskCheckpointPrompt = between(managerMain, "function workerJobResumeCheckpointText", "async function sendProfileRequestUnlocked");
assert.match(taskCheckpointPrompt, /checkpoints = \[\]/, "task resume prompt must accept worker/project checkpoints independently of ChatGPT conversations");
assert.match(taskCheckpointPrompt, /slice\(-3\)/, "task resume prompt must consume at most the three newest worker/project checkpoints");
assert.match(taskCheckpointPrompt, /checkpoint\?\.taskId \|\| checkpoint\?\.task_id/, "task resume prompt must defensively reject checkpoints from a different Task ID");
assert.match(taskCheckpointPrompt, /File quan trọng:/, "task resume prompt must include dedicated important-file checkpoint data");
assert.match(taskCheckpointPrompt, /Kết quả test:/, "task resume prompt must include dedicated test-result checkpoint data");
assert.match(taskCheckpointPrompt, /Không truy lại conversation cũ/, "task resume prompt must forbid recovering context by reopening an old conversation");
const taskResume = between(managerMain, "async function resumeProfileTask", "async function getRepoTaskStatus");
assert.match(taskResume, /"worker_context_history"/, "task resume must load worker/project context checkpoints from MCP");
assert.match(taskResume, /worker_id:\s*profileId/, "task resume context must be isolated by worker");
assert.match(taskResume, /task_id:\s*taskId/, "task resume context must be isolated by exact Task ID");
assert.match(taskResume, /workerJobResumeCheckpointText\(job, workerContexts\)/, "task resume must inject worker/project checkpoints into the new recovery chat");
assert.match(taskResume, /newChat:\s*true/, "task resume must create a new chat instead of reopening a remembered conversation id");
assert.match(taskResume, /requireIdleProfile:\s*!hangRecovery/, "confirmed hang recovery must be allowed to create a new chat before discarding the stale busy tab");
const canonicalRecovery = between(managerMain, "async function sendProfileRequestUnlocked", "async function sendProfileRequest(payload)");
assert.match(canonicalRecovery, /recoveryCheckpointText = `\$\{workerJobResumeCheckpointText\(workerJob, recoveryContexts\)\}/, "every recovery-mode send must replace renderer transcript handoff with canonical worker/task checkpoints");
assert.match(canonicalRecovery, /requestedRecoveryReason[\s\S]*?Lý do phục hồi hiện tại/, "canonical recovery may append only the dedicated recovery reason, not renderer transcript history");
assert.match(canonicalRecovery, /task_id:\s*previousTaskId/, "recovery-mode checkpoint lookup must be scoped to the exact current Task ID");
assert.match(canonicalRecovery, /recoveryCheckpointText[\s\S]*?\.join\("\\n"\)/, "recovery-mode prompt must use canonical checkpoint text rather than the renderer transcript payload");

const rolloverPrompt = between(managerUi, "function buildConversationRolloverPrompt", "function ChatRequestComposer");
assert.match(rolloverPrompt, /continuation_reason \|\| ""\) === "recovery"/, "handoff prompt must distinguish recovery from conversation-limit rollover");
assert.match(rolloverPrompt, /recovery_reason/, "handoff prompt must include why the old tab could not be safely recovered");

assert.equal((managerUi.match(/async function continueTaskFromCheckpoint\(/g) || []).length, 1, "renderer must keep exactly one canonical checkpoint-recovery implementation");
const rollover = between(managerUi, "async function rolloverFullConversation", "async function verifyRepoTaskUse");
assert.match(rollover, /rolloverReason: continuationReason/, "continuation state must retain the rollover reason");
assert.match(rollover, /requestTargetsRef\.current = \{ \.\.\.requestTargetsRef\.current, \[profileId\]: newConversationId \}/, "continuation must atomically select the new conversation");
assert.match(rollover, /checkpointContinuation[\s\S]*?api\.resumeProfileTask\(\{[\s\S]*?taskId: activeTaskId[\s\S]*?hangRecovery: true/, "task continuation must preserve the running Task ID by delegating to checkpoint resume instead of enqueuing a new task");

const openProfile = between(managerMain, "async function openProfileChat", "async function recoverProfileChatTab");
assert.match(openProfile, /action: "activate_tab"[\s\S]*?conversation_id: conversationId \|\| targetConversationId \|\| undefined/, "open Chrome must pass the expected conversation id to the worker for verification");

const recoverIpc = between(managerMain, "async function recoverProfileChatTab", "async function stopProfileTask");
assert.match(recoverIpc, /const discardOnly = payload\?\.discardOnly === true/, "Manager recovery IPC must support discarding the old tab after handoff");
assert.match(recoverIpc, /action: "close_tab"/, "discard-only recovery must close the exact stale tab through the profile worker");
assert.match(recoverIpc, /isMissingChromeTabError\(error\)/, "discarding an already-closed stale tab must be idempotent");

const activate = between(worker, "if(action==='activate_tab')", "if(action==='close_tab')");
assert.match(activate, /expectedConversationId=String\(args\.conversation_id\|\|''\)/, "worker activation must receive an expected conversation id");
assert.match(activate, /CONVERSATION_VERIFY_FAILED/, "worker activation must fail instead of focusing a mismatched conversation");
assert.match(activate, /actual_conversation_id:actualConversationId/, "worker activation result must expose the verified conversation id");

const recoverWorker = between(worker, "if(action==='recover_chat_tab')", "if(action==='send_chat_request')");
assert.match(recoverWorker, /RECOVERY_CONVERSATION_VERIFY_FAILED/, "same-conversation renderer replacement must verify the recovered URL before reporting success");
assert.match(recoverWorker, /recoveredConversationId!==conversationId/, "recovery must compare the loaded conversation against the expected id");

console.log("chat-recovery-continuation-smoke: ok");
