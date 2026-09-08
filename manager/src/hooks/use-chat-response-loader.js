import { useCallback, useEffect, useRef } from "react";
import { NEW_CHAT_TARGET } from "../features/chat/chat-dropdown.jsx";
import { profileRequestChats, visibleUserMessageText } from "../features/chat/chat-conversation-utils.js";
import { isTerminalChatNetworkState } from "../chat-status.js";
import {
  completedResponseNeedsDomFallback,
  discardProvisionalAssistantAfterLatestUser,
  isNetworkStreamCurrentGeneration,
  materializeTranscriptMessages,
  mergeNetworkStreamTranscript,
  mergeProgressiveResponseText,
  replaceCanonicalTranscript,
  transcriptAwaitingAssistant,
  trimRecentTranscriptMessages
} from "../chat-transcript.js";
import { responseAuditTextFingerprint } from "../chat-response-audit.js";
import { confirmChatResponseFinality } from "../chat-response-finality.js";
import { isConversationOutsideRecentWindowError, nextValidConversationTarget } from "../chat-response-target.js";
import { logicalTaskTracking, recordCompletedLogicalTask, shouldQualifyFastMessageLimit } from "../conversation-message-limit.js";
import { logRendererDiagnostic } from "../diagnostic-log-view.jsx";
import { trimMapEntries } from "../performance-retention.js";

const RESPONSE_READ_TRIGGERS = new Set([
  "generating",
  "completion",
  "finality",
  "network_recovery",
  "cache_hydration",
  "manual_or_interactive"
]);

function normalizeResponseReadTrigger(value) {
  const trigger = String(value || "");
  return RESPONSE_READ_TRIGGERS.has(trigger) ? trigger : "manual_or_interactive";
}

function nextResponseReadId(sequence) {
  return `rr_${Date.now().toString(36)}_${sequence.toString(36)}`;
}

