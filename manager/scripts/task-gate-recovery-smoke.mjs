import assert from "node:assert/strict";
import { reconcileRunningTaskGates, runningTaskRecoveryCandidates } from "../electron/task-gate-recovery.mjs";

const profile = { profile_id: "profile-a", connected: true };
const running = { job_id: "cpt_aaaaaaaaaaaaaaaaaaaaaaaa", worker_id: "profile-a", status: "running", kind: "code", title: "Resume running task safely" };
assert.equal(runningTaskRecoveryCandidates([profile], [running]).length, 1);
assert.equal(runningTaskRecoveryCandidates([{ ...profile, connected: false }], [running])[0]?.message, "Đang kết nối lại");
assert.match(runningTaskRecoveryCandidates([profile], [running, { ...running, job_id: "cpt_bbbbbbbbbbbbbbbbbbbbbbbb" }])[0]?.message || "", /Không thể tiếp tục/);

let transientAttempts = 0;
const transientStates = [];
const transient = await reconcileRunningTaskGates({
  runtimeKey: "runtime-transient",
  profiles: [profile],
  jobs: [running],
  sleep: async () => {},
  onState: (state) => transientStates.push(state.state),
  resumeTask: async () => {
    transientAttempts += 1;
    if (transientAttempts < 3) throw new Error("ECONNRESET: temporary MCP connection closed");
    return { resumed: true, gate_active: true, rules_changed: false };
  }
});
assert.equal(transientAttempts, 3);
assert.equal(transient.get("profile-a")?.state, "ready");
assert.deepEqual(transientStates, ["recovering", "reconnecting", "recovering", "reconnecting", "recovering", "ready"]);

let permanentAttempts = 0;
const permanent = await reconcileRunningTaskGates({
  runtimeKey: "runtime-permanent",
  profiles: [profile],
  jobs: [running],
  sleep: async () => {},
  resumeTask: async () => {
    permanentAttempts += 1;
    const error = new Error("WORKSPACE_TASK_WORKTREE_MISSING: recorded worktree is missing");
    error.code = "WORKSPACE_TASK_WORKTREE_MISSING";
    throw error;
  }
});
assert.equal(permanentAttempts, 1);
assert.equal(permanent.get("profile-a")?.state, "blocked");
assert.match(permanent.get("profile-a")?.message || "", /^Không thể tiếp tục:/);

let concurrentAttempts = 0;
let release;
const gate = new Promise((resolve) => { release = resolve; });
const options = {
  runtimeKey: "runtime-concurrent",
  profiles: [profile],
  jobs: [running],
  sleep: async () => {},
  resumeTask: async () => {
    concurrentAttempts += 1;
    await gate;
    return { resumed: true, gate_active: true };
  }
};
const first = reconcileRunningTaskGates(options);
const second = reconcileRunningTaskGates(options);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(concurrentAttempts, 1, "concurrent Manager reconciliation must share one gate recovery");
release();
const [firstResult, secondResult] = await Promise.all([first, second]);
assert.equal(firstResult.get("profile-a")?.state, "ready");
assert.equal(secondResult.get("profile-a")?.state, "ready");
assert.equal(concurrentAttempts, 1);

console.log("task-gate-recovery-smoke: ok");
