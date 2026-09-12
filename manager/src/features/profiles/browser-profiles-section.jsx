import React from "react";
import { ApiWorkerCards } from "../api-workers/api-worker-cards.jsx";
import { ChatGalaxyButtonContent, Dot, WorkerIcon, WorkingBadge } from "../../components/worker-ui.jsx";
import { WorkerRunningDuration } from "../../worker-running-duration.jsx";
import { profileCardBorderState, profileChromeActionState, profileTabFailureState, profileTaskSummaryState } from "../../profile-card-state.js";
import { extensionReady, WORKER_EXTENSION_VERSION } from "./profile-runtime-utils.js";
import { profileRequestChats } from "../chat/chat-conversation-utils.js";
import { profileTaskJobsForWorker } from "../../profile-task-popup.js";

function profileSortRank(profile) {
  if (!profile.connected) return 3;
  const tabs = Array.isArray(profile.conversation_tabs) ? profile.conversation_tabs : [];
  const activeTab = tabs.find((tab) => tab.active) || tabs[0];
  if (activeTab?.settling === true || profile.activity === "settling") return 1;
  if (activeTab?.busy === false || (!activeTab && profile.activity === "idle")) return 0;
  if (activeTab?.busy === true || profile.activity === "working") return 1;
  return 2;
}

