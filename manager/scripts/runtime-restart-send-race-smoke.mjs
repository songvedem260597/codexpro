import assert from "node:assert/strict";
import fs from "node:fs";
import { createRuntimeRestartGuard } from "../electron/runtime-restart-guard.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const managerMain = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");

assert.match(managerMain, /runtimeRestartGuard\.runSend\(\(\)=>sendProfileRequestUnlocked\(payload\)\)/, "profile sends must reserve the runtime restart guard");
assert.match(managerMain, /runtimeRestartGuard\.startRestart\([\s\S]*?controlServer\("restart"\)[\s\S]*?runtime-build-refresh-send-guard/, "automatic runtime refresh must pass through the send/restart guard");

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

{
  const guard = createRuntimeRestartGuard({ sendCooldownMs: 25 });
  const sendGate = deferred();
  const send = guard.runSend(async () => {
    await sendGate.promise;
    return "sent";
  });

  assert.equal(guard.snapshot().activeSendCount, 1, "send must reserve the restart guard synchronously");
  const blocked = guard.startRestart(async () => "restarted");
  assert.equal(blocked.started, false, "runtime restart must not start during an active send");
  assert.equal(blocked.reason, "send-in-flight");

  sendGate.resolve();
  assert.equal(await send, "sent");
  assert.equal(guard.snapshot().activeSendCount, 0);

  const cooldown = guard.startRestart(async () => "restarted");
  assert.equal(cooldown.started, false, "runtime restart must stay blocked briefly after send ACK");
  assert.equal(cooldown.reason, "send-cooldown");
  await wait(35);

  const restart = guard.startRestart(async () => "restarted");
  assert.equal(restart.started, true);
  assert.equal(await restart.promise, "restarted");
}

{
  const guard = createRuntimeRestartGuard({ sendCooldownMs: 1 });
  const restartGate = deferred();
  let sendStarted = false;
  const restart = guard.startRestart(async () => {
    await restartGate.promise;
    return "fresh-runtime";
  });
  assert.equal(restart.started, true);

  const send = guard.runSend(async () => {
    sendStarted = true;
    return "sent-after-restart";
  });
  await wait(0);
  assert.equal(sendStarted, false, "a send that arrives during restart must wait for the fresh runtime");

  restartGate.resolve();
  assert.equal(await restart.promise, "fresh-runtime");
  assert.equal(await send, "sent-after-restart");
  assert.equal(sendStarted, true);
}

console.log("runtime-restart-send-race-smoke: ok");
