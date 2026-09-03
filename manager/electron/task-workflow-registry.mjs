import {
  APP_HANG_RESILIENCE_WORKFLOW_ID,
  appHangResilienceWorkflow,
  detectAppHangResilienceWorkflow
} from "./app-hang-resilience-workflow.mjs";
import {
  PROJECT_PERFORMANCE_WORKFLOW_ID,
  detectProjectPerformanceWorkflow,
  projectPerformanceWorkflow
} from "./project-performance-workflow.mjs";
import {
  SYSTEM_MAINTENANCE_WORKFLOW_ID,
  detectSystemMaintenanceWorkflow,
  systemMaintenanceWorkflow
} from "./system-maintenance-workflow.mjs";

const WORKFLOW_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: SYSTEM_MAINTENANCE_WORKFLOW_ID,
    create: systemMaintenanceWorkflow,
    detect: detectSystemMaintenanceWorkflow
  }),
  Object.freeze({
    id: PROJECT_PERFORMANCE_WORKFLOW_ID,
    create: projectPerformanceWorkflow,
    detect: detectProjectPerformanceWorkflow
  }),
  Object.freeze({
    id: APP_HANG_RESILIENCE_WORKFLOW_ID,
    create: appHangResilienceWorkflow,
    detect: detectAppHangResilienceWorkflow
  })
]);

function cloneWorkflow(workflow) {
  return {
    ...workflow,
    steps: workflow.steps.map((step) => ({
      ...step,
      instructions: [...step.instructions]
    }))
  };
}

export function listTaskWorkflows() {
  return WORKFLOW_DEFINITIONS.map((definition) => cloneWorkflow(definition.create()));
}

export function getTaskWorkflow(workflowId) {
  const definition = WORKFLOW_DEFINITIONS.find((candidate) => candidate.id === String(workflowId ?? "").trim());
  return definition ? cloneWorkflow(definition.create()) : null;
}

export function resolveTaskWorkflow(workflowId, requestText) {
  const explicitId = String(workflowId ?? "").trim();
  if (explicitId) return getTaskWorkflow(explicitId);
  const definition = WORKFLOW_DEFINITIONS.find((candidate) => candidate.detect(requestText));
  return definition ? cloneWorkflow(definition.create()) : null;
}

export function buildTaskWorkflowPrompt(workflowId) {
  const workflow = getTaskWorkflow(workflowId);
  if (!workflow) throw new Error(`Unknown task workflow: ${String(workflowId ?? "").trim() || "(empty)"}`);
  const checklist = workflow.steps.flatMap((step, index) => [
    `${index + 1}. [ ] ${step.title} (${step.id})`,
    ...step.instructions.map((instruction) => `   - ${instruction}`)
  ]);
  return [
    `# CHECKLIST ${workflow.label.toLocaleUpperCase("vi-VN")} · ${workflow.version}`,
    "",
    ...(workflow.summary ? [`TRỌNG TÂM: ${workflow.summary}`, ""] : []),
    "Đây là task theo quy trình có sẵn. Thực hiện đúng thứ tự; không tự bỏ bước hoặc đổi thành một task phát triển chung.",
    "Đây là task_kind=code: phải kích hoạt đầy đủ Rules, AGENTS, CodexGraph và dùng tool MCP để kiểm tra bằng chứng thật.",
    "Nếu một bước không áp dụng, vẫn phải đánh dấu [-] và ghi lý do. Nếu phát hiện lỗi ngoài phạm vi, ghi nhận để điều tra thay vì tự mở rộng sửa chữa.",
    "",
    "QUY TẮC CẬP NHẬT TIẾN ĐỘ: ngay sau khi hoàn thành mỗi bước và trước khi chuyển sang bước tiếp theo, cập nhật ngay một dòng trạng thái theo đúng mẫu `[x] Tên bước (step_id) — bằng chứng`, `[!] ... — vấn đề`, hoặc `[-] ... — lý do bỏ qua`. Không chờ đến cuối task mới cập nhật toàn bộ.",
    "",
    ...checklist,
    "",
    "Đầu ra cuối bắt buộc: lặp lại toàn bộ checklist với [x] đã hoàn thành, [!] có vấn đề, hoặc [-] không áp dụng; mỗi dòng kèm bằng chứng ngắn. Sau checklist mới tóm tắt thay đổi và tồn đọng."
  ].join("\n");
}
