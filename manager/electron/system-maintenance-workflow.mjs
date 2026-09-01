export const SYSTEM_MAINTENANCE_WORKFLOW_ID = "system_stability_maintenance";
export const SYSTEM_MAINTENANCE_WORKFLOW_VERSION = "system-maintenance-v1";

const STEPS = Object.freeze([
  Object.freeze({
    id: "preflight",
    title: "Chốt phạm vi và hiện trạng",
    required: true,
    instructions: Object.freeze([
      "Đọc rule áp dụng, xác nhận đúng workspace/branch và mục tiêu bảo trì.",
      "Kiểm tra Git status; ghi nhận thay đổi chưa commit và tuyệt đối không ghi đè hoặc commit nhầm phần của người khác.",
      "Ghi baseline trước khi sửa để có dữ liệu so sánh sau bảo trì."
    ])
  }),
  Object.freeze({
    id: "health_baseline",
    title: "Kiểm tra sức khỏe runtime",
    required: true,
    instructions: Object.freeze([
      "Kiểm tra Scheduled Task, Local MCP, public tunnel, worker/extension và các process liên quan.",
      "Ghi trạng thái, phiên bản, độ trễ và lỗi kết nối có bằng chứng; không kết luận chỉ từ nhãn UI."
    ])
  }),
  Object.freeze({
    id: "incident_review",
    title: "Rà soát lỗi và task dở",
    required: true,
    instructions: Object.freeze([
      "Rà log hệ thống và lỗi do người dùng báo; nhóm theo fingerprint, nguồn, mức độ và số lần lặp.",
      "Đối chiếu task chưa chốt trạng thái với bằng chứng thực tế; task đã xong thì chốt hoàn thành, task còn dở phải ghi rõ đang làm gì và nguyên nhân.",
      "Ưu tiên lỗi tái diễn, lỗi tunnel/network, worker mất kết nối và trạng thái running sai."
    ])
  }),
  Object.freeze({
    id: "stability_controls",
    title: "Kiểm tra cơ chế an toàn",
    required: true,
    instructions: Object.freeze([
      "Kiểm tra cảnh báo task gián đoạn, âm thanh hoàn thành, giới hạn conversation và phân loại tab/worker đúng trạng thái.",
      "Kiểm tra watchdog task trên 30 phút: chỉ reload có kiểm soát, chỉ mở lại đúng conversation một lần khi không phản hồi, sau đó dừng retry và đánh dấu tab treo.",
      "Kiểm tra cơ chế tránh gửi task mới vào conversation đã bị đánh dấu treo."
    ])
  }),
  Object.freeze({
    id: "scoped_remediation",
    title: "Khắc phục đúng nguyên nhân",
    required: true,
    instructions: Object.freeze([
      "Chỉ sửa lỗi có thể tái hiện hoặc có bằng chứng đủ rõ; ưu tiên nguyên nhân gốc và thêm regression test trước khi sửa khi thực tế cho phép.",
      "Không refactor ngoài phạm vi, không xóa dữ liệu và không tạo vòng retry/reload liên tục.",
      "Lỗi chưa đủ bằng chứng phải được ghi thành tồn đọng để điều tra, không che bằng thay đổi trạng thái giả."
    ])
  }),
  Object.freeze({
    id: "verification",
    title: "Xác minh sau bảo trì",
    required: true,
    instructions: Object.freeze([
      "Chạy test hẹp liên quan trước, sau đó build và smoke test tương xứng với phạm vi thay đổi.",
      "So sánh với baseline, kiểm tra Git diff và xác nhận không làm hỏng cơ chế ổn định khác.",
      "Ghi chính xác lệnh đã chạy, kết quả pass/fail và phần không thể kiểm tra."
    ])
  }),
  Object.freeze({
    id: "handoff",
    title: "Chốt checklist và bàn giao",
    required: true,
    instructions: Object.freeze([
      "Báo từng bước bằng [x] hoàn thành, [!] có vấn đề hoặc [-] bỏ qua kèm lý do và bằng chứng ngắn.",
      "Liệt kê lỗi đã xử lý, lỗi còn tồn tại, rủi ro và việc tiếp theo; không công bố hoàn thành nếu còn bước bắt buộc chưa chốt.",
      "Chỉ commit, push hoặc cài đặt khi người dùng yêu cầu rõ; không đưa thay đổi không liên quan vào commit."
    ])
  })
]);

function normalizedText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function detectSystemMaintenanceWorkflow(requestText) {
  const text = normalizedText(requestText);
  if (!text) return false;
  return /\bbao tri\b.{0,100}\bhe thong\b/.test(text)
    || /\b(?:kiem tra|dam bao|duy tri|cai thien) (?:do )?on dinh (?:cua )?he thong\b/.test(text)
    || /\bsystem (?:stability )?maintenance(?: checklist| workflow| task)?\b/.test(text);
}

export function systemMaintenanceWorkflow() {
  return {
    id: SYSTEM_MAINTENANCE_WORKFLOW_ID,
    version: SYSTEM_MAINTENANCE_WORKFLOW_VERSION,
    label: "Bảo trì ổn định hệ thống",
    mode: "ordered_checklist",
    steps: STEPS.map((step) => ({
      ...step,
      instructions: [...step.instructions]
    }))
  };
}

export function resolveSystemMaintenanceWorkflow(workflow, requestText) {
  const selected = String(workflow ?? "").trim();
  if (selected && selected !== SYSTEM_MAINTENANCE_WORKFLOW_ID) return null;
  if (selected === SYSTEM_MAINTENANCE_WORKFLOW_ID || detectSystemMaintenanceWorkflow(requestText)) {
    return systemMaintenanceWorkflow();
  }
  return null;
}

export function buildSystemMaintenanceWorkflowPrompt() {
  const workflow = systemMaintenanceWorkflow();
  const checklist = workflow.steps.flatMap((step, index) => [
    `${index + 1}. [ ] ${step.title} (${step.id})`,
    ...step.instructions.map((instruction) => `   - ${instruction}`)
  ]);
  return [
    `# CHECKLIST BẢO TRÌ ỔN ĐỊNH HỆ THỐNG · ${workflow.version}`,
    "",
    "Đây là task bảo trì theo quy trình có sẵn. Thực hiện đúng thứ tự; không tự bỏ bước hoặc đổi thành một task phát triển chung.",
    "Đây là task_kind=code: phải kích hoạt đầy đủ Rules, AGENTS, CodexGraph và dùng tool MCP để kiểm tra bằng chứng thật.",
    "Nếu một bước không áp dụng, vẫn phải đánh dấu [-] và ghi lý do. Nếu phát hiện lỗi ngoài phạm vi, ghi nhận để điều tra thay vì tự mở rộng sửa chữa.",
    "",
    ...checklist,
    "",
    "Đầu ra bắt buộc: lặp lại checklist với [x] đã hoàn thành, [!] có vấn đề, hoặc [-] không áp dụng; mỗi dòng kèm bằng chứng ngắn. Sau checklist mới tóm tắt thay đổi và tồn đọng."
  ].join("\n");
}
