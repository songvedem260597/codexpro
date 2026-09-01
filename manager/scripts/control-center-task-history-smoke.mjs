import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/control-center.jsx", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");

assert.match(source, /<h2>\{title\}<\/h2>/, "control center must render terminal task sections");
assert.match(source, /"Task hoàn thành"/, "control center must label completed tasks");
assert.match(source, /"Task chưa hoàn thành"/, "control center must list interrupted running jobs separately");
assert.match(source, /"Task thất bại"/, "control center must label failed tasks");
assert.match(source, /\["failed", "cancelled", "blocked"\]/, "failed task history must include blocked and cancelled outcomes");
assert.match(source, /WorkerRunningDuration startedAt=\{task\.startedAt\}/, "running tasks must show a live duration clock");
assert.match(source, /prefix=\{job\.status === "completed" \? "Hoàn thành trong" : "Hoạt động trong"\}/, "completed tasks alone must label their frozen duration as completion time");
assert.match(source, /const unfinishedTasks = workerJobs\.filter[\s\S]*?job\?\.status === "running"[\s\S]*?!liveTaskIds\.has/, "only non-live running jobs must appear as unfinished coordination tasks");
assert.ok(source.indexOf("UPDATE CENTER") < source.indexOf("TASK CENTER"), "Update Center must be the first coordination section before Task Center");
assert.match(main, /"worker_job_history"[\s\S]*?statuses: \["running", "completed", "failed", "cancelled", "blocked"\]/, "Manager must load unfinished and terminal task history through MCP");

console.log("✓ Control center completed/failed task duration smoke test passed");
