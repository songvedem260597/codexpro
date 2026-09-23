import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../src/hooks/use-chat-send-actions.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const start = source.indexOf("  async function verifyRepoTaskUse(");
const end = source.indexOf("\n  useEffect(() => {", start);
assert.ok(start >= 0 && end > start, "repo task verification implementation must be present");
const verificationSource = source.slice(start, end).trim();
const taskId = "cpt_b3579b36bed57c5f64923a6c";
const conversationId = "6ab45152-993c-83ec-97d4-1fe23829dfdf";
const profile = { profile_id: "a569b150-1fb3-4270-888f-b157a112953c" };

function harness({ proof, error } = {}) {
  const messages = [{ id: "user-1", role: "user", text: "one user intent", submissionState: "submitted" }, { id: "assistant-1", role: "assistant", text: "answer" }];
  let responses = { [profile.profile_id]: { repoTaskId: taskId, conversationId, messages, submissionState: "submitted", repoTaskStatus: "waiting" } };
  let sendErrors = { [profile.profile_id]: "" };
  let physicalSendCount = 1;
  let newConversationCount = 1;
  const sent = [];
  const diagnostics = [];
  const context = {
    api: {
      getRepoTaskStatus: async () => { if (error) throw error; return proof; },
      sendProfileRequest: async (request) => {
        sent.push(request);
        physicalSendCount += 1;
        if (request.newChat) newConversationCount += 1;
        return { submission_state: "submitted", repo_task_id: taskId, conversation_id: request.newChat ? "6ab451a8-d5d8-83ec-82a0-aa43be376854" : conversationId };
      }
    },
    repoTaskVerificationReads: { current: new Map() },
    setRequestResponses: (update) => { responses = update(responses); },
    setRequestSendErrors: (update) => { sendErrors = update(sendErrors); },
    setRequestTargets: () => {},
    requestTargetsRef: { current: { [profile.profile_id]: conversationId } },
    projects: [],
    ALL_ALLOWED_WORKSPACES: "__all_allowed__",
    logRendererDiagnostic: (_api, level, category, message, details) => diagnostics.push({ level, category, message, details }),
    notify: () => {},
    refresh: () => {},
    isRetryableChatTurnBusyError: () => false,
    REPO_TASK_VERIFICATION_RETRY_MS: 1500,
    window: { setTimeout: () => 0 }
  };
  const verify = vm.runInNewContext(`(${verificationSource})`, context, { filename: "use-chat-send-actions.js" });
  const response = {
    repoTaskId: taskId,
    conversationId,
    repoTaskDispatchedAt: "2026-09-23T22:23:10.060Z",
    repoTaskRetryCount: 0,
    repoTaskRolloverCount: 0,
    repoTaskRequest: { text: "one user intent", attachments: [], projectRoot: "C:\\repo", scope: "workspace" }
  };
  return { verify, response, sent, diagnostics, get responses() { return responses; }, get sendErrors() { return sendErrors; }, get physicalSendCount() { return physicalSendCount; }, get newConversationCount() { return newConversationCount; } };
}

function assertNoRetransmission(state, label) {
  assert.equal(state.physicalSendCount, 1, `${label}: the acknowledged user message must not be sent again`);
  assert.equal(state.newConversationCount, 1, `${label}: task verification must not create another conversation`);
  assert.equal(state.sent.length, 0, `${label}: verification must make zero sendProfileRequest calls`);
  const response = state.responses[profile.profile_id];
  assert.equal(response.conversationId, conversationId, `${label}: original conversation must be retained`);
  assert.equal(response.repoTaskId, taskId, `${label}: original task must be retained`);
  assert.equal(response.messages.length, 2, `${label}: submitted message and assistant response must remain visible`);
  assert.equal(response.submissionState, "submitted", `${label}: task activation cannot retroactively fail Send`);
}

const unverified = { verified: false, gate_active: false, worker_job: { status: "prepared", title: "" } };
const first = harness({ proof: unverified });
await first.verify(profile, conversationId, first.response, "2026-09-23T22:24:07Z");
console.log(`PHYSICAL_SEND_COUNT=${first.physicalSendCount}; NEW_CONVERSATION_COUNT=${first.newConversationCount}`);
assertNoRetransmission(first, "first unverified proof");
assert.equal(first.responses[profile.profile_id].repoTaskStatus, "activation-failed");
assert.equal(first.responses[profile.profile_id].repoTaskFailureKind, "activation-missing");
assert.match(first.responses[profile.profile_id].repoTaskFailureReason, /chưa được kích hoạt/i);

await first.verify(profile, conversationId, first.response, "2026-09-23T22:24:35Z");
assertNoRetransmission(first, "second unverified proof");

const missingProof = harness({ proof: null });
await missingProof.verify(profile, conversationId, missingProof.response, "2026-09-23T22:24:07Z");
assertNoRetransmission(missingProof, "missing begin_repo_task proof");
assert.equal(missingProof.responses[profile.profile_id].repoTaskFailureKind, "proof-missing");
assert.match(missingProof.responses[profile.profile_id].repoTaskFailureReason, /proof từ begin_repo_task/i);

const missingTitle = harness({ proof: { verified: false, gate_active: true, worker_job: { status: "running", title: "" } } });
await missingTitle.verify(profile, conversationId, missingTitle.response, "2026-09-23T22:24:07Z");
assertNoRetransmission(missingTitle, "independently missing task title");
assert.equal(missingTitle.responses[profile.profile_id].repoTaskFailureKind, "title-missing");
assert.match(missingTitle.responses[profile.profile_id].repoTaskFailureReason, /task title/i);

const controlPlaneError = harness({ error: new Error("The tool failed internally") });
await controlPlaneError.verify(profile, conversationId, controlPlaneError.response, "2026-09-23T22:24:07Z");
assertNoRetransmission(controlPlaneError, "control-plane error");
assert.equal(controlPlaneError.responses[profile.profile_id].repoTaskStatus, "activation-failed");
assert.equal(controlPlaneError.responses[profile.profile_id].repoTaskFailureKind, "control-plane-error");
assert.match(controlPlaneError.responses[profile.profile_id].repoTaskFailureReason, /Lỗi control-plane/);

const verified = harness({ proof: { verified: true, gate_active: true, scope: "workspace" } });
await verified.verify(profile, conversationId, verified.response, "2026-09-23T22:24:07Z");
assertNoRetransmission(verified, "verified proof");
assert.equal(verified.responses[profile.profile_id].repoTaskStatus, "verified");

const sendSource = source.slice(source.indexOf("  async function sendRequest("), start);
assert.match(sendSource, /shouldRolloverConversation\(rolloverSource, rolloverMessageLimit\)/, "explicit conversation-limit rollover must remain separate from verification");
assert.match(sendSource, /conversationLimitReached = !newChat && message\.includes\("CONVERSATION_LIMIT_REACHED:"\)/, "explicit conversation-limit error rollover must remain available");
const chatModalSource = fs.readFileSync(new URL("../src/features/chat/chat-modal.jsx", import.meta.url), "utf8");
assert.match(chatModalSource, /Tin nhắn đã gửi vẫn được giữ nguyên; CodexPro không tự gửi lại/, "UI must distinguish task activation failure from Send success");
assert.doesNotMatch(chatModalSource, /CodexPro: phản hồi bị chặn/, "task proof failure must not label the ChatGPT response as blocked");

console.log("repo-task-verification-no-resend-smoke: PASS");
