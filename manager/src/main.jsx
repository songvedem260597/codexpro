import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import managerPackage from "../package.json";
import "./styles.css";
import "@fontsource/be-vietnam-pro/400.css";
import "@fontsource/be-vietnam-pro/500.css";
import "@fontsource/be-vietnam-pro/600.css";
import "@fontsource/be-vietnam-pro/700.css";
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/jetbrains-mono/700.css";
import { TaskWorkflowCenter } from "./task-workflow-center.jsx";
import { AppPluginCenter } from "./app-plugin-center.jsx";
import { Icon, ProfileSummaryItem, StatusCard, TitleGalaxyAccent } from "./components/manager-overview-ui.jsx";
import { SettingsView } from "./features/settings/settings-view.jsx";
import { Dot } from "./components/worker-ui.jsx";
import { ApiWorkerJobModal } from "./features/api-workers/api-worker-job-modal.jsx";
import { AttachmentPreviewModal } from "./features/chat/attachment-preview-modal.jsx";
import { ChatModal } from "./features/chat/chat-modal.jsx";
import { createChatUiActions } from "./features/chat/chat-ui-actions.js";
import { ProfileTaskModal } from "./features/tasks/profile-task-modal.jsx";
import { WorkerUpdateConfirmModal } from "./features/profiles/worker-update-confirm-modal.jsx";
import { BrowserProfilesSection } from "./features/profiles/browser-profiles-section.jsx";
import { InspectionModal } from "./features/projects/inspection-modal.jsx";
import { ProjectsSection } from "./features/projects/projects-section.jsx";
import { createManagerRuntimeActions } from "./features/runtime/manager-runtime-actions.js";
import { extensionReady, profileSafeForWorkerUpdate, profileVisibleInWorkerList, WORKER_EXTENSION_VERSION } from "./features/profiles/profile-runtime-utils.js";
import { loadProfileTaskLabels, persistProfileTaskLabels } from "./features/tasks/profile-task-labels.js";
import { FONT_OPTIONS, FONT_ROLE_OPTIONS, FONT_WEIGHT_LABELS, GLOBAL_RULES_TEMPLATE } from "./manager-settings-model.js";
import { useManagerSettings } from "./hooks/use-manager-settings.js";
import { useManagerDiagnostics } from "./hooks/use-manager-diagnostics.js";
import { useChatViewport } from "./hooks/use-chat-viewport.js";
import { useRuntimeStatus } from "./hooks/use-runtime-status.js";
import { useProjectActions } from "./hooks/use-project-actions.js";
import { useProfileActions } from "./hooks/use-profile-actions.js";
import { useChatResponseCache } from "./hooks/use-chat-response-cache.js";
import { useChatResponseLoader } from "./hooks/use-chat-response-loader.js";
import { useChatSendActions } from "./hooks/use-chat-send-actions.js";
import { useChatRecovery } from "./hooks/use-chat-recovery.js";
import { useChatSession } from "./hooks/use-chat-session.js";
import { materializeTranscriptMessages, transcriptAwaitingAssistant } from "./chat-transcript.js";
import { DiagnosticLogView } from "./diagnostic-log-view.jsx";
import { playTaskCompletionSound } from "./task-completion-sound.js";
import { trimMapEntries } from "./performance-retention.js";
import { synchronizeWorkerBorderAnimations } from "./worker-border-sync.js";

const loadResponseMarkdownModule = () => import("./response-markdown.jsx");

const ControlCenter = React.lazy(() => import("./control-center.jsx").then((module) => ({ default: module.ControlCenter })));
const api = window.codexpro;
const PROJECTS_PER_PAGE = 8;
const DEEP_UI_DIAGNOSTICS_ENABLED = new URLSearchParams(window.location.search).get("debugUi") === "1";

