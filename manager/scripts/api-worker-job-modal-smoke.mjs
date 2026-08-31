import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
const start = source.indexOf("function ApiWorkerJobModal(");
const end = source.indexOf("function App()", start);
assert.ok(start >= 0 && end > start, "API worker job modal must remain isolated above App");

const modal = source.slice(start, end);
assert.match(modal, /modal-backdrop chat-modal-backdrop/, "API job must reuse the Chat backdrop");
assert.match(modal, /modal chat-modal api-job-modal/, "API job must reuse the Chat modal geometry");
assert.match(modal, /modal-head chat-modal-head[\s\S]*?chat-modal-profile[\s\S]*?<WorkerIcon/, "API job must reuse the Chat worker header and animated icon");
assert.match(modal, /request-card chat-popup-card[\s\S]*?request-composer[\s\S]*?request-card-foot[\s\S]*?request-card-actions/, "API job must reuse the Chat card, composer, and footer");
assert.match(modal, /includeAllAllowed=\{false\}/, "code jobs must require a concrete repository");
assert.doesNotMatch(modal, /Job title|api-job-title|task_title:|titleWords|Loại job|Đoạn chat|ChatDropdown/, "the user must not choose the title, job kind, or conversation");
assert.match(modal, /task_kind: "code"[\s\S]*?scope: "workspace"[\s\S]*?root,[\s\S]*?text: request\.trim\(\)[\s\S]*?attachments/, "API requests must use the selected repository without a user-supplied title");
assert.match(modal, /Tin nhắn gần nhất[\s\S]*?chat-response is-inline[\s\S]*?Nhắn tiếp/, "the API popup must keep the Chat latest-message and continue-message sections");
assert.match(modal, /request-files[\s\S]*?request-file-image[\s\S]*?attach-button/, "the API popup must keep Chat file/image attachment controls");
assert.match(modal, /AI tự đặt title 2–6 từ; Rules, AGENTS, CodexGraph và tool call đều đi qua MCP/, "API job composer must explain the AI-owned MCP title bootstrap");

assert.match(source, /<span className="already-connected">✓ Đã kết nối CodexPro<\/span>/, "connected API cards must show the CodexPro connection strip below Run job");
assert.match(source, /onClick=\{\(\) => onRun\(worker\)\}>Chat<\/button>/, "API worker cards must use the same Chat action label as Chrome profiles");
assert.doesNotMatch(source, />Chạy job<\/button>/, "the legacy API worker action label must be removed");
assert.doesNotMatch(source, /<code>api:\{worker\.worker_id\}/, "registry worker ids already contain the api: prefix and must not be duplicated");
assert.match(source, /label: "9Router"/, "new 9Router workers must use the concise display label");

console.log("✓ API worker Chat-style job modal smoke test passed");
