import { NEW_CHAT_TARGET } from "./chat-dropdown.jsx";
import { conversationIdFromTab, profileRequestChats, taskConversationIdForProfile } from "./chat-conversation-utils.js";
import { trimRecentTranscriptMessages } from "../../chat-transcript.js";
import { ALL_ALLOWED_WORKSPACES } from "../../project-dropdown.jsx";
import { logRendererDiagnostic } from "../../diagnostic-log-view.jsx";

export function createChatUiActions({
  api,
  busy,
  projects,
  managerSettings,
  requestProjectRoots,
  requestFiles,
  requestDraftsRef,
  requestTargetsRef,
  requestTargetReasons,
  responseTurnAnchors,
  setRequestTargets,
  setRequestProjectRoots,
  setRequestDraftResetVersions,
  setRequestFiles,
  setRequestResponses,
  setRequestSendErrors,
  setAttachmentPreview,
  setChatProfileId,
  setBusy,
  setError,
  projectRootForProfile,
  selectProjectForProfile,
  resetChatViewport,
  positionOpenChatViewport,
  hydrateCachedResponse,
  refresh,
  notify
}) {
  function openChat(profile) {
    const taskConversationId = taskConversationIdForProfile(profile);
    const conversations = profileRequestChats(profile, taskConversationId);
    const pinnedConversationId = String(requestTargetsRef.current[profile.profile_id] || "");
    const activeTab = (profile.conversation_tabs || []).find((tab) => tab.active);
    const activeConversationId = conversationIdFromTab(activeTab);
    const activeTabReady = Boolean(activeConversationId && !activeTab?.busy && !activeTab?.settling && String(activeTab?.network_state || "") !== "generating");
    const conversationId = String(taskConversationId || (activeTabReady ? activeConversationId : pinnedConversationId || activeConversationId || conversations.find((chat) => chat.active)?.id || conversations[0]?.id || NEW_CHAT_TARGET));
    const selectionReason = taskConversationId
      ? (String(profile?.current_task_conversation_id || "").trim() === taskConversationId ? "open_task_bound_conversation" : "open_task_inferred_conversation")
      : activeTabReady
        ? (pinnedConversationId && pinnedConversationId !== activeConversationId ? "open_active_idle_tab_overrode_pinned" : "open_active_idle_tab")
        : pinnedConversationId ? "reopen_pinned_selection" : "initial_open";
    if (conversationId) {
      requestTargetsRef.current = { ...requestTargetsRef.current, [profile.profile_id]: conversationId };
      requestTargetReasons.current.set(profile.profile_id, selectionReason);
      setRequestTargets((current) => ({ ...current, [profile.profile_id]: conversationId }));
    }
    const resolvedTaskTab = (profile.conversation_tabs || []).find((tab) => conversationIdFromTab(tab) === taskConversationId);
    const taskTabDiffersFromChromeActive = Boolean(taskConversationId && activeConversationId && taskConversationId !== activeConversationId);
    logRendererDiagnostic(api, taskTabDiffersFromChromeActive ? "warn" : "info", "chat", taskTabDiffersFromChromeActive
      ? `Task ${profile.current_task_title || profile.current_task_id || profile.profile_id} nằm ở tab khác tab Chrome đang active`
      : `Mở composer ${profile.profile_id} tại ${conversationId}`, {
      action: "open-chat-target-selection",
      profile_id: profile.profile_id,
      task_id: String(profile?.current_task_id || ""),
      task_title: String(profile?.current_task_title || ""),
      task_bound_conversation_id: String(profile?.current_task_conversation_id || ""),
      task_resolved_conversation_id: taskConversationId,
      task_resolved_title: String(resolvedTaskTab?.title || "").slice(0, 160),
      task_tab_differs_from_chrome_active: taskTabDiffersFromChromeActive,
      from_conversation_id: pinnedConversationId,
      to_conversation_id: conversationId,
      selection_reason: selectionReason,
      active_target_id: String(activeTab?.id || ""),
      active_conversation_id: activeConversationId,
      active_title: String(activeTab?.title || "").slice(0, 160),
      active_tab_ready: activeTabReady,
      active_tab_busy: Boolean(activeTab?.busy),
      active_tab_settling: Boolean(activeTab?.settling),
      active_network_state: String(activeTab?.network_state || ""),
      draft_length: String(requestDraftsRef.current[profile.profile_id] || "").length,
      tab_candidates: (profile.conversation_tabs || []).slice(0, 20).map((tab) => ({ id: String(tab?.id || ""), conversation_id: conversationIdFromTab(tab), active: Boolean(tab?.active), busy: Boolean(tab?.busy), settling: Boolean(tab?.settling), network_state: String(tab?.network_state || ""), title: String(tab?.title || "").slice(0, 160) }))
    });
    const projectRoot = projectRootForProfile(profile);
    const rememberedRoot = String(requestProjectRoots[profile.profile_id] || managerSettings.repoSelections?.[profile.profile_id] || "");
    if (projectRoot && projectRoot.toLowerCase() !== rememberedRoot.toLowerCase()) selectProjectForProfile(profile.profile_id, projectRoot);
    else if (projectRoot) setRequestProjectRoots((current) => ({ ...current, [profile.profile_id]: projectRoot }));
    resetChatViewport(profile.profile_id);
    setChatProfileId(profile.profile_id);
    window.requestAnimationFrame(() => {
      positionOpenChatViewport(profile.profile_id, "open-chat:initial");
      window.setTimeout(() => positionOpenChatViewport(profile.profile_id, "open-chat:initial-settle"), 180);
    });
    if (profile.connected && conversationId && conversationId !== NEW_CHAT_TARGET) {
      setRequestResponses((current) => {
        const previous = current[profile.profile_id] || {};
        const sameConversation = previous.conversationId === conversationId;
        const activeTurn = sameConversation && Boolean(previous.loading || previous.busy || previous.networkStreamInProgress || previous.canonicalBusy);
        return { ...current, [profile.profile_id]: { ...(sameConversation ? previous : {}), visible: true, loading: activeTurn ? Boolean(previous.loading) : false, transcriptLoading: !activeTurn, error: "", conversationId, messages: sameConversation ? trimRecentTranscriptMessages(previous.messages) : [] } };
      });
      void hydrateCachedResponse(profile, conversationId).finally(() => {
        window.requestAnimationFrame(() => {
          positionOpenChatViewport(profile.profile_id, "open-chat:hydrated");
          window.setTimeout(() => positionOpenChatViewport(profile.profile_id, "open-chat:hydrated-settle"), 180);
        });
      });
    }
  }

  function selectRequestConversation(profile, conversationId) {
    const profileId = profile.profile_id;
    const previousTarget = String(requestTargetsRef.current[profileId] || "");
    const nextTarget = String(conversationId || "");
    if (!nextTarget || nextTarget === previousTarget) return;
    requestTargetsRef.current = { ...requestTargetsRef.current, [profileId]: nextTarget };
    requestTargetReasons.current.set(profileId, nextTarget === NEW_CHAT_TARGET ? "user_new_chat" : "user_selected_conversation");
    setRequestTargets((current) => ({ ...current, [profileId]: nextTarget }));
    if (nextTarget === NEW_CHAT_TARGET) {
      responseTurnAnchors.current.delete(profileId);
      requestDraftsRef.current[profileId] = "";
      setRequestDraftResetVersions((current) => ({ ...current, [profileId]: (current[profileId] || 0) + 1 }));
      setRequestFiles((current) => ({ ...current, [profileId]: [] }));
      setRequestSendErrors((current) => ({ ...current, [profileId]: "" }));
      setRequestResponses((current) => ({ ...current, [profileId]: { visible: true, loading: false, error: "", conversationId: NEW_CHAT_TARGET, text: "", busy: false } }));
      return;
    }
    setRequestResponses((current) => ({ ...current, [profileId]: { visible: true, loading: false, transcriptLoading: true, error: "", conversationId: nextTarget, text: "", messages: [] } }));
    void hydrateCachedResponse(profile, nextTarget);
  }

  function addRequestAttachments(profileId, selected) {
    const current = requestFiles[profileId] || [];
    const merged = [...current, ...selected].filter((file, index, files) => files.findIndex((candidate) => candidate.path === file.path) === index);
    if (merged.length > 4) throw new Error("Mỗi yêu cầu được đính kèm tối đa 4 file.");
    if (merged.some((file) => file.size > 8 * 1024 * 1024)) throw new Error("Mỗi file được tối đa 8 MB.");
    if (merged.reduce((total, file) => total + file.size, 0) > 10 * 1024 * 1024) throw new Error("Tổng file đính kèm được tối đa 10 MB.");
    setRequestFiles((files) => ({ ...files, [profileId]: merged }));
  }

  async function chooseRequestAttachments(profileId) {
    setError("");
    try {
      const selected = await api.chooseRequestFiles();
      if (!selected.length) return;
      addRequestAttachments(profileId, selected);
    } catch (err) {
      const message = err?.message || String(err);
      logRendererDiagnostic(api, "error", "chat", `Xử lý file đính kèm thất bại: ${message}`, { action: "choose-request-attachments", profile_id: profileId, error: err });
      setError(message);
    }
  }

  async function openAttachmentPreview(file) {
    setAttachmentPreview({ loading: true, name: file.name, size: file.size, mimeType: file.mimeType, path: file.path });
    try {
      const preview = await api.getRequestFilePreview(file.path);
      setAttachmentPreview({ ...preview, loading: false, path: file.path });
    } catch (err) {
      logRendererDiagnostic(api, "error", "chat", `Đọc preview file thất bại: ${err?.message || String(err)}`, { action: "open-attachment-preview", file_name: file.name, file_size: file.size, mime_type: file.mimeType, error: err });
      setAttachmentPreview({
        loading: false,
        name: file.name,
        size: file.size,
        mimeType: file.mimeType,
        path: file.path,
        kind: "error",
        error: err?.message || String(err)
      });
    }
  }

  async function pasteRequestImage(profileId, event) {
    const items = Array.from(event.clipboardData?.items || []);
    const files = Array.from(event.clipboardData?.files || []);
    const hasImage = items.some((item) => String(item.type || "").startsWith("image/")) || files.some((file) => String(file.type || "").startsWith("image/"));
    if (!hasImage) return;
    event.preventDefault();
    setRequestSendErrors((current) => ({ ...current, [profileId]: "" }));
    try {
      const image = await api.captureClipboardImage();
      if (!image) throw new Error("Không đọc được ảnh từ clipboard.");
      addRequestAttachments(profileId, [image]);
      notify("Đã dán ảnh từ clipboard");
    } catch (err) {
      const message = err?.message || String(err);
      logRendererDiagnostic(api, "error", "chat", `Dán ảnh clipboard thất bại: ${message}`, { action: "paste-request-image", profile_id: profileId, error: err });
      setRequestSendErrors((current) => ({ ...current, [profileId]: message }));
    }
  }

  async function continueIncompleteResponse(profile, conversationId) {
    if (!conversationId || busy) return;
    setBusy(`continue:${profile.profile_id}`);
    setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: "" }));
    try {
      const continueProjectRoot = projectRootForProfile(profile);
      const continueAllAllowed = continueProjectRoot === ALL_ALLOWED_WORKSPACES;
      await api.sendProfileRequest({
        profileId: profile.profile_id,
        conversationId,
        scope: continueAllAllowed ? "all_allowed" : "workspace",
        projectRoot: continueAllAllowed ? "" : continueProjectRoot,
        workspaceCandidates: continueAllAllowed ? projects.map((project) => project.root) : [],
        text: "Tiếp tục từ đúng chỗ phản hồi vừa bị ngắt. Không lặp lại phần trước; hoàn thành câu trả lời còn dang dở.",
        attachments: []
      });
      setRequestResponses((current) => ({ ...current, [profile.profile_id]: { ...(current[profile.profile_id] || {}), loading: true, incomplete: false } }));
      notify("Đã yêu cầu ChatGPT tiếp tục phần bị ngắt");
      window.setTimeout(() => void refresh(false), 500);
    } catch (err) {
      setRequestSendErrors((current) => ({ ...current, [profile.profile_id]: err?.message || String(err) }));
    } finally {
      setBusy("");
    }
  }

  return {
    openChat,
    selectRequestConversation,
    chooseRequestAttachments,
    openAttachmentPreview,
    pasteRequestImage,
    continueIncompleteResponse
  };
}
