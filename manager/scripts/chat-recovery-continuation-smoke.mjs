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

const autoRecovery = between(managerUi, "useEffect(() => {\n    if (!managerSettings.autoRecovery)", "}, [managerSettings.autoRecovery, status?.browserProfiles]);");
assert.match(autoRecovery, /recoverProfileTab\(profile, \{ targetTab, silent: true, automatic: true, hardFailure \}\)/, "auto recovery must use the same guarded continuation pipeline as manual recovery");

const recovery = between(managerUi, "async function recoveryContinuationSnapshot", "async function stopControlTask");
assert.match(recovery, /getChatResponseCache\(\{ profileId, conversationId \}\)/, "recovery must fall back to the persisted transcript cache before abandoning a stuck tab");
assert.match(recovery, /materializeTranscriptMessages\(liveResponse, conversationId\)/, "recovery must preserve the live manager transcript when available");
assert.match(recovery, /newChat: false/, "recovery must first try to reopen the original conversation");
assert.match(recovery, /continuation_reason: "recovery"/, "unrecoverable tabs must roll over through the context handoff path");
assert.match(recovery, /discardOnly: true/, "old stuck tab must be discarded only after the continuation chat is created");
assert.match(recovery, /requestTargetsRef\.current = \{ \.\.\.requestTargetsRef\.current, \[profile\.profile_id\]: conversationId \}/, "successful same-conversation recovery must keep the original conversation selected");

const rolloverPrompt = between(managerUi, "function buildConversationRolloverPrompt", "function ChatRequestComposer");
assert.match(rolloverPrompt, /continuation_reason \|\| ""\) === "recovery"/, "handoff prompt must distinguish recovery from conversation-limit rollover");
assert.match(rolloverPrompt, /recovery_reason/, "handoff prompt must include why the old tab could not be safely recovered");

const rollover = between(managerUi, "async function rolloverFullConversation", "async function verifyRepoTaskUse");
assert.match(rollover, /rolloverReason: continuationReason/, "continuation state must retain the rollover reason");
assert.match(rollover, /requestTargetsRef\.current = \{ \.\.\.requestTargetsRef\.current, \[profileId\]: newConversationId \}/, "continuation must atomically select the new conversation");

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
