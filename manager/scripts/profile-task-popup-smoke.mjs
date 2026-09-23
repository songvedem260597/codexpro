import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  profileTaskCanResume,
  profileTaskJobsForWorker,
  profileTaskProgress,
  profileTaskStatusLabel,
  profileWorkerIsIdleForTaskResume
} from "../src/profile-task-popup.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const managerRoot = path.resolve(here, "..");
const mainSource = fs.readFileSync(path.join(managerRoot, "src", "main.jsx"), "utf8");
const profilesSource = fs.readFileSync(path.join(managerRoot, "src", "features", "profiles", "browser-profiles-section.jsx"), "utf8");
const profileActionsSource = fs.readFileSync(path.join(managerRoot, "src", "hooks", "use-profile-actions.js"), "utf8");
const modalSource = fs.readFileSync(path.join(managerRoot, "src", "features", "tasks", "profile-task-modal.jsx"), "utf8");
const electronSource = fs.readFileSync(path.join(managerRoot, "electron", "main.mjs"), "utf8");
const preloadSource = fs.readFileSync(path.join(managerRoot, "electron", "preload.cjs"), "utf8");
const styles = fs.readFileSync(path.join(managerRoot, "src", "styles.css"), "utf8");

const idleProfile = {
  profile_id: "profile-a",
  connected: true,
  activity: "idle",
  conversation_tabs: [{ id: 1, busy: false, settling: false, network_state: "completed" }]
};
assert.equal(profileWorkerIsIdleForTaskResume(idleProfile), true, "idle worker should allow task resume");
assert.equal(profileWorkerIsIdleForTaskResume({ ...idleProfile, activity: "working" }), false, "working worker must block resume");
assert.equal(profileWorkerIsIdleForTaskResume({ ...idleProfile, conversation_tabs: [{ busy: true, network_state: "generating" }] }), false, "busy tab must block resume");

const jobs = [
  { job_id: "cpt_000000000000000000000001", worker_id: "profile-a", status: "completed", progress_percent: 100, updated_at: "2026-09-04T01:00:00Z" },
  { job_id: "cpt_000000000000000000000002", worker_id: "profile-a", status: "failed", progress_percent: 45, updated_at: "2026-09-04T02:00:00Z" },
  { job_id: "cpt_000000000000000000000003", worker_id: "profile-a", status: "running", progress_percent: 70, updated_at: "2026-09-04T03:00:00Z" },
  { job_id: "cpt_000000000000000000000005", worker_id: "profile-a", status: "prepared", title: "Queued task A", progress_percent: 0, fifo_queued_at: "2026-09-04T04:00:00Z" },
  { job_id: "cpt_000000000000000000000006", worker_id: "profile-a", status: "prepared", title: "Queued task B", progress_percent: 0, fifo_queued_at: "2026-09-04T05:00:00Z" },
  { job_id: "cpt_000000000000000000000009", worker_id: "profile-a", status: "prepared", progress_percent: 0, fifo_queued_at: "2026-09-04T05:30:00Z", events: [{ type: "prepared" }] },
  { job_id: "cpt_000000000000000000000004", worker_id: "profile-b", status: "failed", progress_percent: 20, updated_at: "2026-09-04T04:00:00Z" },
  { job_id: "cpt_000000000000000000000007", worker_id: "profile-a", status: "running", completion_confirmed: true, progress_percent: 100, updated_at: "2026-09-04T06:00:00Z" },
  { job_id: "cpt_000000000000000000000008", worker_id: "profile-a", status: "blocked", progress_percent: 55, updated_at: "2026-09-04T07:00:00Z" },
  { job_id: "cpt_000000000000000000000010", worker_id: "profile-a", status: "cancelled", progress_percent: 0, updated_at: "2026-09-04T08:00:00Z" }
];
const sorted = profileTaskJobsForWorker(jobs, "profile-a", "cpt_000000000000000000000002");
assert.deepEqual(sorted.map((job) => job.job_id), [
  "cpt_000000000000000000000002",
  "cpt_000000000000000000000003",
  "cpt_000000000000000000000005",
  "cpt_000000000000000000000006",
  "cpt_000000000000000000000008"
], "popup should keep only real failed/unfinished tasks for the selected worker while queued tasks stay FIFO");
assert.equal(sorted.some((job) => job.status === "completed" || job.completion_confirmed === true), false, "completed tasks must be hidden from the popup");
assert.equal(profileTaskJobsForWorker(jobs, "profile-a", jobs[0].job_id).includes(jobs[0]), false, "current-task priority must not resurrect a completed task");
const placeholderPreparedJob = jobs.find((job) => job.job_id === "cpt_000000000000000000000009");
assert.equal(sorted.includes(placeholderPreparedJob), false, "uninitialized prepared placeholders must be hidden from the popup");
assert.equal(profileTaskCanResume(placeholderPreparedJob, true), false, "uninitialized prepared placeholders must never expose resume");
assert.equal(profileTaskCanResume(jobs[1], true), true, "failed task should resume while idle");
assert.equal(profileTaskCanResume(jobs[1], false), false, "failed task should not resume while worker is busy");
assert.equal(profileTaskCanResume(jobs[0], true), false, "completed task must never resume");
const cancelledJob = jobs.find((job) => job.status === "cancelled");
assert.equal(sorted.includes(cancelledJob), false, "cancelled terminal tasks must not remain in the resumable popup");
assert.equal(profileTaskCanResume(cancelledJob, true), false, "cancelled terminal tasks must never resume");
assert.equal(profileTaskProgress({ completed_parts: ["a", "b"], remaining_parts: ["c", "d"] }), 50);
assert.equal(profileTaskStatusLabel({ status: "cancelled" }), "Đã hủy");

