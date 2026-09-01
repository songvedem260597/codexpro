import assert from "node:assert/strict";

import {
  PROJECT_PERFORMANCE_WORKFLOW_ID,
  PROJECT_PERFORMANCE_WORKFLOW_VERSION,
  detectProjectPerformanceWorkflow,
  projectPerformanceWorkflow
} from "../electron/project-performance-workflow.mjs";
import {
  buildTaskWorkflowPrompt,
  getTaskWorkflow,
  listTaskWorkflows,
  resolveTaskWorkflow
} from "../electron/task-workflow-registry.mjs";

assert.equal(PROJECT_PERFORMANCE_WORKFLOW_ID, "project_performance_optimization");
assert.equal(PROJECT_PERFORMANCE_WORKFLOW_VERSION, "project-performance-v2");

for (const request of [
  "Tối ưu tốc độ dự án này",
  "Tối ưu hiệu suất project hiện tại",
  "Tối ưu hiệu xuất project hiện tại",
  "Làm UI mượt và phản hồi nhanh",
  "Tối ưu backend API phản hồi nhanh",
  "Tối ưu truy vấn nhanh hơn",
  "Kiểm tra bottleneck và tăng performance app",
  "Giảm CPU RAM và tăng tốc repo này",
  "Optimize project performance",
  "Speed up this application"
]) {
  assert.equal(detectProjectPerformanceWorkflow(request), true, `performance request was not detected: ${request}`);
}
for (const request of [
  "Bảo trì ổn định dự án này",
  "Sửa nút đăng nhập",
  "Thêm provider mới"
]) {
  assert.equal(detectProjectPerformanceWorkflow(request), false, `ordinary request was misclassified: ${request}`);
}

const workflow = projectPerformanceWorkflow();
assert.equal(workflow.id, PROJECT_PERFORMANCE_WORKFLOW_ID);
assert.equal(workflow.version, PROJECT_PERFORMANCE_WORKFLOW_VERSION);
assert.equal(workflow.label, "Tối ưu tốc độ và hiệu suất dự án");
assert.match(workflow.summary, /độ mượt.*phản hồi end-to-end.*UI.*API\/backend.*truy vấn dữ liệu/is);
assert.match(workflow.summary, /CPU, RAM và I\/O chỉ là chỉ số phụ/i);
assert.equal(workflow.mode, "ordered_checklist");
assert.deepEqual(workflow.steps.map((step) => step.id), [
  "performance_preflight",
  "performance_baseline",
  "bottleneck_analysis",
  "interaction_data_path",
  "scoped_optimization",
  "performance_verification",
  "performance_handoff"
]);
assert.ok(workflow.steps.every((step) => step.required && step.title && step.instructions.length >= 2));

const registered = getTaskWorkflow(PROJECT_PERFORMANCE_WORKFLOW_ID);
assert.equal(registered?.label, workflow.label, "performance workflow must be registered");
assert.ok(listTaskWorkflows().some((candidate) => candidate.id === PROJECT_PERFORMANCE_WORKFLOW_ID));
assert.equal(resolveTaskWorkflow("", "Tối ưu tốc độ project này")?.id, PROJECT_PERFORMANCE_WORKFLOW_ID);
assert.equal(resolveTaskWorkflow("", "Bảo trì ổn định project này")?.id, "system_stability_maintenance", "performance detection must not steal stability maintenance requests");

const prompt = buildTaskWorkflowPrompt(PROJECT_PERFORMANCE_WORKFLOW_ID);
assert.match(prompt, /TỐI ƯU TỐC ĐỘ VÀ HIỆU SUẤT DỰ ÁN/);
assert.match(prompt, /TRỌNG TÂM:.*độ mượt.*phản hồi end-to-end.*CPU, RAM và I\/O chỉ là chỉ số phụ/is);
assert.match(prompt, /baseline/i);
assert.match(prompt, /benchmark|profile|trace/i);
assert.match(prompt, /click-to-response|phản hồi hữu ích|input responsiveness/i);
assert.match(prompt, /frontend.*backend.*database/is);
assert.match(prompt, /UI API và truy vấn/i);
assert.match(prompt, /query N\+1|thiếu index|Database\/query/i);
assert.match(prompt, /CPU\/RAM\/I\/O chỉ được coi là nguyên nhân phụ trợ/i);
assert.match(prompt, /không biến workflow này thành bài tối ưu tài nguyên thuần túy/i);
assert.match(prompt, /không tối ưu theo cảm tính/i);
assert.match(prompt, /baseline end-to-end|so sánh trước\/sau/i);
assert.match(prompt, /p50\/p95|startup|render\/frame/i);
assert.match(prompt, /commit, push hoặc cài đặt.*người dùng yêu cầu rõ/i);

console.log("project-performance-workflow-smoke: ok");
