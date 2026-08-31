import assert from "node:assert/strict";
import { discoverApiWorkerModels } from "../electron/worker-core/api-worker-model-discovery.mjs";

let observedCredential = "";
const result = await discoverApiWorkerModels({
  id: "9router-main",
  provider: "9router",
  base_url: "http://localhost:20128/v1",
  api_key: "transient-fixture-key"
}, {
  getStoredCredential: async () => { throw new Error("inline credential should win"); },
  createProvider: async (_config, getApiKey) => ({
    listModels: async () => {
      observedCredential = await getApiKey();
      return [{ id: "cc/claude-opus-4-6", name: "Claude Opus", context_length: 200000 }];
    }
  })
});
assert.equal(observedCredential, "transient-fixture-key");
assert.deepEqual(result.models, [{ id: "cc/claude-opus-4-6", name: "Claude Opus", context_length: 200000 }]);
assert.equal(JSON.stringify(result).includes("transient-fixture-key"), false);

let storedCredentialUsed = false;
const storedResult = await discoverApiWorkerModels({ id: "saved-worker", provider: "9router" }, {
  getStoredCredential: async () => {
    storedCredentialUsed = true;
    return "stored-fixture-key";
  },
  createProvider: async (_config, getApiKey) => ({ listModels: async () => [{ id: await getApiKey() }] })
});
assert.equal(storedCredentialUsed, true);
assert.equal(JSON.stringify(storedResult).includes("stored-fixture-key"), false, "provider output must not echo a credential to the renderer");
await assert.rejects(() => discoverApiWorkerModels({ provider: "9router" }, { createProvider: async () => ({}) }), /API key/);

console.log("✓ API worker secure model discovery smoke test passed");
