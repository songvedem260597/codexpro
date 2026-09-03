import assert from "node:assert/strict";

import {
  APP_HANG_RESILIENCE_WORKFLOW_ID,
  APP_HANG_RESILIENCE_WORKFLOW_VERSION,
  appHangResilienceWorkflow,
  detectAppHangResilienceWorkflow
} from "../electron/app-hang-resilience-workflow.mjs";
import {
  buildTaskWorkflowPrompt,
  getTaskWorkflow,
  listTaskWorkflows,
  resolveTaskWorkflow
} from "../electron/task-workflow-registry.mjs";

assert.equal(APP_HANG_RESILIENCE_WORKFLOW_ID, "app_hang_resilience");
assert.equal(APP_HANG_RESILIENCE_WORKFLOW_VERSION, "app-hang-resilience-v1");

for (const request of [
  "Chống treo cho app này",
  "Sửa ứng dụng bị treo không phản hồi",
  "App bị freeze sau vài phút",
  "Ngăn deadlock cho hệ thống",
  "Build workflow anti-hang cho application",
  "App not responding, cần watchdog và timeout"
]) {
  assert.equal(detectAppHangResilienceWorkflow(request), true, `anti-hang request was not detected: ${request}`);
}
for (const request of [
  "Bảo trì ổn định dự án này",
  "Tối ưu tốc độ project hiện tại",
  "Sửa nút đăng nhập",
  "Thêm provider mới"
]) {
  assert.equal(detectAppHangResilienceWorkflow(request), false, `ordinary request was misclassified: ${request}`);
}

const workflow = appHangResilienceWorkflow();
assert.equal(workflow.id, APP_HANG_RESILIENCE_WORKFLOW_ID);
assert.equal(workflow.version, APP_HANG_RESILIENCE_WORKFLOW_VERSION);
assert.equal(workflow.label, "Chống treo và phục hồi ứng dụng");
assert.equal(workflow.mode, "ordered_checklist");
assert.match(workflow.summary, /event loop.*hard deadline.*queue.*cancellation.*fault-injection/is);
assert.deepEqual(workflow.steps.map((step) => step.id), [
  "hang_preflight",
  "hang_baseline",
  "event_loop_safety",
  "hard_deadlines",
  "single_flight_backpressure",
  "cancellation_lifecycle",
  "failure_isolation_recovery",
  "bounded_persistence",
  "hang_fault_injection",
  "hang_verification",
  "hang_handoff"
]);
assert.ok(workflow.steps.every((step) => step.required && step.title && step.instructions.length >= 3));
assert.equal(new Set(workflow.steps.map((step) => step.id)).size, workflow.steps.length);

const registered = getTaskWorkflow(APP_HANG_RESILIENCE_WORKFLOW_ID);
assert.equal(registered?.label, workflow.label, "anti-hang workflow must be registered");
const registeredWorkflowIds = listTaskWorkflows().map((candidate) => candidate.id);
assert.ok(registeredWorkflowIds.includes(APP_HANG_RESILIENCE_WORKFLOW_ID));
assert.deepEqual(registeredWorkflowIds.slice(0, 3), ["system_stability_maintenance", "project_performance_optimization", APP_HANG_RESILIENCE_WORKFLOW_ID], "adding anti-hang must not change the existing default workflow order");
assert.equal(resolveTaskWorkflow("", "Chống treo cho app này")?.id, APP_HANG_RESILIENCE_WORKFLOW_ID);
assert.equal(resolveTaskWorkflow("", "Bảo trì ổn định project này")?.id, "system_stability_maintenance", "anti-hang detection must not steal maintenance requests");
assert.equal(resolveTaskWorkflow("", "Tối ưu tốc độ project này")?.id, "project_performance_optimization", "anti-hang detection must not steal performance requests");

const prompt = buildTaskWorkflowPrompt(APP_HANG_RESILIENCE_WORKFLOW_ID);
assert.match(prompt, /CHỐNG TREO VÀ PHỤC HỒI ỨNG DỤNG/);
assert.match(prompt, /spawnSync\/execSync|blocking I\/O/i);
assert.match(prompt, /hard deadline|upper bound/i);
assert.match(prompt, /AbortSignal|kill process tree/i);
assert.match(prompt, /single-flight|backpressure/i);
assert.match(prompt, /activeRequests|client disconnect/i);
assert.match(prompt, /failure domain|false-healthy|watchdog/i);
assert.match(prompt, /tail\/index\/ring buffer|retention/i);
assert.match(prompt, /fault-injection/i);
assert.match(prompt, /subprocess không exit|HTTP\/TCP accept nhưng không response/i);
assert.match(prompt, /event-loop delay|main-thread responsiveness/i);
assert.match(prompt, /không tuyên bố chống treo nếu còn đường critical không có upper bound/i);

console.log("app-hang-resilience-workflow-smoke: ok");
