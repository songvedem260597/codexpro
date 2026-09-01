import assert from "node:assert/strict";
import fs from "node:fs";

import {
  buildTaskWorkflowPrompt,
  getTaskWorkflow,
  listTaskWorkflows,
  resolveTaskWorkflow
} from "../electron/task-workflow-registry.mjs";
import { deriveTaskWorkflowProgress } from "../src/task-workflow-progress.js";

const workflows = listTaskWorkflows();
assert.ok(workflows.length >= 1, "the workflow registry must expose at least one reusable checklist");
assert.equal(new Set(workflows.map((workflow) => workflow.id)).size, workflows.length, "workflow ids must be unique");
assert.equal(getTaskWorkflow("system_stability_maintenance")?.label, "Bảo trì ổn định hệ thống");
assert.equal(resolveTaskWorkflow("system_stability_maintenance", "")?.id, "system_stability_maintenance");
assert.equal(resolveTaskWorkflow("", "Hãy bảo trì hệ thống")?.id, "system_stability_maintenance");
assert.equal(resolveTaskWorkflow("unknown", "Hãy bảo trì hệ thống"), null, "unknown explicit workflow ids must fail closed");

const prompt = buildTaskWorkflowPrompt("system_stability_maintenance");
assert.match(prompt, /cập nhật ngay một dòng trạng thái/i, "workers must publish checklist progress after every step");
assert.match(prompt, /\(preflight\)/);
assert.match(prompt, /\(handoff\)/);

const progress = deriveTaskWorkflowProgress(getTaskWorkflow("system_stability_maintenance"), [
  "[x] Chốt phạm vi và hiện trạng (preflight) — git status sạch",
  "[!] Kiểm tra sức khỏe runtime (health_baseline) — tunnel offline",
  "[-] Rà soát lỗi và task dở (incident_review) — không áp dụng"
].join("\n"), { running: true });
assert.deepEqual(progress.steps.slice(0, 4).map((step) => step.status), ["completed", "issue", "skipped", "running"]);
assert.equal(progress.completed, 1);
assert.equal(progress.issues, 1);

const app = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
const center = fs.readFileSync(new URL("../src/task-workflow-center.jsx", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/task-workflow-center.css", import.meta.url), "utf8");
const managerMain = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
const agentLoop = fs.readFileSync(new URL("../electron/worker-core/mcp-agent-loop.mjs", import.meta.url), "utf8");
const apiPlugin = fs.readFileSync(new URL("../electron/worker-plugins/api-worker-plugin.mjs", import.meta.url), "utf8");

assert.match(app, /activePage === "workflows"/, "Manager must expose a dedicated workflow tab");
assert.match(app, />Quy trình<\/button>/, "the sidebar must have a workflow navigation button");
assert.match(app, /<TaskWorkflowCenter/, "the dedicated page must render the reusable workflow center");
assert.match(center, /Chọn quy trình[\s\S]*Chọn worker[\s\S]*Chọn workspace/, "the page must let the user select a template, worker, and workspace");
assert.match(center, /import \{ AppDropdown \} from "\.\/app-dropdown\.jsx";/, "the workflow page must import the dropdown component it renders");
assert.match(center, /Giao checklist/, "the page must provide a one-click dispatch action");
assert.match(center, /sendWorkerRequest[\s\S]*workflow:/, "API workers must receive the selected workflow id");
assert.match(center, /sendProfileRequest[\s\S]*workflow:/, "Chrome workers must receive the selected workflow id");
assert.match(center, /readWorkerResponse|readChromeProgress/, "the page must refresh worker evidence while the checklist runs");
assert.match(center, /getRepoTaskStatus/, "Chrome checklist completion must require verified begin_repo_task evidence");
assert.match(center, /deriveTaskWorkflowProgress/, "rendered checkboxes must be derived from worker evidence");
assert.match(styles, /\.task-workflow-checklist-step\.is-completed/, "completed checklist steps need a distinct visual state");
assert.match(managerMain, /resolveTaskWorkflow/, "Chrome dispatch must use the generic workflow registry");
assert.match(agentLoop, /resolveTaskWorkflow/, "API dispatch must use the generic workflow registry");
assert.match(agentLoop, /workflow_progress/, "API workers must publish structured progress evidence between checklist steps");
assert.match(apiPlugin, /workflow_evidence/, "API workers must retain progress evidence across provider turns");

console.log("task-workflow-center-smoke: ok");