function BrowserProfileCard({
  profile,
  status,
  settings,
  projects,
  taskLabels,
  busy,
  autoMigratingProfileId,
  checkingProfiles,
  onOpenTask,
  onOpenChat,
  onRecoverProfile,
  onOpenProfile,
  onSetupProfile
}) {
  const workerExtensionVersion = status?.workerExtensionVersion || WORKER_EXTENSION_VERSION;
  const ready = extensionReady(profile.extension_version, workerExtensionVersion);
  const profileBusy = busy === `profile:${profile.profile_id}` || autoMigratingProfileId === profile.profile_id;
  const profileChecking = checkingProfiles.includes(profile.profile_id);
  const hung = !profile.connected;
  const settling = profile.connected && profile.activity === "settling";
  const working = profile.connected && profile.activity === "working";
  const profileTabs = Array.isArray(profile.conversation_tabs) ? profile.conversation_tabs : [];
  const liveTab = profileTabs.find((tab) => tab.active) || profileTabs.find((tab) => tab.busy || tab.settling) || profileTabs[0];
  const tabFailureState = profileTabFailureState({ connected: profile.connected, working, settling, tab: liveTab });
  const rendererUnresponsive = tabFailureState.rendererUnresponsive;
  const liveActivityText = working || settling ? String(liveTab?.activity_text || "").trim() : "";
  const connectorInstalled = Boolean(profile.connector_installed && profile.connector_profile_bound !== false);
  const connectorUpdateRequired = Boolean(profile.connector_update_required);
  const connectorMessage = connectorInstalled ? "CodexPro READY" : profile.connector_message;
  const idle = profile.connected && profile.activity === "idle" && (connectorInstalled || !ready);
  const noChatGpt = profile.connected && profile.activity === "no_chatgpt";
  const noBrowserTabs = noChatGpt && Number(profile.tab_count || 0) === 0;
  const chatGptTabCount = Math.max(0, Number(profile.chatgpt_tab_count) || 0);
  const workerState = hung ? "hung" : working || settling ? "working" : "idle";
  const taskRecoveryState = String(profile.task_recovery_state || "").trim();
  const taskRecoveryMessage = String(profile.task_recovery_message || "").trim();
  const profileBorderState = profileCardBorderState({
    connected: profile.connected,
    working,
    settling,
    rendererUnresponsive,
    networkState: String(liveTab?.network_state || ""),
    rendererError: String(liveTab?.renderer_error || ""),
    connectionInterrupted: Boolean(liveTab?.connection_interrupted)
  });
  const chromeAction = profileChromeActionState({ profile, busy, rendererUnresponsive: tabFailureState.recoveryRequired });
  const workspaceRoot = String(profile.current_workspace_root || "").trim();
  const profileProject = workspaceRoot ? projects.find((project) => String(project.root || "").toLowerCase() === workspaceRoot.toLowerCase()) : null;
  const profileRepoLabel = String(profile.current_workspace_repo || profileProject?.githubRepo || profileProject?.name || "").trim();
  const profileTaskSummary = profileTaskSummaryState({ profile, cachedTitle: taskLabels[profile.profile_id], working, settling });
  const profileTaskLabel = profileTaskSummary.title;
  const profileJobCount = profileTaskJobsForWorker(status?.workerJobs, profile.profile_id, profile.current_task_id).length;
  const profileRepository = profileRepoLabel ? {
    label: profileRepoLabel,
    title: profileProject?.remoteUrl || workspaceRoot || profileRepoLabel
  } : null;

  return (
    <article className={`browser-profile ${profile.connected ? "is-online" : "is-offline"} is-${profileBorderState}`} data-profile-id={profile.profile_id}>
      <span className="worker-active-border" aria-hidden="true" />
      <WorkerIcon state={workerState} customImages={settings.workerImageDataUrls} />
      <div className="profile-main">
        <div className="profile-title">
          <strong>{profile.email || profile.label}</strong>
          {profile.active && <span className="badge">ACTIVE</span>}
          {hung && <span className="badge profile-hung">MẤT KẾT NỐI</span>}
          {settling && <span className="badge profile-settling">ĐANG HOÀN TẤT</span>}
          {working && <WorkingBadge />}
          {idle && <span className="badge connected">ĐANG RẢNH</span>}
          {noBrowserTabs && <span className="badge profile-missing">CHROME CHẠY NỀN</span>}
          {noChatGpt && !noBrowserTabs && <span className="badge profile-missing">CHƯA MỞ CHATGPT</span>}
          {connectorUpdateRequired && <span className="badge profile-missing">CẦN CẬP NHẬT CONNECTOR</span>}
          {!connectorInstalled && !connectorUpdateRequired && !profileChecking && !idle && !working && !settling && !noChatGpt && <span className="badge profile-missing">CHƯA CÓ CODEXPRO</span>}
          {profile.connected && profileRepository?.label && <span className="active-repo-chip" title={profileRepository.title}>{profileRepository.label}</span>}
        </div>
        {(working || settling) && <WorkerRunningDuration startedAt={profile.busy_since || liveTab?.network_last_started_at} />}
        <div className="profile-meta">
          <span><Dot ok={profile.connected} />{profile.connected ? "Extension online" : "Mất heartbeat extension"}</span>
          <span>v{profile.extension_version || "cũ"}</span>
          <span>{chatGptTabCount} tab</span>
          {connectorMessage && <span className={connectorInstalled ? "ready-text" : "profile-warning"}>{connectorMessage}</span>}
        </div>
        {profileTaskLabel && (
          <div className="profile-task-summary" title={profileTaskLabel}>
            <span>{profileTaskSummary.label}</span>
            <strong>{profileTaskLabel}</strong>
          </div>
        )}
        {taskRecoveryMessage && (
          <div className={`profile-task-recovery is-${taskRecoveryState || "info"}`} role="status" aria-live="polite">
            {taskRecoveryMessage}
          </div>
        )}
        {(working || settling) && <div className="profile-live-activity" role="status" aria-live="polite"><span className="profile-live-activity-text">{liveActivityText || (settling ? "ChatGPT đang hoàn tất tác vụ" : "ChatGPT đang xử lý")}</span><span className="typing-dots" aria-hidden="true"><i /><i /><i /></span></div>}
      </div>
      <div className="profile-actions">
        <button className="button secondary profile-task-button" type="button" onClick={() => onOpenTask(profile.profile_id)} title="Xem task của worker này"><span>Task</span>{profileJobCount > 0 && <b>{profileJobCount}</b>}</button>
        {profile.connected && !ready && <span className="update-needed" role="status">Có extension {workerExtensionVersion} mới</span>}
        {profileChecking && <span className="checking-profile">Đang kiểm tra ChatGPT…</span>}
        <div className="profile-action-buttons">
          <button
            className="button primary profile-chat chat-galaxy-button"
            onClick={() => onOpenChat(profile)}
            disabled={!profile.connected || !connectorInstalled}
            title={profileRequestChats(profile).length ? "Mở khung chat của profile" : "Nhập task; CodexPro sẽ tự mở tab ChatGPT khi gửi"}
          >
            <ChatGalaxyButtonContent />
          </button>
          <button
            className="button secondary open-profile"
            onClick={() => rendererUnresponsive ? onRecoverProfile(profile) : onOpenProfile(profile)}
            disabled={chromeAction.disabled}
            title={chromeAction.title}
          >
            {busy === `recover-profile:${profile.profile_id}` ? "Đang khôi phục…" : busy === `open-profile:${profile.profile_id}` ? "Đang chuyển…" : chromeAction.label}
          </button>
        </div>
        {connectorInstalled ? (
          <span className={`already-connected ${connectorUpdateRequired ? "is-update-required" : working || settling ? "is-working" : idle ? "is-idle" : "is-default"}`}>✓ Đã thêm CodexPro</span>
        ) : (
          <button
            className="button primary profile-setup"
            onClick={() => onSetupProfile(profile)}
            disabled={Boolean(busy) || Boolean(autoMigratingProfileId) || profileChecking || !profile.connected || !ready}
          >
            {profileBusy ? (connectorUpdateRequired ? "Đang cập nhật + test…" : "Đang thêm + test…") : (connectorUpdateRequired ? "Cập nhật CodexPro" : "Thêm CodexPro")}
          </button>
        )}
      </div>
    </article>
  );
}

