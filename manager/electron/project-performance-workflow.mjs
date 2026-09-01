export const PROJECT_PERFORMANCE_WORKFLOW_ID = "project_performance_optimization";
export const PROJECT_PERFORMANCE_WORKFLOW_VERSION = "project-performance-v2";

const STEPS = Object.freeze([
  Object.freeze({
    id: "performance_preflight",
    title: "Chốt luồng và mục tiêu phản hồi",
    required: true,
    instructions: Object.freeze([
      "Đọc rule/AGENTS, manifest, config, script và source cần thiết để nhận diện đúng stack, kiến trúc, entrypoint, luồng người dùng và lệnh run/build/test/benchmark chính thức của dự án.",
      "Chọn các luồng quan trọng cần nhanh và mượt theo trải nghiệm thật, ví dụ mở màn hình, click/chuyển tab, tìm kiếm, load danh sách, lưu dữ liệu, gọi API, truy vấn, upload/xử lý job hoặc phản hồi realtime.",
      "Đặt mục tiêu đo được cho từng luồng: thời gian từ thao tác tới phản hồi hữu ích, startup/first usable render, endpoint/query latency p50/p95, render/frame time, throughput hoặc thời gian hoàn tất tác vụ. CPU/RAM chỉ là chỉ số hỗ trợ khi chúng giải thích độ chậm.",
      "Kiểm tra Git status và ghi nhận thay đổi chưa commit; không ghi đè, reset hoặc gom nhầm thay đổi của task/agent khác.",
      "Không tối ưu theo cảm tính và không đổi behavior/chất lượng đầu ra chỉ để làm số benchmark đẹp hơn nếu người dùng không yêu cầu."
    ])
  }),
  Object.freeze({
    id: "performance_baseline",
    title: "Đo độ mượt và phản hồi baseline",
    required: true,
    instructions: Object.freeze([
      "Thực hiện các thao tác đại diện như người dùng thật và ghi baseline có thể lặp lại trước khi sửa; dùng benchmark/profile/trace/log/timing hoặc công cụ đo phù hợp với stack hiện tại.",
      "Ghi môi trường đo và dữ liệu đầu vào đủ để so sánh công bằng sau tối ưu; ưu tiên nhiều lần chạy khi độ nhiễu cao và ghi median/p50/p95 hoặc min/avg/max khi phù hợp.",
      "Ưu tiên metric người dùng cảm nhận trực tiếp: click-to-response, navigation/load time, search/query latency, API latency, time-to-content, render/frame stability, input responsiveness và thời gian hoàn tất workflow. CPU, memory/RAM và I/O chỉ đo thêm khi cần tìm nguyên nhân; mục không áp dụng phải đánh dấu [-]."
    ])
  }),
  Object.freeze({
    id: "bottleneck_analysis",
    title: "Tìm bottleneck end-to-end",
    required: true,
    instructions: Object.freeze([
      "Theo dấu toàn bộ critical path từ thao tác người dùng → frontend/state/render → IPC/network → backend/API → database/cache/external service → response → render cuối để xác định chính xác đoạn gây chậm; không suy luận bottleneck chỉ từ việc đọc code.",
      "Với frontend/UI nếu có: kiểm tra event handler, render/state update thừa, list lớn, layout/paint, animation, image/media, bundle/chunk, data fetching, waterfall, cache và long task làm UI phản hồi chậm hoặc giật.",
      "Với backend/API/data nếu có: kiểm tra route/handler, serialization, query N+1/index, connection pool, cache, network round-trip, filesystem I/O, queue/concurrency, lock/contention và external API làm endpoint/truy vấn phản hồi chậm.",
      "Xếp hạng bottleneck theo impact và confidence; chỉ chọn tối ưu có khả năng tạo chênh lệch đo được và không mở rộng refactor ngoài phạm vi."
    ])
  }),
  Object.freeze({
    id: "interaction_data_path",
    title: "Tối ưu UI API và truy vấn",
    required: true,
    instructions: Object.freeze([
      "Frontend/UI: ưu tiên giảm thời gian từ thao tác tới phản hồi nhìn thấy được bằng cách loại render/request thừa, chia nhỏ công việc blocking, lazy/prefetch đúng chỗ, virtualization/pagination, cache dữ liệu và giữ input/scroll/navigation luôn responsive khi phù hợp.",
      "Backend/API: rút ngắn critical path của request bằng cách loại công việc lặp, batch hợp lý, giảm round-trip, tối ưu serialization, cache đúng tầng và điều chỉnh concurrency/pooling mà không làm sai dữ liệu.",
      "Database/query: đo query thật rồi xử lý N+1, thiếu index, scan/sort/join dư, truy vấn lặp, transaction/lock kéo dài, pagination và connection usage; không thêm index/cache theo cảm tính.",
      "CPU/RAM/I/O chỉ được coi là nguyên nhân phụ trợ: xử lý hot path, leak, GC pressure, polling hoặc I/O dư khi số đo cho thấy chúng đang làm UI/API/query chậm; không biến workflow này thành bài tối ưu tài nguyên thuần túy."
    ])
  }),
  Object.freeze({
    id: "scoped_optimization",
    title: "Tối ưu critical path ưu tiên",
    required: true,
    instructions: Object.freeze([
      "Ưu tiên thay đổi nhỏ nhất làm critical path người dùng nhanh hơn: giảm thời gian chờ UI, số round-trip, render/request/query dư, hoặc rút ngắn xử lý backend/data theo bottleneck đã đo.",
      "Giữ nguyên correctness, output, UX và API contract trừ khi người dùng yêu cầu thay đổi; không đánh đổi độ ổn định hoặc khả năng bảo trì lấy micro-optimization không đáng kể.",
      "Không tạo cảm giác nhanh giả bằng cách chỉ ẩn loading/spinner, trả dữ liệu cũ hoặc bỏ validation; phản hồi sớm/optimistic UI chỉ dùng khi semantics an toàn và có đường rollback rõ ràng.",
      "Mỗi tối ưu đáng kể phải có regression test hoặc benchmark/check tái hiện được khi thực tế cho phép; nếu không thể đo impact thì ghi rõ và không tuyên bố tăng tốc.",
      "Không refactor diện rộng, đổi framework, thêm dependency nặng hoặc thay kiến trúc chỉ để tối ưu nếu chưa có bằng chứng lợi ích tương xứng."
    ])
  }),
  Object.freeze({
    id: "performance_verification",
    title: "Benchmark và xác minh lại",
    required: true,
    instructions: Object.freeze([
      "Chạy lại đúng các thao tác/workflow baseline end-to-end; so sánh trước/sau bằng số liệu cụ thể cho click-to-response, load/navigation, API/query latency, render stability hoặc thời gian hoàn tất chức năng và nêu cả regression nếu có.",
      "Chạy test hẹp liên quan trước, sau đó build/lint/typecheck/smoke/integration/E2E chính thức tương xứng với thay đổi để xác nhận tối ưu không làm sai chức năng.",
      "Với UI phải chạy app thật và thao tác trực tiếp để xác nhận cảm giác phản hồi/mượt hơn chứ không chỉ benchmark code; với backend/service phải đo request/query/workflow thật khi có thể.",
      "Kiểm tra CPU, memory/RAM và I/O sau tối ưu khi thay đổi có liên quan để bảo đảm tốc độ tăng không đổi lấy leak, spike tài nguyên, overload hoặc race condition."
    ])
  }),
  Object.freeze({
    id: "performance_handoff",
    title: "Chốt kết quả tối ưu",
    required: true,
    instructions: Object.freeze([
      "Báo từng bước bằng [x] hoàn thành, [!] có vấn đề hoặc [-] không áp dụng kèm bằng chứng ngắn.",
      "Lập bảng hoặc tóm tắt baseline so với sau tối ưu theo từng chức năng/luồng người dùng, nêu thời gian phản hồi trước/sau, mức cải thiện tuyệt đối/phần trăm và điều kiện benchmark.",
      "Liệt kê bottleneck đã xử lý, bottleneck còn lại, trade-off/rủi ro và bước tối ưu tiếp theo theo impact; không công bố nhanh hơn nếu không có số đo hỗ trợ.",
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

export function detectProjectPerformanceWorkflow(requestText) {
  const text = normalizedText(requestText);
  if (!text) return false;
  const target = "(?:du an|project|repo|repository|app|application|ung dung|service|he thong)";
  return new RegExp(`\\b(?:toi uu|tang|cai thien|giam|lam muot)\\b.{0,50}\\b(?:toc do|hieu suat|hieu xuat|performance|latency|phan hoi|truy van|query|api|render|lag|giat|cham|bottleneck|cpu|ram|memory)\\b.{0,80}\\b${target}\\b`).test(text)
    || new RegExp(`\\b(?:toi uu|optimi[sz]e|speed up|improve)\\b.{0,80}\\b${target}\\b.{0,80}\\b(?:performance|speed|latency|hieu suat|hieu xuat|toc do|responsiveness)\\b`).test(text)
    || /\b(?:project|repo|repository|app|application|service) performance (?:optimization|optimisation|tuning|audit)\b/.test(text)
    || /\bspeed up (?:this )?(?:project|repo|repository|app|application|service)\b/.test(text)
    || /\b(?:lam|toi uu)\b.{0,30}\b(?:ui|giao dien|api|backend|truy van|query)\b.{0,30}\b(?:muot|nhanh|phan hoi|latency)\b/.test(text)
    || /\b(?:kiem tra|tim|phan tich)\b.{0,40}\bbottleneck\b.{0,80}\b(?:project|app|repo|du an|ung dung)\b/.test(text);
}

export function projectPerformanceWorkflow() {
  return {
    id: PROJECT_PERFORMANCE_WORKFLOW_ID,
    version: PROJECT_PERFORMANCE_WORKFLOW_VERSION,
    label: "Tối ưu tốc độ và hiệu suất dự án",
    summary: "Trọng tâm là độ mượt và tốc độ phản hồi end-to-end của chức năng: UI phải phản hồi nhanh, render/navigation/search/load mượt, API/backend xử lý nhanh và truy vấn dữ liệu nhanh. CPU, RAM và I/O chỉ là chỉ số phụ để tìm nguyên nhân khi chúng thực sự làm chậm trải nghiệm hoặc critical path.",
    mode: "ordered_checklist",
    steps: STEPS.map((step) => ({
      ...step,
      instructions: [...step.instructions]
    }))
  };
}
