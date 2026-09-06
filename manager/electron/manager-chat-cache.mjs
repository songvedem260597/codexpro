import fs from "node:fs";
import path from "node:path";

const MAX_CHAT_CACHE_ENTRIES_PER_PROFILE = 3;
const MAX_CHAT_CACHE_MESSAGES = 12;
const MAX_CHAT_CACHE_TEXT_CHARS = 40000;
const DEFAULT_FLUSH_TIMEOUT_MS = 1500;

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

function defaultEventLoopLagSample() {
  const startedAt = performance.now();
  return new Promise((resolve) => setTimeout(() => resolve(Math.max(0, performance.now() - startedAt)), 0));
}

function roundMetric(value) {
  return Math.round(Math.max(0, Number(value) || 0) * 10) / 10;
}

export function createManagerChatCache({
  home,
  now = () => new Date().toISOString(),
  io = {},
  sampleEventLoopLag = defaultEventLoopLagSample,
  onMetrics = () => {}
}) {
  const managerChatCacheFile = path.join(home, "manager-chat-cache.json");
  const readFileSync = io.readFileSync || ((file, encoding) => fs.readFileSync(file, encoding));
  const mkdir = io.mkdir || ((dir, options) => fs.promises.mkdir(dir, options));
  const writeFile = io.writeFile || ((file, data, encoding) => fs.promises.writeFile(file, data, encoding));
  const rename = io.rename || ((from, to) => fs.promises.rename(from, to));
  const remove = io.remove || ((file) => fs.promises.rm(file, { force: true }));

  let managerChatCacheEntries = null;
  let managerChatCacheIndex = null;
  let requestedRevision = 0;
  let persistedRevision = 0;
  let writeLoopPromise = null;
  let lastWriteError = null;
  let tempSequence = 0;
  const waiters = new Map();
  const metrics = {
    saveRequestsReceived: 0,
    saveRequestsCoalesced: 0,
    saveRequestsCompleted: 0,
    saveRequestsFailed: 0,
    writesStarted: 0,
    writesCompleted: 0,
    writesFailed: 0,
    lastPayloadBytes: 0,
    lastFileBytes: 0,
    lastSerializeMs: 0,
    maxSerializeMs: 0,
    lastWriteMs: 0,
    maxWriteMs: 0,
    lastEventLoopLagMs: 0,
    maxEventLoopLagMs: 0,
    lastErrorAt: ""
  };

  function setMemory(entries) {
    const normalized = retainRecentManagerChatCacheEntries(entries);
    managerChatCacheEntries = normalized;
    managerChatCacheIndex = new Map(normalized.map((entry) => [chatCacheKey(entry.profileId, entry.conversationId), entry]));
    return normalized;
  }

  function read() {
    if (managerChatCacheEntries && managerChatCacheIndex) return managerChatCacheEntries;
    try {
      const parsed = JSON.parse(readFileSync(managerChatCacheFile, "utf8"));
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      return setMemory(entries);
    } catch {
      return setMemory([]);
    }
  }

  function get(payload) {
    const profileId = String(payload?.profileId || "").trim();
    const conversationId = String(payload?.conversationId || "").trim();
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(profileId) || !/^[A-Za-z0-9-]{8,160}$/.test(conversationId)) return null;
    const key = chatCacheKey(profileId, conversationId);
    read();
    return managerChatCacheIndex.get(key) || null;
  }

  function resolveWaitersThrough(revision, error = null) {
    let settled = 0;
    for (const [candidateRevision, waiter] of [...waiters.entries()]) {
      if (candidateRevision > revision) continue;
      waiters.delete(candidateRevision);
      settled += 1;
      if (error) waiter.reject(error);
      else waiter.resolve(waiter.saved);
    }
    return settled;
  }

  async function writeLatestSnapshot() {
    const lag = await sampleEventLoopLag();
    metrics.lastEventLoopLagMs = roundMetric(lag);
    metrics.maxEventLoopLagMs = Math.max(metrics.maxEventLoopLagMs, metrics.lastEventLoopLagMs);

    const targetRevision = requestedRevision;
    const normalized = managerChatCacheEntries || read();
    const serializeStartedAt = performance.now();
    const serialized = `${JSON.stringify({ version: 1, entries: normalized }, null, 2)}\n`;
    const serializeMs = performance.now() - serializeStartedAt;
    metrics.lastSerializeMs = roundMetric(serializeMs);
    metrics.maxSerializeMs = Math.max(metrics.maxSerializeMs, metrics.lastSerializeMs);
    metrics.lastPayloadBytes = Buffer.byteLength(serialized, "utf8");
    const pendingRequestCount = [...waiters.keys()].filter((revision) => revision <= targetRevision).length;
    metrics.saveRequestsCoalesced += Math.max(0, pendingRequestCount - 1);
    metrics.writesStarted += 1;

    await mkdir(home, { recursive: true });
    const tempFile = `${managerChatCacheFile}.tmp-${process.pid}-${++tempSequence}`;
    const writeStartedAt = performance.now();
    try {
      await writeFile(tempFile, serialized, "utf8");
      await rename(tempFile, managerChatCacheFile);
      const writeMs = performance.now() - writeStartedAt;
      metrics.lastWriteMs = roundMetric(writeMs);
      metrics.maxWriteMs = Math.max(metrics.maxWriteMs, metrics.lastWriteMs);
      metrics.lastFileBytes = metrics.lastPayloadBytes;
      metrics.writesCompleted += 1;
      const completedRequests = resolveWaitersThrough(targetRevision);
      metrics.saveRequestsCompleted += completedRequests;
      persistedRevision = targetRevision;
      lastWriteError = null;

      publishMetrics("write-complete");
    } catch (error) {
      const writeMs = performance.now() - writeStartedAt;
      metrics.lastWriteMs = roundMetric(writeMs);
      metrics.maxWriteMs = Math.max(metrics.maxWriteMs, metrics.lastWriteMs);
      metrics.writesFailed += 1;
      const failedRequests = resolveWaitersThrough(targetRevision, error);
      metrics.saveRequestsFailed += failedRequests;
      metrics.lastErrorAt = now();
      lastWriteError = error;
      try { await remove(tempFile); } catch {}

      publishMetrics("write-failed");
      throw error;
    }
  }

  function ensureWriteLoop() {
    if (writeLoopPromise || persistedRevision >= requestedRevision) return writeLoopPromise;
    writeLoopPromise = (async () => {
      while (persistedRevision < requestedRevision) {
        try {
          await writeLatestSnapshot();
        } catch {
          break;
        }
      }
    })().finally(() => {
      writeLoopPromise = null;
      if (!lastWriteError && persistedRevision < requestedRevision) ensureWriteLoop();
    });
    return writeLoopPromise;
  }

  function save(payload) {
    const entry = normalizeChatCacheEntry(payload);
    if (!entry) return Promise.resolve(null);
    const key = chatCacheKey(entry.profileId, entry.conversationId);
    const entries = read().filter((candidate) => chatCacheKey(candidate.profileId, candidate.conversationId) !== key);
    const saved = { ...entry, updatedAt: now() };
    entries.push(saved);
    setMemory(entries);

    metrics.saveRequestsReceived += 1;
    requestedRevision += 1;
    const revision = requestedRevision;
    lastWriteError = null;
    const promise = new Promise((resolve, reject) => waiters.set(revision, { resolve, reject, saved }));
    ensureWriteLoop();
    return promise;
  }

  function metricsSnapshot() {
    return {
      ...metrics,
      pending: Math.max(0, requestedRevision - persistedRevision),
      inFlight: writeLoopPromise ? 1 : 0,
      requestedRevision,
      persistedRevision
    };
  }

  function publishMetrics(reason) {
    try {
      onMetrics({ reason, ...metricsSnapshot() });
    } catch {}
  }

  async function flush({ timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS } = {}) {
    if (persistedRevision >= requestedRevision && !writeLoopPromise) {
      publishMetrics("flush-complete");
      return { flushed: true, timedOut: false, ...metricsSnapshot() };
    }
    lastWriteError = null;
    ensureWriteLoop();
    const deadlineMs = Math.max(1, Number(timeoutMs) || DEFAULT_FLUSH_TIMEOUT_MS);
    let timeoutHandle = 0;
    const timeout = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => resolve(false), deadlineMs);
    });
    const drained = (async () => {
      while (writeLoopPromise) await writeLoopPromise;
      return persistedRevision >= requestedRevision;
    })();
    const flushed = await Promise.race([drained, timeout]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const fullyFlushed = Boolean(flushed) && persistedRevision >= requestedRevision;
    publishMetrics(fullyFlushed ? "flush-complete" : "flush-timeout");
    return { flushed: fullyFlushed, timedOut: !fullyFlushed, ...metricsSnapshot() };
  }

  return {
    read,
    get,
    save,
    flush,
    metrics: metricsSnapshot,
    hasPending: () => persistedRevision < requestedRevision || Boolean(writeLoopPromise)
  };
}
