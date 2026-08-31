import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApiWorkerStore } from "../manager/electron/worker-core/api-worker-store.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-api-worker-store-"));
const secret = "sk-" + "A".repeat(36);
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${Buffer.from(value).toString("base64")}`),
  decryptString: (value) => Buffer.from(String(value).replace(/^encrypted:/, ""), "base64").toString("utf8")
};

try {
  const store = createApiWorkerStore({ home, safeStorage });
  const saved = store.save({
    id: "9router-main",
    label: "9Router chính",
    provider: "9router",
    model: "cc/claude-opus-4-6",
    api_key: secret
  });
  assert.equal(saved.credential_available, true);
  assert.equal(saved.label, "9Router", "legacy 9Router labels must migrate to the concise display name");
  assert.equal(saved.credential_ref, "os-secret:api-worker:9router-main");
  assert.equal(saved.api_key, undefined);
  assert.equal(saved.base_url, "http://localhost:20128/v1");
  assert.equal(store.credential("9router-main"), secret);
  assert.equal(store.list()[0].model, "cc/claude-opus-4-6");
  const metadata = fs.readFileSync(store.files.configsFile, "utf8");
  const encrypted = fs.readFileSync(store.files.secretsFile, "utf8");
  assert.equal(metadata.includes(secret), false, "metadata must never contain the API key");
  assert.equal(encrypted.includes(secret), false, "secret file must contain only OS-encrypted bytes");

  store.save({ ...saved, model: "cc/claude-sonnet-4-20250514" });
  assert.equal(store.credential("9router-main"), secret, "editing metadata must preserve the credential");
  assert.equal(store.list()[0].model, "cc/claude-sonnet-4-20250514");
  const disabled = store.save({ ...store.list()[0], enabled: false });
  assert.equal(disabled.enabled, false, "disabling a worker must persist its disabled state");
  assert.equal(store.credential("9router-main"), secret, "disabling a worker must preserve the encrypted credential");
  const reenabled = store.save({ ...disabled, enabled: true });
  assert.equal(reenabled.enabled, true, "re-enabling a worker must persist its enabled state");
  assert.equal(store.credential("9router-main"), secret, "re-enabling a worker must preserve the encrypted credential");
  assert.throws(() => store.save({ id: "unsafe", provider: "openai-compatible", base_url: "http://provider.example/v1", model: "model", api_key: "x" }), /HTTPS/);

  const unavailable = createApiWorkerStore({ home: path.join(home, "unavailable"), safeStorage: { isEncryptionAvailable: () => false } });
  assert.throws(() => unavailable.save({ id: "blocked", provider: "9router", model: "model", api_key: "secret" }), /unavailable/);
  assert.deepEqual(unavailable.list(), [], "failed encryption must not leave a half-saved worker configuration");
  const weakLinuxBackend = createApiWorkerStore({ home: path.join(home, "weak-linux"), safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "basic_text", encryptString: (value) => Buffer.from(value) } });
  assert.throws(() => weakLinuxBackend.save({ id: "weak", provider: "9router", model: "model", api_key: "secret" }), /unavailable/);

  assert.equal(store.remove("9router-main").removed, true);
  assert.deepEqual(store.list(), []);
  assert.equal(store.credential("9router-main"), "");
  console.log("✓ API worker OS-secret store smoke test passed");
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
