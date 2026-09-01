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
assert.match(SYSTEM_MAINTENANCE_WORKFLOW_VERSION, /^system-maintenance-v\d+$/);

for (const request of [
  "Bảo trì hệ thống giúp tôi",
  "Xây quy trình bảo trì đảm bảo độ ổn định của hệ thống",
  "Kiểm tra và đảm bảo độ ổn định của hệ thống",
  "Run the system stability maintenance checklist"
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
assert.match(prompt, /CHECKLIST BẢO TRÌ ỔN ĐỊNH HỆ THỐNG/);
assert.match(prompt, /task_kind=code/);
assert.match(prompt, /thay đổi chưa commit/i);
assert.match(prompt, /Local MCP, public tunnel, worker/i);
assert.match(prompt, /lỗi do người dùng báo/i);
assert.match(prompt, /số lần lặp/i);
assert.match(prompt, /task chưa chốt trạng thái/i);
assert.match(prompt, /30 phút/i);
assert.match(prompt, /test hẹp.*build.*smoke/is);
assert.match(prompt, /commit, push hoặc cài đặt.*người dùng yêu cầu rõ/i);
assert.match(prompt, /\[x\].*\[!\].*\[-\]/s);

const managerMain = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
const agentLoop = fs.readFileSync(new URL("../electron/worker-core/mcp-agent-loop.mjs", import.meta.url), "utf8");
const apiPlugin = fs.readFileSync(new URL("../electron/worker-plugins/api-worker-plugin.mjs", import.meta.url), "utf8");

assert.match(managerMain, /detectSystemMaintenanceWorkflow\(text\)/, "Chrome worker dispatch must auto-detect maintenance requests");
assert.match(managerMain, /buildSystemMaintenanceWorkflowPrompt\(\)/, "Chrome worker dispatch must inject the predefined checklist");
assert.match(managerMain, /workflow_id:[\s\S]*SYSTEM_MAINTENANCE_WORKFLOW_ID/, "Chrome worker result must expose workflow evidence");
assert.match(managerMain, /system-maintenance-workflow-started/, "Chrome worker dispatch must write a traceable workflow-start diagnostic");
assert.match(apiPlugin, /workflow:[\s\S]*payload\.workflow/, "API plugin must forward explicit workflow selection");
assert.match(agentLoop, /resolveSystemMaintenanceWorkflow/, "API worker loop must resolve the maintenance workflow");
assert.match(agentLoop, /buildSystemMaintenanceWorkflowPrompt\(\)/, "API worker loop must inject the predefined checklist");

console.log("system-maintenance-workflow-smoke: ok");
