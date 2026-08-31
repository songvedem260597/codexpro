import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/control-center.jsx", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");

assert.match(source, /<h2>\{title\}<\/h2>/, "control center must render terminal task sections");
assert.match(source, /"Task hoàn thành"/, "control center must label completed tasks");
assert.match(source, /"Task thất bại"/, "control center must label failed tasks");
assert.match(source, /\["failed", "cancelled", "blocked"\]/, "failed task history must include blocked and cancelled outcomes");
assert.match(source, /WorkerRunningDuration startedAt=\{task\.startedAt\}/, "running tasks must show a live duration clock");
assert.match(source, /WorkerRunningDuration startedAt=\{job\.started_at \|\| job\.prepared_at\} finishedAt=\{job\.finished_at \|\| job\.updated_at\}/, "terminal tasks must show their frozen duration");
assert.match(main, /"worker_job_history"[\s\S]*?statuses: \["completed", "failed", "cancelled", "blocked"\]/, "Manager must load terminal task history through MCP");

console.log("✓ Control center completed/failed task duration smoke test passed");
