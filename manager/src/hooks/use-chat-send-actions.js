import { useEffect, useRef } from "react";
import { NEW_CHAT_TARGET } from "../features/chat/chat-dropdown.jsx";
import { sendDebugEvidence } from "../features/chat/chat-activity.js";
import { buildConversationRolloverPrompt, profileRequestChats } from "../features/chat/chat-conversation-utils.js";
import { canAcceptNextChatMessage, isRecoverableAbortedChatNetworkFailure, isRetryableChatTurnBusyError } from "../chat-status.js";
import { materializeTranscriptMessages, transcriptAwaitingAssistant, trimRecentTranscriptMessages } from "../chat-transcript.js";
import { responseAuditTextFingerprint } from "../chat-response-audit.js";
import {
  conversationCompletedTaskCount,
  conversationMessageLimit,
  conversationTotalMessageCount,
  logicalTaskTracking,
  shouldRolloverConversation
} from "../conversation-message-limit.js";
import { activeLogicalTaskAdjustment } from "../../electron/logical-chat-task.mjs";
import { ALL_ALLOWED_WORKSPACES } from "../project-dropdown.jsx";
import { logRendererDiagnostic } from "../diagnostic-log-view.jsx";
import { pruneTimestampMap, trimMapEntries } from "../performance-retention.js";

const REPO_TASK_VERIFICATION_RETRY_MS = 1500;

