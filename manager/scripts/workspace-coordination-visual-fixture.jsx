import React from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import "../src/control-center.css";
import { WorkspaceCoordinationPanel } from "../src/workspace-coordination-panel.jsx";

const rootPath = "C:\\repo\\codexpro";
const now = Date.now();
const isoAgo = (seconds) => new Date(now - seconds * 1000).toISOString();
const snapshot = {
  root: rootPath,
  current_branch: "win",
  current_head: "f0e1d2c3b4a59687",
  active_task_count: 2,
  conflict_count: 1,
  claims: [
    { path: "manager/src/main.jsx", task_id: "cpt_aaaaaaaaaaaaaaaaaaaaaaaa", task_title: "Hoàn thiện giao diện phối hợp", worker_id: "worker-a", claimed_at: isoAgo(130), updated_at: isoAgo(12) },
    { path: "src/server.ts", task_id: "cpt_bbbbbbbbbbbbbbbbbbbbbbbb", task_title: "Sửa routing worker", worker_id: "worker-b", claimed_at: isoAgo(240), updated_at: isoAgo(18) }
  ],
  integration_queue: [
    { task_id: "cpt_aaaaaaaaaaaaaaaaaaaaaaaa", task_title: "Hoàn thiện giao diện phối hợp", branch: "win", enqueued_at: isoAgo(22), position: 1 }
  ],
  integration_lease: { task_id: "cpt_bbbbbbbbbbbbbbbbbbbbbbbb", task_title: "Sửa routing worker", acquired_at: isoAgo(9) },
  tasks: [
    {
      task_id: "cpt_bbbbbbbbbbbbbbbbbbbbbbbb",
      worker_id: "worker-b",
      title: "Sửa routing worker",
      status: "running",
      base_head: "1111222233334444",
      current_head: "f0e1d2c3b4a59687",
      base_branch: "win",
      worktree_root: "C:\\worktrees\\routing-worker",
      worktree_branch: "codexpro/task/bbbbbbbbbbbbbbbbbbbbbbbb",
      integration_status: "integrating",
      integration_branch: "win",
      queue_position: 0,
      base_behind: true,
      stale_base: false,
      stale_paths: [],
      claimed_paths: ["src/server.ts"],
      touched_paths: ["src/server.ts"],
      commit_shas: ["1234567890abcdef"],
      updated_at: isoAgo(7)
    },
    {
      task_id: "cpt_aaaaaaaaaaaaaaaaaaaaaaaa",
      worker_id: "worker-a",
      title: "Hoàn thiện giao diện phối hợp",
      status: "running",
      base_head: "aaaabbbbccccdddd",
      current_head: "f0e1d2c3b4a59687",
      base_branch: "win",
      worktree_root: "C:\\worktrees\\coordination-ui",
      worktree_branch: "codexpro/task/aaaaaaaaaaaaaaaaaaaaaaaa",
      integration_status: "conflict",
      integration_branch: "win",
      queue_position: 1,
      base_behind: true,
      stale_base: true,
      stale_paths: ["manager/src/main.jsx", "manager/src/styles.css"],
      claimed_paths: ["manager/src/main.jsx"],
      touched_paths: ["manager/src/main.jsx", "manager/src/workspace-coordination-panel.jsx"],
      commit_shas: [],
      updated_at: isoAgo(15)
    }
  ]
};

const api = { getWorkspaceCoordination: async () => snapshot };

function Fixture() {
  return <main style={{ width: "100%", minHeight: "100vh", padding: 24, background: "#090d12", boxSizing: "border-box" }}>
    <div className="control-center" style={{ maxWidth: 1320, margin: "0 auto" }}>
      <WorkspaceCoordinationPanel api={api} roots={[rootPath]} projects={[{ root: rootPath, name: "CodexPro" }]} onOpenRepo={() => undefined} />
    </div>
  </main>;
}

createRoot(document.getElementById("root")).render(<Fixture />);
setTimeout(() => {
  const panel = document.querySelector(".coordination-section");
  const panelRect = panel?.getBoundingClientRect();
  const panelRight = panelRect?.right || 0;
  const panelLeft = panelRect?.left || 0;
  window.__coordinationVisualResult = {
    ok: Boolean(panel),
    text: panel?.innerText || "",
    bodyScrollWidth: document.body.scrollWidth,
    bodyClientWidth: document.body.clientWidth,
    panelLeft: Math.round(panelLeft),
    panelRight: Math.round(panelRight),
    panelHeight: panelRect?.height || 0,
    panelScrollWidth: panel?.scrollWidth || 0,
    panelClientWidth: panel?.clientWidth || 0,
    conflictCount: document.querySelectorAll(".coordination-task.is-danger").length,
    queueBadges: document.querySelectorAll(".coordination-badges .is-queue").length,
    overflowing: [...document.querySelectorAll(".coordination-section *")].map((element) => {
      const rect = element.getBoundingClientRect();
      return { tag: element.tagName, className: String(element.className || ""), text: String(element.textContent || "").trim().slice(0, 80), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    }).filter((item) => item.left < panelLeft - 2 || item.right > panelRight + 2 || item.scrollWidth > item.clientWidth + 2).slice(0, 12)
  };
}, 500);
