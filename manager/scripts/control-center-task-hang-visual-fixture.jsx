import React from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { ControlCenter } from "../src/control-center.jsx";

const now = Date.now();
const isoAgo = (seconds) => new Date(now - seconds * 1000).toISOString();
const taskId = "cpt_aaaaaaaaaaaaaaaaaaaaaaaa";
const conversationId = "6a99b06d-8240-83ec-aac1-ba4d74f507a3";

const profile = {
  profile_id: "profile-one",
  label: "Chrome a569b150",
  extension_version: "0.5.113",
  connected: true,
  connector_installed: true,
  connector_profile_bound: true,
  connector_update_required: false,
  last_seen: isoAgo(2),
  activity: "working",
  busy_request_count: 1,
  busy_since: isoAgo(420),
  active_chat_title: "Sửa lỗi repo picker",
  current_workspace_root: "C:\\repo\\codexpro",
  current_workspace_repo: "songvedem260597/codexpro",
  current_task_id: taskId,
  current_task_title: "Sửa lỗi repo picker",
  current_task_conversation_id: conversationId,
  conversation_tabs: [{
    id: 1333517334,
    title: "Sửa lỗi repo picker",
    url: `https://chatgpt.com/c/${conversationId}`,
    active: true,
    busy: true,
    settling: false,
    activity_text: "ChatGPT không tiến triển sau lỗi 429",
    network_state: "failed",
    network_error: "net::ERR_FAILED",
    network_status_code: 429,
    connection_interrupted: false,
    message_delivery_timed_out: false,
    long_task_watchdog_hung: true
  }]
};

const status = {
  browserProfiles: [profile],
  workers: [],
  workerJobs: [{ job_id: taskId, worker_id: profile.profile_id, root: profile.current_workspace_root, title: profile.current_task_title, status: "running", counts_as_task: true, source_change_count: 1, source_changed_paths: ["src/workerPolicy.ts"], started_at: isoAgo(420), updated_at: isoAgo(5) }],
  taskHangSummary: { active_count: 1, total_count: 4, network_count: 2, openai_count: 2, total_duration_ms: 387_000, longest_duration_ms: 221_000 },
  taskHangIncidents: [
    {
      id: "hang-openai-active",
      profile_id: profile.profile_id,
      task_id: taskId,
      task_title: "Sửa lỗi repo picker",
      conversation_id: conversationId,
      tab_id: 1333517334,
      tab_title: "Sửa lỗi repo picker",
      source: "openai",
      status_code: 429,
      message: "ChatGPT HTTP 429 Too Many Requests: /backend-api/conversations/6a99…",
      started_at: isoAgo(94),
      duration_ms: 94_000,
      active: true,
      occurrence: 2,
      recoverable: true
    },
    {
      id: "hang-network-resolved",
      profile_id: profile.profile_id,
      task_id: "cpt_bbbbbbbbbbbbbbbbbbbbbbbb",
      task_title: "Tải transcript streaming",
      conversation_id: "6a9911d8-11f8-83ec-a507-0f9745ae9f22",
      tab_id: 1333517160,
      tab_title: "Sửa lỗi transcript streaming",
      source: "network",
      status_code: 0,
      message: "net::ERR_CONNECTION_RESET trong lúc chờ generation stream.",
      started_at: isoAgo(780),
      ended_at: isoAgo(655),
      duration_ms: 125_000,
      active: false,
      occurrence: 1,
      recoverable: false
    }
  ],
  processes: [],
  local: { ok: true, data: { runtimeBuildId: "fixture" } }
};

const projects = [{ root: profile.current_workspace_root, name: "codexpro", localName: "codexpro", repoFullName: profile.current_workspace_repo, isGit: true, branch: "win", modified: 2, untracked: 0, ahead: 1, behind: 0, conflicted: 0 }];
const api = { getWorkspaceCoordination: async () => ({ root: profile.current_workspace_root, tasks: [], claims: [], integration_queue: [], active_task_count: 1, conflict_count: 0 }) };
const noop = () => undefined;

function Fixture() {
  return <div style={{ width: "100%", minHeight: "100vh", padding: 24, background: "#090d12", boxSizing: "border-box" }}>
    <div style={{ maxWidth: 1480, margin: "0 auto" }}>
      <ControlCenter
        api={api}
        status={status}
        projects={projects}
        performance={{ processes: [], managerPid: 0, totalMemoryBytes: 16 * 1024 ** 3, freeMemoryBytes: 7 * 1024 ** 3 }}
        uiPerformance={{ fps: 60, longTasks: 0, maxLongTaskMs: 0 }}
        diagnosticEntries={[]}
        settings={{ autoRecovery: false, autoUpdateWorkers: true, taskNotifications: true }}
        managerVersion="0.2.134"
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
setTimeout(() => {
  const section = document.querySelector(".control-hang-section");
  const sectionRect = section?.getBoundingClientRect();
  const row = document.querySelector(".control-hang-row.is-active");
  const rowRect = row?.getBoundingClientRect();
  const continueButton = [...document.querySelectorAll(".control-hang-actions button")].find((button) => /Đóng tab \+ tiếp tục task/.test(button.textContent || ""));
  window.__taskHangVisualResult = {
    ok: Boolean(section && row && continueButton),
    text: section?.innerText || "",
    sectionTop: Math.round(sectionRect?.top || 0),
    sectionHeight: Math.round(sectionRect?.height || 0),
    rowWidth: Math.round(rowRect?.width || 0),
    buttonDisabled: Boolean(continueButton?.disabled),
    bodyScrollWidth: document.body.scrollWidth,
    bodyClientWidth: document.body.clientWidth,
    overflowCount: section ? [...section.querySelectorAll("*")].filter((element) => element.scrollWidth > element.clientWidth + 3 && getComputedStyle(element).overflowX !== "auto").length : 0,
    globalOverflowing: [...document.querySelectorAll("body *")].map((element) => ({ tag: element.tagName, className: String(element.className || ""), text: String(element.textContent || "").trim().slice(0, 80), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, rect: Math.round(element.getBoundingClientRect().width) })).filter((item) => item.scrollWidth > item.clientWidth + 3).slice(0, 12)
  };
}, 800);
