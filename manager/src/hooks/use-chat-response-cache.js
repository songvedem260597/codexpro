import { useCallback, useEffect, useRef } from "react";
import { profileRequestChats } from "../features/chat/chat-conversation-utils.js";
import { isTerminalChatNetworkState } from "../chat-status.js";
import {
  cacheableTranscriptMessages,
  completedResponseNeedsDomFallback,
  discardProvisionalAssistantAfterLatestUser,
  materializeTranscriptMessages,
  transcriptAwaitingAssistant,
  trimRecentTranscriptMessages
} from "../chat-transcript.js";
import { logicalTaskTracking } from "../conversation-message-limit.js";
import { trimMapEntries } from "../performance-retention.js";
import { createResponseCacheSaveQueue } from "../chat-response-cache-save-queue.js";

function profileConversationTab(profile, conversationId) {
  return (profile?.conversation_tabs || []).find((tab) => String(tab?.url || "").includes(`/c/${conversationId}`)) || null;
}

export function useChatResponseCache({ api, requestTargetsRef, setRequestResponses, loadResponse }) {
  const responseCacheLoads = useRef(new Map());
  const responseMemoryCache = useRef(new Map());
  const responseCacheSaveSignatures = useRef(new Map());
  const responseCacheSaveMetricsLoggedAt = useRef(0);
  const apiRef = useRef(api);
  const responseCacheSaveQueue = useRef(null);
  apiRef.current = api;
  if (!responseCacheSaveQueue.current) {
    responseCacheSaveQueue.current = createResponseCacheSaveQueue({
      save: (entry) => apiRef.current.saveChatResponseCache(entry),
      onMetrics: (metrics) => {
        const at = Date.now();
        const shouldLog = String(metrics.reason || "").startsWith("flush:")
          || Number(metrics.failed) > 0
          || at - responseCacheSaveMetricsLoggedAt.current >= 2000;
        if (!shouldLog || typeof apiRef.current.logDiagnostic !== "function") return;
        responseCacheSaveMetricsLoggedAt.current = at;
        apiRef.current.logDiagnostic({
          level: Number(metrics.failed) > 0 ? "warn" : "info",
          source: "renderer",
          category: "chat-cache",
          action: "response-cache-save-queue",
          message: "Response cache save queue metrics",
          details: {
            reason: String(metrics.reason || ""),
            save_received: Number(metrics.received) || 0,
            save_coalesced: Number(metrics.coalesced) || 0,
            save_completed: Number(metrics.completed) || 0,
            save_failed: Number(metrics.failed) || 0,
            pending: Number(metrics.pending) || 0,
            in_flight: Number(metrics.inFlight) || 0,
            payload_bytes: Number(metrics.lastPayloadBytes) || 0,
            last_save_ms: Number(metrics.lastSaveMs) || 0,
            max_save_ms: Number(metrics.maxSaveMs) || 0
          }
        });
      }
    });
  }

  const responseCacheKey = useCallback((profileId, conversationId) => `${profileId}:${conversationId}`, []);

  const rememberResponseCacheEntry = useCallback((key, cached) => {
    responseMemoryCache.current.delete(key);
    responseMemoryCache.current.set(key, cached || null);
    trimMapEntries(responseMemoryCache.current, 30);
    return cached || null;
  }, []);

  const getResponseCacheEntry = useCallback((profileId, conversationId) => {
    const key = responseCacheKey(profileId, conversationId);
    if (responseMemoryCache.current.has(key)) return Promise.resolve(responseMemoryCache.current.get(key));
    const existing = responseCacheLoads.current.get(key);
    if (existing) return existing;
    const pending = api.getChatResponseCache({ profileId, conversationId })
      .catch(() => null)
      .then((cached) => rememberResponseCacheEntry(key, cached))
      .finally(() => {
        if (responseCacheLoads.current.get(key) === pending) responseCacheLoads.current.delete(key);
      });
    responseCacheLoads.current.set(key, pending);
    return pending;
  }, [api, rememberResponseCacheEntry, responseCacheKey]);

  const prefetchProfileResponseCaches = useCallback((profile) => {
    if (!profile?.connected) return;
    for (const chat of profileRequestChats(profile)) {
      const conversationId = String(chat?.id || "");
      if (/^[A-Za-z0-9-]{8,160}$/.test(conversationId)) void getResponseCacheEntry(profile.profile_id, conversationId);
    }
  }, [getResponseCacheEntry]);

  const cachedResponseIsFresh = useCallback((profile, conversationId, cached) => {
    if (!cached?.messages?.length && !cached?.text) return false;
    if (cached?.responseReady !== true) return false;
    if (transcriptAwaitingAssistant(materializeTranscriptMessages(cached, conversationId))) return false;
    const tab = profileConversationTab(profile, conversationId);
    if (!tab) return false;
    const networkState = String(tab.network_state || (tab.busy ? "generating" : "idle"));
    if (tab.busy || tab.settling || networkState === "generating") return false;
    const completedAt = String(tab.network_last_completed_at || "");
    return !completedAt || completedAt === String(cached.networkCompletedAt || "");
  }, []);

  const persistResponseCache = useCallback((profileId, response) => {
    const conversationId = String(response?.conversationId || "");
    const messages = cacheableTranscriptMessages(response?.messages);
    const text = String(response?.text || "").trim();
    const networkState = String(response?.networkState || "");
    const logicalTrackingState = logicalTaskTracking(response);
    if (!/^[A-Za-z0-9-]{8,160}$/.test(conversationId) || (!messages.length && !text)) return;
    const key = responseCacheKey(profileId, conversationId);
    const signature = JSON.stringify([
      String(response?.networkCompletedAt || ""),
      networkState,
      Boolean(response?.responseReady),
      String(response?.responseSource || ""),
      Boolean(response?.truncated),
      Number(response?.messageCount) || 0,
      Number(response?.totalMessageCount) || 0,
      logicalTrackingState.logicalTaskCount,
      logicalTrackingState.completedLogicalTaskIds.join("|"),
      String(response?.repoTaskId || ""),
      String(response?.logicalTaskStatus || ""),
      String(response?.activityStartedAt || ""),
      Boolean(response?.fastMessageLimitQualified),
      text,
      messages.map((message) => [message?.id, message?.role, message?.text, Boolean(message?.truncated), message?.submissionState, message?.createdAt, Boolean(message?.uncertain), Boolean(message?.provisional), message?.endTurn])
    ]);
    const cacheEntry = {
      profileId,
      conversationId,
      messages,
      text,
      truncated: Boolean(response?.truncated),
      networkCompletedAt: String(response?.networkCompletedAt || ""),
      networkState,
      responseReady: Boolean(response?.responseReady),
      responseSource: String(response?.responseSource || ""),
      messageCount: Number(response?.messageCount) || 0,
      totalMessageCount: Number(response?.totalMessageCount) || 0,
      logicalTaskCount: logicalTrackingState.logicalTaskCount,
      completedLogicalTaskIds: logicalTrackingState.completedLogicalTaskIds,
      repoTaskId: String(response?.repoTaskId || ""),
      logicalTaskStatus: String(response?.logicalTaskStatus || ""),
      activityStartedAt: String(response?.activityStartedAt || ""),
      fastMessageLimitQualified: Boolean(response?.fastMessageLimitQualified),
      updatedAt: String(response?.updatedAt || new Date().toISOString())
    };
    rememberResponseCacheEntry(key, cacheEntry);
    if (responseCacheSaveSignatures.current.get(key) === signature) return;
    responseCacheSaveSignatures.current.set(key, signature);
    const finalSnapshot = Boolean(response?.responseReady) && isTerminalChatNetworkState(networkState);
    responseCacheSaveQueue.current.enqueue(key, cacheEntry, {
      immediate: finalSnapshot,
      onError: () => {
        if (responseCacheSaveSignatures.current.get(key) === signature) responseCacheSaveSignatures.current.delete(key);
      }
    });
    if (finalSnapshot) void responseCacheSaveQueue.current.flush({ reason: "response-final", timeoutMs: 1500 });
  }, [api, rememberResponseCacheEntry, responseCacheKey]);

  const flushResponseCache = useCallback((reason = "chat-change") => {
    return responseCacheSaveQueue.current.flush({ reason, timeoutMs: 1500 });
  }, []);

  const hydrateCachedResponse = useCallback(async (profile, conversationId) => {
    const key = responseCacheKey(profile.profile_id, conversationId);
    const cached = responseMemoryCache.current.has(key)
      ? responseMemoryCache.current.get(key)
      : await getResponseCacheEntry(profile.profile_id, conversationId);
    const cacheFresh = cachedResponseIsFresh(profile, conversationId, cached);
    if (cached) {
      const tab = profileConversationTab(profile, conversationId);
      const networkState = String(tab?.network_state || cached.networkState || "idle");
      const terminalUnverified = cached.responseReady !== true && !tab?.busy && !tab?.settling && isTerminalChatNetworkState(networkState);
      const rawCachedMessages = trimRecentTranscriptMessages(cached.messages);
      const cacheableMessages = cacheableTranscriptMessages(cached.messages);
      const cachedMessages = terminalUnverified
        ? discardProvisionalAssistantAfterLatestUser(cacheableMessages, { includeUnverified: true })
        : cacheableMessages;
      const cachedText = terminalUnverified
        ? String([...cachedMessages].reverse().find((message) => message?.role === "assistant")?.text || "")
        : String(cached.text || "").trim();
      if (!terminalUnverified && rawCachedMessages.length === cachedMessages.length) {
        responseCacheSaveSignatures.current.set(key, JSON.stringify([
          String(cached.networkCompletedAt || ""),
          String(cached.networkState || ""),
          Boolean(cached.responseReady),
          String(cached.responseSource || ""),
          Boolean(cached.truncated),
          Number(cached.messageCount) || 0,
          Number(cached.totalMessageCount) || 0,
          Number(cached.logicalTaskCount) || 0,
          (cached.completedLogicalTaskIds || []).join("|"),
          String(cached.repoTaskId || ""),
          String(cached.logicalTaskStatus || ""),
          String(cached.activityStartedAt || ""),
          Boolean(cached.fastMessageLimitQualified),
          cachedText,
          cachedMessages.map((message) => [message?.id, message?.role, message?.text, Boolean(message?.truncated), message?.submissionState, message?.createdAt, Boolean(message?.uncertain), Boolean(message?.provisional), message?.endTurn])
        ]));
      } else {
        responseCacheSaveSignatures.current.delete(key);
      }
      setRequestResponses((current) => {
        const selectedTargetNow = String(requestTargetsRef.current[profile.profile_id] || "");
        if (selectedTargetNow && selectedTargetNow !== conversationId) return current;
        const previous = current[profile.profile_id] || {};
        const previousIsNewer = previous.conversationId === conversationId
          && Date.parse(String(previous.updatedAt || "")) > Date.parse(String(cached.updatedAt || ""));
        if (previousIsNewer) return current;
        return {
          ...current,
          [profile.profile_id]: {
            ...previous,
            ...cached,
            visible: true,
            loading: false,
            transcriptLoading: !cacheFresh,
            error: "",
            conversationId,
            text: cachedText,
            messages: cachedMessages,
            busy: Boolean(tab?.busy || tab?.settling || networkState === "generating"),
            staleConversationFallback: false,
            networkState,
            networkCompletedAt: String(tab?.network_last_completed_at || cached.networkCompletedAt || ""),
            cached: true
          }
        };
      });
    }
    const selectedTargetNow = String(requestTargetsRef.current[profile.profile_id] || "");
    if (selectedTargetNow && selectedTargetNow !== conversationId) return;
    if (!cacheFresh) {
      const cachedHasContent = Boolean(cached?.messages?.length || String(cached?.text || "").trim());
      const fastResult = await loadResponse(profile, conversationId, true, false, false, false, "cache_hydration");
      const fastHasContent = Boolean(
        fastResult?.network_stream_available && fastResult?.network_stream_in_progress === true
        && (String(fastResult?.text || "").trim() || fastResult?.messages?.length || String(fastResult?.network_stream_activity_text || "").trim())
      );
      if (!fastHasContent && completedResponseNeedsDomFallback(fastResult)) {
        window.setTimeout(() => void loadResponse(profile, conversationId, true, true, false, false, "cache_hydration"), cachedHasContent ? 250 : 0);
      }
    }
  }, [cachedResponseIsFresh, getResponseCacheEntry, loadResponse, requestTargetsRef, responseCacheKey, setRequestResponses]);

  useEffect(() => {
    if (typeof api?.onChatResponseCacheFlushRequest !== "function" || typeof api?.ackChatResponseCacheFlush !== "function") return undefined;
    return api.onChatResponseCacheFlushRequest((payload) => {
      const requestId = String(payload?.requestId || "");
      if (!requestId) return;
      void flushResponseCache("app-before-quit").then((result) => {
        api.ackChatResponseCacheFlush({
          requestId,
          flushed: Boolean(result?.flushed),
          timedOut: Boolean(result?.timedOut),
          pending: Number(result?.pending) || 0,
          inFlight: Number(result?.inFlight) || 0
        });
      }).catch(() => {
        api.ackChatResponseCacheFlush({ requestId, flushed: false, timedOut: false, failed: true });
      });
    });
  }, [api, flushResponseCache]);
  useEffect(() => {
    const sweep = () => trimMapEntries(responseCacheSaveSignatures.current, 96);
    sweep();
    const timer = window.setInterval(sweep, 60_000);
    const flushOnPageHide = () => { void flushResponseCache("renderer-pagehide"); };
    window.addEventListener("pagehide", flushOnPageHide);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pagehide", flushOnPageHide);
      void flushResponseCache("renderer-unmount");
    };
  }, [flushResponseCache]);

  return {
    responseCacheKey,
    prefetchProfileResponseCaches,
    persistResponseCache,
    flushResponseCache,
    hydrateCachedResponse
  };
}
