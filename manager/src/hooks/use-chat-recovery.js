import { useEffect, useRef } from "react";
import { profileRequestChats } from "../features/chat/chat-conversation-utils.js";
import { cacheableTranscriptMessages, materializeTranscriptMessages, trimRecentTranscriptMessages } from "../chat-transcript.js";
import { longRunningChatWatchdogCandidate } from "../long-task-watchdog.js";
import { VISUAL_WATCHDOG_INTERVAL_MS, visualWatchdogCandidate } from "../visual-watchdog.js";
import { chatHistoryRateLimitRecoveryCandidate } from "../chat-recovery-policy.js";
import { ALL_ALLOWED_WORKSPACES } from "../project-dropdown.jsx";
import { logRendererDiagnostic } from "../diagnostic-log-view.jsx";
import { pruneTimestampMap, trimSetEntries } from "../performance-retention.js";

export function useChatRecovery({
  api,
  status,
  projects,
  managerSettings,
  requestResponses,
  requestProjectRoots,
  requestTargets,
  requestTargetsRef,
  requestResponsesRef,
  setRequestTargets,
  setRequestResponses,
  setRequestSendErrors,
  setChatProfileId,
  setBusy,
  setError,
  notify,
  refresh,
  projectRootForProfile,
  rolloverFullConversation
}) {
  const operationsRecoveryTimes = useRef(new Map());
  const operationsLongTaskAudits = useRef(new Set());
  const operationsVisualWatchdogChecks = useRef(new Set());
  const operationsVisualWatchdogNextAt = useRef(new Map());
  useEffect(() => {
    const profiles = Array.isArray(status?.browserProfiles) ? status.browserProfiles : [];
    const jobs = Array.isArray(status?.workerJobs) ? status.workerJobs : [];
    for (const profile of profiles) {
      const candidate = longRunningChatWatchdogCandidate(profile, jobs);
      if (!candidate || operationsLongTaskAudits.current.has(candidate.attemptKey)) continue;
      operationsLongTaskAudits.current.add(candidate.attemptKey);
      const recoveryIncidentFingerprint = candidate.connectionInterrupted
        ? `long-task-connection-interrupted:${candidate.profileId}:${candidate.conversationId}`
        : `long-task-${candidate.failureReason || "health"}:${candidate.profileId}:${candidate.conversationId}`;
      logRendererDiagnostic(api, candidate.hardFailure ? "error" : "info", "chat", candidate.connectionInterrupted
        ? "Phát hiện Connection interrupted ở task chạy lâu; bắt đầu phục hồi đúng một lần"
        : candidate.hardFailure
          ? "Phát hiện task chạy lâu có lỗi; bắt đầu phục hồi đúng một lần"
          : "Task ChatGPT chạy quá 30 phút; kiểm tra sức khỏe không reload tab đang hoạt động", {
        action: candidate.connectionInterrupted ? "long-task-watchdog-connection-interrupted" : "long-task-watchdog-start",
        profile_id: candidate.profileId,
        task_id: candidate.taskId,
        task_title: candidate.title,
        conversation_id: candidate.conversationId,
        target_id: candidate.targetId,
        started_at: candidate.startedAt,
        age_ms: candidate.ageMs,
        attempt_key: candidate.attemptKey,
        incident_fingerprint: recoveryIncidentFingerprint,
        watchdog_phase: candidate.phase,
        hard_failure: candidate.hardFailure,
        failure_reason: candidate.failureReason,
        network_state: candidate.networkState,
        network_error: candidate.networkError,
        connection_interrupted: candidate.connectionInterrupted,
        message_delivery_timed_out: candidate.messageDeliveryTimedOut,
        renderer_unresponsive: candidate.rendererUnresponsive
      });
      void api.auditLongRunningProfileChat({
        profileId: candidate.profileId,
        taskId: candidate.taskId,
        conversationId: candidate.conversationId,
        targetId: candidate.targetId,
        startedAt: candidate.startedAt,
        attemptKey: candidate.attemptKey
      }).then(async (result) => {
        if (result?.already_attempted && result?.status !== "hung") {
          logRendererDiagnostic(api, "info", "chat", "Bỏ qua audit task chạy lâu đã thực hiện trước đó", { action: "long-task-watchdog-deduplicated", profile_id: candidate.profileId, task_id: candidate.taskId, conversation_id: candidate.conversationId, attempt_key: candidate.attemptKey, status: String(result?.status || "") });
          return;
        }
        if (result?.status === "active_without_reload" || result?.status === "completed_without_reload") {
          const completed = result.status === "completed_without_reload";
          logRendererDiagnostic(api, "info", "chat", completed ? "Task chạy lâu đã hoàn tất; watchdog không reload tab" : "Task chạy lâu vẫn hoạt động; watchdog không reload tab", {
            action: completed ? "long-task-watchdog-completed-no-reload" : "long-task-watchdog-active-no-reload",
            profile_id: candidate.profileId,
            task_id: candidate.taskId,
            conversation_id: candidate.conversationId,
            target_id: String(result?.recovery_tab_id || result?.target_id || candidate.targetId),
            attempt_key: candidate.attemptKey,
            busy: Boolean(result?.preflight?.busy),
            response_ready: Boolean(result?.preflight?.response_ready),
            network_state: String(result?.preflight?.network_state || candidate.networkState || ""),
            network_error: String(result?.preflight?.network_error || ""),
            reloaded: false,
            retry_allowed: true
          });
          return;
        }
        if (candidate.hardFailure && result?.status === "responsive_after_reload") {
          const recoveryTaskId = /^cpt_[a-f0-9]{24}$/.test(candidate.taskId) ? candidate.taskId : "";
          if (!recoveryTaskId) throw new Error("Không thể gửi ‘tiếp tục’ vì task bị gián đoạn không có Task ID hợp lệ.");
          const targetTab = (profile.conversation_tabs || []).find((tab) => Number(tab?.id) === Number(result?.recovery_tab_id || candidate.targetId));
          const snapshot = await recoveryContinuationSnapshot(profile, candidate.conversationId, targetTab);
          const resumeProjectRoot = snapshot?.projectRoot || projectRootForProfile(profile);
          const resumeAllAllowed = snapshot?.repoTaskScope === "all_allowed" || resumeProjectRoot === ALL_ALLOWED_WORKSPACES;
          logRendererDiagnostic(api, "warn", "chat", "Tab đã phản hồi sau reload; gửi ‘tiếp tục’ đúng một lần trong conversation cũ", {
            action: "long-task-watchdog-resume-start",
            profile_id: candidate.profileId,
            task_id: recoveryTaskId,
            conversation_id: candidate.conversationId,
            target_id: String(result?.recovery_tab_id || candidate.targetId),
            attempt_key: candidate.attemptKey,
            recovery_incident_fingerprint: recoveryIncidentFingerprint,
            reload_probe: result?.reload_probe || null,
            resume_text: "tiếp tục",
            retry_allowed: false
          });
          const resumed = await api.sendProfileRequest({
            profileId: candidate.profileId,
            conversationId: candidate.conversationId,
            newChat: false,
            scope: resumeAllAllowed ? "all_allowed" : "workspace",
            projectRoot: resumeAllAllowed ? "" : resumeProjectRoot,
            workspaceCandidates: resumeAllAllowed ? projects.map((project) => project.root) : [],
            text: "tiếp tục",
            attachments: [],
            taskMode: "adjustment",
            toolRetry: false,
            previousTaskId: recoveryTaskId,
            oneShotRecovery: true,
            user_report_logging: false
          });
          if (String(resumed?.submission_state || "") === "uncertain") throw new Error("Lệnh ‘tiếp tục’ có trạng thái gửi không chắc chắn; watchdog đã dừng để tránh gửi trùng.");
          if (String(resumed?.repo_task_id || "") !== recoveryTaskId) throw new Error("Task ID đổi khi gửi ‘tiếp tục’; watchdog đã dừng để tránh duplicate.");
          requestTargetsRef.current = { ...requestTargetsRef.current, [candidate.profileId]: candidate.conversationId };
          setRequestTargets((current) => ({ ...current, [candidate.profileId]: candidate.conversationId }));
          setRequestResponses((current) => {
            const previous = current[candidate.profileId] || {};
            return {
              ...current,
              [candidate.profileId]: {
                ...previous,
                visible: true,
                loading: true,
                error: "",
                conversationId: candidate.conversationId,
                busy: true,
                submissionState: "submitted",
                sendUncertain: false,
                networkState: String(resumed?.generation_state || resumed?.network_state || "generating"),
                networkError: String(resumed?.network_error || ""),
                repoTaskId: recoveryTaskId,
                repoTaskDispatchedAt: String(resumed?.repo_task_dispatched_at || ""),
                repoTaskScope: String(resumed?.repo_task_scope || (resumeAllAllowed ? "all_allowed" : "workspace")),
                logicalTaskStatus: String(resumed?.worker_job_status || previous.logicalTaskStatus || "running"),
                repoTaskStatus: "waiting",
                repoTaskVerified: false,
                repoTaskRequest: snapshot?.repoTaskRequest || previous.repoTaskRequest || null
              }
            };
          });
          logRendererDiagnostic(api, "warn", "chat", "Đã gửi ‘tiếp tục’ trong conversation cũ sau Connection interrupted", {
            action: "long-task-watchdog-resume-done",
            profile_id: candidate.profileId,
            task_id: recoveryTaskId,
            conversation_id: candidate.conversationId,
            target_id: String(resumed?.target_id || result?.recovery_tab_id || candidate.targetId),
            attempt_key: candidate.attemptKey,
            recovery_incident_fingerprint: recoveryIncidentFingerprint,
            request_id: String(resumed?.request_id || resumed?.generation_request_id || ""),
            submission_state: String(resumed?.submission_state || ""),
            network_state: String(resumed?.generation_state || resumed?.network_state || ""),
            network_error: String(resumed?.network_error || ""),
            task_id_preserved: true,
            retry_allowed: false
          });
          if (managerSettings.taskNotifications !== false) void api.showNotification?.({ title: "CodexPro · Đã tiếp tục task", body: `“${candidate.title}” đã được reload và gửi “tiếp tục” trong chat cũ.` });
          return;
        }
        if (result?.renderer_unresponsive || result?.status === "hung") {
          logRendererDiagnostic(api, "error", "chat", "Tab task chạy lâu vẫn bị treo sau một lần reload; chuyển sang chat tiếp nối", {
            action: "long-task-watchdog-hung",
            profile_id: candidate.profileId,
            task_id: candidate.taskId,
            conversation_id: candidate.conversationId,
            target_id: String(result?.recovery_tab_id || result?.target_id || candidate.targetId),
            attempt_key: candidate.attemptKey,
            recovery_incident_fingerprint: recoveryIncidentFingerprint,
            failure_reason: candidate.failureReason,
            network_state: candidate.networkState,
            network_error: candidate.networkError,
            connection_interrupted: candidate.connectionInterrupted,
            preflight_probe: result?.preflight || null,
            reload_probe: result?.reload_probe || null,
            retry_allowed: false
          });
          const targetTab = (profile.conversation_tabs || []).find((tab) => Number(tab?.id) === Number(result?.recovery_tab_id || result?.target_id || candidate.targetId));
          const continuation = await recoverProfileTab(profile, {
            conversationId: candidate.conversationId,
            taskId: candidate.taskId,
            targetTab,
            forceContinuation: true,
            recoveryReason: "Tab vẫn không phản hồi sau một lần reload watchdog.",
            silent: true,
            automatic: true,
            hardFailure: true
          });
          if (!continuation) throw new Error("Tab cũ vẫn bị treo và không tạo được chat tiếp nối.");
          if (managerSettings.taskNotifications !== false) void api.showNotification?.({ title: "CodexPro · Đã chuyển tab task", body: `“${candidate.title}” đã tiếp tục trong chat mới với cùng Task ID.` });
          return;
        }
        const statusLabel = "tab đã phản hồi sau reload";
        logRendererDiagnostic(api, "info", "chat", `Task chạy lâu đã được kiểm tra: ${statusLabel}`, { action: "long-task-watchdog-responsive", profile_id: candidate.profileId, task_id: candidate.taskId, conversation_id: candidate.conversationId, attempt_key: candidate.attemptKey, status: String(result?.status || ""), busy: Boolean(result?.reload_probe?.busy), response_ready: Boolean(result?.reload_probe?.response_ready), retry_allowed: false });
        if (managerSettings.taskNotifications !== false) void api.showNotification?.({ title: "CodexPro · Đã kiểm tra task chạy lâu", body: `“${candidate.title}” · ${statusLabel}. Watchdog sẽ không reload lại task này.` });
      }).catch((err) => {
        logRendererDiagnostic(api, "error", "chat", `Không hoàn tất được phục hồi task chạy lâu: ${err?.message || String(err)}`, { action: "long-task-watchdog-failed", profile_id: candidate.profileId, task_id: candidate.taskId, conversation_id: candidate.conversationId, target_id: candidate.targetId, attempt_key: candidate.attemptKey, recovery_incident_fingerprint: recoveryIncidentFingerprint, failure_reason: candidate.failureReason, network_state: candidate.networkState, network_error: candidate.networkError, connection_interrupted: candidate.connectionInterrupted, retry_allowed: false, error: err });
        if (managerSettings.taskNotifications !== false) void api.showNotification?.({ title: "CodexPro · Không kiểm tra được task chạy lâu", body: `“${candidate.title}” · đã dừng thử lại tự động để tránh reload liên tục.` });
      }).finally(() => {
        window.setTimeout(() => void refresh(false), 1200);
      });
    }
  }, [managerSettings.taskNotifications, status?.browserProfiles, status?.workerJobs]);

  useEffect(() => {
    if (!managerSettings.autoRecovery) return;
    const profiles = Array.isArray(status?.browserProfiles) ? status.browserProfiles : [];
    const jobs = Array.isArray(status?.workerJobs) ? status.workerJobs : [];
    const now = Date.now();
    for (const profile of profiles) {
      const candidate = visualWatchdogCandidate(profile, jobs, now);
      if (!candidate) continue;
      const key = `${candidate.profileId}:${candidate.taskId}`;
      const nextAt = Number(operationsVisualWatchdogNextAt.current.get(key) || 0);
      if (operationsVisualWatchdogChecks.current.has(key) || now < nextAt) continue;
      operationsVisualWatchdogChecks.current.add(key);
      operationsVisualWatchdogNextAt.current.set(key, now + VISUAL_WATCHDOG_INTERVAL_MS);
      logRendererDiagnostic(api, "info", "chat", "Visual Watchdog bắt đầu kiểm tra ảnh task", {
        action: "visual-watchdog-start",
        profile_id: candidate.profileId,
        task_id: candidate.taskId,
        conversation_id: candidate.conversationId,
        target_id: candidate.targetId,
        interval_ms: VISUAL_WATCHDOG_INTERVAL_MS
      });
      void api.checkVisualWatchdog({
        profileId: candidate.profileId,
        taskId: candidate.taskId,
        conversationId: candidate.conversationId,
        targetId: candidate.targetId,
        title: candidate.title,
        autoRecover: true
      }).then((result) => {
        const parsedNextAt = Date.parse(String(result?.next_check_at || ""));
        operationsVisualWatchdogNextAt.current.set(key, Number.isFinite(parsedNextAt) ? parsedNextAt : Date.now() + VISUAL_WATCHDOG_INTERVAL_MS);
        const state = String(result?.state || "UNCERTAIN").toUpperCase();
        const recovered = result?.recovery?.recovered === true;
        logRendererDiagnostic(api, state === "STUCK" ? "error" : "info", "chat", recovered ? "Visual Watchdog đã chuyển task sang chat mới" : `Visual Watchdog kết luận ${state}`, {
          action: recovered ? "visual-watchdog-recovered" : "visual-watchdog-result",
          profile_id: candidate.profileId,
          task_id: candidate.taskId,
          conversation_id: candidate.conversationId,
          target_id: candidate.targetId,
          state,
          confidence: Number(result?.confidence || 0),
          reason: String(result?.reason || ""),
          compared_two_images: Boolean(result?.compared_two_images),
          watchdog_target_id: Number(result?.watchdog_target_id) || 0,
          watchdog_conversation_id: String(result?.watchdog_conversation_id || ""),
          recovery: result?.recovery || null
        });
        if (recovered && managerSettings.taskNotifications !== false) {
          void api.showNotification?.({
            title: "CodexPro · Watchdog đã chuyển tab",
            body: `“${candidate.title}” được xác nhận treo và đã tiếp tục trong chat mới với cùng Task ID.`
          });
        }
      }).catch((err) => {
        operationsVisualWatchdogNextAt.current.set(key, Date.now() + 60_000);
        logRendererDiagnostic(api, "error", "chat", `Visual Watchdog kiểm tra/phục hồi thất bại: ${err?.message || String(err)}`, {
          action: "visual-watchdog-failed",
          profile_id: candidate.profileId,
          task_id: candidate.taskId,
          conversation_id: candidate.conversationId,
          target_id: candidate.targetId,
          error: err
        });
      }).finally(() => {
        operationsVisualWatchdogChecks.current.delete(key);
        window.setTimeout(() => void refresh(false), 900);
      });
    }
  }, [managerSettings.autoRecovery, managerSettings.taskNotifications, status?.browserProfiles, status?.workerJobs]);

  useEffect(() => {
    if (!managerSettings.autoRecovery) return;
    const profiles = Array.isArray(status?.browserProfiles) ? status.browserProfiles : [];
    const jobs = Array.isArray(status?.workerJobs) ? status.workerJobs : [];
    for (const profile of profiles) {
      if (!profile?.connected) continue;
      const tabs = Array.isArray(profile?.conversation_tabs) ? profile.conversation_tabs : [];
      const messageStreamTab = tabs.find((tab) => !tab?.long_task_watchdog_hung && tab?.message_stream_error && Boolean(profile?.current_task_conversation_id) && (String(tab.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "") === String(profile.current_task_conversation_id));
      if (messageStreamTab?.id) {
        const conversationId = String(profile?.current_task_conversation_id || "");
        const taskId = String(profile?.current_task_id || "");
        if (!conversationId || !messageStreamTab?.id || !/^cpt_[a-f0-9]{24}$/.test(taskId)) continue;
        const taskJob = /^cpt_[a-f0-9]{24}$/.test(taskId)
          ? jobs.find((job) => String(job?.job_id || job?.jobId || "") === taskId && String(job?.worker_id || job?.workerId || "") === String(profile.profile_id || ""))
          : null;
        const taskTerminal = Boolean(taskJob && (["completed", "cancelled"].includes(String(taskJob?.status || "").toLowerCase()) || taskJob?.completion_confirmed === true || taskJob?.completionConfirmed === true));
        if (taskTerminal) {
          logRendererDiagnostic(api, "info", "chat", "Bỏ qua Error in message stream vì task hiện tại đã terminal", { action: "message-stream-error-terminal-task-skip", profile_id: profile.profile_id, task_id: taskId, conversation_id: conversationId, worker_job_status: String(taskJob?.status || "") });
          continue;
        }
        // Never turn an unverified error banner into a new task or resume another owner.
        if (!taskJob || String(taskJob.status || "").toLowerCase() !== "running") continue;
        const key = `message-stream:${profile.profile_id}:${conversationId}:${taskId || "no-task"}`;
        const previous = Number(operationsRecoveryTimes.current.get(key) || 0);
        if (Date.now() - previous < 120_000) continue;
        operationsRecoveryTimes.current.set(key, Date.now());
        logRendererDiagnostic(api, "error", "chat", "ChatGPT báo Error in message stream; chuyển task hiện tại sang chat mới", {
          action: "message-stream-error-rollover",
          profile_id: profile.profile_id,
          task_id: taskId,
          conversation_id: conversationId,
          target_id: String(messageStreamTab.id),
          incident_fingerprint: `message-stream-error:${profile.profile_id}:${conversationId}`,
          retry_old_chat: false
        });
        void recoverProfileTab(profile, {
          targetTab: messageStreamTab,
          conversationId,
          taskId,
          forceContinuation: true,
          silent: true,
          automatic: true,
          hardFailure: true,
          recoveryReason: "ChatGPT báo Error in message stream. Bỏ qua Retry ở chat cũ và tiếp tục đúng Task ID hiện tại trong chat mới."
        }).then((continuation) => {
          if (continuation && managerSettings.taskNotifications !== false) void api.showNotification?.({ title: "CodexPro · Đã chuyển chat", body: `“${profile.current_task_title || "Task hiện tại"}” gặp Error in message stream và đã tiếp tục trong chat mới.` });
        });
        continue;
      }
      if (longRunningChatWatchdogCandidate(profile, jobs)) continue;
      const targetTab = tabs.find((tab) => !tab?.long_task_watchdog_hung && (tab?.renderer_unresponsive || tab?.message_delivery_timed_out || tab?.connection_interrupted || String(tab?.network_state || "").toLowerCase() === "failed" || tab?.network_error));
      if (!targetTab?.id) continue;
      const conversationId = String(targetTab.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
      if (!conversationId) continue;
      const hardFailure = Boolean(targetTab.renderer_unresponsive || targetTab.message_delivery_timed_out || String(targetTab.network_state || "").toLowerCase() === "failed" || targetTab.network_error);
      const key = `${profile.profile_id}:${conversationId}`;
      const previous = Number(operationsRecoveryTimes.current.get(key) || 0);
      if (Date.now() - previous < 120_000) continue;
      operationsRecoveryTimes.current.set(key, Date.now());
      void recoverProfileTab(profile, { targetTab, silent: true, automatic: true, hardFailure });
    }
  }, [managerSettings.autoRecovery, status?.browserProfiles, status?.workerJobs]);

  useEffect(() => {
    if (!managerSettings.autoRecovery) return;
    const incidents = Array.isArray(status?.taskHangIncidents) ? status.taskHangIncidents : [];
    const profiles = Array.isArray(status?.browserProfiles) ? status.browserProfiles : [];
    for (const incident of incidents) {
      if (!incident?.active || !incident?.recoverable) continue;
      if (incident?.no_meaningful_progress !== true && String(incident?.conversation_id || "")) continue;
      const profileId = String(incident?.profile_id || "");
      const taskId = String(incident?.task_id || "");
      const profile = profiles.find((item) => String(item?.profile_id || "") === profileId);
      if (!profile || String(profile?.current_task_id || "") !== taskId || !/^cpt_[a-f0-9]{24}$/.test(taskId)) continue;
      const key = `checkpoint-hang:${profileId}:${taskId}:${String(incident?.id || incident?.started_at || "active")}`;
      const previous = Number(operationsRecoveryTimes.current.get(key) || 0);
      if (Date.now() - previous < 120_000) continue;
      operationsRecoveryTimes.current.set(key, Date.now());
      const targetTab = (profile.conversation_tabs || []).find((tab) => Number(tab?.id) === Number(incident?.tab_id));
      void continueTaskFromCheckpoint(profile, taskId, {
        conversationId: String(incident?.conversation_id || ""),
        targetTab,
        recoveryReason: String(incident?.message || "Task bị treo hoặc không có tiến triển; tiếp tục từ checkpoint gần nhất."),
        automatic: true,
        silent: true
      });
    }
  }, [managerSettings.autoRecovery, status?.taskHangIncidents, status?.browserProfiles]);

  useEffect(() => {
    const profiles = Array.isArray(status?.browserProfiles) ? status.browserProfiles : [];
    const jobs = Array.isArray(status?.workerJobs) ? status.workerJobs : [];
    for (const profile of profiles) {
      const response = requestResponses[profile.profile_id];
      const candidate = chatHistoryRateLimitRecoveryCandidate({ profile, jobs, response });
      if (!candidate) continue;
      const key = `history-rate-limit:${candidate.profileId}:${candidate.conversationId}:${candidate.taskId}`;
      const previous = Number(operationsRecoveryTimes.current.get(key) || 0);
      if (Date.now() - previous < 120_000) continue;
      operationsRecoveryTimes.current.set(key, Date.now());
      const targetTab = (profile.conversation_tabs || []).find((tab) => String(tab?.url || "").includes(`/c/${candidate.conversationId}`));
      void recoverProfileTab(profile, {
        conversationId: candidate.conversationId,
        taskId: candidate.taskId,
        targetTab,
        forceContinuation: true,
        recoveryReason: "ChatGPT giới hạn đọc lịch sử nhiều lần; chuyển task sang chat mới để chặn vòng lặp 429.",
        silent: true,
        automatic: true,
        hardFailure: true
      });
    }
  }, [requestResponses, status?.browserProfiles, status?.workerJobs]);

  useEffect(() => {
    const profiles = Array.isArray(status?.browserProfiles) ? status.browserProfiles : [];
    for (const profile of profiles) {
      if (!profile?.connected) continue;
      const selectedConversationId = String(requestTargetsRef.current[profile.profile_id] || requestTargets[profile.profile_id] || "");
      const tabs = Array.isArray(profile?.conversation_tabs) ? profile.conversation_tabs : [];
      const targetTab = tabs.find((tab) => {
        if (!tab?.conversation_limit_reached) return false;
        const conversationId = String(tab?.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
        return Boolean(conversationId && (tab.active || conversationId === selectedConversationId));
      });
      if (!targetTab?.id) continue;
      const conversationId = String(targetTab.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
      if (!conversationId) continue;
      const key = `conversation-limit:${profile.profile_id}:${conversationId}`;
      const previous = Number(operationsRecoveryTimes.current.get(key) || 0);
      if (Date.now() - previous < 120_000) continue;
      operationsRecoveryTimes.current.set(key, Date.now());
      void (async () => {
        const snapshot = await recoveryContinuationSnapshot(profile, conversationId, targetTab);
        const title = snapshot?.title || targetTab?.title || profile.active_chat_title || "";
        const projectRoot = snapshot?.projectRoot || projectRootForProfile(profile);
        logRendererDiagnostic(api, "warn", "chat", "ChatGPT reported terminal conversation length; creating continuation tab automatically", { action: "conversation-limit-auto-rollover-start", profile_id: profile.profile_id, conversation_id: conversationId, target_id: String(targetTab.id), conversation_limit_message: String(targetTab.conversation_limit_message || "").slice(0, 500) });
        const newConversationId = await rolloverFullConversation(profile, conversationId, {
          ...snapshot,
          title,
          projectRoot,
          continuation_reason: "limit",
          conversation_limit_reached: true,
          conversation_limit_message: String(targetTab.conversation_limit_message || "ChatGPT báo đoạn chat đã đạt giới hạn độ dài."),
          silent: true
        });
        if (!newConversationId) throw new Error("Không tạo được chat tiếp nối sau khi ChatGPT báo đạt giới hạn độ dài.");
        logRendererDiagnostic(api, "info", "chat", "Automatically moved full conversation context to a focused continuation tab", { action: "conversation-limit-auto-rollover-done", profile_id: profile.profile_id, previous_conversation_id: conversationId, conversation_id: newConversationId, target_id: String(targetTab.id) });
        if (managerSettings.taskNotifications !== false) void api.showNotification?.({ title: "CodexPro · Chat đã đầy", body: `“${title || "Đoạn chat"}” đã chuyển bối cảnh sang tab mới.` });
      })().catch((err) => {
        logRendererDiagnostic(api, "error", "chat", `Automatic full-conversation rollover failed: ${err?.message || String(err)}`, { action: "conversation-limit-auto-rollover-failed", profile_id: profile.profile_id, conversation_id: conversationId, target_id: String(targetTab.id), error: err });
      }).finally(() => {
        window.setTimeout(() => void refresh(false), 900);
      });
    }
  }, [managerSettings.taskNotifications, requestTargets, status?.browserProfiles]);

  async function recoveryContinuationSnapshot(profile, conversationId, targetTab) {
    const profileId = String(profile?.profile_id || "");
    const liveResponse = requestResponsesRef.current[profileId] || {};
    const liveMatches = String(liveResponse?.conversationId || "") === conversationId;
    const liveMessages = liveMatches ? cacheableTranscriptMessages(materializeTranscriptMessages(liveResponse, conversationId)) : [];
    const cached = liveMessages.length ? null : await api.getChatResponseCache({ profileId, conversationId }).catch(() => null);
    const cachedMessages = trimRecentTranscriptMessages(cached?.messages);
    const messages = trimRecentTranscriptMessages(liveMessages.length ? liveMessages : cachedMessages);
    const selectedConversation = profileRequestChats(profile).find((chat) => String(chat.id) === conversationId);
    const projectRoot = String(liveResponse?.repoTaskRequest?.projectRoot || requestProjectRoots[profileId] || projectRootForProfile(profile) || "");
    return {
      ...(cached || {}),
      ...(liveMatches ? liveResponse : {}),
      title: selectedConversation?.title || targetTab?.title || profile?.active_chat_title || "",
      messages,
      projectRoot,
      repoTaskScope: String(liveResponse?.repoTaskScope || ""),
      repoTaskRequest: liveResponse?.repoTaskRequest || null,
      continuation_reason: "recovery"
    };
  }

  async function recoverProfileTab(profile, options = {}) {
    const tabs = profile.conversation_tabs || [];
    const conversationOf = (tab) => String(tab?.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
    const selectedConversationId = String(requestTargetsRef.current[profile.profile_id] || requestTargets[profile.profile_id] || "");
    const requestedConversationId = String(options.conversationId || selectedConversationId || "");
    const selectedTab = tabs.find((tab) => conversationOf(tab) === requestedConversationId);
    const exactTargetTab = options.targetTab && conversationOf(options.targetTab) === requestedConversationId ? options.targetTab : selectedTab;
    const targetTab = exactTargetTab || tabs.find((tab) => tab.active) || tabs[0];
    const conversationId = requestedConversationId || conversationOf(exactTargetTab);
    const selectedConversation = profileRequestChats(profile).find((chat) => String(chat.id) === conversationId);
    const title = selectedConversation?.title || exactTargetTab?.title || profile.active_chat_title || "";
    const silent = options.silent === true;
    if (!conversationId) {
      const message = "Kh\u00f4ng x\u00e1c \u0111\u1ecbnh \u0111\u01b0\u1ee3c h\u1ed9i tho\u1ea1i c\u0169 c\u1ea7n kh\u00f4i ph\u1ee5c.";
      if (!silent) setError(message);
      logRendererDiagnostic(api, "error", "profile", message, { action: "recover-profile-missing-target", profile_id: profile.profile_id });
      return null;
    }
    const snapshot = await recoveryContinuationSnapshot(profile, conversationId, exactTargetTab || targetTab);
    if (/^cpt_[a-f0-9]{24}$/.test(String(options.taskId || ""))) snapshot.repoTaskId = String(options.taskId);
    if (!silent) setBusy(`recover-profile:${profile.profile_id}`);
    if (!silent) setError("");
    try {
      let recoveryReason = String(options.recoveryReason || "").slice(0, 600);
      if (!options.forceContinuation && exactTargetTab?.id) {
        try {
          const restored = await api.recoverProfileChat({
            profileId: profile.profile_id,
            conversationId,
            targetId: exactTargetTab.id,
            title,
            silent,
            newChat: false
          });
          requestTargetsRef.current = { ...requestTargetsRef.current, [profile.profile_id]: conversationId };
          setRequestTargets((current) => ({ ...current, [profile.profile_id]: conversationId }));
          logRendererDiagnostic(api, "info", "profile", "Recovered original ChatGPT conversation", { action: "recover-profile-same-conversation", profile_id: profile.profile_id, conversation_id: conversationId, old_target_id: String(exactTargetTab.id), result_target_id: String(restored?.target_id || ""), automatic: Boolean(options.automatic) });
          if (!silent) notify("\u0110\u00e3 kh\u00f4i ph\u1ee5c \u0111\u00fang h\u1ed9i tho\u1ea1i c\u0169");
          window.setTimeout(() => void refresh(false), 900);
          return { mode: "same_conversation", conversationId, result: restored };
        } catch (restoreError) {
          recoveryReason = String(restoreError?.message || restoreError || "Original renderer could not be recovered.").slice(0, 600);
        }
      }
      if (!recoveryReason) recoveryReason = exactTargetTab?.id
        ? "Original conversation did not recover after the bounded attempt."
        : "Original conversation no longer has an owned Chrome tab.";
      logRendererDiagnostic(api, "warn", "profile", `Original conversation recovery failed; creating continuation chat: ${recoveryReason}`, { action: "recover-profile-rollover-start", profile_id: profile.profile_id, conversation_id: conversationId, target_id: String(exactTargetTab?.id || ""), automatic: Boolean(options.automatic), hard_failure: Boolean(options.hardFailure) });
      const newConversationId = await rolloverFullConversation(profile, conversationId, {
        ...snapshot,
        title,
        continuation_reason: "recovery",
        recovery_reason: recoveryReason,
        silent
      });
      if (!newConversationId) throw new Error(`Original chat recovery failed and continuation chat was not created. ${recoveryReason}`);
      if (exactTargetTab?.id) {
        await api.recoverProfileChat({
          profileId: profile.profile_id,
          conversationId,
          targetId: exactTargetTab.id,
          title,
          silent: true,
          discardOnly: true
        }).catch((discardError) => {
          logRendererDiagnostic(api, "warn", "profile", `Continuation created but old tab could not be closed: ${discardError?.message || String(discardError)}`, { action: "recover-profile-discard-old-tab-failed", profile_id: profile.profile_id, conversation_id: conversationId, target_id: String(exactTargetTab.id), error: discardError });
        });
      }
      logRendererDiagnostic(api, "info", "profile", "Moved cached context from unrecoverable tab to continuation chat", { action: "recover-profile-rollover-done", profile_id: profile.profile_id, abandoned_conversation_id: conversationId, conversation_id: newConversationId, automatic: Boolean(options.automatic) });
      if (!silent) notify("Tab c\u0169 kh\u00f4ng kh\u00f4i ph\u1ee5c \u0111\u01b0\u1ee3c \u00b7 \u0111\u00e3 chuy\u1ec3n sang chat ti\u1ebfp n\u1ed1i");
      window.setTimeout(() => void refresh(false), 900);
      return { mode: "continuation", conversationId: newConversationId };
    } catch (err) {
      const message = err?.message || String(err);
      logRendererDiagnostic(api, "error", "profile", `Chat recovery failed: ${message}`, { action: "recover-profile-failed", profile_id: profile.profile_id, conversation_id: conversationId, target_id: String(exactTargetTab?.id || ""), automatic: Boolean(options.automatic), error: err });
      if (!silent) setError(message);
      return null;
    } finally {
      if (!silent) setBusy("");
    }
  }

  async function continueTaskFromCheckpoint(profile, taskId, options = {}) {
    const profileId = String(profile?.profile_id || "").trim();
    const normalizedTaskId = String(taskId || "").trim();
    const conversationId = String(options?.conversationId || "").trim();
    const targetTab = options?.targetTab || null;
    const silent = options?.silent === true;
    const automatic = options?.automatic === true;
    const recoveryReason = String(options?.recoveryReason || "Task bị treo; tiếp tục từ checkpoint gần nhất.").slice(0, 600);
    if (!profileId || !/^cpt_[a-f0-9]{24}$/.test(normalizedTaskId)) return null;
    if (!silent) setBusy(`checkpoint-recovery:${profileId}`);
    if (!silent) setError("");
    try {
      const resumed = await api.resumeProfileTask({ profileId, taskId: normalizedTaskId, hangRecovery: true, recoveryReason });
      if (String(resumed?.repo_task_id || "") !== normalizedTaskId) throw new Error("Task ID đổi khi phục hồi từ checkpoint; đã dừng để tránh tạo task mới.");
      const newConversationId = String(resumed?.conversation_id || "").trim();
      if (!/^[A-Za-z0-9-]{8,160}$/.test(newConversationId)) throw new Error("Chat phục hồi chưa trả conversation id hợp lệ.");
      requestTargetsRef.current = { ...requestTargetsRef.current, [profileId]: newConversationId };
      setRequestTargets((current) => ({ ...current, [profileId]: newConversationId }));
      setChatProfileId(profileId);
      setRequestSendErrors((current) => ({ ...current, [profileId]: "" }));
      setRequestResponses((current) => {
        const previous = current[profileId] || {};
        return {
          ...current,
          [profileId]: {
            ...previous,
            visible: true,
            loading: true,
            error: "",
            conversationId: newConversationId,
            text: "",
            messages: [],
            busy: true,
            submissionState: "submitted",
            sendUncertain: false,
            rolloverStatus: "done",
            rolloverReason: "checkpoint_recovery",
            rolloverFromConversationId: conversationId,
            rolloverNotice: "Task treo đã được chuyển sang chat mới từ checkpoint gần nhất.",
            activityStartedAt: String(resumed?.repo_task_dispatched_at || new Date().toISOString()),
            repoTaskId: String(resumed?.repo_task_id || normalizedTaskId),
            repoTaskDispatchedAt: String(resumed?.repo_task_dispatched_at || ""),
            repoTaskScope: String(resumed?.repo_task_scope || previous?.repoTaskScope || ""),
            logicalTaskStatus: String(resumed?.worker_job_status || previous?.logicalTaskStatus || "running"),
            repoTaskStatus: "waiting",
            repoTaskVerified: false
          }
        };
      });
      if (targetTab?.id) {
        await api.recoverProfileChat({ profileId, conversationId, targetId: targetTab.id, silent: true, discardOnly: true }).catch((discardError) => {
          logRendererDiagnostic(api, "warn", "profile", `Checkpoint continuation created but stale tab could not be closed: ${discardError?.message || String(discardError)}`, { action: "checkpoint-recovery-discard-old-tab-failed", profile_id: profileId, task_id: normalizedTaskId, conversation_id: conversationId, target_id: String(targetTab.id), error: discardError });
        });
      }
      logRendererDiagnostic(api, "info", "profile", "Continued hung task from canonical checkpoint in a new chat", { action: "checkpoint-recovery-done", profile_id: profileId, task_id: normalizedTaskId, previous_conversation_id: conversationId, conversation_id: newConversationId, target_id: String(targetTab?.id || ""), checkpoint_count: Number(resumed?.resumed_checkpoint_count || 0), automatic });
      if (!silent) notify("Đã tiếp tục task từ checkpoint gần nhất trong chat mới");
      window.setTimeout(() => void refresh(false), 900);
      return { mode: "checkpoint_continuation", conversationId: newConversationId, result: resumed };
    } catch (err) {
      const message = err?.message || String(err);
      logRendererDiagnostic(api, "error", "profile", `Checkpoint recovery failed: ${message}`, { action: "checkpoint-recovery-failed", profile_id: profileId, task_id: normalizedTaskId, conversation_id: conversationId, target_id: String(targetTab?.id || ""), automatic, error: err });
      if (!silent) setError(message);
      return null;
    } finally {
      if (!silent) setBusy("");
    }
  }

  async function continueTaskAfterHang(incident) {
    const profileId = String(incident?.profile_id || "");
    const taskId = String(incident?.task_id || "");
    const conversationId = String(incident?.conversation_id || "");
    const profile = (status?.browserProfiles || []).find((item) => String(item?.profile_id || "") === profileId);
    if (!profile) {
      setError("Không còn tìm thấy Chrome profile của task bị treo.");
      return null;
    }
    if (!/^cpt_[a-f0-9]{24}$/.test(taskId)) {
      setError("Task bị treo chưa có Task ID hợp lệ để tiếp tục an toàn.");
      return null;
    }
    const targetTab = (profile.conversation_tabs || []).find((tab) => Number(tab?.id) === Number(incident?.tab_id));
    const sourceLabel = incident?.source === "openai" ? "OpenAI/ChatGPT" : incident?.source === "stalled" ? "task không tiến triển" : "mạng";
    const statusLabel = Number(incident?.status_code || 0) ? ` HTTP ${Number(incident.status_code)}` : "";
    return await continueTaskFromCheckpoint(profile, taskId, {
      conversationId,
      targetTab,
      recoveryReason: `Control Center xác nhận lỗi ${sourceLabel}${statusLabel} làm task treo. Tiếp tục đúng Task ID hiện tại từ checkpoint, không dùng conversation cũ.`
    });
  }

  useEffect(() => {
    const sweep = () => {
      pruneTimestampMap(operationsRecoveryTimes.current, { maxEntries: 96, maxAgeMs: 60 * 60_000 });
      pruneTimestampMap(operationsVisualWatchdogNextAt.current, { maxEntries: 96, maxAgeMs: 60 * 60_000 });
      trimSetEntries(operationsLongTaskAudits.current, 128);
      trimSetEntries(operationsVisualWatchdogChecks.current, 128);
    };
    sweep();
    const timer = window.setInterval(sweep, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return { recoverProfileTab, continueTaskFromCheckpoint, continueTaskAfterHang };
}
