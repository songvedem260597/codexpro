export const SYSTEM_MAINTENANCE_WORKFLOW_ID = "system_stability_maintenance";
export const SYSTEM_MAINTENANCE_WORKFLOW_VERSION = "system-maintenance-v2";

const STEPS = Object.freeze([
  Object.freeze({
    id: "preflight",
    title: "Chốt phạm vi và hiện trạng",
    required: true,
    instructions: Object.freeze([
      "Đọc rule/AGENTS áp dụng, xác nhận đúng workspace/branch và mục tiêu bảo trì của dự án hiện tại.",
      "Đọc manifest, config, script và tài liệu gốc cần thiết để nhận diện stack, kiến trúc, entrypoint và các lệnh build/test/run chính thức của dự án; không giả định công nghệ từ dự án khác.",
      "Kiểm tra Git status; ghi nhận thay đổi chưa commit và tuyệt đối không ghi đè hoặc commit nhầm phần của người khác.",
      "Ghi baseline trước khi sửa để có dữ liệu so sánh sau bảo trì."
    ])
  }),
  Object.freeze({
    id: "health_baseline",
    title: "Kiểm tra sức khỏe runtime",
    required: true,
    instructions: Object.freeze([
      "Kiểm tra các runtime, service và process mà dự án thực sự có, ví dụ app/web/API/database/queue/worker/scheduler/container/tunnel; chỉ kiểm tra những thành phần được chứng minh từ source, config hoặc cách chạy của dự án.",
      "Không mặc định dự án có Scheduled Task, Local MCP, public tunnel, Chrome worker/extension hay bất kỳ hạ tầng riêng của CodexPro; thành phần không tồn tại phải đánh dấu [-] thay vì tạo kiểm tra giả.",
      "Ghi trạng thái, phiên bản, độ trễ, tài nguyên và lỗi kết nối/runtime có bằng chứng khi áp dụng; không kết luận chỉ từ nhãn UI."
    ])
  }),
  Object.freeze({
    id: "incident_review",
    title: "Rà soát lỗi và task dở",
    required: true,
    instructions: Object.freeze([
      "Rà log, crash report, test output và lỗi do người dùng báo của chính dự án; nhóm theo fingerprint, nguồn, mức độ và số lần lặp khi dữ liệu cho phép.",
      "Nếu dự án có task/job/queue/worker hoặc trạng thái công việc nền, đối chiếu task chưa chốt trạng thái với bằng chứng thực tế; nếu không có cơ chế này thì đánh dấu phần đó [-].",
      "Ưu tiên lỗi tái diễn và lỗi ảnh hưởng trực tiếp tới stack hiện có như crash, network, storage/database, queue/concurrency, resource leak hoặc trạng thái running sai; không ưu tiên lỗi thuộc hạ tầng mà dự án không sử dụng."
    ])
  }),
  Object.freeze({
    id: "stability_controls",
    title: "Kiểm tra cơ chế an toàn",
    required: true,
    instructions: Object.freeze([
      "Xác định và kiểm tra các cơ chế ổn định mà dự án thực sự có: validation, error handling, timeout, retry, watchdog, recovery, persistence, queue/concurrency, rate limit, resource cleanup, graceful shutdown, session/auth hoặc backup/rollback.",
      "Nếu dự án có job/process chạy lâu hoặc background worker, kiểm tra timeout/retry/watchdog/recovery có giới hạn, không tạo vòng lặp vô hạn và không nhân bản tác vụ; nếu dự án không có thì đánh dấu [-].",
      "Nếu dự án có trạng thái hoặc tài nguyên có thể bị treo/hỏng, kiểm tra cơ chế không tái sử dụng trạng thái hỏng cho tác vụ mới và có đường phục hồi an toàn; áp dụng theo semantics của chính dự án."
    ])
  }),
  Object.freeze({
    id: "scoped_remediation",
    title: "Khắc phục đúng nguyên nhân",
    required: true,
    instructions: Object.freeze([
      "Chỉ sửa lỗi có thể tái hiện hoặc có bằng chứng đủ rõ; ưu tiên nguyên nhân gốc và thêm regression test trước khi sửa khi thực tế cho phép.",
      "Không refactor ngoài phạm vi, không xóa dữ liệu và không tạo vòng retry/reload/restart liên tục.",
      "Lỗi chưa đủ bằng chứng phải được ghi thành tồn đọng để điều tra, không che bằng thay đổi trạng thái giả hoặc workaround không kiểm chứng."
    ])
  }),
  Object.freeze({
    id: "verification",
    title: "Xác minh sau bảo trì",
    required: true,
    instructions: Object.freeze([
      "Chạy test hẹp liên quan trước, sau đó dùng các lệnh chính thức của dự án để chạy build/lint/typecheck/smoke/integration/E2E tương xứng với phạm vi thay đổi; không tự bịa lệnh không có trong project.",
      "So sánh với baseline, kiểm tra Git diff và xác nhận không làm hỏng cơ chế ổn định khác của dự án.",
      "Với UI phải chạy app thật và kiểm tra trực quan khi thay đổi có ảnh hưởng giao diện; với backend/CLI/service phải kiểm tra output/runtime thực tế khi có thể.",
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
  const target = "(?:he thong|du an|project|repo|repository|app|ung dung|service)";
  return new RegExp(`\\bbao tri\\b.{0,100}\\b${target}\\b`).test(text)
    || new RegExp(`\\bmaintenance\\b.{0,60}\\b${target}\\b`).test(text)
    || new RegExp(`\\b(?:kiem tra|dam bao|duy tri|cai thien)\\b.{0,50}\\b(?:do )?on dinh\\b.{0,50}\\b${target}\\b`).test(text)
    || /\b(?:system|project|repo|repository|app|application|service) (?:stability )?maintenance(?: checklist| workflow| task)?\b/.test(text);
}

export function systemMaintenanceWorkflow() {
  return {
    id: SYSTEM_MAINTENANCE_WORKFLOW_ID,
    version: SYSTEM_MAINTENANCE_WORKFLOW_VERSION,
    label: "Bảo trì ổn định dự án",
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
    `# CHECKLIST BẢO TRÌ ỔN ĐỊNH DỰ ÁN · ${workflow.version}`,
    "",
    "Đây là task bảo trì theo quy trình có sẵn cho dự án hiện tại. Thực hiện đúng thứ tự; không tự bỏ bước hoặc đổi thành một task phát triển chung.",
    "Đây là task_kind=code: phải kích hoạt đầy đủ Rules, AGENTS, CodexGraph và dùng tool MCP để kiểm tra bằng chứng thật.",
    "Workflow này dùng cho nhiều loại dự án: hãy tự nhận diện stack/kiến trúc từ workspace rồi chỉ kiểm tra những thành phần mà dự án thực sự có. Không giả định hạ tầng CodexPro và không mặc định phải có MCP/runtime/tunnel/worker riêng bên trong dự án đang bảo trì.",
    "Nếu một bước hoặc một mục con không áp dụng, vẫn phải đánh dấu [-] và ghi lý do. Nếu phát hiện lỗi ngoài phạm vi, ghi nhận để điều tra thay vì tự mở rộng sửa chữa.",
    "",
    ...checklist,
    "",
    "Đầu ra bắt buộc: lặp lại checklist với [x] đã hoàn thành, [!] có vấn đề, hoặc [-] không áp dụng; mỗi dòng kèm bằng chứng ngắn. Sau checklist mới tóm tắt thay đổi và tồn đọng."
  ].join("\n");
}
