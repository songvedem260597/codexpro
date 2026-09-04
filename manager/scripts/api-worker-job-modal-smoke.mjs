import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
const modalSource = fs.readFileSync(new URL("../src/features/api-workers/api-worker-job-modal.jsx", import.meta.url), "utf8");
const cardsSource = fs.readFileSync(new URL("../src/features/api-workers/api-worker-cards.jsx", import.meta.url), "utf8");
const apiWorkerFormSource = fs.readFileSync(new URL("../src/api-worker-form.js", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const latestMessagePanel = fs.readFileSync(new URL("../src/latest-message-panel.jsx", import.meta.url), "utf8");

assert.match(source, /import \{ ApiWorkerJobModal \} from "\.\/features\/api-workers\/api-worker-job-modal\.jsx";/, "Manager must render the extracted API worker job modal module");
assert.doesNotMatch(source, /function ApiWorkerJobModal\(/, "API worker job modal implementation must stay out of main.jsx");
assert.match(modalSource, /export function ApiWorkerJobModal\(/, "API worker job modal must be exported from its feature module");
assert.match(modalSource, /modal-backdrop chat-modal-backdrop/, "API job must reuse the Chat backdrop");
assert.match(modalSource, /modal chat-modal api-job-modal/, "API job must reuse the Chat modal geometry");
assert.match(modalSource, /modal-head chat-modal-head[\s\S]*?chat-modal-profile[\s\S]*?<WorkerIcon/, "API job must reuse the Chat worker header and animated icon");
assert.match(modalSource, /request-card chat-popup-card[\s\S]*?request-composer[\s\S]*?request-card-foot[\s\S]*?request-card-actions/, "API job must reuse the Chat card, composer, and footer");
assert.doesNotMatch(modalSource, /includeAllAllowed=\{false\}/, "API workers must offer all allowed workspaces like profile Chat");
assert.doesNotMatch(modalSource, /Job title|api-job-title|task_title:|titleWords|Loại job|Đoạn chat|ChatDropdown/, "the user must not choose the title, job kind, or conversation");
assert.match(modalSource, /const allAllowedScope = root === ALL_ALLOWED_WORKSPACES[\s\S]*?task_kind: "code"[\s\S]*?scope: allAllowedScope \? "all_allowed" : "workspace"[\s\S]*?root: allAllowedScope \? "" : root[\s\S]*?workspaceCandidates: allAllowedScope \? projects\.map/, "API requests must support either a selected repository or all allowed workspaces");
assert.match(modalSource, /Tin nhắn gần nhất[\s\S]*?<LatestMessagePanel[\s\S]*?Nhắn tiếp/, "the API popup must keep the shared latest-message and continue-message sections");
assert.match(latestMessagePanel, /chat-response is-inline[\s\S]*?latest-response chat-transcript/, "the shared latest-message surface must preserve the fixed Chat response geometry");
assert.match(modalSource, /<LatestMessagePanel[\s\S]*?worker\.stream_text[\s\S]*?worker\.last_result/, "API workers must render live stream text through the shared latest-message surface before falling back to the settled result");
assert.match(modalSource, /const processing = worker\.activity === "working";[\s\S]*?const working = sending \|\| processing;/, "API workers must distinguish local submission from confirmed processing");
assert.match(modalSource, /<LatestMessagePanel[\s\S]*?working=\{processing\}[\s\S]*?headline=\{sending \? "Đang gửi tin nhắn…" : processing \? "CodexPro đang xử lý…" : ""\}/, "API latest-message border must not enter streaming mode until the worker actually reports processing");
assert.match(modalSource, /request-files[\s\S]*?request-file-image[\s\S]*?attach-button/, "the API popup must keep Chat file/image attachment controls");
assert.match(modalSource, /AI tự đặt title 4–6 từ; Rules, AGENTS, CodexGraph và tool call đều đi qua MCP/, "API job composer must explain the AI-owned MCP title bootstrap");

assert.match(cardsSource, /<span className="already-connected">✓ Đã kết nối CodexPro<\/span>/, "connected API cards must show the CodexPro connection strip below Run job");
assert.match(cardsSource, /onClick=\{\(\) => onRun\(worker\)\}><ChatGalaxyButtonContent \/><\/button>/, "API worker cards must use the shared Chat galaxy action content as Chrome profiles");
assert.match(cardsSource, /<Dot ok=\{worker\.connected\} \/>\{worker\.model\}/, "API worker model metadata must show its online status dot");
assert.match(cardsSource, /<div className=\{`profile-action-buttons \$\{worker\.activity === "working" \? "" : "is-single"\}`\}>[\s\S]*?onClick=\{\(\) => onRun\(worker\)\}><ChatGalaxyButtonContent \/><\/button>[\s\S]*?worker\.activity === "working"[\s\S]*?onClick=\{\(\) => onStop\(worker\.worker_id\)\}>Dừng<\/button>/, "working API cards must keep the shared Chat action available next to Stop");
assert.match(styles, /\.profile-list\.is-card-layout \.profile-action-buttons\.is-single \{ grid-template-columns: 1fr; \}/, "idle API cards must outrank the card-layout grid and keep Chat full width");
assert.match(cardsSource, /profile-task-summary[\s\S]*?Task gần nhất/, "completed API cards must show the latest task title");
assert.doesNotMatch(cardsSource, /Kết quả job gần nhất/, "API cards must keep the latest response inside Chat instead of expanding it on the overview");
assert.doesNotMatch(cardsSource, />Chạy job<\/button>/, "the legacy API worker action label must be removed");
assert.doesNotMatch(cardsSource, /<code>api:\{worker\.worker_id\}/, "registry worker ids already contain the api: prefix and must not be duplicated");
assert.match(apiWorkerFormSource, /label: "9Router"/, "new 9Router workers must use the concise display label");
assert.match(source, /onWorkerUpdate/, "Manager must subscribe to push worker updates instead of waiting for the 30-second status watchdog");

console.log("✓ API worker Chat-style job modal smoke test passed");