const taskButtonIndex = profilesSource.indexOf('className="button secondary profile-task-button"');
const normalButtonsIndex = profilesSource.indexOf('className="profile-action-buttons"', taskButtonIndex);
assert.ok(taskButtonIndex >= 0 && normalButtonsIndex > taskButtonIndex, "Task button must be above Chat / Mở Chrome buttons");
assert.match(mainSource, /<ProfileTaskModal[\s\S]*resumeBusyTaskId=\{resumeBusyTaskId\}/, "profile task popup must be rendered from App");
assert.match(modalSource, /profileTaskCanResume\(job, workerIdle\)/, "popup must gate resume by worker idle state");
assert.match(modalSource, /useEffect\(\(\) => \{[\s\S]*?event\.key !== "Escape"[\s\S]*?window\.addEventListener\("keydown", handleEscape\)[\s\S]*?window\.removeEventListener\("keydown", handleEscape\)/, "profile task popup must close on Escape regardless of nested focus and clean up its global listener");
assert.match(profilesSource, /profileJobCount = profileTaskJobsForWorker\(status\?\.workerJobs, profile\.profile_id, profile\.current_task_id\)\.length/, "Task badge must count only failed/unfinished jobs shown by the popup");
assert.match(modalSource, /Không có task thất bại hoặc chưa hoàn thành\./, "empty state must describe the filtered task list");
assert.match(electronSource, /const WORKER_JOB_HISTORY_LIMIT = 200;[\s\S]*?"worker_job_history"[\s\S]*?limit: WORKER_JOB_HISTORY_LIMIT/, "profile task popup must retain the full worker history window supported by the runtime so completed tasks do not disappear behind other profiles");
assert.match(profileActionsSource, /api\.resumeProfileTask\(\{ profileId: profile\.profile_id, taskId \}\)/, "popup must call the dedicated resume IPC");
assert.match(preloadSource, /resumeProfileTask: \(payload\) => invokeResult\("codexpro:resume-profile-task", payload\)/, "preload must expose resumeProfileTask");
assert.match(mainSource, /onAbandon=\{abandonProfileTask\}/, "App must wire the explicit task-abandon action into the popup");
assert.match(modalSource, /profile-task-abandon[\s\S]*?onClick=\{\(\) => void onAbandon\(job\)\}/, "popup must expose a dedicated abandon button for unfinished tasks");
assert.match(profileActionsSource, /window\.confirm\([\s\S]*?Source và worktree sẽ không bị xóa/, "abandon must require explicit confirmation and state that source/worktree are retained");
assert.match(profileActionsSource, /api\.abandonProfileTask\(\{ profileId: profile\.profile_id, taskId \}\)/, "popup must call the dedicated abandon IPC with exact profile/task identity");
assert.match(preloadSource, /abandonProfileTask: \(payload\) => invokeResult\("codexpro:abandon-profile-task", payload\)/, "preload must expose abandonProfileTask");
assert.match(electronSource, /WORKER_NOT_IDLE: Chỉ có thể tiếp tục task khi worker đang ở trạng thái ĐANG RẢNH/, "backend must re-check worker idle state for resume");
assert.match(electronSource, /WORKER_NOT_IDLE: Chỉ có thể bỏ task khi worker đang ở trạng thái ĐANG RẢNH/, "backend must re-check worker idle state for abandon");
assert.match(electronSource, /jobWorkerId !== profileId[\s\S]*?Task này không thuộc worker đang chọn/, "abandon must reject a task owned by another profile");
assert.match(electronSource, /"finalize_worker_job"[\s\S]*?task_id: taskId[\s\S]*?outcome: "cancelled"/, "abandon must use the sanctioned cancelled terminal transition");
assert.match(electronSource, /RESUMABLE_BROWSER_TASK_STATUSES = new Set\(\["prepared", "running", "failed", "blocked"\]\)/, "backend must not treat terminal cancellation as resumable");
assert.match(electronSource, /previousStatus === "failed" && codeTask[\s\S]*?"recover_repo_task"[\s\S]*?profile_id: profileId[\s\S]*?task_id: taskId/, "failed code tasks must use official Manager terminal recovery with the same Task ID and owner");
assert.match(electronSource, /preparedFailedLifecycle = previousStatus === "prepared" && codeTask && lastFailedFinalization > lastTerminalRecovery/, "Manager must recover the failed authoritative lifecycle even when an earlier all_allowed re-prepare already left WorkerJob prepared and unbound");
assert.match(electronSource, /\(previousStatus === "failed" && codeTask\) \|\| preparedFailedLifecycle/, "both terminal and prepared split-state failures must use the same official recovery primitive");
assert.match(electronSource, /recovered\?\.recovered !== true[\s\S]*?String\(recovered\?\.task_id \|\| ""\) !== taskId[\s\S]*?String\(recovered\?\.profile_id \|\| ""\) !== profileId/, "Manager must reject incomplete or identity-mismatched recovery results");
assert.match(electronSource, /projectRoot: recoveryRoot/, "terminal all_allowed recovery must dispatch the authoritative existing worktree root");
assert.match(electronSource, /recoveryAccepted && initialWorkspaceRoot[\s\S]*?Không chọn repo\/root khác, không tạo task ID mới, không tạo worktree mới/, "recovery prompt must bind begin_repo_task to the authoritative worktree and forbid replacement state");
assert.match(electronSource, /existingWorkerJobStatus === "prepared"[\s\S]*begin_repo_task đúng Task ID/, "re-prepared task must call begin_repo_task before workspace tools");
assert.match(electronSource, /previousTaskId: taskId[\s\S]*taskMode: "recovery"|taskMode: "recovery"[\s\S]*previousTaskId: taskId/, "resume must reuse the original Task ID via recovery mode");
for (const className of ["profile-task-button", "profile-task-modal", "profile-task-list", "profile-task-actions", "profile-task-abandon", "profile-task-resume"]) {
  assert.ok(styles.includes(`.${className}`), `missing ${className} styles`);
}

console.log("profile task popup/resume smoke passed");
