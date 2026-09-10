import assert from "node:assert/strict";
import { CodexProError } from "../src/guard.js";
import { registerBrowserControlTool } from "../src/browserControlTool.js";

const config = { browserDebugUrl: "http://127.0.0.1:9223" };
const server = {};
const order = ["before_browser_control"];
let registeredName;
let registeredOptions;
let registeredHandler;
let profiles = [];
let forgottenIds = [];
let dedicatedStatusError;
let dedicatedResult = { ok: true, target_id: "tab-dedicated" };
let dedicatedCalls = [];
let extensionResult = { ok: true, target_id: "tab-extension" };
let extensionCalls = [];
let workspaceBindings = [];
let workspaceAnnouncements = [];
let rebound = true;
let reboundCalls = [];
let jobs = new Map();
let taskBinding;
let finalizedJobs = [];
let finalizedWorkspaceTasks = [];
let openedRoots = [];

const workspaces = {
  openWorkspace(root) {
    openedRoots.push(root);
    return { id: "ws-selected", root, openedAt: "2026-01-01T00:00:00.000Z" };
  }
};

const dependencies = {
  listBrowserExtensionProfiles: () => profiles,
  forgetBrowserExtensionProfile: (profileId) => {
    forgottenIds.push(profileId);
    return profileId === "profile-a";
  },
  runBrowserControl: async (debugUrl, args) => {
    dedicatedCalls.push({ debugUrl, args });
    if (args.action === "status" && dedicatedStatusError) throw dedicatedStatusError;
    if (args.action === "status") return { connected: true, debug_url: debugUrl };
    return { ...dedicatedResult };
  },
  runBrowserExtensionCommand: async (action, args, profileId) => {
    extensionCalls.push({ action, args, profileId });
    return { ...extensionResult };
  },
  setBrowserExtensionProfileWorkspaceBinding: (profileId, root) => workspaceBindings.push({ profileId, root }),
  setBrowserExtensionProfileWorkspace: (profileId, root) => workspaceAnnouncements.push({ profileId, root }),
  rebindBrowserExtensionProfileTaskConversation: (profileId, taskId, conversationId) => {
    reboundCalls.push({ profileId, taskId, conversationId });
    return rebound;
  },
  readWorkerJob: (taskId) => jobs.get(taskId),
  getBrowserExtensionProfileTaskBinding: () => taskBinding,
  finalizeWorkerJob: async ({ jobId, workerId, outcome, summary, error }) => {
    finalizedJobs.push({ jobId, workerId, outcome, summary, error });
    const current = jobs.get(jobId);
    const finalized = {
      ...current,
      jobId,
      workerId,
      status: outcome,
      finishedAt: "2026-01-02T00:00:00.000Z"
    };
    jobs.set(jobId, finalized);
    return finalized;
  },
  finalizeWorkspaceTask: async (context, outcome) => finalizedWorkspaceTasks.push({ context, outcome }),
  textResult: (text, structuredContent = {}) => ({ content: [{ type: "text", text }], structuredContent })
};

function registerCodexTool(_config, _server, name, options, handler) {
  order.push(name);
  registeredName = name;
  registeredOptions = options;
  registeredHandler = handler;
}

registerBrowserControlTool({
  config,
  server,
  workspaces,
  registerCodexTool,
  annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true, idempotentHint: false },
  dependencies
});
order.push("after_browser_control");

assert.equal(registeredName, "browser_control");
assert.deepEqual(order, ["before_browser_control", "browser_control", "after_browser_control"]);
assert.equal(registeredOptions.title, "Browser Control");
assert.equal(registeredOptions.annotations.destructiveHint, true);
assert.equal(registeredOptions._meta["openai/toolInvocation/invoking"], "Controlling CodexPro Chrome...");
assert.equal(registeredOptions._meta["openai/toolInvocation/invoked"], "Browser action complete");
assert.equal(registeredOptions.inputSchema.action.safeParse("browser_control").success, false);
assert.equal(registeredOptions.inputSchema.action.safeParse("get_chat_response").success, true);
assert.equal(registeredOptions.inputSchema.task_id.safeParse("cpt_0123456789abcdef01234567").success, true);
assert.equal(registeredOptions.inputSchema.task_id.safeParse("bad-task").success, false);
assert.ok(registeredOptions.inputSchema.canonical_only);
assert.ok(registeredOptions.inputSchema.attachments);
assert.ok(registeredOptions.inputSchema.steps);

