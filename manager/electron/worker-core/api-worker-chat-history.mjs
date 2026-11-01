import fs from "node:fs";
import path from "node:path";

export const CLOUD_CHAT_WORKER_ID = "render-deepseek";
export const CLOUD_CHAT_MESSAGE_LIMIT = 5;

function messagesOnly(value) {
  return (Array.isArray(value) ? value : [])
    .filter((item) => (item?.role === "user" || item?.role === "assistant") && typeof item.content === "string" && item.content.trim())
    .map((item) => ({ role: item.role, content: item.content.slice(0, 20_000) }))
    .slice(-CLOUD_CHAT_MESSAGE_LIMIT);
}

function sameWorkspace(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

export function createApiWorkerChatHistoryStore({ home, safeStorage }) {
  const file = path.join(path.resolve(home), "api-worker-chat-history.json");

  function readData() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.version === 1 ? parsed : { version: 1, workers: {} };
    } catch {
      return { version: 1, workers: {} };
    }
  }

  function checkEncryption() {
    if (!safeStorage?.isEncryptionAvailable?.() || safeStorage?.getSelectedStorageBackend?.() === "basic_text") {
      throw new Error("Encrypted worker chat history requires OS credential encryption.");
    }
  }

  function read(id, scope, root) {
    if (id !== CLOUD_CHAT_WORKER_ID) return { messages: [] };
    const record = readData().workers?.[id];
    if (!record?.ciphertext) return { messages: [] };
    if (scope !== undefined && (record.scope !== scope || (scope !== "all_allowed" && !sameWorkspace(record.root, root)))) {
      return { messages: [] };
    }
    try {
      checkEncryption();
      const messages = messagesOnly(JSON.parse(safeStorage.decryptString(Buffer.from(record.ciphertext, "base64"))));
      return { messages, scope: record.scope, root: record.root };
    } catch {
      // Invalid or unavailable encrypted history must never leak untrusted data.
      return { messages: [] };
    }
  }

  function save(id, scope, root, messages) {
    if (id !== CLOUD_CHAT_WORKER_ID) return;
    checkEncryption();
    const normalized = messagesOnly(messages);
    const current = readData();
    const workers = current.workers && typeof current.workers === "object" && !Array.isArray(current.workers)
      ? { ...current.workers } : {};
    workers[id] = {
      scope: scope === "all_allowed" ? "all_allowed" : "workspace",
      root: scope === "all_allowed" ? "" : String(root || "").slice(0, 2048),
      ciphertext: safeStorage.encryptString(JSON.stringify(normalized)).toString("base64")
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const staged = file + "." + process.pid + "." + Date.now() + ".tmp";
    try {
      fs.writeFileSync(staged, JSON.stringify({ version: 1, workers }, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(staged, file);
    } finally {
      try { fs.unlinkSync(staged); } catch {}
    }
  }

  return { read, save, file };
}
