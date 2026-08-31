import assert from "node:assert/strict";
import { createApiWorkerDraft, switchApiWorkerProvider, validateApiWorkerDraft } from "../src/api-worker-form.js";

const draft = createApiWorkerDraft();
assert.equal(draft.id, "9router-main");
assert.equal(draft.label, "9Router chính");
assert.equal(draft.provider, "9router");
assert.equal(draft.base_url, "http://localhost:20128/v1");
assert.equal(draft.model, "cc/claude-opus-4-6");
assert.match(validateApiWorkerDraft(draft).message, /API key/);
assert.equal(validateApiWorkerDraft({ ...draft, api_key: "fixture-key" }).valid, true);

const secondDraft = createApiWorkerDraft("9router", ["9router-main"]);
assert.equal(secondDraft.id, "9router-main-2");
assert.equal(secondDraft.label, "9Router chính 2");
assert.match(validateApiWorkerDraft(draft, { configs: [{ id: "9router-main" }] }).message, /tồn tại/);
assert.equal(validateApiWorkerDraft(draft, { editingId: "9router-main", credentialAvailable: true }).valid, true);

const switched = switchApiWorkerProvider({ ...draft, api_key: "fixture-key" }, "openai-compatible");
assert.equal(switched.id, "openai-worker");
assert.equal(switched.label, "OpenAI-compatible");
assert.equal(switched.base_url, "https://api.openai.com/v1");
assert.equal(switched.model, "gpt-4.1-mini");
assert.equal(switched.api_key, "fixture-key");

console.log("✓ API worker form defaults and validation smoke test passed");