const call = async (args) => registeredHandler(args);

profiles = [
  { profile_id: "profile-a", label: "Alpha", active: true, connected: true },
  { profile_id: "profile-b", label: "Beta", active: false, connected: false }
];
let result = await call({ action: "list_profiles" });
assert.equal(result.structuredContent.profiles.length, 2);
assert.match(result.content[0].text, /ACTIVE · Alpha · online · profile-a/);

result = await call({ action: "forget_profile", profile_id: "profile-a" });
assert.equal(result.structuredContent.forgotten, true);
assert.deepEqual(forgottenIds, ["profile-a"]);
await assert.rejects(
  call({ action: "forget_profile" }),
  (error) => error instanceof CodexProError && error.message === "Chrome profile id is required before forgetting a profile."
);

dedicatedStatusError = undefined;
result = await call({ action: "status" });
assert.equal(result.structuredContent.dedicated.connected, true);
assert.equal(result.structuredContent.active_profile_id, "profile-a");
assert.equal(dedicatedCalls.at(-1).args.action, "status");

dedicatedStatusError = new Error("dedicated offline");
result = await call({ action: "status" });
assert.equal(result.structuredContent.dedicated.connected, false);
assert.equal(result.structuredContent.dedicated.error, "dedicated offline");
dedicatedStatusError = undefined;

profiles = [];
await assert.rejects(
  call({ action: "check_chatgpt" }),
  (error) => error instanceof CodexProError && error.message === "Choose an online Chrome extension profile before setting up CodexPro in ChatGPT."
);

profiles = [{ profile_id: "profile-a", label: "Alpha", active: true, connected: true }];
result = await call({ action: "select_workspace", root: "C:/workspace/one" });
assert.equal(result.structuredContent.workspace_id, "ws-selected");
assert.equal(result.structuredContent.root, "C:/workspace/one");
assert.equal(result.structuredContent.locked, true);
assert.deepEqual(workspaceBindings.at(-1), { profileId: "profile-a", root: "C:/workspace/one" });
assert.deepEqual(workspaceAnnouncements.at(-1), { profileId: "profile-a", root: "C:/workspace/one" });
assert.equal(openedRoots.at(-1), "C:/workspace/one");

const rebindTask = "cpt_aaaaaaaaaaaaaaaaaaaaaaaa";
jobs.set(rebindTask, { jobId: rebindTask, workerId: "profile-a", status: "prepared", kind: "code", root: "C:/repo", title: "Task" });
result = await call({ action: "rebind_profile_task", task_id: rebindTask, conversation_id: "conv-new" });
assert.equal(result.structuredContent.rebound, true);
assert.deepEqual(reboundCalls.at(-1), { profileId: "profile-a", taskId: rebindTask, conversationId: "conv-new" });

jobs.set(rebindTask, { jobId: rebindTask, workerId: "profile-foreign", status: "running" });
await assert.rejects(
  call({ action: "rebind_profile_task", task_id: rebindTask, conversation_id: "conv-new" }),
  (error) => error instanceof CodexProError && error.message === "RECOVERY_TASK_NOT_ACTIVE: Refusing to move a completed or foreign task to another conversation."
);
jobs.set(rebindTask, { jobId: rebindTask, workerId: "profile-a", status: "completed" });
await assert.rejects(
  call({ action: "rebind_profile_task", task_id: rebindTask, conversation_id: "conv-new" }),
  (error) => error instanceof CodexProError && error.message === "RECOVERY_TASK_NOT_ACTIVE: Refusing to move a completed or foreign task to another conversation."
);

