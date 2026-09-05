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
  { job_id: "cpt_000000000000000000000005", worker_id: "profile-a", status: "prepared", progress_percent: 0, fifo_queued_at: "2026-09-04T04:00:00Z" },
  { job_id: "cpt_000000000000000000000006", worker_id: "profile-a", status: "prepared", progress_percent: 0, fifo_queued_at: "2026-09-04T05:00:00Z" },
  { job_id: "cpt_000000000000000000000004", worker_id: "profile-b", status: "failed", progress_percent: 20, updated_at: "2026-09-04T04:00:00Z" }
];
const sorted = profileTaskJobsForWorker(jobs, "profile-a", "cpt_000000000000000000000002");
assert.deepEqual(sorted.map((job) => job.job_id), [
  "cpt_000000000000000000000002",
  "cpt_000000000000000000000003",
  "cpt_000000000000000000000005",
  "cpt_000000000000000000000006",
  "cpt_000000000000000000000001"
], "current task should stay on top, queued tasks must stay FIFO, and jobs must be filtered by worker");
assert.equal(profileTaskCanResume(jobs[1], true), true, "failed task should resume while idle");
assert.equal(profileTaskCanResume(jobs[1], false), false, "failed task should not resume while worker is busy");
assert.equal(profileTaskCanResume(jobs[0], true), false, "completed task must never resume");
assert.equal(profileTaskProgress({ completed_parts: ["a", "b"], remaining_parts: ["c", "d"] }), 50);
assert.equal(profileTaskStatusLabel({ status: "cancelled" }), "Chưa hoàn thành");

const taskButtonIndex = mainSource.indexOf('className="button secondary profile-task-button"');
const normalButtonsIndex = mainSource.indexOf('className="profile-action-buttons"', taskButtonIndex);
assert.ok(taskButtonIndex >= 0 && normalButtonsIndex > taskButtonIndex, "Task button must be above Chat / Mở Chrome buttons");
assert.match(mainSource, /<ProfileTaskModal[\s\S]*resumeBusyTaskId=\{resumeBusyTaskId\}/, "profile task popup must be rendered from App");
assert.match(modalSource, /profileTaskCanResume\(job, workerIdle\)/, "popup must gate resume by worker idle state");
assert.match(modalSource, /useEffect\(\(\) => \{[\s\S]*?event\.key !== "Escape"[\s\S]*?window\.addEventListener\("keydown", handleEscape\)[\s\S]*?window\.removeEventListener\("keydown", handleEscape\)/, "profile task popup must close on Escape regardless of nested focus and clean up its global listener");
assert.match(electronSource, /const WORKER_JOB_HISTORY_LIMIT = 200;[\s\S]*?"worker_job_history"[\s\S]*?limit: WORKER_JOB_HISTORY_LIMIT/, "profile task popup must retain the full worker history window supported by the runtime so completed tasks do not disappear behind other profiles");
assert.match(mainSource, /api\.resumeProfileTask\(\{ profileId: profile\.profile_id, taskId \}\)/, "popup must call the dedicated resume IPC");
assert.match(preloadSource, /resumeProfileTask: \(payload\) => invokeResult\("codexpro:resume-profile-task", payload\)/, "preload must expose resumeProfileTask");
assert.match(electronSource, /WORKER_NOT_IDLE: Chỉ có thể tiếp tục task khi worker đang ở trạng thái ĐANG RẢNH/, "backend must re-check worker idle state");
assert.match(electronSource, /RESUMABLE_BROWSER_TASK_STATUSES = new Set\(\["prepared", "running", "failed", "cancelled", "blocked"\]\)/, "backend must limit resumable task statuses");
assert.match(electronSource, /\["failed", "cancelled", "blocked"\]\.includes\(previousStatus\)[\s\S]*prepare_repo_task/, "terminal tasks must be prepared again with the same Task ID");
assert.match(electronSource, /existingWorkerJobStatus === "prepared"[\s\S]*begin_repo_task đúng Task ID/, "re-prepared task must call begin_repo_task before workspace tools");
assert.match(electronSource, /previousTaskId: taskId[\s\S]*taskMode: "recovery"|taskMode: "recovery"[\s\S]*previousTaskId: taskId/, "resume must reuse the original Task ID via recovery mode");
for (const className of ["profile-task-button", "profile-task-modal", "profile-task-list", "profile-task-resume"]) {
  assert.ok(styles.includes(`.${className}`), `missing ${className} styles`);
}

console.log("profile task popup/resume smoke passed");
