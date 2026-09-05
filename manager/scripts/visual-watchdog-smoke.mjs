import assert from "node:assert/strict";

import {
  VISUAL_WATCHDOG_INTERVAL_MS as RENDERER_INTERVAL_MS,
  visualWatchdogCandidate
} from "../src/visual-watchdog.js";
import {
  VISUAL_WATCHDOG_INTERVAL_MS as SERVICE_INTERVAL_MS,
  buildVisualWatchdogPrompt,
  createVisualWatchdogService,
  parseVisualWatchdogJudgement
} from "../electron/visual-watchdog.mjs";

const TASK_ID = "cpt_1234567890abcdef12345678";
const TASK_CONVERSATION = "12345678-abcd-1234-abcd-1234567890ab";
const WATCHDOG_CONVERSATION = "abcdef12-abcd-1234-abcd-1234567890ab";
const RECOVERY_CONVERSATION = "fedcba98-abcd-1234-abcd-1234567890ab";
const PROFILE_ID = "profile-test";

assert.equal(RENDERER_INTERVAL_MS, 5 * 60 * 1000);
assert.equal(SERVICE_INTERVAL_MS, 5 * 60 * 1000);
assert.match(buildVisualWatchdogPrompt({ taskId: TASK_ID, title: "Smoke", hasPrevious: true }), /5 phút/);

const lowConfidence = parseVisualWatchdogJudgement('{"state":"STUCK","confidence":0.89,"reason":"same"}');
assert.equal(lowConfidence.state, "UNCERTAIN");
const highConfidence = parseVisualWatchdogJudgement('{"state":"STUCK","confidence":0.95,"reason":"same"}');
assert.equal(highConfidence.state, "STUCK");

const now = Date.now();
const profile = {
  connected: true,
  profile_id: PROFILE_ID,
  current_task_id: TASK_ID,
  current_task_title: "Watchdog smoke",
  current_task_conversation_id: TASK_CONVERSATION,
  conversation_tabs: [{ id: 11, url: `https://chatgpt.com/c/${TASK_CONVERSATION}`, busy: true }]
};
const runningJob = {
  job_id: TASK_ID,
  worker_id: PROFILE_ID,
  status: "running",
  started_at: new Date(now - SERVICE_INTERVAL_MS - 1000).toISOString()
};
assert.equal(visualWatchdogCandidate(profile, [runningJob], now)?.taskId, TASK_ID);
assert.equal(visualWatchdogCandidate(profile, [{ ...runningJob, started_at: new Date(now - SERVICE_INTERVAL_MS + 1000).toISOString() }], now), null);

function createMockService({ judgementText }) {
  let watchdogRegistered = false;
  const closed = [];
  const resumed = [];
  const readyRuntimeStatus = async () => ({
    local: { ok: true },
    config: { tokenFile: "fake-token" },
    browserProfiles: [profile]
  });
  const callTool = async (_session, toolName, args) => {
    if (toolName === "worker_job_status") return { job: runningJob };
    assert.equal(toolName, "browser_control");
    if (args.action === "screenshot") return { image_base64: "aW1hZ2U=" };
    if (args.action === "list_tabs") {
      return {
        tabs: [
          { id: 11, url: `https://chatgpt.com/c/${TASK_CONVERSATION}`, visual_watchdog: false },
          ...(watchdogRegistered ? [{ id: 99, url: `https://chatgpt.com/c/${WATCHDOG_CONVERSATION}`, visual_watchdog: true }] : [])
        ]
      };
    }
    if (args.action === "register_watchdog_tab") {
      watchdogRegistered = true;
      return { ok: true };
    }
    if (args.action === "rename_chat") return { ok: true };
    if (args.action === "get_chat_response") return { response_ready: true, busy: false, text: judgementText };
    if (args.action === "close_tab") {
      closed.push(Number(args.target_id));
      return { ok: true };
    }
    throw new Error(`Unexpected browser action: ${args.action}`);
  };
  const resumeTask = async (payload) => {
    resumed.push(payload);
    return { repo_task_id: TASK_ID, conversation_id: RECOVERY_CONVERSATION };
  };
  const service = createVisualWatchdogService({
    readyRuntimeStatus,
    readToken: () => "token",
    openSession: async () => ({ id: "session" }),
    closeSession: async () => {},
    callTool,
    sendChat: async () => ({ target_id: 99, conversation_id: WATCHDOG_CONVERSATION }),
    resumeTask
  });
  return { service, closed, resumed };
}

const stuck = createMockService({ judgementText: '{"state":"STUCK","confidence":0.95,"reason":"không tiến triển"}' });
const stuckResult = await stuck.service.check({
  profileId: PROFILE_ID,
  taskId: TASK_ID,
  conversationId: TASK_CONVERSATION,
  targetId: 11,
  title: "Watchdog smoke",
  autoRecover: true
});
assert.equal(stuckResult.state, "STUCK");
assert.equal(stuckResult.recovery?.recovered, true);
assert.deepEqual(stuck.closed, [11]);
assert.equal(stuck.resumed.length, 1);
assert.equal(stuck.resumed[0].taskId, TASK_ID);
assert.equal(stuck.resumed[0].hangRecovery, true);

const uncertain = createMockService({ judgementText: '{"state":"STUCK","confidence":0.89,"reason":"chưa chắc"}' });
const uncertainResult = await uncertain.service.check({
  profileId: PROFILE_ID,
  taskId: TASK_ID,
  conversationId: TASK_CONVERSATION,
  targetId: 11,
  title: "Watchdog smoke",
  autoRecover: true
});
assert.equal(uncertainResult.state, "UNCERTAIN");
assert.equal(uncertainResult.recovery?.recovered, false);
assert.deepEqual(uncertain.closed, []);
assert.deepEqual(uncertain.resumed, []);

console.log("visual-watchdog-smoke: ok");
