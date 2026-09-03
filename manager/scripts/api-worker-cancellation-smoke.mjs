import assert from "node:assert/strict";
import { createApiWorkerPlugin } from "../electron/worker-plugins/api-worker-plugin.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(read, predicate, label, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  let state;
  while (Date.now() < deadline) {
    state = await read();
    if (predicate(state)) return state;
    await sleep(10);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(state)}`);
}

let startupSignal;
let providerCreated = false;
const plugin = createApiWorkerPlugin({
  configurations: [{ id: "cancel-api", label: "Cancel API", provider: "fixture", model: "fixture", credential_available: true }],
  createMcpClients: async ({ signal }) => {
    startupSignal = signal;
    await new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason || new Error("aborted"));
      signal?.addEventListener("abort", () => reject(signal.reason || new Error("aborted")), { once: true });
    });
    throw new Error("unreachable");
  },
  createProvider: async () => {
    providerCreated = true;
    throw new Error("provider should not be created after startup cancellation");
  }
});

const sendPromise = plugin.send({
  local_worker_id: "cancel-api",
  task_id: "cpt_cccccccccccccccccccccccc",
  task_kind: "general",
  scope: "all_allowed",
  text: "Cancel during MCP startup"
}).then(
  () => null,
  (error) => error
);

await waitFor(
  () => plugin.read({ local_worker_id: "cancel-api" }),
  () => Boolean(startupSignal),
  "startup signal propagation"
);
assert.ok(startupSignal instanceof AbortSignal, "createMcpClients must receive the job AbortSignal");
assert.equal(startupSignal.aborted, false);

const stopped = await plugin.stop({ local_worker_id: "cancel-api" });
assert.equal(stopped.stopped, true);
assert.equal(startupSignal.aborted, true, "Stop must abort MCP startup immediately");

const sendError = await sendPromise;
assert.ok(sendError instanceof Error, "cancelled startup send should settle instead of hanging");
assert.equal(providerCreated, false, "provider creation must not continue after MCP startup cancellation");

const cancelled = await waitFor(
  () => plugin.read({ local_worker_id: "cancel-api" }),
  (state) => state.activity === "idle" && state.stream_phase === "cancelled",
  "cancelled startup state"
);
assert.equal(cancelled.activity, "idle");
assert.equal(cancelled.stream_phase, "cancelled");

console.log("API worker startup cancellation smoke passed");
