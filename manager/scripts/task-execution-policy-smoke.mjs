import assert from "node:assert/strict";
import fs from "node:fs";

import { buildAutonomousTaskExecutionPolicy, normalizeTaskSize } from "../electron/task-execution-policy.mjs";

const taskId = "cpt_111111111111111111111111";
const prompt = buildAutonomousTaskExecutionPolicy(taskId).join("\n");
assert.equal(normalizeTaskSize(" LARGE "), "large");
assert.equal(normalizeTaskSize("unknown"), "");
assert.match(prompt, /tự điều tra trước khi sửa/i);
assert.match(prompt, /không hỏi người dùng chỉ vì task phức tạp, mơ hồ/i);
assert.match(prompt, /task lớn\/phức tạp BẮT BUỘC tạo checklist/i);
assert.match(prompt, new RegExp(taskId));
assert.match(prompt, /Chỉ một item được in_progress/i);
assert.match(prompt, /điều chỉnh cùng task/i);
assert.match(prompt, /giữ thứ tự FIFO/i);
assert.match(prompt, /reload\/mất kết nối\/rollover/i);

const managerMain = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
const agentLoop = fs.readFileSync(new URL("../electron/worker-core/mcp-agent-loop.mjs", import.meta.url), "utf8");
assert.match(managerMain, /buildAutonomousTaskExecutionPolicy\(taskId\)/, "Chrome workers must receive the autonomous task policy");
assert.match(managerMain, /task_size[^\n]*small\|medium\|large/, "Chrome task bootstrap must require a size classification");
assert.match(agentLoop, /buildAutonomousTaskExecutionPolicy\(jobId\)/, "API workers must receive the same autonomous task policy");
assert.match(agentLoop, /task_size: requestedTaskSize/, "API task bootstrap must persist its size classification");

console.log("task-execution-policy-smoke: ok");
