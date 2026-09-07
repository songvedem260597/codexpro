import { useEffect, useRef } from "react";
import { NEW_CHAT_TARGET } from "../features/chat/chat-dropdown.jsx";
import { conversationIdFromTab, profileRequestChats } from "../features/chat/chat-conversation-utils.js";
import { extensionReady } from "../features/profiles/profile-runtime-utils.js";
import { canVerifyRepoTaskUse, isRecoverableAbortedChatNetworkFailure } from "../chat-status.js";
import { completedResponseNeedsDomFallback, materializeTranscriptMessages } from "../chat-transcript.js";
import { buildChatResponseAuditRecord } from "../chat-response-audit.js";
import { logRendererDiagnostic } from "../diagnostic-log-view.jsx";
import { pruneTimestampMap, trimMapEntries } from "../performance-retention.js";

const LATEST_RESPONSE_RECOVERY_POLL_MS = 3000;

export function shouldScheduleGeneratingPoll(chatProfileId, profileId) {
  return Boolean(chatProfileId) && chatProfileId === profileId;
}

export function createCanonicalResponseReadCoordinator({ now = () => Date.now(), maxCooldownMs = 60_000 } = {}) {
  const states = new Map();
  const normalizedCooldownLimit = Math.max(0, Number(maxCooldownMs) || 0);
  const nextAllowedAtFrom = (result, currentNow) => {
    if (result?.canonical_rate_limited !== true) return 0;
    const retryAtMs = Date.parse(String(result?.canonical_retry_at || ""));
    const retryAfterMs = Math.max(0, Number(result?.canonical_retry_after_ms) || 0);
    const requestedAt = Number.isFinite(retryAtMs) && retryAtMs > currentNow
      ? retryAtMs
      : currentNow + retryAfterMs;
    const boundedDelay = normalizedCooldownLimit > 0
      ? Math.min(normalizedCooldownLimit, Math.max(0, requestedAt - currentNow))
      : Math.max(0, requestedAt - currentNow);
    return currentNow + boundedDelay;
  };
  return {
    run(key, read) {
      const normalizedKey = String(key || "");
      if (!normalizedKey || typeof read !== "function") return Promise.resolve(null);
      const currentNow = Number(now()) || Date.now();
      const current = states.get(normalizedKey) || { inFlight: null, nextAllowedAt: 0, lastRateLimitedResult: null, touchedAt: currentNow };
      if (current.inFlight) return current.inFlight;
      if (current.nextAllowedAt > currentNow) {
        return Promise.resolve({
          ...(current.lastRateLimitedResult || {}),
          canonical_rate_limited: true,
          canonical_poll_deferred: true,
          canonical_retry_at: new Date(current.nextAllowedAt).toISOString(),
          canonical_retry_after_ms: Math.max(0, current.nextAllowedAt - currentNow)
        });
      }
      let operation;
      operation = Promise.resolve().then(read).then((result) => {
        const completedAt = Number(now()) || Date.now();
        const nextAllowedAt = nextAllowedAtFrom(result, completedAt);
        states.set(normalizedKey, {
          inFlight: operation,
          nextAllowedAt,
          lastRateLimitedResult: result?.canonical_rate_limited === true ? result : null,
          touchedAt: completedAt
        });
        return result;
      }).finally(() => {
        const latest = states.get(normalizedKey);
        if (latest?.inFlight === operation) states.set(normalizedKey, { ...latest, inFlight: null });
      });
      states.set(normalizedKey, { ...current, inFlight: operation, touchedAt: currentNow });
      return operation;
    },
    prune(maxEntries = 96) {
      const limit = Math.max(1, Number(maxEntries) || 96);
      if (states.size <= limit) return;
      const removable = [...states.entries()]
        .filter(([, state]) => !state?.inFlight)
        .sort((left, right) => Number(left[1]?.touchedAt || 0) - Number(right[1]?.touchedAt || 0));
      for (const [key] of removable) {
        if (states.size <= limit) break;
        states.delete(key);
      }
    },
    size() {
      return states.size;
    }
  };
}