export function BrowserProfilesSection({
  status,
  visibleProfiles,
  settings,
  projects,
  taskLabels,
  busy,
  autoMigratingProfileId,
  checkingProfiles,
  onApiRun,
  onApiStop,
  onOpenTask,
  onOpenChat,
  onRecoverProfile,
  onOpenProfile,
  onSetupProfile
}) {
  const apiWorkers = (status?.workers || []).filter((worker) => worker.worker_type === "api");
  const sortedProfiles = [...visibleProfiles].sort((left, right) => profileSortRank(left) - profileSortRank(right) || String(left.profile_id || "").localeCompare(String(right.profile_id || "")));

  return (
    <section id="profiles">
      <div className="section-head">
        <div><p className="eyebrow">CONNECTED WORKERS</p><h2>Worker đã kết nối</h2><p className="section-note">Hãy kết nối API worker và Chrome profile của bạn</p></div>
      </div>
      {status?.workerSnapshotStale && (
        <div className="worker-snapshot-warning" role="status">
          {status.workerSnapshotStaleReason === "empty-grace" ? "Đang xác minh kết nối worker; tạm giữ trạng thái gần nhất." : "MCP tạm thời không phản hồi, worker sẽ tự cập nhật khi kết nối phục hồi."}
        </div>
      )}
      <div className={`profile-list is-${settings.profileLayout === "cards" ? "card" : "row"}-layout working-border-${settings.workingBorderStyle}`}>
        {!apiWorkers.length && !visibleProfiles.length && <div className="empty">Chưa có worker nào kết nối. Hãy lưu API worker hoặc Load unpacked extension CodexPro trong Chrome profile cần dùng.</div>}
        <ApiWorkerCards workers={apiWorkers} customImages={settings.workerImageDataUrls} onRun={onApiRun} onStop={onApiStop} />
        {sortedProfiles.map((profile) => (
          <BrowserProfileCard
            key={profile.profile_id}
            profile={profile}
            status={status}
            settings={settings}
            projects={projects}
            taskLabels={taskLabels}
            busy={busy}
            autoMigratingProfileId={autoMigratingProfileId}
            checkingProfiles={checkingProfiles}
            onOpenTask={onOpenTask}
            onOpenChat={onOpenChat}
            onRecoverProfile={onRecoverProfile}
            onOpenProfile={onOpenProfile}
            onSetupProfile={onSetupProfile}
          />
        ))}
      </div>
    </section>
  );
}
