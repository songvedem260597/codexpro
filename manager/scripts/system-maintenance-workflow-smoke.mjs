import assert from "node:assert/strict";
import fs from "node:fs";

import {
  SYSTEM_MAINTENANCE_WORKFLOW_ID,
  SYSTEM_MAINTENANCE_WORKFLOW_VERSION,
  buildSystemMaintenanceWorkflowPrompt,
  detectSystemMaintenanceWorkflow,
  systemMaintenanceWorkflow
} from "../electron/system-maintenance-workflow.mjs";

assert.equal(SYSTEM_MAINTENANCE_WORKFLOW_ID, "system_stability_maintenance");
assert.equal(SYSTEM_MAINTENANCE_WORKFLOW_VERSION, "system-maintenance-v2");

for (const request of [
  "Bảo trì hệ thống giúp tôi",
  "Bảo trì ổn định dự án này",
  "Bảo trì project hiện tại",
  "Kiểm tra độ ổn định của repo này",
  "Maintenance cho app hiện tại",
  "Xây quy trình bảo trì đảm bảo độ ổn định của hệ thống",
  "Kiểm tra và đảm bảo độ ổn định của hệ thống",
  "Run the system stability maintenance checklist",
  "Run the project maintenance checklist"
]) {
  assert.equal(detectSystemMaintenanceWorkflow(request), true, `maintenance request was not detected: ${request}`);
}
for (const request of [
  "Sửa nút đăng nhập bị lệch",
  "Giải thích cơ chế tunnel",
  "Cập nhật dependency React"
]) {
  assert.equal(detectSystemMaintenanceWorkflow(request), false, `ordinary request was misclassified: ${request}`);
}

const workflow = systemMaintenanceWorkflow();
assert.equal(workflow.id, SYSTEM_MAINTENANCE_WORKFLOW_ID);
assert.equal(workflow.version, SYSTEM_MAINTENANCE_WORKFLOW_VERSION);
assert.equal(workflow.mode, "ordered_checklist");
assert.deepEqual(workflow.steps.map((step) => step.id), [
  "preflight",
  "health_baseline",
  "incident_review",
  "stability_controls",
  "scoped_remediation",
  "verification",
  "handoff"
]);
assert.equal(new Set(workflow.steps.map((step) => step.id)).size, workflow.steps.length);
assert.ok(workflow.steps.every((step) => step.required && step.title && step.instructions.length), "each maintenance step must be actionable and required");

const prompt = buildSystemMaintenanceWorkflowPrompt();
assert.match(prompt, /CHECKLIST BẢO TRÌ ỔN ĐỊNH DỰ ÁN/);
assert.match(prompt, /task_kind=code/);
assert.match(prompt, /thay đổi chưa commit/i);
assert.match(prompt, /stack|kiến trúc|runtime|service/i);
assert.match(prompt, /chỉ kiểm tra những thành phần.*dự án.*thực sự có/is);
assert.match(prompt, /không giả định.*CodexPro|không mặc định.*MCP/is);
assert.match(prompt, /lỗi do người dùng báo/i);
assert.match(prompt, /số lần lặp/i);
assert.match(prompt, /task chưa chốt trạng thái/i);
assert.match(prompt, /timeout|retry|watchdog|recovery/i);
assert.match(prompt, /nếu dự án có/i);
assert.match(prompt, /test hẹp.*build.*smoke/is);
assert.match(prompt, /commit, push hoặc cài đặt.*người dùng yêu cầu rõ/i);
assert.match(prompt, /\[x\].*\[!\].*\[-\]/s);
assert.doesNotMatch(prompt, /Scheduled Task, Local MCP, public tunnel, worker\/extension/i, "generic project maintenance must not require CodexPro-only infrastructure");
assert.doesNotMatch(prompt, /watchdog task trên 30 phút/i, "generic project maintenance must not require CodexPro's chat watchdog semantics");

const managerMain = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
const agentLoop = fs.readFileSync(new URL("../electron/worker-core/mcp-agent-loop.mjs", import.meta.url), "utf8");
const apiPlugin = fs.readFileSync(new URL("../electron/worker-plugins/api-worker-plugin.mjs", import.meta.url), "utf8");

assert.match(managerMain, /resolveTaskWorkflow\(requestedWorkflow, text\)/, "Chrome worker dispatch must auto-detect registered maintenance requests");
assert.match(managerMain, /buildTaskWorkflowPrompt\(taskWorkflow\.id\)/, "Chrome worker dispatch must inject the registered checklist");
assert.match(managerMain, /workflow_id: taskWorkflow\?\.id/, "Chrome worker result must expose workflow evidence");
assert.match(managerMain, /task-workflow-started/, "Chrome worker dispatch must write a traceable workflow-start diagnostic");
assert.match(apiPlugin, /workflow:[\s\S]*payload\.workflow/, "API plugin must forward explicit workflow selection");
assert.match(agentLoop, /resolveTaskWorkflow/, "API worker loop must resolve the maintenance workflow");
assert.match(agentLoop, /buildTaskWorkflowPrompt\(taskWorkflow\.id\)/, "API worker loop must inject the predefined checklist");

console.log("system-maintenance-workflow-smoke: ok");
