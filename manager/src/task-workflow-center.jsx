import React, { useEffect, useMemo, useState } from "react";
import { listTaskWorkflows } from "../electron/task-workflow-registry.mjs";
import { AppDropdown } from "./app-dropdown.jsx";
import { ALL_ALLOWED_WORKSPACES, ProjectDropdown } from "./project-dropdown.jsx";
import { deriveTaskWorkflowProgress } from "./task-workflow-progress.js";
import "./task-workflow-center.css";
const POLL_MS = 2500;

function taskId() {
  const bytes = new Uint8Array(12);
  window.crypto.getRandomValues(bytes);
  return `cpt_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function unwrap(value) {
  return value?.ok === true && value?.value ? value.value : value;
}

function responseEvidence(value) {
  const result = unwrap(value) || {};
  const messages = Array.isArray(result.messages) ? result.messages : [];
  const assistantText = messages.filter((message) => message?.role === "assistant").map((message) => String(message?.text || message?.content || "")).join("\n");
  return [result.workflow_evidence, result.stream_text, result.network_stream_text, result.response_text, result.text, result.result?.text, assistantText]
    .map((item) => String(item || "").trim())
    .sort((left, right) => right.length - left.length)[0] || "";
}

function workerOptions(status) {
  const apiWorkers = (status?.workers || [])
    .filter((worker) => worker.worker_type === "api")
    .map((worker) => ({
      key: `api|${worker.worker_id}`,
      type: "api",
      id: worker.worker_id,
      label: `${worker.label || worker.worker_id} · API`,
      ready: Boolean(worker.connected) && worker.activity !== "working",
      reason: !worker.connected ? "thiếu kết nối" : worker.activity === "working" ? "đang làm việc" : "sẵn sàng"
    }));
  const chromeWorkers = (status?.browserProfiles || [])
    .map((profile) => ({
      key: `chrome|${profile.profile_id}`,
      type: "chrome",
      id: profile.profile_id,
      label: `${profile.email || profile.label || profile.profile_id} · Chrome`,
      ready: Boolean(profile.connected && profile.connector_installed && profile.connector_profile_bound !== false && profile.activity !== "working" && profile.activity !== "settling"),
      reason: !profile.connected ? "mất kết nối" : !profile.connector_installed ? "chưa có CodexPro" : profile.activity === "working" || profile.activity === "settling" ? "đang làm việc" : "sẵn sàng"
    }));
  return [...apiWorkers, ...chromeWorkers];
}

async function readChromeProgress(api, run) {
  const network = unwrap(await api.getProfileResponse({
    profileId: run.workerId,
    conversationId: run.conversationId,
    taskId: run.taskId,
    readDom: false,
    priority: "background"
  })) || {};
  const networkState = String(network.network_state || network.generation_state || "").toLowerCase();
  const completed = network.response_ready === true || networkState === "completed";
  if (!completed) return { value: network, status: networkState === "failed" ? "failed" : "running" };
  const canonical = unwrap(await api.getProfileResponse({
    profileId: run.workerId,
    conversationId: run.conversationId,
    taskId: run.taskId,
    canonicalOnly: true,
    priority: "background"
  }).catch(() => network)) || network;
  const proof = unwrap(await api.getRepoTaskStatus({ taskId: run.taskId }).catch(() => null));
  if (!proof?.verified) return { value: canonical, status: "failed", error: "Worker chưa xác minh begin_repo_task cho checklist này." };
  return { value: canonical, status: "completed" };
}

export function TaskWorkflowCenter({ api, status, projects, notify, onError, onRefresh }) {
  const workflows = useMemo(() => listTaskWorkflows(), []);
  const workers = useMemo(() => workerOptions(status), [status]);
  const [workflowId, setWorkflowId] = useState(workflows[0]?.id || "");
  const [workerKey, setWorkerKey] = useState("");
  const [workspaceRoot, setWorkspaceRoot] = useState(projects[0]?.root || ALL_ALLOWED_WORKSPACES);
  const [details, setDetails] = useState("");
  const [launching, setLaunching] = useState(false);
  const [run, setRun] = useState(null);

  useEffect(() => {
    if (!workers.some((worker) => worker.key === workerKey && worker.ready)) {
      setWorkerKey(workers.find((worker) => worker.ready)?.key || "");
    }
  }, [workerKey, workers]);
  useEffect(() => {
    if (workspaceRoot !== ALL_ALLOWED_WORKSPACES && !projects.some((project) => project.root === workspaceRoot)) {
      setWorkspaceRoot(projects[0]?.root || ALL_ALLOWED_WORKSPACES);
    }
  }, [projects, workspaceRoot]);

  const selectedWorkflow = workflows.find((workflow) => workflow.id === workflowId) || workflows[0];
  const selectedWorker = workers.find((worker) => worker.key === workerKey);
  const activeWorkflow = workflows.find((workflow) => workflow.id === run?.workflowId) || selectedWorkflow;
  const progress = deriveTaskWorkflowProgress(activeWorkflow, run?.evidence || "", { running: run?.status === "running" });
  const finishedCount = progress.completed + progress.issues + progress.skipped;
  const percent = progress.total ? Math.round((finishedCount / progress.total) * 100) : 0;

  useEffect(() => {
    if (!run || run.status !== "running") return undefined;
    let cancelled = false;
    let timer;
    const poll = async () => {
      try {
        let next;
        if (run.workerType === "api") {
          const value = unwrap(await api.readWorkerResponse({ workerId: run.workerId })) || {};
          const activity = String(value.activity || "").toLowerCase();
          const statusValue = activity === "failed" ? "failed" : activity === "working" ? "running" : value.finished_at ? "completed" : "running";
          next = { value, status: statusValue };
        } else {
          next = await readChromeProgress(api, run);
        }
        if (cancelled) return;
        const nextEvidence = responseEvidence(next.value);
        const error = String(next.error || next.value?.error || next.value?.last_error || next.value?.network_error || "");
        setRun((current) => current?.taskId === run.taskId ? { ...current, evidence: nextEvidence || current.evidence, status: next.status, error, updatedAt: new Date().toISOString() } : current);
        if (next.status === "completed") {
          notify?.("Checklist đã hoàn thành");
          onRefresh?.();
          return;
        }
        if (next.status === "failed") {
          onError?.(new Error(error || "Worker không hoàn thành được checklist."));
          onRefresh?.();
          return;
        }
      } catch (error) {
        if (!cancelled) setRun((current) => current?.taskId === run.taskId ? { ...current, error: error?.message || String(error), updatedAt: new Date().toISOString() } : current);
      }
      if (!cancelled) timer = window.setTimeout(poll, POLL_MS);
    };
    timer = window.setTimeout(poll, 700);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [api, notify, onError, onRefresh, run?.status, run?.taskId, run?.workerId, run?.workerType, run?.conversationId]);

  const launch = async () => {
    if (!selectedWorkflow || !selectedWorker?.ready || !workspaceRoot || launching) return;
    setLaunching(true);
    const allAllowed = workspaceRoot === ALL_ALLOWED_WORKSPACES;
    const request = details.trim() || `Thực hiện quy trình ${selectedWorkflow.label} theo checklist chuẩn và báo bằng chứng cho từng bước.`;
    const nextTaskId = taskId();
    try {
      let result;
      if (selectedWorker.type === "api") {
        result = unwrap(await api.sendWorkerRequest({
          workerId: selectedWorker.id,
          task_id: nextTaskId,
          task_kind: "code",
          scope: allAllowed ? "all_allowed" : "workspace",
          root: allAllowed ? "" : workspaceRoot,
          workspaceCandidates: allAllowed ? projects.map((project) => project.root) : [],
          text: request,
          workflow: selectedWorkflow.id
        })) || {};
      } else {
        result = unwrap(await api.sendProfileRequest({
          profileId: selectedWorker.id,
          conversationId: "",
          newChat: true,
          scope: allAllowed ? "all_allowed" : "workspace",
          projectRoot: allAllowed ? "" : workspaceRoot,
          workspaceCandidates: allAllowed ? projects.map((project) => project.root) : [],
          text: request,
          attachments: [],
          workflow: selectedWorkflow.id
        })) || {};
      }
      const acceptedTaskId = String(result.job_id || result.repo_task_id || nextTaskId);
      const conversationId = String(result.conversation_id || "");
      if (selectedWorker.type === "chrome" && !conversationId) throw new Error("Chrome worker chưa trả conversation id cho task checklist.");
      setRun({
        workflowId: selectedWorkflow.id,
        workflowVersion: selectedWorkflow.version,
        workerType: selectedWorker.type,
        workerId: selectedWorker.id,
        workerLabel: selectedWorker.label,
        workspaceRoot,
        taskId: acceptedTaskId,
        conversationId,
        status: "running",
        evidence: "",
        error: "",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      setDetails("");
      notify?.("Đã giao checklist cho worker");
      onRefresh?.();
    } catch (error) {
      onError?.(error);
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div className="task-workflow-center">
      <section className="task-workflow-launcher">
        <div className="section-head">
          <div><p className="eyebrow">REUSABLE TASK WORKFLOWS</p><h2>Giao việc theo checklist</h2><p className="section-note">Chọn quy trình, worker và workspace. Mỗi template mới thêm vào registry sẽ tự xuất hiện tại đây.</p></div>
        </div>
        <div className="task-workflow-launcher-grid">
          <label className="task-workflow-field">
            <span>Chọn quy trình</span>
            <AppDropdown
              value={workflowId}
              options={workflows.map((workflow) => ({ value: workflow.id, label: workflow.label }))}
              onChange={setWorkflowId}
              disabled={launching || run?.status === "running"}
              ariaLabel="Chọn quy trình"
              searchable={workflows.length > 6}
            />
          </label>
          <label className="task-workflow-field">
            <span>Chọn worker</span>
            <AppDropdown
              value={workerKey}
              options={[{ value: "", label: "Chưa có worker rảnh", disabled: true }, ...workers.map((worker) => ({ value: worker.key, label: worker.label, hint: worker.reason, disabled: !worker.ready }))]}
              onChange={setWorkerKey}
              disabled={launching || run?.status === "running"}
              ariaLabel="Chọn worker"
              searchable={workers.length > 6}
            />
          </label>
          <label className="task-workflow-field">
            <span>Chọn workspace</span>
            <ProjectDropdown
              value={workspaceRoot}
              projects={projects}
              onChange={setWorkspaceRoot}
              disabled={launching || run?.status === "running"}
              ariaLabel="Chọn workspace"
            />
          </label>
          <label className="task-workflow-field is-wide"><span>Phạm vi hoặc lưu ý thêm · không bắt buộc</span><textarea value={details} onChange={(event) => setDetails(event.target.value)} disabled={launching || run?.status === "running"} placeholder="Ví dụ: ưu tiên kiểm tra tunnel và các task chưa chốt trong 24 giờ gần nhất." /></label>
        </div>
        <div className="task-workflow-launch-actions"><small>{selectedWorkflow?.steps.length || 0} bước · {selectedWorkflow?.version}</small><button type="button" className="button primary" onClick={() => void launch()} disabled={!selectedWorker?.ready || !workspaceRoot || launching || run?.status === "running"}>{launching ? "Đang giao…" : run?.status === "running" ? "Checklist đang chạy" : "Giao checklist"}</button></div>
      </section>

      <section className="task-workflow-progress-card" aria-live="polite">
        <div className="task-workflow-progress-head"><div><strong>{activeWorkflow?.label}</strong><span>{run ? `${run.workerLabel} · ${run.status === "running" ? "đang thực hiện" : run.status === "completed" ? "đã hoàn thành" : "gặp lỗi"}` : "Xem trước checklist; giao việc để bắt đầu tự cập nhật."}</span></div><b>{finishedCount}/{progress.total}</b></div>
        <div className="task-workflow-progress-meter" aria-label={`${percent}% checklist đã chốt`}><i style={{ width: `${percent}%` }} /></div>
        <ol className="task-workflow-checklist">
          {progress.steps.map((step, index) => <li className={`task-workflow-checklist-step is-${step.status}`} key={step.id}><span className="task-workflow-check">{step.status === "completed" ? "✓" : step.status === "issue" ? "!" : step.status === "skipped" ? "–" : step.status === "running" ? "●" : index + 1}</span><div><strong>{step.title}</strong><small>{step.evidence || (step.status === "running" ? "Worker đang thực hiện bước này…" : step.instructions[0])}</small></div></li>)}
        </ol>
        {run?.error && <div className="task-workflow-run-error">{run.error}</div>}
      </section>
    </div>
  );
}
