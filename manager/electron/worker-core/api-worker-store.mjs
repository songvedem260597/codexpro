import fs from "node:fs";
import path from "node:path";
import { normalizeProviderBaseUrl } from "../provider-core/openai-compatible-provider.mjs";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,94}$/;
const PROVIDERS = new Set(["openrouter", "openai-compatible"]);

function clean(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function normalizeConfig(value) {
  const source = value && typeof value === "object" ? value : {};
  const id = clean(source.id, 95);
  if (!ID_PATTERN.test(id)) throw new Error("API worker id must use 1-95 letters, numbers, dot, underscore, or dash.");
  const provider = clean(source.provider, 40).toLowerCase();
  if (!PROVIDERS.has(provider)) throw new Error("API worker provider must be openrouter or openai-compatible.");
  const baseUrl = normalizeProviderBaseUrl(source.base_url || source.baseUrl || (provider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1")).toString().replace(/\/$/, "");
  const model = clean(source.model, 240);
  if (!model) throw new Error("API worker model is required.");
  return {
    id,
    label: clean(source.label || id, 100),
    provider,
    base_url: baseUrl,
    model,
    enabled: source.enabled !== false,
    app_name: clean(source.app_name || source.appName || "CodexPro", 100),
    app_url: clean(source.app_url || source.appUrl, 500),
    updated_at: new Date().toISOString()
  };
}

export function createApiWorkerStore(options = {}) {
  const home = path.resolve(String(options.home || ""));
  const safeStorage = options.safeStorage;
  const configsFile = path.join(home, "api-workers.json");
  const secretsFile = path.join(home, "api-worker-secrets.json");

  function osEncryptionAvailable() {
    if (!safeStorage?.isEncryptionAvailable?.()) return false;
    return safeStorage?.getSelectedStorageBackend?.() !== "basic_text";
  }

  function secretMap() {
    const parsed = readJson(secretsFile, {});
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  }

  function credentialAvailable(id) {
    return typeof secretMap()[id] === "string";
  }

  function list() {
    const parsed = readJson(configsFile, { workers: [] });
    return (Array.isArray(parsed?.workers) ? parsed.workers : []).flatMap((value) => {
      try {
        const config = normalizeConfig(value);
        return [{ ...config, credential_available: credentialAvailable(config.id), credential_ref: `os-secret:api-worker:${config.id}` }];
      } catch {
        return [];
      }
    });
  }

  function save(value) {
    const config = normalizeConfig(value);
    const apiKey = typeof value?.api_key === "string" ? value.api_key.trim() : typeof value?.apiKey === "string" ? value.apiKey.trim() : "";
    const clearCredential = value?.clear_credential === true || value?.clearCredential === true;
    const workers = list().filter((item) => item.id !== config.id).map(({ credential_available, credential_ref, ...item }) => item);
    workers.push(config);
    workers.sort((left, right) => left.id.localeCompare(right.id));
    let nextSecrets;
    if (apiKey || clearCredential) {
      nextSecrets = secretMap();
      if (clearCredential) delete nextSecrets[config.id];
      if (apiKey) {
        if (!osEncryptionAvailable()) throw new Error("OS credential encryption is unavailable; API key was not saved.");
        nextSecrets[config.id] = safeStorage.encryptString(apiKey).toString("base64");
      }
    }
    if (nextSecrets) atomicJson(secretsFile, nextSecrets);
    atomicJson(configsFile, { version: 1, workers });
    return list().find((item) => item.id === config.id);
  }

  function remove(idValue) {
    const id = clean(idValue, 95);
    if (!ID_PATTERN.test(id)) throw new Error("API worker id is invalid.");
    const current = list();
    const workers = current.filter((item) => item.id !== id).map(({ credential_available, credential_ref, ...item }) => item);
    atomicJson(configsFile, { version: 1, workers });
    const secrets = secretMap();
    const removed = Object.prototype.hasOwnProperty.call(secrets, id) || workers.length !== current.length;
    delete secrets[id];
    atomicJson(secretsFile, secrets);
    return { removed, id };
  }

  function credential(idValue) {
    const id = clean(idValue, 95);
    const encrypted = secretMap()[id];
    if (typeof encrypted !== "string") return "";
    if (!osEncryptionAvailable()) throw new Error("OS credential decryption is unavailable.");
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  }

  return { list, save, remove, credential, files: { configsFile, secretsFile } };
}