export function useChatSendActions({
  api,
  status,
  projects,
  requestTargets,
  requestDraftsRef,
  requestFiles,
  requestResponses,
  requestTargetsRef,
  requestTargetReasons,
  setRequestTargets,
  setRequestFiles,
  setRequestResponses,
  setRequestSendErrors,
  setRequestSendEvidence,
  setClearedResponseTargets,
  setChatProfileId,
  setBusy,
  setError,
  notify,
  refresh,
  refreshStatus,
  projectRootForProfile,
  responseScrollLocked,
  responseTurnAnchors
}) {
  const conversationRollovers = useRef(new Map());
  const repoTaskVerificationReads = useRef(new Map());

  async function rolloverFullConversation(profile, conversationId, result) {
    const profileId = profile.profile_id;
    const continuationReason = String(result?.continuation_reason || "limit");
    const recoveryContinuation = continuationReason === "recovery";
    const activeTaskId = /^cpt_[a-f0-9]{24}$/.test(String(result?.repoTaskId || profile.current_task_id || ""))
      ? String(result?.repoTaskId || profile.current_task_id)
      : "";
    const checkpointContinuation = Boolean(activeTaskId && (recoveryContinuation || continuationReason === "limit"));
    const key = `${profileId}:${conversationId}:${continuationReason}`;
    const previousAttempt = conversationRollovers.current.get(key);
    if (previousAttempt?.status === "creating" || previousAttempt?.status === "done") return previousAttempt?.conversationId || null;
    if (previousAttempt?.status === "failed" && Date.now() - Number(previousAttempt.at || 0) < 10000) return null;

    const creatingNotice = recoveryContinuation
      ? "Tab cũ không thể khôi phục an toàn. CodexPro đang tạo chat tiếp nối và chuyển bối cảnh gần nhất để bạn tiếp tục dự án."
      : "Đoạn chat đã đầy. CodexPro đang tự tạo chat mới và chuyển bối cảnh gần nhất để bạn tiếp tục dự án.";
    const doneNotice = recoveryContinuation
      ? "Tab cũ không thể khôi phục. CodexPro đã tạo chat tiếp nối và chuyển bối cảnh gần nhất. Bạn có thể tiếp tục dự án ngay tại đây."
      : "Chat cũ đã đạt giới hạn. CodexPro đã tự tạo chat mới và chuyển bối cảnh gần nhất. Bạn có thể tiếp tục dự án ngay tại đây.";
    const failedNotice = recoveryContinuation
      ? "Tab cũ không thể khôi phục và CodexPro chưa tạo được chat tiếp nối tự động."
      : "ChatGPT đã báo đoạn chat này đạt giới hạn nhưng CodexPro chưa tạo được chat mới tự động.";

    conversationRollovers.current.set(key, { status: "creating", at: Date.now() });
    setRequestResponses((current) => {
      const previous = current[profileId] || {};
      if (previous.conversationId !== conversationId) return current;
      return {
        ...current,
        [profileId]: {
          ...previous,
          conversationLimitReached: recoveryContinuation ? false : true,
          conversationLimitMessage: recoveryContinuation ? "" : (result?.conversation_limit_message || "ChatGPT báo đoạn chat đã đạt giới hạn độ dài."),
          rolloverStatus: "creating",
          rolloverReason: continuationReason,
          rolloverNotice: creatingNotice
        }
      };
    });

    try {
      const handoffText = buildConversationRolloverPrompt(result);
      const rolloverProjectRoot = result?.projectRoot || projectRootForProfile(profile);
      const rolloverWorkspaceExpanded = result?.repoTaskScope === "all_allowed" && result?.repoTaskRequest?.scope === "workspace" && rolloverProjectRoot !== ALL_ALLOWED_WORKSPACES;
      const rolloverAllAllowed = !rolloverWorkspaceExpanded && (result?.repo_task_scope === "all_allowed" || result?.repoTaskScope === "all_allowed" || rolloverProjectRoot === ALL_ALLOWED_WORKSPACES);
      const rolloverStartedAt = new Date().toISOString();
      const created = checkpointContinuation
        ? await api.resumeProfileTask({
            profileId,
            taskId: activeTaskId,
            hangRecovery: true,
            recoveryReason: String(result?.recovery_reason || result?.conversation_limit_message || "Task cần chuyển sang chat mới để tiếp tục an toàn.").slice(0, 600)
          })
        : await api.sendProfileRequest({
            profileId,
            conversationId: "",
            newChat: true,
            scope: rolloverAllAllowed ? "all_allowed" : "workspace",
            projectRoot: rolloverAllAllowed ? "" : rolloverProjectRoot,
            workspaceCandidates: rolloverAllAllowed ? projects.map((project) => project.root) : [],
            text: handoffText,
            attachments: Array.isArray(result?.rollover_attachments) ? result.rollover_attachments : [],
            previousTaskId: "",
            taskMode: "new",
            oneShotRecovery: recoveryContinuation
          });
      if (String(created?.submission_state || "") === "uncertain") throw new Error("Chat tiếp nối có trạng thái gửi không chắc chắn; đã dừng để tránh duplicate.");
      if (checkpointContinuation && String(created?.repo_task_id || "") !== activeTaskId) throw new Error("Manager đã đổi Task ID khi chuyển chat; đã dừng để tránh tạo task FIFO mới.");
      const newConversationId = String(created?.conversation_id || "").trim();
      if (!/^[A-Za-z0-9-]{8,160}$/.test(newConversationId)) throw new Error("ChatGPT chưa trả conversation id cho chat tiếp nối.");

      conversationRollovers.current.set(key, { status: "done", at: Date.now(), conversationId: newConversationId });
      requestTargetsRef.current = { ...requestTargetsRef.current, [profileId]: newConversationId };
      setRequestTargets((current) => ({ ...current, [profileId]: newConversationId }));
      setChatProfileId(profileId);
      setRequestSendErrors((current) => ({ ...current, [profileId]: "" }));
      setRequestResponses((current) => ({
        ...current,
        [profileId]: {
          visible: true,
          loading: true,
          error: "",
          conversationId: newConversationId,
          text: "",
          messages: [],
          busy: true,
          submissionState: "submitted",
          sendUncertain: false,
          conversationLimitReached: false,
          rolloverStatus: "done",
          rolloverReason: continuationReason,
          rolloverFromConversationId: conversationId,
          activityStartedAt: rolloverStartedAt,
          rolloverNotice: doneNotice,
          repoTaskId: String(created?.repo_task_id || activeTaskId),
          repoTaskDispatchedAt: String(created?.repo_task_dispatched_at || ""),
          repoTaskScope: String(created?.repo_task_scope || result?.repoTaskScope || ""),
          logicalTaskStatus: String(created?.worker_job_status || result?.logicalTaskStatus || "running"),
          repoTaskStatus: "waiting",
          repoTaskVerified: false,
          repoTaskRequest: result?.repoTaskRequest || null
        }
      }));
      if (!result?.silent) {
        notify(recoveryContinuation
          ? "Đã chuyển sang chat tiếp nối và giữ bối cảnh công việc"
          : "Chat cũ đã đầy · CodexPro đã tự tạo chat mới để tiếp tục dự án");
      }
      window.setTimeout(() => void refresh(false), 500);
      return newConversationId;
    } catch (err) {
      const message = err?.message || String(err);
      logRendererDiagnostic(api, "error", "chat", `Continuation chat creation failed: ${message}`, { action: "conversation-rollover", profile_id: profileId, conversation_id: conversationId, continuation_reason: continuationReason, error: err });
      conversationRollovers.current.set(key, { status: "failed", at: Date.now() });
      setRequestResponses((current) => {
        const previous = current[profileId] || {};
        if (previous.conversationId !== conversationId) return current;
        return {
          ...current,
          [profileId]: {
            ...previous,
            loading: false,
            rolloverStatus: "failed",
            rolloverReason: continuationReason,
            rolloverNotice: failedNotice,
            error: `Không tạo được chat tiếp nối: ${message}`
          }
        };
      });
      setRequestSendErrors((current) => ({ ...current, [profileId]: recoveryContinuation
        ? `Không khôi phục được chat cũ và chưa tạo được chat tiếp nối: ${message}`
        : `Chat đã đầy. Không tạo được chat mới tự động: ${message}` }));
      return null;
    }
  }

  async function sendRequest(profile, draftOverride = null, sendTiming = {}) {
    const sendRequestEnteredAt = performance.now();
    const sendTraceId = `send_${Date.now().toString(36)}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const acceptedAt = Number(sendTiming?.acceptedAt);
    const submitEnteredAt = Number(sendTiming?.submitEnteredAt);
    const onSendEnteredAt = Number(sendTiming?.onSendEnteredAt);
    const rendererTiming = (endAt = performance.now()) => ({
      trigger: String(sendTiming?.trigger || "unknown"),
      click_to_submit_ms: Number.isFinite(acceptedAt) && Number.isFinite(submitEnteredAt) ? Math.max(0, submitEnteredAt - acceptedAt) : 0,
      submit_to_on_send_ms: Number.isFinite(submitEnteredAt) && Number.isFinite(onSendEnteredAt) ? Math.max(0, onSendEnteredAt - submitEnteredAt) : 0,
      on_send_to_send_request_ms: Number.isFinite(onSendEnteredAt) ? Math.max(0, sendRequestEnteredAt - onSendEnteredAt) : 0,
      click_to_send_request_ms: Number.isFinite(acceptedAt) ? Math.max(0, sendRequestEnteredAt - acceptedAt) : 0,
      renderer_pre_send_ms: Math.max(0, endAt - sendRequestEnteredAt),
      click_to_send_api_ms: Number.isFinite(acceptedAt) ? Math.max(0, endAt - acceptedAt) : 0
    });
    api.sendTraceEvent?.({ event: "renderer_send_started", send_trace_id: sendTraceId, profile_id: String(profile?.profile_id || ""), ...rendererTiming(sendRequestEnteredAt) });
    const conversations = profileRequestChats(profile);
    const defaultTarget = conversations.find((chat) => chat.active)?.id ?? conversations[0]?.id;
    const requestedConversationId = String(requestTargets[profile.profile_id] ?? defaultTarget ?? NEW_CHAT_TARGET);
    const requestedTab = (profile.conversation_tabs || []).find((tab) => String(tab.url || "").includes(`/c/${requestedConversationId}`));
    const requestedConversation = conversations.find((chat) => String(chat.id) === requestedConversationId);
    const forcedNewChat = Boolean(requestedTab?.long_task_watchdog_hung || requestedConversation?.long_task_watchdog_hung);
    const conversationId = forcedNewChat ? NEW_CHAT_TARGET : requestedConversationId;
    const newChat = conversationId === NEW_CHAT_TARGET;
    const text = String(draftOverride !== null ? draftOverride : (requestDraftsRef.current[profile.profile_id] || "")).trim();
    const attachments = requestFiles[profile.profile_id] || [];
    const projectRoot = projectRootForProfile(profile);
    const currentResponse = requestResponses[profile.profile_id] || {};
    if (forcedNewChat) {
      requestTargetsRef.current = { ...requestTargetsRef.current, [profile.profile_id]: NEW_CHAT_TARGET };
      requestTargetReasons.current.set(profile.profile_id, "long_task_watchdog_hung_send_guard");
      setRequestTargets((current) => ({ ...current, [profile.profile_id]: NEW_CHAT_TARGET }));
      logRendererDiagnostic(api, "warn", "chat", "Không gửi task mới vào conversation đã bị watchdog đánh dấu treo", { action: "long-task-watchdog-force-new-chat", profile_id: profile.profile_id, abandoned_conversation_id: requestedConversationId, target_id: String(requestedTab?.id || "") });
    }
    if (!text && !attachments.length) return false;
    if (!projectRoot) {
      setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "Chưa có workspace nào được chọn." }));
      return false;
    }
    if (!newChat) {
      const selectedTab = (profile.conversation_tabs || []).find((tab) => String(tab.url || "").includes(`/c/${conversationId}`));
      const networkState = String(selectedTab?.network_state || currentResponse?.networkState || (selectedTab?.busy ? "generating" : "idle"));
      const selectedRecoveringNetworkAbort = isRecoverableAbortedChatNetworkFailure({
        networkState,
        networkError: currentResponse?.networkError || selectedTab?.network_error || "",
        networkCompletedAt: currentResponse?.networkCompletedAt || selectedTab?.network_last_completed_at || "",
        responseReady: Boolean(currentResponse?.responseReady)
      });
      canAcceptNextChatMessage({
        networkState,
        networkCompletedAt: currentResponse?.networkCompletedAt || selectedTab?.network_last_completed_at || "",
        tabBusy: selectedTab?.busy,
        tabSettling: selectedTab?.settling,
        responseCurrent: currentResponse?.conversationId === conversationId,
        responseBusy: currentResponse?.busy,
        responseReady: currentResponse?.responseReady,
        responseLoading: currentResponse?.loading || currentResponse?.transcriptLoading,
        responseIncomplete: currentResponse?.incomplete,
        awaitingAssistant: currentResponse?.conversationId === conversationId && transcriptAwaitingAssistant(materializeTranscriptMessages(currentResponse, conversationId)),
        finalityPending: currentResponse?.finalityPending,
        canonicalBusy: currentResponse?.canonicalBusy,
        streamBusy: currentResponse?.networkStreamInProgress
      });
      if (selectedRecoveringNetworkAbort) {
        setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "ChatGPT đang xác minh lại một lượt bị hủy transport. Chờ xác minh xong để tránh gửi trùng vào trạng thái chưa chắc chắn." }));
        return false;
      }
    }
    const rolloverNetworkState = String(requestedTab?.network_state || currentResponse?.networkState || "").toLowerCase();
    const rolloverTaskInProgress = Boolean(requestedTab?.busy || requestedTab?.settling || ["generating", "pending", "streaming"].includes(rolloverNetworkState) || currentResponse?.busy || currentResponse?.loading || currentResponse?.transcriptLoading || currentResponse?.incomplete || currentResponse?.finalityPending || currentResponse?.canonicalBusy || currentResponse?.networkStreamInProgress || currentResponse?.awaitingAssistant);
    const rolloverSource = { ...currentResponse, taskInProgress: rolloverTaskInProgress };
    const logicalAdjustment = !newChat ? activeLogicalTaskAdjustment({
      profileId: profile.profile_id,
      conversationId,
      taskInProgress: rolloverTaskInProgress,
      response: currentResponse,
      profile,
      jobs: status?.workerJobs
    }) : null;
    const rolloverMessageLimit = conversationMessageLimit(rolloverSource);
    if (!newChat && currentResponse?.conversationId === conversationId && shouldRolloverConversation(rolloverSource, rolloverMessageLimit)) {
      const observedCompletedTaskCount = conversationCompletedTaskCount(rolloverSource);
      const observedTotalMessageCount = conversationTotalMessageCount(currentResponse);
      const cleanMessages = materializeTranscriptMessages(currentResponse, conversationId).filter((item) => !item?.pending);
      const rolloverMessages = text
        ? trimRecentTranscriptMessages([...cleanMessages, { id: `rollover-user-${Date.now()}`, role: "user", text, submissionState: "submitted", createdAt: new Date().toISOString() }])
        : trimRecentTranscriptMessages(cleanMessages);
      setBusy(`request:${profile.profile_id}`);
      setError("");
      setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "" }));
      try {
        const newConversationId = await rolloverFullConversation(profile, conversationId, {
          ...currentResponse,
          title: conversations.find((chat) => chat.id === conversationId)?.title || profile.active_chat_title || "",
          messages: rolloverMessages,
          continuation_reason: "message_limit",
          conversation_limit_reached: true,
          conversation_limit_message: `Đoạn chat đã hoàn thành ${rolloverMessageLimit} task; yêu cầu mới được chuyển sang tab tiếp theo.`,
          projectRoot,
          rollover_attachments: attachments
        });
        if (!newConversationId) return false;
        setRequestFiles((current) => ({ ...current, [profile.profile_id]: [] }));
        logRendererDiagnostic(api, "info", "chat", "Automatically moved a completed-task-limit conversation to a new ChatGPT tab", {
          action: "conversation-message-limit-rollover",
          profile_id: profile.profile_id,
          previous_conversation_id: conversationId,
          conversation_id: newConversationId,
          message_limit: rolloverMessageLimit,
          message_count: observedCompletedTaskCount,
          completed_task_count: observedCompletedTaskCount,
          total_message_count: observedTotalMessageCount,
          activity_started_at: String(currentResponse?.activityStartedAt || "")
        });
        return true;
      } finally {
        setBusy("");
      }
    }
    responseScrollLocked.current.delete(profile.profile_id);
    if (text) {
      responseTurnAnchors.current.set(profile.profile_id, {
        conversationId,
        fingerprint: responseAuditTextFingerprint(text),
        createdAt: Date.now()
      });
    } else {
      responseTurnAnchors.current.delete(profile.profile_id);
    }
    setBusy(`request:${profile.profile_id}`);
    setError("");
    setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "" }));
    setRequestSendEvidence((current) => ({ ...current, [profile.profile_id]: null }));
    const requestSubmittedAt = new Date().toISOString();
    const clearKey = `${profile.profile_id}:${conversationId}`;
    setClearedResponseTargets((current) => {
      if (!current[clearKey]) return current;
      const { [clearKey]: _cleared, ...next } = current;
      return next;
    });
    if (!newChat && text) {
      setRequestResponses((current) => {
        const previous = current[profile.profile_id] || {};
        const previousMessages = materializeTranscriptMessages(previous, conversationId);
        return {
          ...current,
          [profile.profile_id]: {
            ...previous,
            visible: true,
            loading: true,
            error: "",
            conversationId,
            messages: trimRecentTranscriptMessages([...previousMessages, {
              id: `optimistic-user-${Date.now()}`,
              role: "user",
              text,
              pending: true,
              submissionState: "pending",
              createdAt: requestSubmittedAt
            }])
          }
        };
      });
    }
    try {
      const restoreSubmittedInputs = () => {
        setRequestFiles((current) => {
          if (!attachments.length || (current[profile.profile_id] || []).length) return current;
          return { ...current, [profile.profile_id]: attachments };
        });
      };
      setRequestFiles((current) => ({ ...current, [profile.profile_id]: [] }));
      const allAllowedScope = projectRoot === ALL_ALLOWED_WORKSPACES;
      const sendApiInvokedAt = performance.now();
      api.sendTraceEvent?.({ event: "renderer_send_api_invoked", send_trace_id: sendTraceId, profile_id: String(profile?.profile_id || ""), ...rendererTiming(sendApiInvokedAt) });
      const sendPromise = api.sendProfileRequest({ send_trace_id: sendTraceId, profileId: profile.profile_id, conversationId: newChat ? "" : conversationId, targetId: newChat ? undefined : requestedTab?.id, newChat, allowBusyFollowup: !newChat, taskMode: logicalAdjustment ? "adjustment" : "new", previousTaskId: logicalAdjustment?.taskId || "", scope: allAllowedScope ? "all_allowed" : "workspace", projectRoot: allAllowedScope ? "" : projectRoot, workspaceCandidates: allAllowedScope ? projects.map((project) => project.root) : [], text, attachments });
      const result = await sendPromise;
      const debugEvidence = sendDebugEvidence(result);
      setRequestSendEvidence((current) => ({ ...current, [profile.profile_id]: debugEvidence }));
      if (Object.prototype.hasOwnProperty.call(window, "__codexproSmokeSendTarget")) window.__codexproSmokeSendTarget = debugEvidence;
      const submissionState = String(result?.submission_state || (result?.network_acknowledged ? "submitted" : "uncertain"));
      const generationState = String(result?.generation_state || result?.network_state || "idle");
      const resolvedConversationId = String(result?.conversation_id || conversationId);
      const activeTurnAnchor = responseTurnAnchors.current.get(profile.profile_id);
      if (activeTurnAnchor) responseTurnAnchors.current.set(profile.profile_id, { ...activeTurnAnchor, conversationId: resolvedConversationId });
      if (submissionState === "failed") {
        throw new Error(String(result?.error || "ChatGPT không chuẩn bị được tin nhắn để gửi."));
      }
      if (submissionState === "uncertain") {
        setRequestResponses((current) => {
          const previous = current[profile.profile_id] || {};
          const previousMessages = previous.conversationId === conversationId && Array.isArray(previous.messages) ? previous.messages : [];
          const messages = text
            ? previousMessages.map((message) => message?.role === "user" && message?.pending && message?.text === text ? { ...message, pending: false, uncertain: true, submissionState: "uncertain" } : message)
            : previousMessages;
          return {
            ...current,
            [profile.profile_id]: {
              ...previous,
              visible: true,
              loading: false,
              error: "",
              conversationId,
              messages,
              submissionState: "uncertain",
              sendUncertain: true
            }
          };
        });
        const technicalReason = String(result?.error || "Chưa thấy network ACK.").replace(/^SEND_UNCERTAIN:\s*/i, "");
        const submitPath = String(result?.submitted_by || result?.submit_path || "pre-submit");
        const generationEndpoint = String(result?.network_generation_endpoint || "");
        const uncertainMessage = `Chưa xác định được tin nhắn đã gửi hay chưa. Path: ${submitPath}.${generationEndpoint ? ` Endpoint: ${generationEndpoint}.` : ""} ${technicalReason}`;
        logRendererDiagnostic(api, "warn", "network", uncertainMessage, { action: "send-uncertain", profile_id: profile.profile_id, conversation_id: conversationId, submission_state: submissionState, submitted_by: submitPath, generation_endpoint: generationEndpoint });
        setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: uncertainMessage }));
        restoreSubmittedInputs();
        notify("Trạng thái gửi chưa chắc chắn · CodexPro không tự gửi lại");
        window.setTimeout(() => void refresh(false), 500);
        return false;
      }
      if (newChat && resolvedConversationId && resolvedConversationId !== NEW_CHAT_TARGET) {
        requestTargetsRef.current = { ...requestTargetsRef.current, [profile.profile_id]: resolvedConversationId };
        requestTargetReasons.current.set(profile.profile_id, "new_chat_created");
        setRequestTargets((current) => ({ ...current, [profile.profile_id]: resolvedConversationId }));
      }
      setRequestResponses((current) => {
        const previous = current[profile.profile_id] || {};
        const sameConversation = previous.conversationId === resolvedConversationId;
        const tracking = logicalTaskTracking(sameConversation ? previous : {});
        const repoTaskId = String(result?.repo_task_id || "");
        const adjustmentAccepted = result?.repo_task_adjustment === true
          && sameConversation
          && repoTaskId === String(previous.repoTaskId || "");
        const previousMessages = materializeTranscriptMessages(previous, resolvedConversationId);
        const matchingPendingIndex = text ? previousMessages.findIndex((message) => message?.role === "user" && message?.pending && message?.text === text) : -1;
        let optimisticMessages = previousMessages;
        if (text && matchingPendingIndex >= 0) {
          optimisticMessages = previousMessages.map((message, index) => index === matchingPendingIndex ? { ...message, pending: false, uncertain: false, submissionState: "submitted" } : message);
        } else if (text) {
          optimisticMessages = trimRecentTranscriptMessages([...previousMessages, { id: `optimistic-user-${Date.now()}`, role: "user", text, pending: false, uncertain: false, submissionState: "submitted", createdAt: requestSubmittedAt }]);
        }
        return {
          ...current,
          [profile.profile_id]: {
            ...previous,
            visible: true,
            loading: generationState === "generating",
            error: "",
            conversationId: resolvedConversationId,
            activityStartedAt: previous.conversationId === resolvedConversationId
              ? String(previous.activityStartedAt || "")
              : (newChat ? requestSubmittedAt : ""),
            fastMessageLimitQualified: previous.conversationId === resolvedConversationId
              ? Boolean(previous.fastMessageLimitQualified)
              : false,
            messages: optimisticMessages,
            submissionState: "submitted",
            sendUncertain: false,
            networkState: generationState,
            networkError: String(result?.network_error || previous.networkError || ""),
            networkStatusCode: Number(result?.network_status_code) || Number(previous.networkStatusCode) || 0,
            logicalTaskCount: tracking.logicalTaskCount,
            completedLogicalTaskIds: tracking.completedLogicalTaskIds,
            logicalTaskStatus: String(result?.worker_job_status || (adjustmentAccepted ? previous.logicalTaskStatus : "prepared")),
            repoTaskAdjustment: adjustmentAccepted,
            repoTaskId,
            repoTaskDispatchedAt: String(result?.repo_task_dispatched_at || ""),
            repoTaskScope: String(result?.repo_task_scope || (allAllowedScope ? "all_allowed" : "workspace")),
            repoTaskRetryCount: adjustmentAccepted ? Number(previous.repoTaskRetryCount) || 0 : Number(result?.repo_task_retry_count) || 0,
            repoTaskRolloverCount: adjustmentAccepted ? Number(previous.repoTaskRolloverCount) || 0 : Number(result?.repo_task_rollover_count) || 0,
            repoTaskStatus: adjustmentAccepted ? String(previous.repoTaskStatus || "waiting") : "waiting",
            repoTaskVerified: adjustmentAccepted ? Boolean(previous.repoTaskVerified) : false,
            repoTaskRequest: adjustmentAccepted ? previous.repoTaskRequest : { text, attachments, projectRoot, scope: allAllowedScope ? "all_allowed" : "workspace" }
          }
        };
      });
      if (generationState === "failed") {
        logRendererDiagnostic(api, "error", "network", `AI gặp lỗi network${result?.network_error ? `: ${result.network_error}` : ""}`, { action: "generation-failed", profile_id: profile.profile_id, conversation_id: resolvedConversationId, network_status_code: result?.network_status_code, network_error: result?.network_error });
        setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: `Tin nhắn đã gửi nhưng AI gặp lỗi network${result?.network_error ? `: ${result.network_error}` : ""}.` }));
        notify("Tin nhắn đã gửi · AI gặp lỗi network");
      } else if (result?.repo_task_adjustment === true) {
        notify("Đã gửi điều chỉnh vào task hiện tại");
      } else {
        notify("Đã gửi tin nhắn thành công");
      }
      window.setTimeout(() => void refresh(false), 500);
      return true;
    } catch (err) {
      const message = err?.message || String(err);
      const sendErrorDetails = err?.details && typeof err.details === "object" ? err.details : {};
      const nestedSendErrorDetails = sendErrorDetails?.details && typeof sendErrorDetails.details === "object" ? sendErrorDetails.details : {};
      const sendAcked = sendErrorDetails?.network_acknowledged === true || nestedSendErrorDetails?.network_acknowledged === true;
      const sendUncertain = !sendAcked && /BRIDGE_TIMEOUT|EXTENSION_HEARTBEAT_LOST/.test(String(err?.code || sendErrorDetails?.code || ""));
      logRendererDiagnostic(api, sendUncertain ? "warn" : "error", "chat", sendAcked ? "Đã xác nhận gửi, lỗi xử lý sau ACK" : sendUncertain ? "Trạng thái gửi ChatGPT chưa xác định" : `Gửi yêu cầu thất bại: ${message}`, { action: "send-request", profile_id: profile.profile_id, conversation_id: conversationId, project_root: projectRoot, submission_state: sendAcked ? "submitted" : sendUncertain ? "uncertain" : "failed", network_acknowledged: sendAcked, error: err });
      const debugEvidence = sendDebugEvidence({}, err);
      setRequestSendEvidence((current) => ({ ...current, [profile.profile_id]: debugEvidence }));
      if (Object.prototype.hasOwnProperty.call(window, "__codexproSmokeSendTarget")) window.__codexproSmokeSendTarget = debugEvidence;
      const conversationLimitReached = !newChat && message.includes("CONVERSATION_LIMIT_REACHED:");
      if (conversationLimitReached) {
        const previous = requestResponses[profile.profile_id] || {};
        const cleanMessages = Array.isArray(previous.messages) ? previous.messages.filter((item) => !item?.pending) : [];
        const rolloverMessages = text ? trimRecentTranscriptMessages([...cleanMessages, { id: `rollover-user-${Date.now()}`, role: "user", text, submissionState: "submitted", createdAt: new Date().toISOString() }]) : trimRecentTranscriptMessages(cleanMessages);
        const newConversationId = await rolloverFullConversation(profile, conversationId, {
          ...previous,
          title: conversations.find((chat) => chat.id === conversationId)?.title || profile.active_chat_title || "",
          messages: rolloverMessages,
          conversation_limit_reached: true,
          conversation_limit_message: message.replace(/^.*CONVERSATION_LIMIT_REACHED:\s*/s, "").trim() || "ChatGPT báo đoạn chat đã đạt giới hạn độ dài.",
          projectRoot,
          rollover_attachments: attachments
        });
        if (newConversationId) return true;
      }
      responseTurnAnchors.current.delete(profile.profile_id);
      setRequestFiles((current) => {
        if (!attachments.length || (current[profile.profile_id] || []).length) return current;
        return { ...current, [profile.profile_id]: attachments };
      });
      if (!newChat && text) {
        setRequestResponses((current) => {
          const previous = current[profile.profile_id] || {};
          const messages = Array.isArray(previous.messages) ? previous.messages.filter((item) => !(item?.role === "user" && item?.pending && item?.text === text)) : [];
          return { ...current, [profile.profile_id]: { ...previous, loading: false, messages } };
        });
      }
      setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: conversationLimitReached ? "Chat đã đầy và chưa chuyển được sang chat mới." : message }));
      if (/heartbeat|offline|did not reconnect|không còn được CodexPro nhận diện/i.test(message)) {
        window.setTimeout(() => void refreshStatus(), 0);
      }
      return false;
    } finally {
      setBusy("");
    }
  }

  async function verifyRepoTaskUse(profile, conversationId, response, networkCompletedAt) {
    const taskId = String(response?.repoTaskId || "");
    if (!taskId || response?.conversationId !== conversationId) return;
    const taskDispatchedAt = String(response?.repoTaskDispatchedAt || "");
    const verificationKey = `${taskId}:${taskDispatchedAt}:${networkCompletedAt}`;
    const verificationState = repoTaskVerificationReads.current.get(verificationKey);
    if (verificationState === "running" || verificationState === "done" || Number(verificationState) > Date.now()) return;
    repoTaskVerificationReads.current.set(verificationKey, "running");
    setRequestResponses((current) => {
      const previous = current[profile.profile_id] || {};
      return previous.repoTaskId === taskId ? { ...current, [profile.profile_id]: { ...previous, repoTaskStatus: "checking" } } : current;
    });
    try {
      const proof = await api.getRepoTaskStatus({ taskId, profileId: profile.profile_id, conversationId });
      if (proof?.verified) {
        repoTaskVerificationReads.current.set(verificationKey, "done");
        setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "" }));
        setRequestResponses((current) => {
          const previous = current[profile.profile_id] || {};
          return previous.repoTaskId === taskId ? { ...current, [profile.profile_id]: { ...previous, repoTaskScope: String(proof?.scope || previous.repoTaskScope || "workspace"), repoTaskStatus: "verified", repoTaskVerified: true, repoTaskProof: proof } } : current;
        });
        return;
      }
      const retryCount = Number(response?.repoTaskRetryCount) || 0;
      const rolloverCount = Number(response?.repoTaskRolloverCount) || 0;
      const original = response?.repoTaskRequest;
      const originalScope = original?.scope === "all_allowed" || original?.projectRoot === ALL_ALLOWED_WORKSPACES ? "all_allowed" : "workspace";
      if (retryCount >= 1 || !original?.projectRoot) {
        if (retryCount >= 1 && rolloverCount < 1 && original?.projectRoot) {
          setRequestResponses((current) => {
            const previous = current[profile.profile_id] || {};
            return previous.repoTaskId === taskId ? { ...current, [profile.profile_id]: { ...previous, repoTaskStatus: "rolling-over", loading: true } } : current;
          });
          notify("Chat cũ thiếu task title 2 lần · đang tạo chat mới");
          const created = await api.sendProfileRequest({
            profileId: profile.profile_id,
            conversationId: "",
            newChat: true,
            scope: originalScope,
            projectRoot: originalScope === "all_allowed" ? "" : original.projectRoot,
            workspaceCandidates: originalScope === "all_allowed" ? projects.map((project) => project.root) : [],
            text: original.text,
            attachments: Array.isArray(original.attachments) ? original.attachments : [],
            toolRetry: false,
            toolRolloverCount: rolloverCount + 1,
            previousTaskId: taskId
          });
          if (String(created?.submission_state || "") === "uncertain") throw new Error("Chat mới có trạng thái gửi không chắc chắn; không tự gửi thêm để tránh duplicate.");
          if (String(created?.repo_task_id || "") !== taskId) throw new Error("Manager đã đổi Task ID khi tạo chat mới; đã dừng để tránh REPO_TASK_MISMATCH.");
          const newConversationId = String(created?.conversation_id || "").trim();
          if (!/^[A-Za-z0-9-]{8,160}$/.test(newConversationId)) throw new Error("ChatGPT chưa trả conversation id cho chat mới bắt buộc dùng CodexPro.");
          requestTargetsRef.current = { ...requestTargetsRef.current, [profile.profile_id]: newConversationId };
          setRequestTargets((current) => ({ ...current, [profile.profile_id]: newConversationId }));
          setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "" }));
          setRequestResponses((current) => ({
            ...current,
            [profile.profile_id]: {
              visible: true,
              loading: true,
              error: "",
              conversationId: newConversationId,
              messages: [],
              submissionState: "submitted",
              sendUncertain: false,
              networkState: String(created?.generation_state || created?.network_state || "generating"),
              repoTaskId: String(created?.repo_task_id || ""),
              repoTaskDispatchedAt: String(created?.repo_task_dispatched_at || ""),
              repoTaskScope: String(created?.repo_task_scope || originalScope),
              logicalTaskStatus: String(created?.worker_job_status || "prepared"),
              repoTaskRetryCount: 0,
              repoTaskRolloverCount: rolloverCount + 1,
              repoTaskStatus: "waiting",
              repoTaskVerified: false,
              repoTaskRequest: original
            }
          }));
          repoTaskVerificationReads.current.set(verificationKey, "done");
          logRendererDiagnostic(api, "warn", "tool", "ChatGPT thiếu task title; Manager đã tạo chat mới và giữ nguyên Task ID", { action: "repo-task-title-rollover", profile_id: profile.profile_id, previous_conversation_id: conversationId, conversation_id: newConversationId, previous_task_id: taskId, rollover_task_id: String(created?.repo_task_id || ""), task_id_reused: created?.repo_task_id_reused === true, repo_task_dispatched_at: String(created?.repo_task_dispatched_at || "") });
          notify("Đã tạo chat mới · @CodexPro được gọi lại đúng một lần");
          window.setTimeout(() => void refresh(false), 500);
          return;
        }
        const message = "ChatGPT đã trả lời nhưng không trả task title qua CodexPro sau 2 lần. Phản hồi này không được công nhận.";
        logRendererDiagnostic(api, "error", "tool", message, { action: "repo-task-title-missing", profile_id: profile.profile_id, conversation_id: conversationId, task_id: taskId, retry_count: retryCount, rollover_count: rolloverCount, proof });
        setRequestResponses((current) => {
          const previous = current[profile.profile_id] || {};
          return previous.repoTaskId === taskId ? { ...current, [profile.profile_id]: { ...previous, repoTaskStatus: "failed", repoTaskVerified: false } } : current;
        });
        repoTaskVerificationReads.current.set(verificationKey, "done");
        setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: message }));
        notify("ChatGPT thiếu task title · đã chặn phản hồi");
        return;
      }
      setRequestResponses((current) => {
        const previous = current[profile.profile_id] || {};
        return previous.repoTaskId === taskId ? { ...current, [profile.profile_id]: { ...previous, repoTaskStatus: "retrying", loading: true } } : current;
      });
      const retried = await api.sendProfileRequest({
        profileId: profile.profile_id,
        conversationId,
        newChat: false,
        scope: originalScope,
        projectRoot: originalScope === "all_allowed" ? "" : original.projectRoot,
        workspaceCandidates: originalScope === "all_allowed" ? projects.map((project) => project.root) : [],
        text: original.text,
        attachments: Array.isArray(original.attachments) ? original.attachments : [],
        toolRetry: true,
        toolRolloverCount: rolloverCount,
        previousTaskId: taskId
      });
      if (String(retried?.submission_state || "") === "uncertain") throw new Error("Lần bắt buộc gọi CodexPro có trạng thái gửi không chắc chắn; không tự gửi thêm để tránh duplicate.");
      if (String(retried?.repo_task_id || "") !== taskId) throw new Error("Manager đã đổi Task ID khi gửi lại; đã dừng để tránh REPO_TASK_MISMATCH.");
      repoTaskVerificationReads.current.set(verificationKey, "done");
      setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "" }));
      setRequestResponses((current) => {
        const previous = current[profile.profile_id] || {};
        return previous.repoTaskId === taskId ? {
          ...current,
          [profile.profile_id]: {
            ...previous,
            repoTaskId: String(retried?.repo_task_id || ""),
            repoTaskDispatchedAt: String(retried?.repo_task_dispatched_at || ""),
            repoTaskScope: String(retried?.repo_task_scope || originalScope),
            logicalTaskStatus: String(retried?.worker_job_status || "prepared"),
            repoTaskRetryCount: 1,
            repoTaskRolloverCount: rolloverCount,
            repoTaskStatus: "waiting",
            repoTaskVerified: false,
            loading: true,
            networkState: String(retried?.generation_state || retried?.network_state || "generating")
          }
        } : current;
      });
      notify("ChatGPT chưa trả task title · đang tự gửi lại bắt buộc");
      logRendererDiagnostic(api, "warn", "tool", "ChatGPT thiếu task title; Manager đã gửi lại một lần và giữ nguyên Task ID", { action: "repo-task-title-retry", profile_id: profile.profile_id, conversation_id: conversationId, previous_task_id: taskId, retry_task_id: String(retried?.repo_task_id || ""), task_id_reused: retried?.repo_task_id_reused === true, repo_task_dispatched_at: String(retried?.repo_task_dispatched_at || "") });
      window.setTimeout(() => void refresh(false), 500);
    } catch (err) {
      const message = err?.message || String(err);
      if (isRetryableChatTurnBusyError(err)) {
        repoTaskVerificationReads.current.set(verificationKey, Date.now() + REPO_TASK_VERIFICATION_RETRY_MS);
        setRequestResponses((current) => {
          const previous = current[profile.profile_id] || {};
          return previous.repoTaskId === taskId ? { ...current, [profile.profile_id]: { ...previous, repoTaskStatus: "waiting", loading: false } } : current;
        });
        setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "" }));
        window.setTimeout(() => void refresh(false), REPO_TASK_VERIFICATION_RETRY_MS + 50);
        return;
      }
      repoTaskVerificationReads.current.set(verificationKey, "done");
      logRendererDiagnostic(api, "error", "tool", `Không xác minh được tool call CodexPro: ${message}`, { action: "repo-task-verification", profile_id: profile.profile_id, conversation_id: conversationId, task_id: taskId, error: err });
      setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: `Không xác minh được tool call CodexPro: ${message}` }));
    }
  }

  useEffect(() => {
    const sweep = () => {
      pruneTimestampMap(repoTaskVerificationReads.current, { maxEntries: 96, maxAgeMs: 60 * 60_000 });
      trimMapEntries(conversationRollovers.current, 96);
    };
    sweep();
    const timer = window.setInterval(sweep, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return { sendRequest, rolloverFullConversation, verifyRepoTaskUse };
}
