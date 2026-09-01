import assert from "node:assert/strict";
import { createApiWorkerPlugin } from "../electron/worker-plugins/api-worker-plugin.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(read, predicate, label, timeoutMs = 1200) {
  const deadline = Date.now() + timeoutMs;
  let state;
  while (Date.now() < deadline) {
    state = await read();
    if (predicate(state)) return state;
    await sleep(10);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(state)}`);
}

let providerRun = 0;
const staleEvents = [];
const plugin = createApiWorkerPlugin({
  configurations: [{ id: "stream-api", label: "Stream API", provider: "fixture", model: "fixture", credential_available: true }],
  createProvider: async () => {
    providerRun += 1;
    const runNumber = providerRun;
    let turn = 0;
    return {
      manifest: { id: `stream-provider-${runNumber}`, name: "Stream fixture", kind: "fixture", capabilities: { tool_calling: true, streaming: true } },
      async complete(input) {
        turn += 1;
        if (turn === 1) {
          return {
            text: "",
            toolCalls: [{ id: `title-${runNumber}`, name: "begin_repo_task", arguments: { task_title: runNumber === 1 ? "Stream first API answer" : "Stream second API answer" } }]
          };
        }
        const parts = runNumber === 1 ? ["First ", "answer"] : ["Second ", "answer"];
        input.onDelta?.({ type: "text", text: parts[0] });
        await sleep(25);
        input.onDelta?.({ type: "text", text: parts[1] });
        if (runNumber === 1) {
          setTimeout(() => {
            staleEvents.push("old-delta-fired");
            input.onDelta?.({ type: "text", text: " STALE" });
          }, 90);
          await sleep(30);
        } else {
          await sleep(120);
        }
        return { text: parts.join(""), toolCalls: [], usage: { total_tokens: 2 } };
      }
    };
  },
  createMcpClients: async () => ({
    controlMcp: { async callTool() { return { prepared: true }; }, async close() {} },
    jobMcp: {
      async listTools() { return [{ name: "begin_repo_task", description: "title", inputSchema: { type: "object" } }]; },
      async callTool(name, args) {
        if (name === "begin_repo_task") return { verified: true, task_title: args.task_title, task_kind: "general" };
        if (name === "finalize_worker_job") return { finalized: true, job: { status: args.outcome } };
        throw new Error(`unexpected tool ${name}`);
      },
      async close() {}
    }
  })
});

const read = () => plugin.read({ local_worker_id: "stream-api" });

await plugin.send({
  local_worker_id: "stream-api",
  task_id: "cpt_aaaaaaaaaaaaaaaaaaaaaaaa",
  task_kind: "general",
  scope: "all_allowed",
  text: "First request"
});

const firstStreaming = await waitFor(read, (state) => state.activity === "working" && state.stream_text === "First answer", "first visible stream");
assert.equal(firstStreaming.stream_phase, "streaming");
assert.equal(firstStreaming.stream_revision > 0, true, "stream revision must advance while visible text grows");
assert.equal(Boolean(firstStreaming.stream_updated_at), true, "stream updates must carry a timestamp");
const firstDone = await waitFor(read, (state) => state.activity === "idle", "first completion");
assert.equal(firstDone.result.text, "First answer");
assert.equal(firstDone.stream_text, "First answer", "settled stream text must equal the final result exactly once");
assert.equal(firstDone.stream_phase, "complete");

await plugin.send({
  local_worker_id: "stream-api",
  task_id: "cpt_bbbbbbbbbbbbbbbbbbbbbbbb",
  task_kind: "general",
  scope: "all_allowed",
  text: "Second request"
});

const secondStreaming = await waitFor(read, (state) => state.activity === "working" && state.stream_text.startsWith("Second"), "second visible stream");
assert.equal(secondStreaming.job_id, "cpt_bbbbbbbbbbbbbbbbbbbbbbbb");
await sleep(100);
const afterStale = await read();
assert.equal(staleEvents.includes("old-delta-fired"), true, "fixture must actually fire the old job delta");
assert.equal(String(afterStale.stream_text || "").includes("STALE"), false, "late deltas from the previous job must never cross into the active job");
const secondDone = await waitFor(read, (state) => state.activity === "idle", "second completion");
assert.equal(secondDone.stream_text, "Second answer");
assert.equal(secondDone.result.text, "Second answer");

console.log("✓ API worker visible streaming and stale-job rejection smoke test passed");
