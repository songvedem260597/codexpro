import assert from "node:assert/strict";
import { WorkerPluginRegistry } from "../manager/electron/worker-core/plugin-registry.mjs";
import { createChromeWorkerPlugin } from "../manager/electron/worker-plugins/chrome-worker-plugin.mjs";
import { normalizeWorkerPluginManifest, splitWorkerId } from "../manager/electron/worker-core/plugin-contract.mjs";
import { workerChromeActionsVisible, workerNeedsExtensionUpdate, workerSupports, workerVisualState } from "../manager/src/worker-state.js";

const sent = [];
const registry = new WorkerPluginRegistry();
registry.register(createChromeWorkerPlugin({
  sendRequest: async (payload) => { sent.push(payload); return { ok: true }; },
  readResponse: async (payload) => ({ profile_id: payload.profileId, text: "done" }),
  stopTask: async (payload) => ({ profile_id: payload.profileId, stopped: true })
}));

registry.register({
  manifest: { id: "api", name: "API Workers", version: "1", worker_type: "api", capabilities: ["read"] },
  async list() {
    return [{ local_worker_id: "openrouter-main", label: "OpenRouter", provider: "openrouter", model: "example/model", connected: true, activity: "queued", capabilities: ["send", "stop"] }];
  }
});

registry.register({
  manifest: { id: "broken", name: "Broken fixture", version: "1", worker_type: "custom" },
  async list() { throw new Error("fixture unavailable"); }
});

const result = await registry.list({
  browserProfiles: [{
    profile_id: "profile-a",
    label: "Chrome A",
    connected: true,
    activity: "working",
    extension_version: "0.5.85",
    current_task_id: "cpt_test",
    current_task_title: "Worker plugin test",
    conversation_tabs: []
  }]
});

assert.deepEqual(result.workers.map((worker) => worker.worker_id), ["api:openrouter-main", "chrome:profile-a"]);
assert.equal(result.sources.find((source) => source.plugin_id === "broken")?.ok, false, "one broken plugin must not hide healthy workers");
const chrome = result.workers.find((worker) => worker.worker_type === "browser");
const api = result.workers.find((worker) => worker.worker_type === "api");
assert.equal(chrome.activity, "working");
assert.equal(workerVisualState(chrome), "working");
assert.equal(workerChromeActionsVisible(chrome), true);
assert.equal(workerVisualState(api), "working");
assert.equal(workerChromeActionsVisible(api), false);
assert.equal(workerNeedsExtensionUpdate(api, () => false), false, "API workers must not enter the extension update flow");
assert.equal(workerSupports(api, "send"), true);
assert.deepEqual(splitWorkerId("api:openrouter-main"), { pluginId: "api", localWorkerId: "openrouter-main" });

await registry.invoke("send", "chrome:profile-a", { text: "hello" });
assert.equal(sent[0].profileId, "profile-a", "registry must pass only the local id to the Chrome compatibility adapter");
await assert.rejects(() => registry.invoke("send", "api:openrouter-main", {}), /does not support send/);
assert.throws(() => registry.register(createChromeWorkerPlugin()), /already registered/);
assert.throws(() => normalizeWorkerPluginManifest({ id: "BAD ID", name: "Bad", version: "1", worker_type: "api" }), /invalid/);

console.log("✓ Worker plugin registry smoke test passed");
