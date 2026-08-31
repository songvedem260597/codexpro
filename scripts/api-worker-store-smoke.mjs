import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApiWorkerStore } from "../manager/electron/worker-core/api-worker-store.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-api-worker-store-"));
const secret = "sk-store-fixture-secret";
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${Buffer.from(value).toString("base64")}`),
  decryptString: (value) => Buffer.from(String(value).replace(/^encrypted:/, ""), "base64").toString("utf8")
};

try {
  const store = createApiWorkerStore({ home, safeStorage });
  const saved = store.save({
    id: "openrouter-main",
    label: "OpenRouter chính",
    provider: "openrouter",
    base_url: "https://openrouter.ai/api/v1",
    model: "openai/gpt-5",
    api_key: secret
  });
  assert.equal(saved.credential_available, true);
  assert.equal(saved.credential_ref, "os-secret:api-worker:openrouter-main");
  assert.equal(saved.api_key, undefined);
  assert.equal(store.credential("openrouter-main"), secret);
  assert.equal(store.list()[0].model, "openai/gpt-5");
  const metadata = fs.readFileSync(store.files.configsFile, "utf8");
  const encrypted = fs.readFileSync(store.files.secretsFile, "utf8");
  assert.equal(metadata.includes(secret), false, "metadata must never contain the API key");
  assert.equal(encrypted.includes(secret), false, "secret file must contain only OS-encrypted bytes");

  store.save({ ...saved, model: "anthropic/claude-test" });
  assert.equal(store.credential("openrouter-main"), secret, "editing metadata must preserve the credential");
  assert.equal(store.list()[0].model, "anthropic/claude-test");
  assert.throws(() => store.save({ id: "unsafe", provider: "openai-compatible", base_url: "http://provider.example/v1", model: "model", api_key: "x" }), /HTTPS/);

  const unavailable = createApiWorkerStore({ home: path.join(home, "unavailable"), safeStorage: { isEncryptionAvailable: () => false } });
  assert.throws(() => unavailable.save({ id: "blocked", provider: "openrouter", model: "model", api_key: "secret" }), /unavailable/);
  assert.deepEqual(unavailable.list(), [], "failed encryption must not leave a half-saved worker configuration");
  const weakLinuxBackend = createApiWorkerStore({ home: path.join(home, "weak-linux"), safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "basic_text", encryptString: (value) => Buffer.from(value) } });
  assert.throws(() => weakLinuxBackend.save({ id: "weak", provider: "openrouter", model: "model", api_key: "secret" }), /unavailable/);

  assert.equal(store.remove("openrouter-main").removed, true);
  assert.deepEqual(store.list(), []);
  assert.equal(store.credential("openrouter-main"), "");
  console.log("✓ API worker OS-secret store smoke test passed");
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