export function useChatResponseLoader({
  api,
  status,
  chatProfileId,
  requestTargets,
  requestTargetsRef,
  requestTargetReasons,
  requestResponsesRef,
  setRequestTargets,
  setRequestResponses,
  setError
}) {
  const responseFetches = useRef(new Set());
  const responseFinalCandidates = useRef(new Map());
  const responseReadSequence = useRef(0);
  const responseReadTelemetry = useRef(new Map());
  const chatProfileIdRef = useRef(chatProfileId);

  const responseReadTargetStillCurrent = useCallback((entry) => {
    if (!entry) return false;
    const currentTarget = String(requestTargetsRef.current[entry.profile_id] || "");
    const conversationStillCurrent = !currentTarget || currentTarget === entry.conversation_id;
    const profileStillCurrent = !entry.started_as_active || chatProfileIdRef.current === entry.profile_id;
    return conversationStillCurrent && profileStillCurrent;
  }, [requestTargetsRef]);

  const emitResponseReadTelemetry = useCallback((entry, resolvedAt = "") => {
    if (!entry) return;
    const now = Date.now();
    const resolvedAtMs = resolvedAt ? Date.parse(resolvedAt) : 0;
    const durationMs = Math.max(0, (Number.isFinite(resolvedAtMs) && resolvedAtMs > 0 ? resolvedAtMs : now) - entry.started_at_ms);
    if (!entry.cancel_requested_at && !resolvedAt) return;
    if (!entry.cancel_requested_at && entry.trigger === "generating" && durationMs < 2_000) return;
    logRendererDiagnostic(api, "info", "chat", "Response read causal telemetry", {
      action: "response-read-causal",
      response_read_id: entry.response_read_id,
      trigger: entry.trigger,
      profile_id: entry.profile_id,
      conversation_id: entry.conversation_id,
      chat_profile_id_at_start: entry.chat_profile_id_at_start,
      started_at: entry.started_at,
      cancel_requested_at: entry.cancel_requested_at || "",
      resolved_at: resolvedAt,
      duration_ms: durationMs,
      target_still_current: responseReadTargetStillCurrent(entry)
    });
  }, [api, responseReadTargetStillCurrent]);

  const markStaleResponseReads = useCallback((closed = false) => {
    const nowIso = new Date().toISOString();
    for (const entry of responseReadTelemetry.current.values()) {
      if (entry.cancel_requested_at) continue;
      if (!closed && responseReadTargetStillCurrent(entry)) continue;
      entry.cancel_requested_at = nowIso;
      emitResponseReadTelemetry(entry, "");
    }
  }, [emitResponseReadTelemetry, responseReadTargetStillCurrent]);

  useEffect(() => {
    chatProfileIdRef.current = chatProfileId;
    markStaleResponseReads(false);
  }, [chatProfileId, requestTargets, markStaleResponseReads]);

  useEffect(() => () => markStaleResponseReads(true), [markStaleResponseReads]);

  const loadResponse = useCallback(async (profile, explicitConversationId, silent = false, readDom = false, recoverStaleDom = false, canonicalOnly = false, trigger = "manual_or_interactive") => {
    const pinnedTarget = String(requestTargetsRef.current[profile.profile_id] || requestTargets[profile.profile_id] || "");
    const conversations = profileRequestChats(profile, pinnedTarget);
    const defaultTarget = conversations.find((chat) => chat.active)?.id ?? conversations[0]?.id;
    const conversationId = String(explicitConversationId || requestTargets[profile.profile_id] || defaultTarget || "");
    const fetchKey = `${profile.profile_id}:${conversationId}`;
    const responseTargetStillCurrent = () => {
      const currentTarget = String(requestTargetsRef.current[profile.profile_id] || "");
      return !currentTarget || currentTarget === conversationId;
    };
    if (!conversationId || conversationId === NEW_CHAT_TARGET || responseFetches.current.has(fetchKey)) return null;
    responseFetches.current.add(fetchKey);
    responseReadSequence.current += 1;
    const responseReadId = nextResponseReadId(responseReadSequence.current);
    const startedAtMs = Date.now();
    const responseReadEntry = {
      response_read_id: responseReadId,
      trigger: normalizeResponseReadTrigger(trigger),
      profile_id: String(profile.profile_id || ""),
      conversation_id: conversationId,
      chat_profile_id_at_start: String(chatProfileIdRef.current || ""),
      started_at: new Date(startedAtMs).toISOString(),
      started_at_ms: startedAtMs,
      started_as_active: chatProfileIdRef.current === profile.profile_id,
      cancel_requested_at: ""
    };
    responseReadTelemetry.current.set(responseReadId, responseReadEntry);
    trimMapEntries(responseReadTelemetry.current, 96);
    if (!silent) {
      setRequestResponses((current) => responseTargetStillCurrent()
        ? { ...current, [profile.profile_id]: { ...(current[profile.profile_id] || {}), visible: true, loading: true, error: "", conversationId } }
        : current);
    }
    try {
      const activeResponse = requestResponsesRef.current[profile.profile_id] || {};
      const responseTaskId = activeResponse.conversationId === conversationId ? String(activeResponse.repoTaskId || "") : "";
      const result = await api.getProfileResponse({
        profileId: profile.profile_id,
        conversationId,
        taskId: responseTaskId,
        readDom,
        recoverStaleDom,
        canonicalOnly,
        priority: profile.profile_id === chatProfileId ? "interactive" : "background",
        responseReadId,
        trigger: responseReadEntry.trigger,
        chatProfileIdAtStart: responseReadEntry.chat_profile_id_at_start,
        startedAt: responseReadEntry.started_at
      });
      const responseProfileId = String(result?.response_profile_id || result?.profile_id || "").trim();
      const responseConversationId = String(result?.response_conversation_id || result?.conversation_id || "").trim()
        || String(result?.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1]
        || "";
      if (responseProfileId !== profile.profile_id || responseConversationId !== conversationId) {
        throw new Error(`RESPONSE_OWNERSHIP_MISMATCH: expected ${profile.profile_id}:${conversationId}, received ${responseProfileId || "(missing-profile)"}:${responseConversationId || "(missing-conversation)"}.`);
      }
      if (!responseTargetStillCurrent()) return null;
      const domAvailable = result.dom_available !== false;
      const canonicalAvailable = result.canonical_available === true;
      const canonicalRateLimited = result.canonical_rate_limited === true;
      const contentAvailable = domAvailable || canonicalAvailable;
      const networkStreamPayloadAvailable = Boolean(result.network_stream_available && (result.text || result.messages?.length || result.network_stream_activity_text));
      const responseAudit = result.response_audit && typeof result.response_audit === "object" ? result.response_audit : null;
      const needsDomFallback = completedResponseNeedsDomFallback(result);
      const responseAuditFetchMode = canonicalOnly ? "canonical_only" : readDom ? (recoverStaleDom ? "dom_recovery" : "dom") : "network_only";
      const responseAuditKey = responseAudit ? JSON.stringify([responseAuditFetchMode, responseAudit]) : "";
      setRequestResponses((current) => {
        if (!responseTargetStillCurrent()) return current;
        const previous = current[profile.profile_id] || {};
        const sameConversation = previous.conversationId === conversationId;
        const networkStreamCurrentGeneration = networkStreamPayloadAvailable && isNetworkStreamCurrentGeneration({
          networkStartedAt: result.network_last_started_at || previous.networkStartedAt,
          streamUpdatedAt: result.network_stream_updated_at
        });
        const nextNetworkState = String(result.network_state || previous.networkState || (result.busy ? "generating" : "idle"));
        const networkTerminal = isTerminalChatNetworkState(nextNetworkState);
        const networkStreamInProgress = Boolean(networkStreamCurrentGeneration && result.network_stream_in_progress);
        const networkStreamCompleted = Boolean(networkStreamCurrentGeneration && result.network_stream_completed === true && !result.network_stream_error);
        const networkStreamAvailable = Boolean(networkStreamCurrentGeneration && (!networkTerminal || networkStreamInProgress || networkStreamCompleted));
        const domResponseVerified = Boolean(result.response_ready === true && domAvailable && result.dom_busy !== true && result.network_stream_in_progress !== true);
        const canonicalBusyFromSource = Object.prototype.hasOwnProperty.call(result, "canonical_busy")
          ? Boolean(result.canonical_busy)
          : Boolean(sameConversation && previous.canonicalBusy);
        const canonicalBusy = domResponseVerified ? false : canonicalBusyFromSource;
        const incomingMessages = Array.isArray(result.messages)
          ? trimRecentTranscriptMessages(result.messages.map((message, index) => ({
              id: String(message?.id || `${message?.role || "message"}-${index}`),
              role: message?.role === "user" ? "user" : "assistant",
              text: message?.role === "user" ? visibleUserMessageText(message?.text) : String(message?.text || ""),
              images: message?.role === "assistant" && Array.isArray(message?.images) ? message.images.slice(0, 4).map((image, imageIndex) => ({ id: String(image?.id || `${message?.id || "assistant"}-image-${imageIndex}`), name: String(image?.name || "Ảnh tạo bởi ChatGPT"), alt: String(image?.alt || "Ảnh tạo bởi ChatGPT"), mimeType: String(image?.mime_type || image?.mimeType || "image/jpeg"), width: Number(image?.width) || 0, height: Number(image?.height) || 0, sourceWidth: Number(image?.source_width) || Number(image?.sourceWidth) || 0, sourceHeight: Number(image?.source_height) || Number(image?.sourceHeight) || 0, size: Number(image?.size) || 0, dataUrl: String(image?.data_url || image?.dataUrl || "") })).filter((image) => image.dataUrl.startsWith("data:image/")) : [],
              truncated: Boolean(message?.truncated),
              provisional: message?.role === "assistant" && (message?.provisional === true || message?.end_turn === false),
              endTurn: message?.role === "assistant" ? (message?.end_turn === true ? true : message?.end_turn === false ? false : null) : null
            })).filter((message) => message.text || message.images?.length))
          : [];
        let nextMessages = sameConversation ? materializeTranscriptMessages(previous, conversationId) : [];
        if (contentAvailable) nextMessages = replaceCanonicalTranscript(nextMessages, incomingMessages);
        else if (networkStreamAvailable) nextMessages = mergeNetworkStreamTranscript(nextMessages, {
          conversationId,
          text: result.text,
          truncated: result.truncated
        });
        const terminalAwaitingFinal = Boolean(networkTerminal && !networkStreamInProgress && !canonicalBusy && result.response_ready !== true);
        if (terminalAwaitingFinal) {
          nextMessages = discardProvisionalAssistantAfterLatestUser(nextMessages, { includeUnverified: true });
        }
        const nextAssistantText = String([...nextMessages].reverse().find((message) => message?.role === "assistant")?.text || "").trim();
        const rawResponseReady = Boolean(!canonicalBusy && result.response_ready && !networkStreamInProgress);
        const incomingResponseSource = terminalAwaitingFinal ? "network_state" : String(result.response_source || previous.responseSource || "");
        const latestUserIndex = nextMessages.findLastIndex((message) => message?.role === "user");
        const latestUserMessage = latestUserIndex >= 0 ? nextMessages[latestUserIndex] : null;
        const latestAssistantAfterUser = latestUserIndex >= 0
          ? nextMessages.slice(latestUserIndex + 1).findLast((message) => message?.role === "assistant")
          : [...nextMessages].reverse().find((message) => message?.role === "assistant");
        const finalitySignature = latestAssistantAfterUser
          ? JSON.stringify([
              latestUserIndex,
              String(latestUserMessage?.id || ""),
              responseAuditTextFingerprint(latestUserMessage?.text || ""),
              String(latestAssistantAfterUser.id || ""),
              responseAuditTextFingerprint(latestAssistantAfterUser.text || ""),
              (latestAssistantAfterUser.images || []).map((image) => String(image?.id || image?.dataUrl || "")).join("|")
            ])
          : "";
        const finalityKey = `${profile.profile_id}:${conversationId}`;
        const finality = confirmChatResponseFinality(responseFinalCandidates.current.get(finalityKey), {
          ready: rawResponseReady,
          source: incomingResponseSource,
          signature: finalitySignature
        });
        if (finality.candidate) responseFinalCandidates.current.set(finalityKey, finality.candidate);
        else responseFinalCandidates.current.delete(finalityKey);
        const responseReady = Boolean(rawResponseReady && finality.confirmed);
        const finalityPending = Boolean(rawResponseReady && !finality.confirmed);
        const nextTotalMessageCount = contentAvailable
          ? Number(result.total_message_count) || Number(result.message_count) || nextMessages.length
          : Number(previous.totalMessageCount) || 0;
        const activityStartedAt = sameConversation ? String(previous.activityStartedAt || "") : "";
        const logicalTaskStatus = String(result.worker_job_status || (sameConversation ? previous.logicalTaskStatus : "") || "").toLowerCase();
        const logicalTrackingState = responseReady
          ? recordCompletedLogicalTask(sameConversation ? previous : {}, responseTaskId, logicalTaskStatus)
          : logicalTaskTracking(sameConversation ? previous : {});
        const fastMessageLimitQualified = Boolean(sameConversation && shouldQualifyFastMessageLimit({
          ...previous,
          ...logicalTrackingState,
          totalMessageCount: nextTotalMessageCount,
          activityStartedAt
        }));
        return {
          ...current,
          [profile.profile_id]: {
            ...(sameConversation ? previous : {}),
            visible: true,
            loading: false,
            transcriptLoading: Boolean(previous.transcriptLoading && needsDomFallback),
            error: "",
            conversationId,
            text: terminalAwaitingFinal
              ? nextAssistantText
              : contentAvailable || networkStreamAvailable
                ? nextAssistantText || mergeProgressiveResponseText(sameConversation ? previous.text : "", result.text)
                : (sameConversation ? previous.text || "" : ""),
            messages: nextMessages,
            busy: Boolean(canonicalBusy || networkStreamInProgress || (!networkTerminal && result.busy)),
            canonicalBusy,
            truncated: contentAvailable || networkStreamAvailable ? Boolean(result.truncated) : Boolean(previous.truncated),
            incomplete: canonicalBusy ? true : networkTerminal ? false : contentAvailable || networkStreamAvailable ? Boolean(result.incomplete) : false,
            incompleteReason: canonicalBusy ? "canonical_generation_in_progress" : networkTerminal ? "" : contentAvailable || networkStreamAvailable ? (result.incomplete_reason || "") : "",
            conversationLimitReached: Boolean(previous.conversationLimitReached),
            conversationLimitMessage: previous.conversationLimitMessage || "",
            domAvailable,
            domSkipped: Boolean(result.dom_skipped),
            canonicalAvailable,
            canonicalRateLimited,
            canonicalRateLimitCount: canonicalRateLimited ? Math.max(1, Number(result.canonical_rate_limit_count) || 1) : 0,
            canonicalRetryAt: canonicalRateLimited ? String(result.canonical_retry_at || "") : "",
            networkStreamAvailable,
            networkStreamEndpoint: String(result.network_stream_endpoint || previous.networkStreamEndpoint || ""),
            networkStreamEventCount: Number(result.network_stream_event_count) || Number(previous.networkStreamEventCount) || 0,
            networkStreamActivityText: networkStreamAvailable ? String(result.network_stream_activity_text || "") : "",
            networkStreamInProgress,
            networkStreamUpdatedAt: String(result.network_stream_updated_at || previous.networkStreamUpdatedAt || ""),
            networkStreamError: String(result.network_stream_error || ""),
            contentNeedsRefresh: networkStreamInProgress
              ? false
              : result.dom_skipped
              ? String(result.network_state || previous.networkState || "") === "completed"
              : contentAvailable
                ? false
                : Boolean(previous.contentNeedsRefresh),
            domError: result.dom_error || "",
            networkState: nextNetworkState,
            networkSource: String(result.network_source || previous.networkSource || ""),
            networkStartedAt: result.network_last_started_at || previous.networkStartedAt || "",
            networkCompletedAt: result.network_last_completed_at || previous.networkCompletedAt || "",
            networkStatusCode: Number(result.network_status_code) || Number(previous.networkStatusCode) || 0,
            networkError: String(result.network_error || previous.networkError || ""),
            networkDurationMs: Number(result.network_duration_ms) || Number(previous.networkDurationMs) || 0,
            responseReady,
            finalityPending,
            finalityReason: finality.reason,
            nonRetryable: false,
            staleConversationFallback: false,
            responseSource: incomingResponseSource,
            responseAudit,
            responseAuditFetchMode,
            responseAuditKey,
            messageCount: contentAvailable || networkStreamAvailable ? Number(result.message_count) || nextMessages.length : Number(previous.messageCount) || 0,
            totalMessageCount: nextTotalMessageCount,
            logicalTaskCount: logicalTrackingState.logicalTaskCount,
            completedLogicalTaskIds: logicalTrackingState.completedLogicalTaskIds,
            logicalTaskStatus,
            activityStartedAt,
            fastMessageLimitQualified,
            awaitingAssistant: transcriptAwaitingAssistant(nextMessages),
            updatedAt: result.updated_at || new Date().toISOString()
          }
        };
      });
      return result;
    } catch (err) {
      const message = err?.message || String(err);
      const outsideRecentWindow = isConversationOutsideRecentWindowError(message);
      const activeTaskId = String(profile?.current_task_id || "");
      const activeTask = (status?.workerJobs || []).find((job) => (
        String(job?.job_id || job?.jobId || "") === activeTaskId
        && ["prepared", "running"].includes(String(job?.status || ""))
      ));
      const requestedConversationOwnsActiveTask = Boolean(
        activeTask
        && String(profile?.current_task_conversation_id || "") === conversationId
      );
      const fallbackConversationId = outsideRecentWindow && !requestedConversationOwnsActiveTask
        ? nextValidConversationTarget(profile, conversationId)
        : "";
      logRendererDiagnostic(api, "error", "chat", `Đọc phản hồi thất bại: ${message}`, { action: "load-response", profile_id: profile.profile_id, conversation_id: conversationId, read_dom: readDom, recover_stale_dom: recoverStaleDom, canonical_only: canonicalOnly, silent, error: err });
      if (fallbackConversationId) {
        requestTargetsRef.current = { ...requestTargetsRef.current, [profile.profile_id]: fallbackConversationId };
        requestTargetReasons.current.set(profile.profile_id, "stale_conversation_fallback");
        setRequestTargets((current) => ({ ...current, [profile.profile_id]: fallbackConversationId }));
        setRequestResponses((current) => ({
          ...current,
          [profile.profile_id]: { visible: true, loading: false, transcriptLoading: true, error: "", conversationId: fallbackConversationId, text: "", messages: [], nonRetryable: false, staleConversationFallback: true }
        }));
        return null;
      }
      setRequestResponses((current) => responseTargetStillCurrent()
        ? { ...current, [profile.profile_id]: { ...(current[profile.profile_id] || {}), visible: true, loading: false, transcriptLoading: false, error: message, conversationId, nonRetryable: outsideRecentWindow } }
        : current);
      if (!silent && responseTargetStillCurrent()) setError(message);
      return null;
    } finally {
      const resolvedAt = new Date().toISOString();
      emitResponseReadTelemetry(responseReadEntry, resolvedAt);
      responseReadTelemetry.current.delete(responseReadId);
      responseFetches.current.delete(fetchKey);
    }
  }, [api, chatProfileId, emitResponseReadTelemetry, requestResponsesRef, requestTargetReasons, requestTargets, requestTargetsRef, setError, setRequestResponses, setRequestTargets, status?.workerJobs]);

  useEffect(() => {
    const sweep = () => trimMapEntries(responseFinalCandidates.current, 96);
    sweep();
    const timer = window.setInterval(sweep, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return { loadResponse };
}
