import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/control-center.jsx", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
const renderer = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");

assert.match(source, /<h2>\{title\}<\/h2>/, "control center must render terminal task sections");
assert.match(source, /"Task hoàn thành"/, "control center must label completed tasks");
assert.match(source, /"Task chưa hoàn thành"/, "control center must list interrupted running jobs separately");
assert.match(source, /"Task thất bại"/, "control center must label failed tasks");
assert.match(source, /\["failed", "cancelled", "blocked"\]/, "failed task history must include blocked and cancelled outcomes");
assert.match(source, /WorkerRunningDuration startedAt=\{task\.startedAt\}/, "running tasks must show a live duration clock");
assert.match(source, /function TaskProgressSnapshot[\s\S]*?progress_reports[\s\S]*?completed_parts[\s\S]*?remaining_parts[\s\S]*?derivedProgress/, "task cards must render persisted snapshots and derive progress from legacy progress reports");
assert.match(source, /blocked_part[\s\S]*?latest\?\.blocked_part[\s\S]*?blocked_reason[\s\S]*?latest\?\.reason/, "task cards must expose blockers from both current snapshots and legacy progress reports");
assert.match(source, /last_progress_stage[\s\S]*?\["blocked", "stalled", "error", "verifying"\]/, "legacy worker progress stages must map to structured execution state before runtime restart");
assert.match(source, /completion_confirmed[\s\S]*?Đã xác nhận hoàn tất/, "completed tasks must render an explicit completion confirmation");
assert.match(source, /\["blocked", "stalled", "error", "verifying"\]\.includes\(executionState\)/, "live task state must use structured worker execution state instead of flattening everything to running");
assert.match(source, /prefix=\{job\.status === "completed" \? "Hoàn thành trong" : "Hoạt động trong"\}/, "completed tasks alone must label their frozen duration as completion time");
assert.match(source, /const taskWorkerJobs = useMemo\(\(\) => workerJobs\.filter\(\(job\) => job\?\.counts_as_task === true\), \[workerJobs\]\)/, "Control Center must count only worker jobs with proven source changes as tasks");
assert.match(source, /const completedTasks = taskWorkerJobs\.filter[\s\S]*?const failedTasks = taskWorkerJobs\.filter/, "terminal task history must exclude read-only, build-only, commit-only, and push-only worker jobs");
assert.match(source, /const job = taskWorkerJobs\.find[\s\S]*?if \(!job\) return null/, "a busy browser profile must not become a live Task before source code actually changes");
assert.match(source, /const unfinishedTasks = taskWorkerJobs\.filter[\s\S]*?job\?\.status === "running"[\s\S]*?!liveTaskIds\.has/, "only source-changing non-live running jobs must appear as unfinished coordination tasks");
assert.match(source, /taskWorkerJobs\.filter\(\(job\) => job\?\.status === "running"\)[\s\S]*?coordinationRoots/, "workspace task coordination roots must ignore non-task worker jobs");
assert.match(source, /function normalizeTaskName[\s\S]*?normalize\("NFD"\)[\s\S]*?replace\(\/đ\/g, "d"\)/, "task name search must be case/accent tolerant for Vietnamese titles");
assert.match(source, /placeholder="Tìm task theo tên…"[\s\S]*?aria-label="Tìm task theo tên"/, "Task Center must expose a task-name search input");
assert.match(source, /const visibleTasks = useMemo\(\(\) => tasks\.filter\(\(task\) => taskMatchesName\(task, normalizedTaskSearch\)\)/, "running task cards must filter by task title");
assert.match(source, /const completedTasks = taskWorkerJobs\.filter[\s\S]*?taskMatchesName\(job, normalizedTaskSearch\)[\s\S]*?const failedTasks = taskWorkerJobs\.filter[\s\S]*?taskMatchesName\(job, normalizedTaskSearch\)/, "completed and failed task history must filter by task title");
assert.match(source, /const unfinishedTasks = taskWorkerJobs\.filter[\s\S]*?taskMatchesName\(job, normalizedTaskSearch\)/, "unfinished task history must filter by task title");
assert.ok(source.indexOf("UPDATE CENTER") < source.indexOf("TASK CENTER"), "Update Center must be the first coordination section before Task Center");
assert.match(main, /"worker_job_history"[\s\S]*?statuses: \["prepared", "running", "completed", "failed", "cancelled", "blocked"\]/, "Manager must load queued, unfinished, and terminal task history through MCP");
assert.match(main, /const countedTaskIds = new Set\(workerJobs[\s\S]*?counts_as_task === true/, "runtime status must derive Task identity from proven source changes");
assert.match(main, /taskHangTracker\.reconcile\(taskBrowserProfiles,\s*workerJobs\)/, "task hang tracking must exclude analysis/build-only worker jobs that never changed source while using worker-job progress for stall detection");
assert.match(main, /taskUnfinalizedIncidents\(workerJobs\.filter\(\(job\) => job\?\.counts_as_task === true\)/, "unfinalized-task diagnostics must ignore non-task worker jobs");
assert.match(main, /build\/test-only, commit-only hoặc push-only không được tính là Task/, "Manager dispatch prompt must explain that repository access kind is not the user-visible Task classification");
assert.match(renderer, /const countsAsTask = job\?\.counts_as_task === true[\s\S]*?const previousCountsAsTask = previous\.countsAsTask \|\| previousJob\?\.counts_as_task === true[\s\S]*?previousCountsAsTask[\s\S]*?countsAsTask && !previous\.failed && failed/, "Windows task notifications must fire only for source-changing jobs");

console.log("✓ Control center completed/failed task duration smoke test passed");