function App() {
  const [activePage, setActivePage] = useState("overview");
  const [chatProfileId, setChatProfileId] = useState("");
  const [status, setStatus] = useState(null);
  const [projects, setProjects] = useState([]);
  const [projectPage, setProjectPage] = useState(0);
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const notify = useCallback((message) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);
  const reportApiWorkerError = useCallback((workerError) => setError(workerError?.message || String(workerError)), []);
  const {
    managerSettings,
    setManagerSettings,
    chatWidthInput,
    setChatWidthInput,
    chatHeightInput,
    setChatHeightInput,
    profileCardHeightInput,
    setProfileCardHeightInput,
    globalRulesDraft,
    setGlobalRulesDraft,
    settingsBusy,
    workerPackDraft,
    setWorkerPackDraft,
    showWorkerPackCreator,
    setShowWorkerPackCreator,
    workerPackDeleteArmed,
    applyManagerSettings,
    saveManagerSetting,
    commitChatWidthInput,
    commitChatHeightInput,
    commitProfileCardHeightInput,
    changeAppBackground,
    restoreAppBackground,
    changeWorkerImage,
    restoreWorkerImage,
    createWorkerImagePack,
    selectWorkerImagePack,
    deleteWorkerImagePack,
    restoreManagerSettings
  } = useManagerSettings({ api, notify, setError });
  const {
    diagnosticLogs,
    diagnosticFilters,
    setDiagnosticFilters,
    diagnosticBusy,
    selectedDiagnostic,
    setSelectedDiagnostic,
    operationsPerformance,
    operationsLogs,
    uiPerformance,
    loadDiagnosticLogs,
    clearDiagnosticLogHistory
  } = useManagerDiagnostics({ api, activePage, status, notify, setError });
  const [workerUpdateConfirmOpen, setWorkerUpdateConfirmOpen] = useState(false);
  const [apiJobWorker, setApiJobWorker] = useState(null);
  const [taskProfileId, setTaskProfileId] = useState("");
  const [resumeBusyTaskId, setResumeBusyTaskId] = useState("");
  const [inspection, setInspection] = useState(null);
  const [checkingProfiles, setCheckingProfiles] = useState([]);
  const [autoMigratingProfileId, setAutoMigratingProfileId] = useState("");
  const requestDraftsRef = useRef({});
  const [requestDraftResetVersions, setRequestDraftResetVersions] = useState({});
  const [requestTargets, setRequestTargets] = useState({});
  const [requestProjectRoots, setRequestProjectRoots] = useState({});
  const [requestFiles, setRequestFiles] = useState({});
  const [attachmentPreview, setAttachmentPreview] = useState(null);
  const [requestResponses, setRequestResponses] = useState({});
  const requestResponsesRef = useRef({});
  requestResponsesRef.current = requestResponses;
  const [profileTaskLabels, setProfileTaskLabels] = useState(() => loadProfileTaskLabels());
  const [responseSelection, setResponseSelection] = useState({ key: "", text: "" });
  const [clearedResponseTargets, setClearedResponseTargets] = useState({});
  const [requestSendErrors, setRequestSendErrors] = useState({});
  const [requestSendEvidence, setRequestSendEvidence] = useState({});
  const conversationTitleOverridesRef = useRef({});
  const networkStreamPushTimes = useRef(new Map());
  const requestTargetsRef = useRef({});
  const requestTargetReasons = useRef(new Map());
  const operationsNotificationState = useRef(new Map());
  const operationsAutoUpdateAt = useRef(0);
  const {
    responseBodyRefs,
    chatModalRef,
    chatResponseRef,
    responseScrollLocked,
    responseComposerActive,
    responseScrollPositions,
    responseScrollDiagnostics,
    responseTurnAnchors,
    maintainResponsePosition,
    restoreOpenResponseTurnAnchor,
    positionOpenChatViewport,
    holdOpenChatAutoScroll,
    holdResponseAutoScroll,
    pauseResponseAutoScroll,
    resetChatViewport,
    captureResponseSelection
  } = useChatViewport({
    api,
    chatProfileId,
    selectedRequestTarget: requestTargets[chatProfileId],
    requestTargetsRef,
    setResponseSelection,
    deepDiagnosticsEnabled: DEEP_UI_DIAGNOSTICS_ENABLED
  });
  const { refresh, refreshStatus } = useRuntimeStatus({
    api,
    status,
    setStatus,
    setProjects,
    busy,
    setBusy,
    setError,
    conversationTitleOverridesRef,
    requestTargetsRef,
    setRequestResponses,
    networkStreamPushTimes,
    checkingProfiles,
    setCheckingProfiles,
    setAutoMigratingProfileId
  });
  const {
    addProject,
    inspect,
    projectRootForProfile,
    selectProjectForProfile,
    changeProjectForProfile
  } = useProjectActions({
    api,
    projects,
    requestProjectRoots,
    managerSettings,
    requestTargetsRef,
    setProjects,
    setInspection,
    setBusy,
    setError,
    setRequestProjectRoots,
    setManagerSettings,
    setRequestTargets,
    setRequestResponses,
    setRequestSendErrors,
    setRequestSendEvidence,
    applyManagerSettings,
    resetChatViewport,
    notify
  });
  const { loadResponse } = useChatResponseLoader({
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
  });
  const {
    prefetchProfileResponseCaches,
    persistResponseCache,
    hydrateCachedResponse
  } = useChatResponseCache({
    api,
    requestTargetsRef,
    setRequestResponses,
    loadResponse
  });
  const { sendRequest, rolloverFullConversation, verifyRepoTaskUse } = useChatSendActions({
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
  });
  const { recoverProfileTab, continueTaskAfterHang } = useChatRecovery({
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
  });

  useLayoutEffect(() => {
    if (activePage !== "overview") return;
    synchronizeWorkerBorderAnimations(document);
  }, [activePage, managerSettings.profileLayout, managerSettings.workingBorderStyle, status]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadResponseMarkdownModule();
    }, 120);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const sweepRetentionCaches = () => {
      for (const map of [
        requestTargetReasons.current,
        responseScrollPositions.current,
        responseScrollDiagnostics.current,
        responseTurnAnchors.current,
        operationsNotificationState.current
      ]) trimMapEntries(map, 96);
    };
    sweepRetentionCaches();
    const timer = window.setInterval(sweepRetentionCaches, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const projectPageCount = Math.max(1, Math.ceil(projects.length / PROJECTS_PER_PAGE));
  const visibleProjects = useMemo(() => projects.slice(projectPage * PROJECTS_PER_PAGE, (projectPage + 1) * PROJECTS_PER_PAGE), [projects, projectPage]);
  const openChatResponse = chatProfileId ? requestResponses[chatProfileId] : null;
  const openChatMessages = useMemo(() => openChatResponse && chatProfileId
    ? materializeTranscriptMessages(openChatResponse, String(openChatResponse.conversationId || ""))
    : [], [chatProfileId, openChatResponse]);
  const openChatAwaitingAssistant = !openChatResponse?.nonRetryable && transcriptAwaitingAssistant(openChatMessages);
  const openChatLatestMessage = openChatMessages.at(-1);
  const openChatLatestMessageKey = openChatLatestMessage
    ? `${openChatLatestMessage.id || "message"}:${openChatLatestMessage.role || ""}:${String(openChatLatestMessage.text || "").length}`
    : "";
  const openChatScrollKey = useMemo(() => {
    if (!openChatResponse || !chatProfileId) return "";
    const messages = Array.isArray(openChatResponse.messages) ? openChatResponse.messages : [];
    const lastMessage = messages.at(-1);
    const visibleText = String(lastMessage?.text || openChatResponse.text || "");
    const contentKey = `${lastMessage?.id || "response"}:${visibleText.length}:${visibleText.slice(-48)}`;
    const selectedTarget = String(requestTargets[chatProfileId] || openChatResponse.conversationId || "");
    const openProfile = (status?.browserProfiles || []).find((profile) => profile.profile_id === chatProfileId);
    const openTab = (openProfile?.conversation_tabs || []).find((tab) => selectedTarget && String(tab.url || "").includes(`/c/${selectedTarget}`))
      || (openProfile?.conversation_tabs || []).find((tab) => tab.active);
    const turnKey = [
      busy === `request:${chatProfileId}`,
      Boolean(openChatResponse.busy),
      Boolean(openChatResponse.loading),
      Boolean(openChatResponse.transcriptLoading),
      Boolean(openChatResponse.networkStreamInProgress),
      Boolean(openTab?.busy),
      Boolean(openTab?.settling),
      String(openTab?.network_state || openChatResponse.networkState || "")
    ].join(":");
    return `${openChatResponse.conversationId || ""}:${messages.length}:${contentKey}:${turnKey}`;
  }, [busy, chatProfileId, openChatResponse, requestTargets, status?.browserProfiles]);
  const openChatTurnActive = useMemo(() => {
    if (!chatProfileId) return false;
    const selectedTarget = String(requestTargets[chatProfileId] || openChatResponse?.conversationId || "");
    const responseCurrent = Boolean(openChatResponse && openChatResponse.conversationId === selectedTarget);
    const openProfile = (status?.browserProfiles || []).find((profile) => profile.profile_id === chatProfileId);
    const openTab = (openProfile?.conversation_tabs || []).find((tab) => selectedTarget && String(tab.url || "").includes(`/c/${selectedTarget}`))
      || (openProfile?.conversation_tabs || []).find((tab) => tab.active);
    return Boolean(
      busy === `request:${chatProfileId}`
      || openTab?.busy
      || openTab?.settling
      || String(openTab?.network_state || "") === "generating"
      || (responseCurrent && (
        openChatResponse.busy
        || openChatResponse.loading
        || openChatResponse.transcriptLoading
        || openChatResponse.networkStreamInProgress
        || openChatResponse.canonicalBusy
        || openChatResponse.incomplete
        || openChatAwaitingAssistant
      ))
    );
  }, [busy, chatProfileId, openChatAwaitingAssistant, openChatResponse, requestTargets, status?.browserProfiles]);

  useChatSession({
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
    loadResponse,
    verifyRepoTaskUse,
    notify,
    openChatResponse,
    openChatAwaitingAssistant,
    openChatLatestMessageKey,
    responseBodyRefs
  });
  useEffect(() => {
    setProjectPage((current) => Math.min(current, Math.max(0, Math.ceil(projects.length / PROJECTS_PER_PAGE) - 1)));
  }, [projects.length]);

  useEffect(() => persistProfileTaskLabels(profileTaskLabels), [profileTaskLabels]);

  useEffect(() => {
    const browserProfiles = Array.isArray(status?.browserProfiles) ? status.browserProfiles : [];
    if (!browserProfiles.length) return;
    setProfileTaskLabels((current) => {
      let changed = false;
      const next = { ...current };
      for (const profile of browserProfiles) {
        const title = String(profile?.current_task_title || "").trim();
        if (!title || next[profile.profile_id] === title) continue;
        next[profile.profile_id] = title;
        changed = true;
      }
      return changed ? next : current;
    });
  }, [status?.browserProfiles]);
  useEffect(() => {
    setRequestProjectRoots((current) => ({ ...current, ...(managerSettings.repoSelections || {}) }));
  }, [managerSettings.repoSelections]);

  useEffect(() => {
    const profiles = Array.isArray(status?.browserProfiles) ? status.browserProfiles : [];
    const jobs = Array.isArray(status?.workerJobs) ? status.workerJobs : [];
    for (const profile of profiles) {
      const tabs = Array.isArray(profile?.conversation_tabs) ? profile.conversation_tabs : [];
      const tab = tabs.find((item) => item.busy || item.settling || String(item?.network_state || "") === "generating") || tabs.find((item) => item.active) || tabs[0];
      const taskId = String(profile?.current_task_id || "");
      const job = jobs.find((item) => String(item?.job_id || item?.jobId || "") === taskId) || null;
      const countsAsTask = job?.counts_as_task === true;
      const title = String(profile?.current_task_title || tab?.title || profile?.active_chat_title || "Task CodexPro");
      const working = Boolean(tab?.busy || tab?.settling || profile?.activity === "working" || Number(profile?.busy_request_count || 0) > 0);
      const failed = Boolean(tab?.renderer_unresponsive || tab?.message_delivery_timed_out || tab?.message_stream_error || tab?.connection_interrupted || String(tab?.network_state || "").toLowerCase() === "failed" || tab?.network_error);
      const previous = operationsNotificationState.current.get(profile.profile_id);
      if (managerSettings.taskNotifications !== false && previous) {
        const previousJob = previous.taskId ? jobs.find((job) => String(job?.job_id || job?.jobId || "") === previous.taskId) : null;
        const previousJobStatus = String(previousJob?.status || "").toLowerCase();
        const previousCountsAsTask = previous.countsAsTask || previousJob?.counts_as_task === true;
        if (previousCountsAsTask && previous.working && !working && previous.taskId && previousJobStatus === "completed") {
          void api.showNotification?.({ title: "CodexPro · Task hoàn tất", body: `${previous.title} · ${profile.label || profile.profile_id.slice(0, 8)}`, silent: true });
          playTaskCompletionSound();
        } else if (countsAsTask && !previous.failed && failed) {
          void api.showNotification?.({ title: "CodexPro · Task bị gián đoạn", body: `“${title}” gặp lỗi hoặc profile bị treo. Code có thể đang sửa dở/chưa commit.` });
        }
      }
      operationsNotificationState.current.set(profile.profile_id, { working, failed, taskId, title, countsAsTask });
    }
  }, [managerSettings.taskNotifications, status?.browserProfiles, status?.workerJobs]);

  useLayoutEffect(() => {
    if (!chatProfileId || !openChatScrollKey) return;
    if (openChatTurnActive) restoreOpenResponseTurnAnchor(chatProfileId);
    maintainResponsePosition(chatProfileId, "layout-effect:open-chat-scroll-key");
  }, [chatProfileId, openChatScrollKey, openChatTurnActive, maintainResponsePosition, restoreOpenResponseTurnAnchor]);

  useEffect(() => {
    if (!chatProfileId) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event) => {
      if (event.key !== "Escape") return;
      if (attachmentPreview) {
        event.preventDefault();
        setAttachmentPreview(null);
        return;
      }
      setChatProfileId("");
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [chatProfileId, attachmentPreview]);

  const visibleBrowserProfiles = useMemo(
    () => (status?.browserProfiles || []).filter(profileVisibleInWorkerList),
    [status?.browserProfiles]
  );

  const workerExtensionVersion = status?.workerExtensionVersion || WORKER_EXTENSION_VERSION;
  const profileSummary = useMemo(() => {
    const allProfiles = status?.browserProfiles || [];
    const profiles = visibleBrowserProfiles.filter((profile) => profile.connected);
    const connectedProfiles = allProfiles.filter((profile) => profile.connected);
    const apiWorkers = (status?.workers || []).filter((worker) => worker.worker_type === "api");
    const outdated = connectedProfiles.filter((profile) => !extensionReady(profile.extension_version, workerExtensionVersion));
    return {
      working: profiles.filter((profile) => profile.activity === "working" || profile.activity === "settling").length + apiWorkers.filter((worker) => worker.connected && worker.activity === "working").length,
      idle: profiles.filter((profile) => profile.activity === "idle" && (profile.connector_installed || !extensionReady(profile.extension_version, workerExtensionVersion))).length + apiWorkers.filter((worker) => worker.connected && worker.activity !== "working" && worker.activity !== "failed").length,
      hung: visibleBrowserProfiles.filter((profile) => !profile.connected).length + apiWorkers.filter((worker) => !worker.connected || worker.activity === "failed").length,
      missing: profiles.filter((profile) => profile.activity === "no_chatgpt" && !profile.connector_installed).length,
      reload: outdated.filter(profileSafeForWorkerUpdate).length,
      deferredUpdate: outdated.filter((profile) => !profileSafeForWorkerUpdate(profile)).length,
      outdated: outdated.length
    };
  }, [status?.browserProfiles, status?.workers, visibleBrowserProfiles, workerExtensionVersion]);
  const {
    setupProfile,
    openProfile,
    resumeProfileTask,
    stopControlTask,
    reloadProfiles
  } = useProfileActions({
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
  });

  useEffect(() => {
    if (!managerSettings.autoUpdateWorkers || busy || !status?.local?.ok || status?.workerSnapshotStale) return;
    const profiles = Array.isArray(status?.browserProfiles) ? status.browserProfiles : [];
    const hasSafeOutdatedWorker = profiles.some((profile) => {
      if (!profile?.connected || extensionReady(profile.extension_version, workerExtensionVersion)) return false;
      const tabs = Array.isArray(profile.conversation_tabs) ? profile.conversation_tabs : [];
      const hasBusyTab = tabs.some((tab) => tab?.busy || tab?.settling || String(tab?.network_state || "") === "generating");
      return profile.activity === "idle" && Number(profile.busy_request_count || 0) === 0 && !hasBusyTab;
    });
    if (!hasSafeOutdatedWorker || Date.now() - operationsAutoUpdateAt.current < 60_000) return;
    operationsAutoUpdateAt.current = Date.now();
    void reloadProfiles();
  }, [busy, managerSettings.autoUpdateWorkers, reloadProfiles, status?.browserProfiles, status?.local?.ok, status?.workerSnapshotStale, workerExtensionVersion]);

  const { copyLink, rotateLink, control } = createManagerRuntimeActions({
    api,
    status,
    conversationTitleOverridesRef,
    setStatus,
    setBusy,
    setError,
    notify
  });

  const {
    openChat,
    selectRequestConversation,
    chooseRequestAttachments,
    openAttachmentPreview,
    pasteRequestImage,
    continueIncompleteResponse
  } = createChatUiActions({
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
  });

  function renderChatModal() {
    const profile = (status?.browserProfiles || []).find((item) => item.profile_id === chatProfileId);
    if (!profile) return null;
    return (
      <ChatModal
        profile={profile}
        settings={managerSettings}
        projects={projects}
        busy={busy}
        state={{ requestTargets, requestDraftResetVersions, requestFiles, requestResponses, requestSendErrors, requestSendEvidence, responseSelection, clearedResponseTargets }}
        refs={{ requestTargetsRef, requestDraftsRef, chatModalRef, chatResponseRef, responseBodyRefs, responseComposerActive }}
        actions={{
          projectRootForProfile,
          changeProjectForProfile,
          selectRequestConversation,
          loadResponse,
          continueIncompleteResponse,
          copyText: api.copyText,
          notify,
          clearResponse: (clearedKey) => { setClearedResponseTargets((current) => ({ ...current, [clearedKey]: true })); notify("Đã dọn chat trong Manager"); },
          captureResponseSelection,
          openGeneratedImage: (image) => setAttachmentPreview({ loading: false, name: image.name || "Ảnh tạo bởi ChatGPT", size: Number(image.size) || 0, mimeType: image.mimeType || "image/jpeg", kind: "image", dataUrl: image.dataUrl, generated: true }),
          holdOpenChatAutoScroll,
          holdResponseAutoScroll,
          pauseResponseAutoScroll,
          pasteRequestImage,
          chooseRequestAttachments,
          openAttachmentPreview,
          removeAttachment: (profileId, filePath) => setRequestFiles((current) => ({ ...current, [profileId]: (current[profileId] || []).filter((item) => item.path !== filePath) })),
          clearSendError: (profileId) => setRequestSendErrors((current) => ({ ...current, [profileId]: "" })),
          close: () => setChatProfileId(""),
          openProfile,
          sendRequest
        }}
      />
    );
  }

  const selectedFont = FONT_OPTIONS.find((option) => option.value === managerSettings.fontFamily) || FONT_OPTIONS[0];
  const selectedHeadingFont = FONT_OPTIONS.find((option) => option.value === managerSettings.headingFontFamily);
  const selectedMonoFont = FONT_OPTIONS.find((option) => option.value === managerSettings.monoFontFamily);
  const appStyle = {
    "--chat-modal-width": `${managerSettings.chatWidth}px`,
    "--chat-response-height": `${managerSettings.chatHeight}px`,
    "--chat-response-runway-height": `${Math.max(108, Math.round((managerSettings.chatHeight - 45) / 2))}px`,
    "--profile-card-height": `${managerSettings.profileCardHeight}px`,
    "--app-font-family": selectedFont.css,
    "--heading-font-family": selectedHeadingFont?.css || selectedFont.css,
    "--mono-font-family": selectedMonoFont?.css || selectedFont.css,
    "--font-micro": `${Math.max(10, managerSettings.fontSize - 4)}px`,
    "--font-description": `${Math.max(11, managerSettings.fontSize - 2)}px`,
    "--font-body": `${managerSettings.fontSize}px`,
    "--font-control": `${managerSettings.fontSize}px`,
    "--font-title": `${managerSettings.fontSize + 3}px`,
    "--font-xs": `${Math.max(11, managerSettings.fontSize - 2)}px`,
    "--font-base": `${managerSettings.fontSize}px`,
    "--font-brand": `${managerSettings.fontSize + 3}px`,
    "--font-section": `${managerSettings.fontSize + 6}px`,
    "--font-page": `${managerSettings.fontSize + 14}px`,
    "--weight-regular": managerSettings.fontWeight,
    "--weight-description": managerSettings.fontWeight,
    "--weight-body": managerSettings.fontWeight,
    "--weight-medium": Math.max(managerSettings.fontWeight, 500),
    "--weight-control": Math.max(managerSettings.fontWeight, 600),
    "--weight-title": Math.max(managerSettings.fontWeight, 600),
    "--weight-semibold": Math.max(managerSettings.fontWeight, 600),
    "--weight-bold": Math.max(managerSettings.fontWeight, 700),
    "--app-wallpaper-blur": `${Math.max(0, Math.min(24, Number(managerSettings.appBackgroundBlur) || 0))}px`,
    "--app-wallpaper-dim": Math.max(0, Math.min(85, Number(managerSettings.appBackgroundDim) || 0)) / 100
  };
  return (
    <div className={`app-shell ${managerSettings.appBackgroundDataUrl ? "has-wallpaper" : ""}`} style={appStyle}>
      {managerSettings.appBackgroundDataUrl && <>
        <div className="app-wallpaper" aria-hidden="true" style={{ backgroundImage: `url("${managerSettings.appBackgroundDataUrl}")` }} />
        <div className="app-wallpaper-overlay" aria-hidden="true" />
      </>}
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">C</div>
          <div><strong>CodexPro</strong><span>Manager</span></div>
        </div>
        <nav>
          <button type="button" className={activePage === "overview" ? "active" : ""} onClick={() => setActivePage("overview")}><Icon>⌁</Icon>Tổng quan</button>
          <button type="button" className={activePage === "control" ? "active" : ""} onClick={() => setActivePage("control")}><Icon>◫</Icon>Điều phối</button>
          <button type="button" className={activePage === "workflows" ? "active" : ""} onClick={() => setActivePage("workflows")}><Icon>✓</Icon>Quy trình</button>
          <button type="button" className={activePage === "plugins" ? "active" : ""} onClick={() => setActivePage("plugins")}><Icon>◇</Icon>Plugin</button>
          <button type="button" className={activePage === "logs" ? "active" : ""} onClick={() => setActivePage("logs")}><Icon>≡</Icon>Nhật ký</button>
          <button type="button" className={activePage === "settings" ? "active" : ""} onClick={() => setActivePage("settings")}><Icon>⚙</Icon>Cài đặt</button>
        </nav>
        <div className="sidebar-foot">
          <span className="autostart"><Dot ok={status?.autoStart} />{status?.autoStart ? "Tự chạy cùng Windows" : "Autostart sau khi cài"}</span>
          <small>CodexPro Manager {managerPackage.version}</small>
        </div>
      </aside>

      <main className={activePage === "settings" ? "page-settings" : activePage === "logs" ? "page-logs" : activePage === "plugins" ? "page-plugins" : activePage === "workflows" ? "page-workflows" : activePage === "control" ? "page-control" : "page-overview"}>
        <header>
          <div>
            <p className="eyebrow">{activePage === "settings" ? "SETTINGS" : activePage === "logs" ? "DIAGNOSTIC LOGS" : activePage === "plugins" ? "APP PLUGINS" : activePage === "workflows" ? "TASK WORKFLOWS" : activePage === "control" ? "AGENT OPERATIONS" : "WINDOWS CONTROL CENTER"}</p>
            <h1>{activePage === "settings" ? "Cài đặt CodexPro" : activePage === "logs" ? "Nhật ký CodexPro" : activePage === "plugins" ? "Plugin" : activePage === "workflows" ? "Trung tâm quy trình" : activePage === "control" ? "Trung tâm điều phối" : <>CodexPro <TitleGalaxyAccent /> Agent</>}</h1>
            <p className="subtitle">{activePage === "settings" ? "Quản lý kết nối MCP, popup chat, ảnh worker và font chữ theo thành phần." : activePage === "logs" ? "Theo dõi lỗi, cảnh báo và hoạt động MCP trong 24 giờ gần nhất." : activePage === "plugins" ? "Tích hợp giao diện từ repo khác mà không đóng Manager hay gián đoạn worker." : activePage === "workflows" ? "Giao task theo checklist có sẵn và theo dõi từng bước bằng bằng chứng của worker." : activePage === "control" ? "Theo dõi task, hiệu suất, tự phục hồi, phiên bản và an toàn repo trong một màn hình." : "Một chỗ để xem server, profile và kiểm tra repo."}</p>
          </div>
          {activePage === "overview" && (
            <div className="header-server-actions">
              <div className="profile-count" aria-label={`${profileSummary.working} làm việc, ${profileSummary.idle} rảnh, ${profileSummary.hung} mất kết nối, ${profileSummary.missing} chưa cài`}>
                <ProfileSummaryItem state="working" count={profileSummary.working} label="làm việc" />
                <ProfileSummaryItem state="idle" count={profileSummary.idle} label="rảnh" />
                <ProfileSummaryItem state="hung" count={profileSummary.hung} label="mất kết nối" />
                <ProfileSummaryItem state="hung" count={profileSummary.missing} label="chưa cài" missing />
                {profileSummary.reload > 0 && <span className="profile-summary-update">{profileSummary.reload} cần update worker</span>}
                {profileSummary.deferredUpdate > 0 && <span className="profile-summary-update">{profileSummary.deferredUpdate} chờ rảnh để update</span>}
              </div>
              <button
                className={`button ${profileSummary.reload ? "primary" : "secondary"} reload-all`}
                onClick={() => setWorkerUpdateConfirmOpen(true)}
                disabled={Boolean(busy) || profileSummary.reload === 0}
                title={profileSummary.reload
                  ? `Chỉ update ${profileSummary.reload} worker đang rảnh lên ${workerExtensionVersion}${profileSummary.deferredUpdate ? `; ${profileSummary.deferredUpdate} worker đang làm việc sẽ được bỏ qua` : ""}`
                  : profileSummary.deferredUpdate
                    ? `${profileSummary.deferredUpdate} worker cần update nhưng đang làm việc; chờ rảnh rồi update`
                    : `Tất cả profile đã dùng worker ${workerExtensionVersion}`}
              >
                {busy === "reload-profiles" ? "Đang update extension…" : "Update extension"}
              </button>
            </div>
          )}
        </header>

        {error && <div className="alert"><span>!</span>{error}<button onClick={() => setError("")}>×</button></div>}

        <div className="page-view" hidden={activePage !== "overview"}>
        <section id="overview">
          <div className="section-head"><div><p className="eyebrow">LIVE STATUS</p><h2>Trạng thái hệ thống</h2></div><span className="last-check">{status ? `Cập nhật ${new Date(status.checkedAt).toLocaleTimeString("vi-VN")}` : "Đang kiểm tra..."}</span></div>
          <div className="status-grid">
            <StatusCard label="Scheduled Task" ok={status?.task?.state === "Running"} value={status?.task?.state || "..."} detail={status?.task?.lastRunTime ? `Lần chạy: ${new Date(status.task.lastRunTime).toLocaleString("vi-VN")}` : "Windows Task Scheduler"} />
            <StatusCard label="Local MCP" ok={status?.local?.ok} value={status?.local?.ok ? "Online" : "Offline"} detail={status?.local?.ok ? `127.0.0.1:${status.config.port} · ${status.local.latency} ms` : status?.local?.error || "Đang kiểm tra"} />
            <StatusCard label="Public tunnel" ok={status?.tunnel?.ok} value={status?.tunnel?.ok ? "Online" : "Offline"} detail={status?.tunnel?.ok ? `${status.config.hostname} · ${status.tunnel.latency} ms` : status?.tunnel?.error || status?.config?.hostname || "Chưa cấu hình"} />
            <StatusCard label="Processes" ok={status?.processes?.length >= 3} value={`${status?.processes?.length ?? 0} tiến trình`} detail={status?.processes?.length ? status.processes.map((p) => `${p.name} ${p.pid}`).join(" · ") : "Không tìm thấy process"} />
          </div>
        </section>

        <BrowserProfilesSection
          status={status}
          visibleProfiles={visibleBrowserProfiles}
          settings={managerSettings}
          projects={projects}
          taskLabels={profileTaskLabels}
          busy={busy}
          autoMigratingProfileId={autoMigratingProfileId}
          checkingProfiles={checkingProfiles}
          onApiRun={setApiJobWorker}
          onApiStop={async (workerId) => {
            try { await api.stopWorkerTask({ workerId }); await refresh(false); notify("Đã dừng API worker"); }
            catch (workerError) { reportApiWorkerError(workerError); }
          }}
          onOpenTask={setTaskProfileId}
          onOpenChat={openChat}
          onRecoverProfile={(profile) => recoverProfileTab(profile)}
          onOpenProfile={(profile) => openProfile(profile, { focusOnly: true })}
          onSetupProfile={setupProfile}
        />

        <ProjectsSection
          projects={projects}
          visibleProjects={visibleProjects}
          busy={busy}
          page={projectPage}
          pageCount={projectPageCount}
          pageSize={PROJECTS_PER_PAGE}
          onAdd={addProject}
          onInspect={inspect}
          onOpenFolder={(root) => api.openFolder(root)}
          onRemove={async (root) => setProjects(await api.removeProject(root))}
          onPageChange={setProjectPage}
        />
        </div>

        <div className="control-page" hidden={activePage !== "control"}>
          {activePage === "control" ? (
            <React.Suspense fallback={<div className="section-note">Đang tải Control Center…</div>}>
              <ControlCenter
                api={api}
                status={status}
                projects={projects}
                performance={operationsPerformance}
                uiPerformance={uiPerformance}
                diagnosticEntries={operationsLogs}
                settings={managerSettings}
                managerVersion={managerPackage.version}
                workerVersion={workerExtensionVersion}
                profileSummary={profileSummary}
                busy={busy}
                onOpenChat={setChatProfileId}
                onOpenChrome={(profile) => void openProfile(profile, { focusOnly: true })}
                onRecover={(profile, options) => void recoverProfileTab(profile, options)}
                onContinueAfterHang={(incident) => void continueTaskAfterHang(incident)}
                onStop={(task) => void stopControlTask(task)}
                onOpenRepo={(root) => void api.openFolder(root)}
                onToggleSetting={(key, value) => void saveManagerSetting({ [key]: value }, value ? "Đã bật tự động hóa" : "Đã tắt tự động hóa")}
                onUpdateWorkers={() => void reloadProfiles()}
                onRestartServer={() => void control("restart")}
              />
            </React.Suspense>
          ) : null}
        </div>

        <div className="task-workflow-page" hidden={activePage !== "workflows"}>
          <TaskWorkflowCenter
            api={api}
            status={status}
            projects={projects}
            notify={notify}
            onError={(workflowError) => setError(workflowError?.message || String(workflowError))}
            onRefresh={() => void refresh(false)}
          />
        </div>

        <div className="app-plugin-page" hidden={activePage !== "plugins"}>
          <AppPluginCenter
            api={api}
            status={status}
            projects={projects}
            notify={notify}
            onError={(pluginError) => setError(pluginError?.message || String(pluginError))}
            onRefresh={() => void refresh(false)}
          />
        </div>

        <div className="diagnostic-page" hidden={activePage !== "logs"}>
          <DiagnosticLogView
            data={diagnosticLogs}
            filters={diagnosticFilters}
            busy={diagnosticBusy}
            selected={selectedDiagnostic}
            onFilters={(patch) => setDiagnosticFilters((current) => ({ ...current, ...patch }))}
            onRefresh={() => void loadDiagnosticLogs(true)}
            onClear={() => void clearDiagnosticLogHistory()}
            onSelect={setSelectedDiagnostic}
            onCopy={(entry) => {
              void api.copyText(JSON.stringify(entry, null, 2));
              notify("Đã copy chi tiết log");
            }}
          />
        </div>

        <SettingsView
          active={activePage === "settings"}
          api={api}
          status={status}
          busy={busy}
          copyLink={copyLink}
          rotateLink={rotateLink}
          refresh={refresh}
          notify={notify}
          reportApiWorkerError={reportApiWorkerError}
          managerSettings={managerSettings}
          setManagerSettings={setManagerSettings}
          settingsBusy={settingsBusy}
          changeAppBackground={changeAppBackground}
          restoreAppBackground={restoreAppBackground}
          globalRulesDraft={globalRulesDraft}
          setGlobalRulesDraft={setGlobalRulesDraft}
          GLOBAL_RULES_TEMPLATE={GLOBAL_RULES_TEMPLATE}
          saveManagerSetting={saveManagerSetting}
          chatWidthInput={chatWidthInput}
          setChatWidthInput={setChatWidthInput}
          commitChatWidthInput={commitChatWidthInput}
          chatHeightInput={chatHeightInput}
          setChatHeightInput={setChatHeightInput}
          commitChatHeightInput={commitChatHeightInput}
          profileCardHeightInput={profileCardHeightInput}
          setProfileCardHeightInput={setProfileCardHeightInput}
          commitProfileCardHeightInput={commitProfileCardHeightInput}
          FONT_OPTIONS={FONT_OPTIONS}
          FONT_ROLE_OPTIONS={FONT_ROLE_OPTIONS}
          FONT_WEIGHT_LABELS={FONT_WEIGHT_LABELS}
          workerPackDraft={workerPackDraft}
          setWorkerPackDraft={setWorkerPackDraft}
          showWorkerPackCreator={showWorkerPackCreator}
          setShowWorkerPackCreator={setShowWorkerPackCreator}
          workerPackDeleteArmed={workerPackDeleteArmed}
          selectWorkerImagePack={selectWorkerImagePack}
          deleteWorkerImagePack={deleteWorkerImagePack}
          createWorkerImagePack={createWorkerImagePack}
          changeWorkerImage={changeWorkerImage}
          restoreWorkerImage={restoreWorkerImage}
          restoreManagerSettings={restoreManagerSettings}
        />
        <ApiWorkerJobModal
          worker={(status?.workers || []).find((worker) => worker.worker_id === apiJobWorker?.worker_id) || apiJobWorker}
          projects={projects}
          customImages={managerSettings.workerImageDataUrls}
          attachments={requestFiles[apiJobWorker?.worker_id] || []}
          onChooseAttachments={() => void chooseRequestAttachments(apiJobWorker?.worker_id)}
          onOpenAttachmentPreview={(file) => openAttachmentPreview(file)}
          onRemoveAttachment={(filePath) => setRequestFiles((current) => ({ ...current, [apiJobWorker?.worker_id]: (current[apiJobWorker?.worker_id] || []).filter((item) => item.path !== filePath) }))}
          onClearAttachments={() => setRequestFiles((current) => ({ ...current, [apiJobWorker?.worker_id]: [] }))}
          onPaste={(event) => void pasteRequestImage(apiJobWorker?.worker_id, event)}
          onCopyResponse={async (text) => { await api.copyText(text); notify("Đã copy phản hồi"); }}
          onClose={() => setApiJobWorker(null)}
          onError={reportApiWorkerError}
          onStarted={() => { void refresh(false); window.setTimeout(() => void refreshStatus(), 500); notify("API worker đã nhận job"); }}
        />

      </main>

      {renderChatModal()}

      {taskProfileId && (
        <ProfileTaskModal
          profile={(status?.browserProfiles || []).find((profile) => profile.profile_id === taskProfileId)}
          jobs={status?.workerJobs || []}
          resumeBusyTaskId={resumeBusyTaskId}
          onClose={() => setTaskProfileId("")}
          onResume={resumeProfileTask}
        />
      )}

      <AttachmentPreviewModal preview={attachmentPreview} onClose={() => setAttachmentPreview(null)} />

      <WorkerUpdateConfirmModal
        open={workerUpdateConfirmOpen}
        reloadCount={profileSummary.reload}
        deferredUpdateCount={profileSummary.deferredUpdate}
        workerVersion={workerExtensionVersion}
        onClose={() => setWorkerUpdateConfirmOpen(false)}
        onConfirm={() => void reloadProfiles()}
      />

      <InspectionModal inspection={inspection} onClose={() => setInspection(null)} />

      {toast && (
        <div className="toast" role="status" aria-live="polite">
          <span className="toast-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="m7.5 12.4 3 3.1 6.4-7" />
            </svg>
          </span>
          <span className="toast-message">{toast}</span>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);
