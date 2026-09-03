import assert from "node:assert/strict";
import { nonInteractiveGitEnv, runCheckedProcess } from "../electron/process-runner.mjs";

const env = nonInteractiveGitEnv({ CODEXPRO_PROCESS_RUNNER_SMOKE: "1" });
assert.equal(env.GIT_TERMINAL_PROMPT, "0");
assert.equal(env.GCM_INTERACTIVE, "Never");
assert.equal(env.CODEXPRO_PROCESS_RUNNER_SMOKE, "1");

const success = await runCheckedProcess(process.execPath, ["-e", "process.stdout.write('ok')"], {
  timeoutMs: 2_000,
  maxBuffer: 16 * 1024
});
assert.equal(success.status, 0);
assert.equal(success.stdout, "ok");

const timeoutStartedAt = Date.now();
await assert.rejects(
  () => runCheckedProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    timeoutMs: 300,
    maxBuffer: 16 * 1024
  }),
  (error) => {
    assert.equal(error?.code, "PROCESS_TIMEOUT");
    assert.equal(error?.timedOut, true);
    return true;
  }
);
assert.ok(Date.now() - timeoutStartedAt < 4_000, "timeout subprocess should be killed promptly");

await assert.rejects(
  () => runCheckedProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(256 * 1024))"], {
    timeoutMs: 2_000,
    maxBuffer: 8 * 1024
  }),
  (error) => {
    assert.equal(error?.code, "PROCESS_OUTPUT_LIMIT");
    assert.equal(error?.outputLimitExceeded, true);
    return true;
  }
);

console.log("manager process runner smoke passed");
