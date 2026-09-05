import fs from "node:fs";
import path from "node:path";

const MAX_CHAT_CACHE_ENTRIES_PER_PROFILE = 3;
const MAX_CHAT_CACHE_MESSAGES = 12;
const MAX_CHAT_CACHE_TEXT_CHARS = 40000;

function chatCacheKey(profileId, conversationId) {
  return `${profileId}:${conversationId}`;
}

function normalizeChatCacheMessage(message, index) {
  const role = message?.role === "user" ? "user" : message?.role === "assistant" ? "assistant" : "";
  const text = String(message?.text || "").trim().slice(0, MAX_CHAT_CACHE_TEXT_CHARS);
  if (!role || !text) return null;
  return {
    id: String(message?.id || `${role}-${index}`).slice(0, 220),
    role,
    text,
    truncated: Boolean(message?.truncated),
    pending: Boolean(message?.pending),
    uncertain: Boolean(message?.uncertain),
    provisional: Boolean(message?.provisional),
    endTurn: message?.endTurn === true ? true : message?.endTurn === false ? false : null,
    submissionState: ["pending", "submitted", "uncertain"].includes(String(message?.submissionState || "")) ? String(message.submissionState) : "",
    createdAt: String(message?.createdAt || "").slice(0, 80)
  };
}

function normalizeChatCacheEntry(value) {
  const profileId = String(value?.profileId || "").trim();
  const conversationId = String(value?.conversationId || "").trim();
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(profileId) || !/^[A-Za-z0-9-]{8,160}$/.test(conversationId)) return null;
  const messages = (Array.isArray(value?.messages) ? value.messages : [])
    .map(normalizeChatCacheMessage)
    .filter(Boolean)
    .slice(-MAX_CHAT_CACHE_MESSAGES);
  const text = String(value?.text || "").trim().slice(0, MAX_CHAT_CACHE_TEXT_CHARS);
  const hasLogicalTaskCount = Object.prototype.hasOwnProperty.call(value || {}, "logicalTaskCount");
  const completedLogicalTaskIds = [...new Set((Array.isArray(value?.completedLogicalTaskIds) ? value.completedLogicalTaskIds : [])
    .map((taskId) => String(taskId || "").trim())
    .filter((taskId) => /^cpt_[a-f0-9]{24}$/.test(taskId)))]
    .slice(-20);
  const repoTaskId = String(value?.repoTaskId || "").trim();
  const logicalTaskStatus = String(value?.logicalTaskStatus || "").trim().toLowerCase();
  if (!messages.length && !text) return null;
  return {
    profileId,
    conversationId,
    messages,
    text,
    truncated: Boolean(value?.truncated),
    networkCompletedAt: String(value?.networkCompletedAt || "").slice(0, 80),
    networkState: String(value?.networkState || "").slice(0, 32),
    responseReady: Boolean(value?.responseReady),
    responseSource: String(value?.responseSource || "").slice(0, 80),
    messageCount: Math.max(0, Math.floor(Number(value?.messageCount) || 0)),
    totalMessageCount: Math.max(0, Math.floor(Number(value?.totalMessageCount) || 0)),
    ...(hasLogicalTaskCount ? { logicalTaskCount: Math.max(0, Math.floor(Number(value?.logicalTaskCount) || 0)) } : {}),
    completedLogicalTaskIds,
    repoTaskId: /^cpt_[a-f0-9]{24}$/.test(repoTaskId) ? repoTaskId : "",
    logicalTaskStatus: ["prepared", "running", "completed", "failed", "cancelled", "blocked"].includes(logicalTaskStatus) ? logicalTaskStatus : "",
    activityStartedAt: String(value?.activityStartedAt || "").slice(0, 80),
    fastMessageLimitQualified: Boolean(value?.fastMessageLimitQualified),
    updatedAt: String(value?.updatedAt || new Date().toISOString()).slice(0, 80)
  };
}

function retainRecentManagerChatCacheEntries(entries) {
  const grouped = new Map();
  for (const entry of entries.map(normalizeChatCacheEntry).filter(Boolean)) {
    const current = grouped.get(entry.profileId) || [];
    const deduped = current.filter((candidate) => candidate.conversationId !== entry.conversationId);
    deduped.push(entry);
    deduped.sort((left, right) => {
      const leftAt = Date.parse(String(left.updatedAt || ""));
      const rightAt = Date.parse(String(right.updatedAt || ""));
      return (Number.isFinite(leftAt) ? leftAt : 0) - (Number.isFinite(rightAt) ? rightAt : 0);
    });
    grouped.set(entry.profileId, deduped.slice(-MAX_CHAT_CACHE_ENTRIES_PER_PROFILE));
  }
  return [...grouped.values()].flat().sort((left, right) => {
    const leftAt = Date.parse(String(left.updatedAt || ""));
    const rightAt = Date.parse(String(right.updatedAt || ""));
    return (Number.isFinite(leftAt) ? leftAt : 0) - (Number.isFinite(rightAt) ? rightAt : 0);
  });
}

export function createManagerChatCache({ home, now = () => new Date().toISOString() }) {
  const managerChatCacheFile = path.join(home, "manager-chat-cache.json");
  let managerChatCacheEntries = null;
  let managerChatCacheIndex = null;

  function setMemory(entries) {
    const normalized = retainRecentManagerChatCacheEntries(entries);
    managerChatCacheEntries = normalized;
    managerChatCacheIndex = new Map(normalized.map((entry) => [chatCacheKey(entry.profileId, entry.conversationId), entry]));
    return normalized;
  }

  function read() {
    if (managerChatCacheEntries && managerChatCacheIndex) return managerChatCacheEntries;
    try {
      const parsed = JSON.parse(fs.readFileSync(managerChatCacheFile, "utf8"));
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      return setMemory(entries);
    } catch {
      return setMemory([]);
    }
  }

  function write(entries) {
    fs.mkdirSync(home, { recursive: true });
    const normalized = setMemory(entries);
    fs.writeFileSync(managerChatCacheFile, `${JSON.stringify({ version: 1, entries: normalized }, null, 2)}\n`, "utf8");
  }

  function get(payload) {
    const profileId = String(payload?.profileId || "").trim();
    const conversationId = String(payload?.conversationId || "").trim();
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(profileId) || !/^[A-Za-z0-9-]{8,160}$/.test(conversationId)) return null;
    const key = chatCacheKey(profileId, conversationId);
    read();
    return managerChatCacheIndex.get(key) || null;
  }

  function save(payload) {
    const entry = normalizeChatCacheEntry(payload);
    if (!entry) return null;
    const key = chatCacheKey(entry.profileId, entry.conversationId);
    const entries = read().filter((candidate) => chatCacheKey(candidate.profileId, candidate.conversationId) !== key);
    const saved = { ...entry, updatedAt: now() };
    entries.push(saved);
    write(entries);
    return saved;
  }

  return { read, get, save };
}
