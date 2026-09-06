import { useCallback } from "react";
import { profileRequestChats } from "../features/chat/chat-conversation-utils.js";
import { WORKER_EXTENSION_VERSION } from "../features/profiles/profile-runtime-utils.js";
import { persistProfileTaskLabels } from "../features/tasks/profile-task-labels.js";
import { logRendererDiagnostic } from "../diagnostic-log-view.jsx";
import { profileChromeTarget } from "../profile-card-state.js";
import { profileWorkerIsIdleForTaskResume } from "../profile-task-popup.js";

export function useProfileActions({
  api,
  status,
  requestTargets,
  taskProfileId,
  resumeBusyTaskId,
  profileSummary,
  refresh,
  notify,
  setBusy,
  setError,
  setRequestSendErrors,
  setRequestSendEvidence,
  setTaskProfileId,
  setResumeBusyTaskId,
  setProfileTaskLabels,
  setWorkerUpdateConfirmOpen
}) {
  const setupProfile = useCallback(async (profile) => {
    setBusy(`profile:${profile.profile_id}`);
    setError("");
    try {
      const result = await api.setupProfile(profile.profile_id);
      notify(result.message || "CodexPro READY");
      await refresh(false);
    } catch (err) {
      const setupError = err?.message || String(err);
      logRendererDiagnostic(api, "error", "profile", `UI setup profile thất bại: ${setupError}`, {
        action: "setup-profile-renderer-error",
        profile_id: profile.profile_id,
        extension_version: String(profile.extension_version || ""),
        connector_installed: Boolean(profile.connector_installed),
        connector_profile_bound: profile.connector_profile_bound !== false,
        connector_message: String(profile.connector_message || ""),
        tab_candidates: (profile.conversation_tabs || []).slice(0, 20).map((tab) => ({
          id: String(tab?.id || ""),
          url: String(tab?.url || "").slice(0, 300),
          title: String(tab?.title || "").slice(0, 160),
          active: Boolean(tab?.active),
          busy: Boolean(tab?.busy),
          network_state: String(tab?.network_state || "")
        })),
        error: err
      });
      setError(setupError.replace(/\s*\[CODEXPRO_SETUP_EVIDENCE\s+[\s\S]*$/, ""));
    } finally {
      setBusy("");
    }
  }, [api, notify, refresh, setBusy, setError]);

  const openProfile = useCallback(async (profile, options = {}) => {
    const tabs = profile.conversation_tabs || [];
    const activeTab = profileChromeTarget(profile);
    const conversationOf = (tab) => String(tab?.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
    const activeConversationId = conversationOf(activeTab);
    const conversations = profileRequestChats(profile);
    const defaultTarget = activeConversationId || conversations.find((chat) => chat.active)?.id || conversations[0]?.id || "";
    const requestedConversationId = String(requestTargets[profile.profile_id] || "");
    const conversationId = options.focusOnly ? activeConversationId : String(requestedConversationId || defaultTarget);
    const selectedTab = tabs.find((tab) => conversationOf(tab) === conversationId);
    const targetTab = selectedTab || activeTab;
    const selectedConversation = conversations.find((chat) => String(chat.id) === conversationId);
    const selectionReason = options.focusOnly ? "focus_only_active_tab" : selectedTab ? "selected_conversation_tab" : activeTab ? "active_tab_fallback" : "missing_target_tab";
    const selectionDiagnostic = {
      action: "profile-tab-open-selection",
      profile_id: profile.profile_id,
      focus_only: Boolean(options.focusOnly),
      selection_reason: selectionReason,
      requested_conversation_id: requestedConversationId,
      default_conversation_id: String(defaultTarget || ""),
      selected_conversation_id: String(conversationId || ""),
      active_target_id: String(activeTab?.id || ""),
      active_conversation_id: activeConversationId,
      selected_target_id: String(selectedTab?.id || ""),
      target_id: String(targetTab?.id || ""),
      target_conversation_id: conversationOf(targetTab),
      target_title: String(selectedConversation?.title || targetTab?.title || profile.active_chat_title || ""),
      tab_candidates: tabs.slice(0, 20).map((tab) => ({
        id: String(tab?.id || ""),
        conversation_id: conversationOf(tab),
        active: Boolean(tab?.active),
        window_id: String(tab?.windowId ?? tab?.window_id ?? ""),
        title: String(tab?.title || "").slice(0, 160),
        url: String(tab?.url || "").slice(0, 300)
      }))
    };
    logRendererDiagnostic(api, "info", "profile", `Manager chọn tab ${selectionDiagnostic.target_id || "không xác định"} để mở profile ${profile.profile_id}`, selectionDiagnostic);
    setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "" }));
    setRequestSendEvidence((current) => ({ ...current, [profile.profile_id]: null }));
    setBusy(`open-profile:${profile.profile_id}`);
    setError("");
    try {
      const result = await api.openProfileChat({
        profileId: profile.profile_id,
        conversationId,
        targetId: targetTab?.id,
        targetConversationId: conversationOf(targetTab),
        title: selectedConversation?.title || targetTab?.title || profile.active_chat_title || "",
        selectionReason,
        activeTargetId: activeTab?.id,
        activeConversationId
      });
      logRendererDiagnostic(api, "info", "profile", `Chrome xác nhận mở tab ${String(result?.activation?.target_id || result?.target_id || "không xác định")}`, {
        ...selectionDiagnostic,
        action: "profile-tab-open-result",
        result_profile_id: String(result?.profile_id || ""),
        result_conversation_id: String(result?.conversation_id || ""),
        result_target_id: String(result?.target_id || ""),
        activation_target_id: String(result?.activation?.target_id || ""),
        activation_window_id: String(result?.activation?.window_id || ""),
        activation_window_focused: Boolean(result?.activation?.window_focused),
        activation_acknowledgement_delayed: Boolean(result?.activation_acknowledgement_delayed),
        navigation_target_id: String(result?.navigation?.target_id || ""),
        navigation_url: String(result?.navigation?.url || ""),
        window_focus: result?.window_focus || null
      });
    } catch (err) {
      logRendererDiagnostic(api, "error", "profile", `Mở tab profile thất bại: ${err?.message || String(err)}`, { ...selectionDiagnostic, action: "profile-tab-open-error", error: err });
      setError(err?.message || String(err));
    } finally {
      setBusy("");
    }
  }, [api, requestTargets, setBusy, setError, setRequestSendErrors, setRequestSendEvidence]);

  const resumeProfileTask = useCallback(async (job) => {
    const taskId = String(job?.job_id || job?.jobId || "").trim();
    const profile = (status?.browserProfiles || []).find((item) => item.profile_id === taskProfileId);
    if (!profile || !taskId || resumeBusyTaskId) return;
    if (!profileWorkerIsIdleForTaskResume(profile)) {
      setError("Worker đang bận. Chỉ có thể tiếp tục task khi worker trở về trạng thái ĐANG RẢNH.");
      return;
    }
    setResumeBusyTaskId(taskId);
    setError("");
    try {
      const result = await api.resumeProfileTask({ profileId: profile.profile_id, taskId });
      setTaskProfileId("");
      setProfileTaskLabels((current) => {
        const next = { ...current, [profile.profile_id]: String(job?.title || current[profile.profile_id] || "Task CodexPro") };
        persistProfileTaskLabels(next);
        return next;
      });
      notify(result?.repo_task_id ? `Đang tiếp tục ${String(job?.title || "task")}` : "Đã gửi yêu cầu tiếp tục task");
      await refresh(false);
    } catch (resumeError) {
      setError(resumeError?.message || String(resumeError));
      await refresh(false).catch(() => undefined);
    } finally {
      setResumeBusyTaskId("");
    }
  }, [api, notify, refresh, resumeBusyTaskId, setError, setProfileTaskLabels, setResumeBusyTaskId, setTaskProfileId, status?.browserProfiles, taskProfileId]);

  const stopControlTask = useCallback(async (task) => {
    const profile = task?.profile;
    const tab = task?.tab;
    if (!profile?.profile_id || !tab?.id) return;
    const conversationId = String(tab?.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
    setBusy(`stop-task:${profile.profile_id}`);
    setError("");
    try {
      const result = await api.stopProfileTask({
        profileId: profile.profile_id,
        conversationId,
        targetId: tab.id,
        taskId: String(profile.current_task_id || "")
      });
      notify(result?.stopped ? "Đã dừng task ChatGPT" : "Task đã ngừng trước khi nhận lệnh dừng");
      window.setTimeout(() => void refresh(false), 700);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy("");
    }
  }, [api, notify, refresh, setBusy, setError]);

  const reloadProfiles = useCallback(async () => {
    if (!profileSummary.reload) return;
    setWorkerUpdateConfirmOpen(false);
    setBusy("reload-profiles");
    setError("");
    try {
      const result = await api.reloadProfiles();
      if (result.count) {
        notify(`Đã update thành công ${result.count} worker lên ${result.version}${result.deferred ? ` · bỏ qua ${result.deferred} worker đang làm việc` : ""}`);
      } else if (result.deferred) {
        notify(`${result.deferred} worker đang làm việc · chưa update để tránh gián đoạn`);
      } else if (result.mode === "runtime_unavailable") {
        notify("MCP tạm thời không phản hồi · sẽ tự update worker khi kết nối phục hồi");
      } else {
        notify(`Worker extension đã ở bản ${result.version || status?.workerExtensionVersion || WORKER_EXTENSION_VERSION}`);
      }
      window.setTimeout(() => void refresh(false), result.mode === "bootstrap_reload" || result.mode === "mixed_update" ? 8000 : 3500);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy("");
    }
  }, [api, notify, status?.workerExtensionVersion, profileSummary.reload, refresh, setBusy, setError, setWorkerUpdateConfirmOpen]);

  return {
    setupProfile,
    openProfile,
    resumeProfileTask,
    stopControlTask,
    reloadProfiles
  };
}
