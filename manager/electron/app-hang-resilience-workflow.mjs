export const APP_HANG_RESILIENCE_WORKFLOW_ID = "app_hang_resilience";
export const APP_HANG_RESILIENCE_WORKFLOW_VERSION = "app-hang-resilience-v1";

const STEPS = Object.freeze([
  Object.freeze({
    id: "hang_preflight",
    title: "Chốt phạm vi chống treo",
    required: true,
    instructions: Object.freeze([
      "Đọc rule/AGENTS, manifest, config, script và source cần thiết để nhận diện đúng process model, event loop/thread, IPC/network, worker/background job, storage và lifecycle của ứng dụng; không giả định kiến trúc từ app khác.",
      "Chọn các đường sống còn phải luôn có hard upper bound, ví dụ startup, health/status, click/IPC, request/API, subprocess, database/storage, queue/job, browser/CDP, restart/shutdown và tunnel/external service khi dự án thực sự có chúng.",
      "Kiểm tra Git status và ownership thay đổi; giữ nguyên code của task/agent khác và ghi baseline trước khi sửa.",
      "Phân loại bằng chứng thành đã xảy ra thực tế, source-proven nhưng chưa tái hiện, và giả thuyết cần fault-injection; không trộn ba mức confidence."
    ])
  }),
  Object.freeze({
    id: "hang_baseline",
    title: "Đo baseline treo và starvation",
    required: true,
    instructions: Object.freeze([
      "Tái hiện hoặc đo các luồng có nguy cơ treo bằng thao tác thật; ghi duration p50/p95/max, event-loop delay hoặc main-thread long task, queue wait, request/session in-flight, child PID/process count và trạng thái heartbeat/health khi áp dụng.",
      "Rà log/crash/timeout gần đây để tìm bằng chứng về request kéo dài, heartbeat mất, renderer/utility crash, startup health timeout, retry storm hoặc process sống nhưng không phục vụ được.",
      "Xác định SLO chống treo cho từng critical path: thời gian phản hồi tối đa, deadline subprocess/request, thời gian recovery và phạm vi cô lập sự cố. Một path critical không được phụ thuộc vô hạn vào WMI/Git/filesystem/network/browser/database hoặc service ngoài."
    ])
  }),
  Object.freeze({
    id: "event_loop_safety",
    title: "Loại blocking khỏi đường sống",
    required: true,
    instructions: Object.freeze([
      "Tìm synchronous/blocking I/O hoặc CPU work trên UI/main/runtime event loop và critical server loop: spawnSync/execSync, readFileSync/writeFileSync dữ liệu lớn, JSON parse/sort lớn, crypto/compression nặng, lock chờ dài hoặc vòng lặp CPU; chứng minh bằng call path trước khi sửa.",
      "Chuyển công việc có thể block sang async subprocess/worker/thread/pool phù hợp; mọi async operation phải có bounded concurrency và không được biến một request chậm thành starvation toàn event loop.",
      "Nếu ứng dụng có health/status endpoint hoặc UI heartbeat, fault-inject một operation chậm song song và xác nhận health/UI vẫn tiến triển trong budget thay vì đứng theo subsystem khác."
    ])
  }),
  Object.freeze({
    id: "hard_deadlines",
    title: "Đặt hard deadline mọi dependency",
    required: true,
    instructions: Object.freeze([
      "Mọi subprocess, IPC, HTTP/API, database query, filesystem/network operation, browser/CDP command và system command có thể chờ bên ngoài phải có deadline rõ ràng; timeout phải bao phủ toàn operation chứ không chỉ một bước con.",
      "Khi timeout phải hủy hoặc vô hiệu hóa operation thật: AbortSignal/cancel token khi hỗ trợ, kill process tree cho subprocess, đóng/detach session hỏng và release lock/resource; Promise.race đơn thuần không được coi là đủ nếu underlying work vẫn chạy.",
      "Đặt automation ở non-interactive mode khi phù hợp, ví dụ tắt credential prompt cho Git/CLI; lỗi timeout phải trả về bounded failure có diagnostic thay vì retry vô hạn."
    ])
  }),
  Object.freeze({
    id: "single_flight_backpressure",
    title: "Chặn refresh và queue chồng",
    required: true,
    instructions: Object.freeze([
      "Rà polling, refresh, autosave, search, status, retry và background scheduler; nếu chu kỳ mới có thể bắt đầu khi lượt cũ chưa xong thì thêm single-flight/coalescing hoặc cancellation theo semantics của chức năng.",
      "Mọi queue phải có giới hạn size/concurrency, backpressure và policy khi đầy; ưu tiên cô lập theo lane/profile/workspace/tab/user khi một tác vụ chậm không nên serialize toàn app.",
      "Kiểm tra race giữa restart/reload/send/save/close và các operation dài; chỉ cho phép số operation đồng thời đã định nghĩa, tránh restart storm hoặc nhân bản job."
    ])
  }),
  Object.freeze({
    id: "cancellation_lifecycle",
    title: "Lan truyền cancel và dọn lifecycle",
    required: true,
    instructions: Object.freeze([
      "Propagate client disconnect, unmount, navigation, task cancel, shutdown và deadline xuống operation sâu nhất có thể; trạng thái UI timeout không được để server/tool/job tiếp tục âm thầm nếu semantics cho phép hủy.",
      "Trong finally/abort path phải release activeRequests, session, lock, temp file, stream, debugger, child process và semaphore token; stuck-active object không được miễn retention/cap vô thời hạn.",
      "Dùng operation ID/generation khi callback cũ có thể về muộn; kết quả của operation đã timeout/cancel không được ghi đè trạng thái mới hoặc tái sử dụng session/tab/process đã bị đánh dấu hỏng."
    ])
  }),
  Object.freeze({
    id: "failure_isolation_recovery",
    title: "Cô lập lỗi và tự phục hồi",
    required: true,
    instructions: Object.freeze([
      "Thiết kế failure domain theo process/profile/tab/worker/workspace/service: một dependency treo chỉ làm hỏng phạm vi nhỏ nhất có thể và các domain khác vẫn phục vụ bình thường.",
      "Thêm watchdog/supervisor cho false-healthy state: process còn sống nhưng không phản hồi, heartbeat vẫn có nhưng command executor chết, tunnel alive nhưng offline, queue không tiến triển hoặc session active mãi; recovery phải có threshold/cooldown và không lặp vô hạn.",
      "Ưu tiên restart đúng thành phần hỏng thay vì restart toàn app; sau recovery phải invalidate state cũ và xác nhận operation tiếp theo thực sự chạy được."
    ])
  }),
  Object.freeze({
    id: "bounded_persistence",
    title: "Giữ log và persistence bounded",
    required: true,
    instructions: Object.freeze([
      "Rà mọi log/history/cache/job/trace/session/state store có thể tăng theo thời gian; đặt retention theo size/count/age và cleanup global, không chỉ giới hạn từng file nếu số file/workspace có thể tăng vô hạn.",
      "Read path có limit nhỏ phải có cost gần với limit: ưu tiên tail/index/ring buffer/pagination thay vì đọc toàn file/thư mục rồi parse/sort trước khi slice; malformed record phải bị bỏ qua có kiểm soát, không tạo retry loop.",
      "Persistence trên UI/main event loop phải tránh synchronous read/write/serialize lớn; kiểm tra partial write/power loss và dùng atomic write/rename hoặc journal phù hợp với dữ liệu quan trọng."
    ])
  }),
  Object.freeze({
    id: "hang_fault_injection",
    title: "Fault-inject các kiểu treo",
    required: true,
    instructions: Object.freeze([
      "Chạy fault-injection trong môi trường test/temporary an toàn, không phá dữ liệu thật: subprocess không exit, HTTP/TCP accept nhưng không response, database/query chậm, filesystem/log lớn, malformed persistence, lock contention, command/browser promise không resolve và service alive-but-offline khi các subsystem đó tồn tại.",
      "Kiểm tra refresh/poll lặp khi backend chưa xong, nhiều profile/worker song song, restart spam, client disconnect giữa request, kill app giữa write và stale session/job; xác nhận concurrency/cap/recovery đúng thiết kế.",
      "Thu số liệu trước/sau gồm latency max/p95, event-loop delay/main-thread responsiveness, queue/in-flight count, memory/CPU/handle/PID khi phù hợp và thời gian recovery; không chỉ dựa vào test unit pass."
    ])
  }),
  Object.freeze({
    id: "hang_verification",
    title: "Xác minh app không bị kéo treo",
    required: true,
    instructions: Object.freeze([
      "Chạy regression test hẹp cho từng bug class rồi build/lint/typecheck/smoke/integration/E2E chính thức tương xứng; mỗi subsystem sửa phải có test chứng minh timeout, cancellation, isolation hoặc bounded concurrency của chính nó.",
      "Chạy app thật và thao tác UI/IPC/request/restart liên quan; trong khi cố tình làm một dependency chậm, xác nhận phần còn lại vẫn responsive và người dùng nhận lỗi/recovery trong hard deadline đã đặt.",
      "So sánh baseline với kết quả sau sửa, kiểm tra Git diff và nêu rõ fault case nào đã pass, case nào chưa chạy được và rủi ro còn lại; không tuyên bố chống treo nếu còn đường critical không có upper bound đã biết."
    ])
  }),
  Object.freeze({
    id: "hang_handoff",
    title: "Chốt checklist chống treo",
    required: true,
    instructions: Object.freeze([
      "Báo từng bước bằng [x] hoàn thành, [!] có vấn đề hoặc [-] không áp dụng kèm bằng chứng ngắn và số đo quan trọng.",
      "Liệt kê các hang class đã loại bỏ, deadline/cap mới, failure domain và recovery path; tách rõ vấn đề đã tái hiện khỏi rủi ro source-proven chưa fault-inject.",
      "Nêu test/build/runtime/fault-injection đã chạy và tồn đọng theo mức Critical/High/Medium; không gộp sửa nhiều subsystem không liên quan chỉ để chốt checklist."
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

export function detectAppHangResilienceWorkflow(requestText) {
  const text = normalizedText(requestText);
  if (!text) return false;
  const target = "(?:app|application|ung dung|project|du an|service|he thong|system)";
  return new RegExp(`\\b(?:chong|tranh|khac phuc|sua|xu ly|ngan)\\b.{0,50}\\b(?:treo|freeze|hang|deadlock|not responding|khong phan hoi)\\b.{0,80}\\b${target}\\b`).test(text)
    || new RegExp(`\\b${target}\\b.{0,70}\\b(?:bi )?(?:treo|freeze|hang|deadlock|not responding|khong phan hoi)\\b`).test(text)
    || /\b(?:anti[- ]?hang|hang resilience|freeze resilience|deadlock prevention)\b/.test(text)
    || /\b(?:timeout|watchdog|single[- ]?flight|backpressure|cancellation)\b.{0,80}\b(?:freeze|hang|treo|not responding)\b/.test(text);
}

export function appHangResilienceWorkflow() {
  return {
    id: APP_HANG_RESILIENCE_WORKFLOW_ID,
    version: APP_HANG_RESILIENCE_WORKFLOW_VERSION,
    label: "Chống treo và phục hồi ứng dụng",
    summary: "Chuyên chống treo end-to-end: loại blocking khỏi event loop/main thread, đặt hard deadline và hủy thật cho dependency bên ngoài, chặn polling/queue chồng, propagate cancellation, cô lập failure domain, giữ persistence bounded và bắt buộc fault-injection để chứng minh app vẫn responsive khi một subsystem bị kẹt.",
    mode: "ordered_checklist",
    steps: STEPS.map((step) => ({
      ...step,
      instructions: [...step.instructions]
    }))
  };
}
