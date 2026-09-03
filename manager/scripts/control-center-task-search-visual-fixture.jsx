import React from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { ControlCenter } from "../src/control-center.jsx";

const now = Date.now();
const isoAgo = (seconds) => new Date(now - seconds * 1000).toISOString();
const liveTaskId = "cpt_aaaaaaaaaaaaaaaaaaaaaaaa";

const profile = {
  profile_id: "profile-search",
  label: "Chrome search",
  extension_version: "0.5.113",
  connected: true,
  connector_installed: true,
  connector_profile_bound: true,
  connector_update_required: false,
  last_seen: isoAgo(1),
  activity: "working",
  busy_request_count: 1,
  busy_since: isoAgo(180),
  active_chat_title: "Sửa lỗi repo picker",
  current_workspace_root: "C:\\repo\\codexpro",
  current_workspace_repo: "songvedem260597/codexpro",
  current_task_id: liveTaskId,
  current_task_title: "Sửa lỗi repo picker",
  conversation_tabs: [{ id: 101, title: "Sửa lỗi repo picker", url: "https://chatgpt.com/c/search-live", active: true, busy: true, settling: false, activity_text: "Đang sửa source", network_state: "generating" }]
};

const status = {
  browserProfiles: [profile],
  workers: [],
  workerJobs: [
    { job_id: liveTaskId, worker_id: profile.profile_id, root: profile.current_workspace_root, title: "Sửa lỗi repo picker", status: "running", counts_as_task: true, source_change_count: 1, started_at: isoAgo(180), updated_at: isoAgo(2) },
    { job_id: "cpt_bbbbbbbbbbbbbbbbbbbbbbbb", worker_id: "profile-old", root: profile.current_workspace_root, title: "Cân padding tin nhắn", status: "completed", counts_as_task: true, source_change_count: 2, started_at: isoAgo(720), finished_at: isoAgo(600), updated_at: isoAgo(600), completion_confirmed: true },
    { job_id: "cpt_cccccccccccccccccccccccc", worker_id: "profile-old", root: profile.current_workspace_root, title: "Fix nhấp nháy khung chat", status: "failed", counts_as_task: true, source_change_count: 1, started_at: isoAgo(900), finished_at: isoAgo(820), updated_at: isoAgo(820), error: "fixture failure" },
    { job_id: "cpt_dddddddddddddddddddddddd", worker_id: "profile-old", root: profile.current_workspace_root, title: "Tải transcript streaming", status: "running", counts_as_task: true, source_change_count: 1, started_at: isoAgo(1300), updated_at: isoAgo(1100) }
  ],
  taskHangSummary: { active_count: 0, total_count: 0, network_count: 0, openai_count: 0, total_duration_ms: 0, longest_duration_ms: 0 },
  taskHangIncidents: [],
  processes: [],
  local: { ok: true, data: { runtimeBuildId: "task-search-fixture" } }
};

const projects = [{ root: profile.current_workspace_root, name: "codexpro", localName: "codexpro", repoFullName: profile.current_workspace_repo, isGit: true, branch: "win", modified: 0, untracked: 0, ahead: 0, behind: 0, conflicted: 0 }];
const api = { getWorkspaceCoordination: async () => ({ root: profile.current_workspace_root, tasks: [], claims: [], integration_queue: [], active_task_count: 1, conflict_count: 0 }) };
const noop = () => undefined;

function Fixture() {
  return <div style={{ width: "100%", minHeight: "100vh", padding: 24, background: "#090d12", boxSizing: "border-box" }}>
    <div style={{ maxWidth: 1480, margin: "0 auto" }}>
      <ControlCenter
        api={api}
        status={status}
        projects={projects}
        performance={{ processes: [], managerPid: 0, totalMemoryBytes: 16 * 1024 ** 3, freeMemoryBytes: 8 * 1024 ** 3 }}
        uiPerformance={{ fps: 60, longTasks: 0, maxLongTaskMs: 0 }}
        diagnosticEntries={[]}
        settings={{ autoRecovery: false, autoUpdateWorkers: true, taskNotifications: true }}
        managerVersion="0.2.136"
        workerVersion="0.5.113"
        profileSummary={{ reload: 0, deferredUpdate: 0 }}
        busy=""
        onOpenChat={noop}
        onOpenChrome={noop}
        onRecover={noop}
        onContinueAfterHang={noop}
        onStop={noop}
        onOpenRepo={noop}
        onToggleSetting={noop}
        onUpdateWorkers={noop}
        onRestartServer={noop}
      />
    </div>
  </div>;
}

createRoot(document.getElementById("root")).render(<Fixture />);