export function useChatSession({
  api,
  status,
  chatProfileId,
  busy,
  requestTargets,
  requestTargetsRef,
  requestTargetReasons,
  requestResponses,
  setRequestTargets,
  setRequestResponses,
  networkStreamPushTimes,
  prefetchProfileResponseCaches,
  hydrateCachedResponse,
  persistResponseCache,
  flushResponseCache,
  loadResponse,
  verifyRepoTaskUse,
  notify,
  openChatResponse,
  openChatAwaitingAssistant,
  openChatLatestMessageKey,
  responseBodyRefs
}) {
  const networkStreamReads = useRef(new Map());
  const networkCompletionReads = useRef(new Map());
  const connectionRecoveryReads = useRef(new Map());
  const profilesRef = useRef([]);
  const requestTargetDiagnostics = useRef(new Map());
  const responseAuditSignatures = useRef(new Map());
  const canonicalResponseReads = useRef(null);
  if (!canonicalResponseReads.current) canonicalResponseReads.current = createCanonicalResponseReadCoordinator();
  const loadCanonicalResponse = (profile, conversationId) => canonicalResponseReads.current.run(
    `${profile.profile_id}:${conversationId}`,
    () => loadResponse(profile, conversationId, true, false, false, true)
  );
  useEffect(() => {
    profilesRef.current = status?.browserProfiles || [];
  }, [status?.browserProfiles]);

  useEffect(() => {
    const profiles = status?.browserProfiles || [];
    if (!profiles.length) return undefined;
    const timer = window.setTimeout(() => {
      for (const profile of profiles) prefetchProfileResponseCaches(profile);
    }, 100);
    return () => window.clearTimeout(timer);
  }, [status?.browserProfiles]);

  useEffect(() => {
    for (const profile of status?.browserProfiles || []) {
      if (!profile?.connected || !extensionReady(profile.extension_version)) continue;
      for (const tab of profile.conversation_tabs || []) {
        const conversationId = String(tab.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
        if (!conversationId) continue;
        const selectedTarget = String(requestTargetsRef.current[profile.profile_id] || "");
        const currentResponse = requestResponses[profile.profile_id];
        const relevant = selectedTarget
          ? selectedTarget === conversationId
          : currentResponse?.conversationId === conversationId || (chatProfileId === profile.profile_id && tab.active);
        if (!relevant) continue;
        const networkState = String(tab.network_state || (tab.busy ? "generating" : "idle"));
        const networkCompletedAt = String(tab.network_last_completed_at || "");
        setRequestResponses((current) => {
          const previous = current[profile.profile_id] || {};
          if (previous.conversationId && previous.conversationId !== conversationId) return current;
          if (previous.networkState === networkState && previous.networkCompletedAt === networkCompletedAt && previous.networkError === String(tab.network_error || "")) return current;
          return {
            ...current,
            [profile.profile_id]: {
              ...previous,
              visible: true,
              conversationId,
              busy: networkState === "generating",
              loading: networkState === "generating" ? previous.loading !== false : false,
              networkState,
              networkSource: String(tab.network_source || ""),
              networkStartedAt: String(tab.network_last_started_at || ""),
              networkCompletedAt,
              networkStatusCode: Number(tab.network_status_code) || 0,
              networkError: String(tab.network_error || ""),
              networkDurationMs: Number(tab.network_duration_ms) || 0,
              contentNeedsRefresh: networkState === "completed" ? true : networkState === "generating" ? false : Boolean(previous.contentNeedsRefresh)
            }
          };
        });
        if (tab.connection_interrupted) {
          const recoveryKey = `${profile.profile_id}:${conversationId}`;
          const lastRecovery = Number(connectionRecoveryReads.current.get(recoveryKey) || 0);
          if (Date.now() - lastRecovery >= 15000) {
            connectionRecoveryReads.current.set(recoveryKey, Date.now());
            void loadResponse(profile, conversationId, true, true, true);
          }
          continue;
        }
        const recoverableAbort = isRecoverableAbortedChatNetworkFailure({
          networkState,
          networkError: tab.network_error,
          networkCompletedAt,
          responseReady: Boolean(currentResponse?.responseReady)
        });
        if (recoverableAbort) {
          const recoveryKey = `network-abort:${profile.profile_id}:${conversationId}`;
          const lastRecovery = Number(connectionRecoveryReads.current.get(recoveryKey) || 0);
          if (Date.now() - lastRecovery >= LATEST_RESPONSE_RECOVERY_POLL_MS) {
            connectionRecoveryReads.current.set(recoveryKey, Date.now());
            void loadCanonicalResponse(profile, conversationId);
          }
          continue;
        }
        if (networkState === "generating" || tab.busy || tab.settling) {
          if (!shouldScheduleGeneratingPoll(chatProfileId, profile.profile_id)) continue;
          const streamKey = `${profile.profile_id}:${conversationId}`;
          const lastStreamRead = Number(networkStreamReads.current.get(streamKey) || 0);
          const lastStreamPush = Number(networkStreamPushTimes.current.get(streamKey) || 0);
          const realtimePushFresh = Date.now() - lastStreamPush < 1500;
          const activityPollMs = realtimePushFresh ? LATEST_RESPONSE_RECOVERY_POLL_MS : networkState === "generating" ? 850 : LATEST_RESPONSE_RECOVERY_POLL_MS;
          if (Date.now() - lastStreamRead >= activityPollMs) {
            networkStreamReads.current.set(streamKey, Date.now());
            if (networkState === "generating") void loadResponse(profile, conversationId, true, false, false, false);
            else void loadCanonicalResponse(profile, conversationId);
          }
          continue;
        }
        if (currentResponse?.finalityPending) {
          const finalityPollKey = `finality:${profile.profile_id}:${conversationId}`;
          const lastFinalityRead = Number(connectionRecoveryReads.current.get(finalityPollKey) || 0);
          if (Date.now() - lastFinalityRead >= LATEST_RESPONSE_RECOVERY_POLL_MS) {
            connectionRecoveryReads.current.set(finalityPollKey, Date.now());
            void loadResponse(profile, conversationId, true, true, false, false);
          }
          continue;
        }
        if (networkState !== "completed" || !networkCompletedAt) continue;
        const completionKey = `${profile.profile_id}:${conversationId}`;
        const contentAlreadyRead = networkCompletionReads.current.get(completionKey) === networkCompletedAt;
        if (!contentAlreadyRead) {
          networkCompletionReads.current.set(completionKey, networkCompletedAt);
          void (async () => {
            const canonical = await loadCanonicalResponse(profile, conversationId);
            if (!canonical) {
              if (networkCompletionReads.current.get(completionKey) === networkCompletedAt) networkCompletionReads.current.delete(completionKey);
              return;
            }
            if (canonical.canonical_poll_deferred) {
              if (networkCompletionReads.current.get(completionKey) === networkCompletedAt) networkCompletionReads.current.delete(completionKey);
              return;
            }
            if (completedResponseNeedsDomFallback(canonical)) {
              const dom = await loadResponse(profile, conversationId, true, true);
              if (!dom && networkCompletionReads.current.get(completionKey) === networkCompletedAt) networkCompletionReads.current.delete(completionKey);
            }
          })();
          if (Date.now() - Date.parse(networkCompletedAt) < 15000 && tab.network_source === "codexpro") notify("AI đã phản hồi xong · xác nhận trực tiếp từ network");
        }
        if (currentResponse?.repoTaskId && canVerifyRepoTaskUse({
          responseCurrent: currentResponse.conversationId === conversationId,
          responseReady: currentResponse.responseReady,
          responseBusy: currentResponse.busy,
          responseIncomplete: currentResponse.incomplete,
          awaitingAssistant: currentResponse.awaitingAssistant,
          tabBusy: tab.busy,
          tabSettling: tab.settling,
          canonicalBusy: currentResponse.canonicalBusy,
          streamBusy: currentResponse.networkStreamInProgress,
          networkCompletedAt,
          repoTaskDispatchedAt: currentResponse.repoTaskDispatchedAt
        })) {
          void verifyRepoTaskUse(profile, conversationId, currentResponse, networkCompletedAt);
        }
      }
    }
  }, [status?.browserProfiles, chatProfileId, requestResponses, notify]);

  useEffect(() => {
    requestTargetsRef.current = requestTargets;
  }, [requestTargets]);

  useEffect(() => {
    if (!chatProfileId) return;
    const profile = (status?.browserProfiles || []).find((item) => item.profile_id === chatProfileId);
    const target = String(requestTargetsRef.current[chatProfileId] || requestTargets[chatProfileId] || "");
    if (!profile || !target) return;
    const response = requestResponses[chatProfileId];
    const selectedTab = (profile.conversation_tabs || []).find((tab) => conversationIdFromTab(tab) === target);
    const composerLockReason = !profile.connected
      ? "profile_disconnected"
      : busy === `request:${chatProfileId}`
        ? "request_sending"
        : selectedTab?.busy || String(selectedTab?.network_state || "") === "generating"
          ? "selected_tab_busy"
          : selectedTab?.settling
            ? "selected_tab_settling"
            : response?.conversationId === target && response?.rolloverStatus === "creating"
              ? "conversation_rollover"
              : response?.conversationId === target && (response?.busy || response?.loading || response?.transcriptLoading || response?.networkStreamInProgress || response?.canonicalBusy)
                ? "selected_response_busy"
                : "";
    const previous = requestTargetDiagnostics.current.get(chatProfileId);
    const reason = requestTargetReasons.current.get(chatProfileId) || (previous?.target && previous.target !== target ? "state_update" : "status_refresh");
    const signature = JSON.stringify([target, composerLockReason, (profile.conversation_tabs || []).map((tab) => [tab.id, conversationIdFromTab(tab), tab.active, tab.busy, tab.settling, tab.network_state])]);
    if (previous?.signature === signature) return;
    logRendererDiagnostic(api, "info", "chat", `Mục tiêu composer ${chatProfileId}: ${previous?.target || "(chưa chọn)"} -> ${target}`, {
      action: "composer-target-state",
      profile_id: chatProfileId,
      from_conversation_id: previous?.target || "",
      to_conversation_id: target,
      selection_reason: reason,
      composer_locked: Boolean(composerLockReason),
      composer_lock_reason: composerLockReason,
      tab_candidates: (profile.conversation_tabs || []).slice(0, 20).map((tab) => ({ id: String(tab?.id || ""), conversation_id: conversationIdFromTab(tab), active: Boolean(tab?.active), busy: Boolean(tab?.busy), settling: Boolean(tab?.settling), network_state: String(tab?.network_state || ""), title: String(tab?.title || "").slice(0, 160) }))
    });
    requestTargetReasons.current.delete(chatProfileId);
    requestTargetDiagnostics.current.set(chatProfileId, { target, signature });
  }, [busy, chatProfileId, requestResponses, requestTargets, status?.browserProfiles]);

  useEffect(() => {
    if (!chatProfileId) return;
    const profile = (status?.browserProfiles || []).find((item) => item.profile_id === chatProfileId);
    if (!profile) return;
    const conversations = profileRequestChats(profile);
    const initialTarget = requestTargetsRef.current[chatProfileId] || conversations.find((chat) => chat.active)?.id || conversations[0]?.id || NEW_CHAT_TARGET;
    if (!requestTargetsRef.current[chatProfileId]) {
      requestTargetsRef.current = { ...requestTargetsRef.current, [chatProfileId]: initialTarget };
      requestTargetReasons.current.set(chatProfileId, "initial_open");
      setRequestTargets((current) => ({ ...current, [chatProfileId]: initialTarget }));
    }
    const response = requestResponses[chatProfileId];
    const needsFallbackHydration = response?.conversationId === initialTarget && response?.staleConversationFallback === true;
    if (profile.connected && initialTarget !== NEW_CHAT_TARGET && (!response || response.conversationId !== initialTarget || needsFallbackHydration)) void hydrateCachedResponse(profile, initialTarget);
  }, [chatProfileId, status?.browserProfiles, requestResponses]);

  useEffect(() => {
    const conversationId = String(openChatResponse?.conversationId || "");
    const networkState = String(openChatResponse?.networkState || "").toLowerCase();
    const liveNetworkHealthy = networkState === "generating" || openChatResponse?.networkStreamInProgress === true;
    if (!chatProfileId || !/^[A-Za-z0-9-]{8,160}$/.test(conversationId) || !openChatAwaitingAssistant || liveNetworkHealthy) return;
    let cancelled = false;
    let timer = 0;
    const pollLatestResponse = async () => {
      let nextPollMs = LATEST_RESPONSE_RECOVERY_POLL_MS;
      const profile = profilesRef.current.find((item) => item.profile_id === chatProfileId);
      if (cancelled) return;
      if (profile?.connected) {
        const canonical = await loadCanonicalResponse(profile, conversationId);
        if (canonical?.canonical_rate_limited) {
          const retryAtMs = Date.parse(String(canonical.canonical_retry_at || ""));
          const retryAfterMs = Number(canonical.canonical_retry_after_ms) || 0;
          nextPollMs = Math.max(nextPollMs, Math.min(60_000, Number.isFinite(retryAtMs) ? retryAtMs - Date.now() : retryAfterMs));
        }
        if (!cancelled && !canonical?.canonical_poll_deferred && !canonical?.canonical_rate_limited && completedResponseNeedsDomFallback(canonical)) {
          await loadResponse(profile, conversationId, true, true);
        }
      }
      if (!cancelled) timer = window.setTimeout(pollLatestResponse, Math.max(500, nextPollMs));
    };
    timer = window.setTimeout(pollLatestResponse, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [chatProfileId, openChatResponse?.conversationId, openChatResponse?.networkState, openChatResponse?.networkStreamInProgress, openChatAwaitingAssistant]);

  useEffect(() => {
    if (!chatProfileId) return;
    const response = requestResponses[chatProfileId];
    persistResponseCache(chatProfileId, response);
  }, [chatProfileId, requestResponses]);

  useEffect(() => {
    if (!chatProfileId) return undefined;
    return () => { void flushResponseCache("chat-change-or-close"); };
  }, [chatProfileId, openChatResponse?.conversationId, flushResponseCache]);

  useEffect(() => {
    if (!chatProfileId || !openChatResponse?.responseAudit || typeof api.logChatResponseAudit !== "function") return undefined;
    const conversationId = String(openChatResponse.conversationId || "");
    const timer = window.setTimeout(() => {
      const transcript = responseBodyRefs.current.get(chatProfileId);
      const renderedMessages = transcript ? [...transcript.querySelectorAll(".chat-transcript-message[data-audit-role]")].map((node) => {
        const content = node.querySelector(".chat-message-text");
        const visibleText = String(content?.innerText || content?.textContent || "").replace(/\s+/g, " ").trim();
        return {
          role: String(node.dataset.auditRole || ""),
          fingerprint: String(node.dataset.auditFingerprint || ""),
          length: Number(node.dataset.auditLength) || 0,
          preview: visibleText.slice(-180)
        };
      }) : [];
      const record = buildChatResponseAuditRecord({
        profileId: chatProfileId,
        conversationId,
        requestId: openChatResponse.repoTaskId,
        fetchMode: openChatResponse.responseAuditFetchMode,
        sourceAudit: openChatResponse.responseAudit,
        managerMessages: materializeTranscriptMessages(openChatResponse, conversationId),
        renderedMessages,
        networkState: openChatResponse.networkState,
        networkStartedAt: openChatResponse.networkStartedAt,
        networkCompletedAt: openChatResponse.networkCompletedAt
      });
      const key = `${chatProfileId}:${conversationId}`;
      const signature = JSON.stringify({
        comparison: record.comparison,
        basis: record.comparisonBasis,
        selectedSource: record.selectedSource,
        source: record.sources[record.comparisonBasis === "chatgpt_dom" ? "chatgptDom" : record.comparisonBasis === "canonical_api" ? "canonical" : "networkStream"],
        managerState: record.managerState,
        managerUi: record.managerUi
      });
      if (responseAuditSignatures.current.get(key) === signature) return;
      responseAuditSignatures.current.set(key, signature);
      api.logChatResponseAudit(record);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [chatProfileId, openChatResponse?.conversationId, openChatResponse?.responseAuditKey, openChatLatestMessageKey]);

  useEffect(() => {
    const sweep = () => {
      for (const map of [networkStreamReads.current, networkCompletionReads.current, connectionRecoveryReads.current]) {
        pruneTimestampMap(map, { maxEntries: 96, maxAgeMs: 60 * 60_000 });
      }
      for (const map of [requestTargetDiagnostics.current, responseAuditSignatures.current]) trimMapEntries(map, 96);
      canonicalResponseReads.current?.prune(96);
    };
    sweep();
    const timer = window.setInterval(sweep, 60_000);
    return () => window.clearInterval(timer);
  }, []);
}