profiles = [];
dedicatedResult = { ok: true, target_id: "nav-tab" };
for (const url of ["http://example.com", "https://example.com/path", "chrome-extension://gndipignbnipohooclcbhjliikamjlpl/popup.html"]) {
  result = await call({ action: "navigate", browser: "dedicated", url });
  assert.equal(result.structuredContent.browser_backend, "dedicated");
  assert.equal(dedicatedCalls.at(-1).args.url, url);
}
await assert.rejects(
  call({ action: "navigate", browser: "dedicated", url: "file:///C:/secret.txt" }),
  (error) => error instanceof CodexProError && error.message === "Browser navigation only allows http, https, and the signed CodexPro reload page."
);
await assert.rejects(
  call({ action: "navigate", browser: "dedicated", url: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/popup.html" }),
  (error) => error instanceof CodexProError && error.message === "Browser navigation only allows http, https, and the signed CodexPro reload page."
);

profiles = [{ profile_id: "profile-a", label: "Alpha", active: true, connected: true }];
extensionResult = { response_ready: false, target_id: "ext-tab" };
const attachment = { name: "a.txt", mime_type: "text/plain", data_base64: "YQ==" };
result = await call({
  action: "send_chat_request",
  profile_id: "profile-a",
  target_id: "tab-x",
  conversation_id: "conv-x",
  task_id: "cpt_bbbbbbbbbbbbbbbbbbbbbbbb",
  started_at: "start",
  attempt_key: "attempt",
  read_dom: false,
  canonical_only: true,
  recover_stale_dom: true,
  new_chat: true,
  visual_watchdog: true,
  focus_window: true,
  allow_busy_followup: true,
  one_shot_recovery: true,
  title: "Rename",
  attachments: [attachment],
  expression: "1+1",
  state: "visible",
  timeout_ms: 4321,
  delta_x: 12,
  delta_y: 34,
  steps: [{ action: "click", test_id: "step-test", timeout_ms: 700, delta_x: 1, delta_y: 2, max_chars: 777, full_page: true, delta: true }],
  url: "https://chatgpt.com",
  selector: "#composer",
  ref: "@e1",
  role: "textbox",
  name: "Prompt",
  placeholder: "Ask",
  label: "Message",
  test_id: "composer",
  nth: 2,
  text: "hello",
  key: "Enter",
  max_chars: 2222,
  full_page: true,
  delta: true,
  trace: true,
  trace_ms: 987
});
const extCall = extensionCalls.at(-1);
assert.equal(extCall.action, "send_chat_request");
assert.equal(extCall.profileId, "profile-a");
assert.deepEqual(extCall.args.attachments, [attachment]);
assert.equal(extCall.args.read_dom, false);
assert.equal(extCall.args.recover_stale_dom, true);
assert.equal(extCall.args.allow_busy_followup, true);
assert.equal(extCall.args.one_shot_recovery, true);
assert.equal(extCall.args.trace, true);
assert.equal(extCall.args.trace_ms, 987);
assert.equal(extCall.args.test_id, "composer");
assert.deepEqual(extCall.args.steps, [{ action: "click", test_id: "step-test", timeout_ms: 700, delta_x: 1, delta_y: 2, max_chars: 777, full_page: true, delta: true }]);
assert.equal(Object.hasOwn(extCall.args, "canonical_only"), false);
assert.equal(result.structuredContent.browser_backend, "extension");
assert.equal(result.structuredContent.profile_id, "profile-a");

profiles = [];
dedicatedResult = { ok: true, target_id: "dedicated-tab" };
result = await call({
  action: "batch",
  browser: "dedicated",
  target_id: "tab-d",
  expression: "window.x",
  state: "attached",
  timeout_ms: 1234,
  delta_x: 5,
  delta_y: 6,
  steps: [{
    action: "click",
    url: "https://example.com",
    selector: ".button",
    ref: "@e2",
    role: "button",
    name: "Save",
    placeholder: "p",
    label: "l",
    test_id: "save",
    nth: 3,
    text: "x",
    key: "Enter",
    expression: "2+2",
    state: "visible",
    timeout_ms: 456,
    delta_x: 7,
    delta_y: 8,
    max_chars: 3333,
    full_page: true,
    delta: true
  }],
  url: "https://example.com",
  selector: "body",
  ref: "@e0",
  role: "main",
  name: "Main",
  placeholder: "none",
  label: "Main",
  test_id: "root",
  nth: 4,
  text: "typed",
  key: "Tab",
  max_chars: 4444,
  full_page: true,
  delta: true,
  trace: true,
  trace_ms: 654
});
const dedCall = dedicatedCalls.at(-1);
assert.equal(dedCall.args.action, "batch");
assert.equal(dedCall.args.targetId, "tab-d");
assert.equal(dedCall.args.testId, "root");
assert.equal(dedCall.args.timeoutMs, 1234);
assert.equal(dedCall.args.traceMs, 654);
assert.deepEqual(dedCall.args.steps[0], {
  action: "click",
  url: "https://example.com",
  selector: ".button",
  ref: "@e2",
  role: "button",
  name: "Save",
  placeholder: "p",
  label: "l",
  testId: "save",
  nth: 3,
  text: "x",
  key: "Enter",
  expression: "2+2",
  state: "visible",
  timeoutMs: 456,
  deltaX: 7,
  deltaY: 8,
  maxChars: 3333,
  fullPage: true,
  delta: true
});
assert.equal(result.structuredContent.browser_backend, "dedicated");

const completionTask = "cpt_cccccccccccccccccccccccc";
profiles = [{ profile_id: "profile-a", label: "Alpha", active: true, connected: true }];
jobs.set(completionTask, { jobId: completionTask, workerId: "profile-a", status: "running", kind: "code", root: "C:/repo", title: "Completion" });
taskBinding = { taskId: completionTask, conversationId: "conv-owned" };
extensionResult = { response_ready: true, busy: false, network_stream_in_progress: false, network_state: "completed", target_id: "chat-tab" };
result = await call({ action: "get_chat_response", task_id: completionTask, conversation_id: "conv-owned" });
assert.equal(result.structuredContent.worker_job_completion_pending_finalize, true);
assert.equal(result.structuredContent.worker_job_status, "running");
assert.equal(finalizedJobs.length, 0);

const failedTask = "cpt_dddddddddddddddddddddddd";
jobs.set(failedTask, { jobId: failedTask, workerId: "profile-a", status: "running", kind: "code", root: "C:/repo", title: "Failed" });
taskBinding = { taskId: failedTask, conversationId: "conv-failed" };
extensionResult = { network_state: "failed", network_error: "network exploded", target_id: "chat-tab" };
result = await call({ action: "get_chat_response", task_id: failedTask, conversation_id: "conv-failed" });
assert.equal(result.structuredContent.worker_job_finalized, true);
assert.equal(result.structuredContent.worker_job_status, "failed");
assert.equal(finalizedJobs.at(-1).outcome, "failed");
assert.equal(finalizedJobs.at(-1).error, "network exploded");
assert.equal(finalizedWorkspaceTasks.at(-1).outcome, "failed");

const cancelledTask = "cpt_eeeeeeeeeeeeeeeeeeeeeeee";
jobs.set(cancelledTask, { jobId: cancelledTask, workerId: "profile-a", status: "running", kind: "general", title: "Cancelled" });
taskBinding = { taskId: cancelledTask, conversationId: "conv-cancelled" };
extensionResult = { stopped: true, target_id: "chat-tab" };
result = await call({ action: "stop_chat_generation", task_id: cancelledTask, conversation_id: "conv-cancelled" });
assert.equal(result.structuredContent.worker_job_finalized, true);
assert.equal(result.structuredContent.worker_job_status, "cancelled");
assert.equal(finalizedJobs.at(-1).outcome, "cancelled");

const reboundTask = "cpt_ffffffffffffffffffffffff";
jobs.set(reboundTask, { jobId: reboundTask, workerId: "profile-a", status: "running", kind: "code", root: "C:/repo", title: "Rebound" });
taskBinding = { taskId: reboundTask, conversationId: "different-conversation" };
extensionResult = { network_state: "failed", network_error: "old conversation failed", target_id: "chat-tab" };
const finalizedCountBeforeRebound = finalizedJobs.length;
result = await call({ action: "get_chat_response", task_id: reboundTask, conversation_id: "old-conversation" });
assert.equal(result.structuredContent.worker_job_finalization_skipped, "conversation_rebound");
assert.equal(finalizedJobs.length, finalizedCountBeforeRebound);
assert.equal(result.structuredContent.worker_job_status, "running");

profiles = [];
dedicatedResult = { image_base64: "aW1hZ2U=", mime_type: undefined, target_id: "shot-tab", width: 100, height: 50 };
result = await call({ action: "screenshot", browser: "dedicated", target_id: "shot-tab" });
assert.equal(result.content[0].type, "image");
assert.equal(result.content[0].data, "aW1hZ2U=");
assert.equal(result.content[0].mimeType, "image/png");
assert.equal(result.content[1].text, "Browser screenshot captured for tab shot-tab.");
assert.equal("image_base64" in result.structuredContent, false);
assert.equal(result.structuredContent.browser_backend, "dedicated");

profiles = [];
dedicatedResult = { ok: true, target_id: "normal-tab", value: 42 };
result = await call({ action: "snapshot", browser: "dedicated" });
assert.match(result.content[0].text, /^# Browser Control/);
assert.equal(result.structuredContent.value, 42);
assert.equal(result.structuredContent.browser_backend, "dedicated");

console.log("browser-control-tool smoke passed");
