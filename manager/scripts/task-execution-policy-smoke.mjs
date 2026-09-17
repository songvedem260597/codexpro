import assert from "node:assert/strict";
import fs from "node:fs";

import { buildAutonomousTaskExecutionPolicy, normalizeTaskSize } from "../electron/task-execution-policy.mjs";

const taskId = "cpt_111111111111111111111111";
const prompt = buildAutonomousTaskExecutionPolicy(taskId).join("\n");
assert.equal(normalizeTaskSize(" LARGE "), "large");
assert.equal(normalizeTaskSize("unknown"), "");
assert.match(prompt, /tự điều tra trước khi sửa/i);
assert.match(prompt, /không hỏi người dùng chỉ vì task phức tạp, mơ hồ/i);
assert.match(prompt, /task lớn\/phức tạp BẮT BUỘC tạo checklist/i);
assert.match(prompt, new RegExp(taskId));
assert.match(prompt, /Chỉ một item được in_progress/i);
assert.match(prompt, /điều chỉnh cùng task/i);
assert.match(prompt, /giữ thứ tự FIFO/i);
assert.match(prompt, /reload\/mất kết nối\/rollover/i);

const managerMain = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
const agentLoop = fs.readFileSync(new URL("../electron/worker-core/mcp-agent-loop.mjs", import.meta.url), "utf8");
const repoTaskTools = fs.readFileSync(new URL("../../src/repoTaskTools.ts", import.meta.url), "utf8");
const globalRules = fs.readFileSync(new URL("../../src/globalRules.ts", import.meta.url), "utf8");
const codexProAgents = fs.readFileSync(new URL("../../AGENTS.md", import.meta.url), "utf8");
const codexProInjectedPolicy = `${prompt}\n${codexProAgents}`;

assert.match(managerMain, /buildAutonomousTaskExecutionPolicy\(taskId\)/, "Chrome workers must receive the autonomous task policy");
assert.match(managerMain, /task_size[^\n]*small\|medium\|large/, "Chrome task bootstrap must require a size classification");
assert.match(agentLoop, /buildAutonomousTaskExecutionPolicy\(jobId\)/, "API workers must receive the same autonomous task policy");
assert.match(agentLoop, /task_size: requestedTaskSize/, "API task bootstrap must persist its size classification");
assert.match(repoTaskTools, /# Mandatory Repository Instructions[\s\S]*codexContext\?\.text/, "begin_repo_task must expose the loaded repository instructions to Chrome workers");
assert.match(repoTaskTools, /repository_instructions:\s*codexContext\?\.text/, "begin_repo_task must return repository instructions in structured bootstrap data");
assert.match(agentLoop, /repository_instructions[\s\S]*# Mandatory Repository Instructions/, "API workers must inject repository instructions into the provider system message");

assert.match(codexProInjectedPolicy, /NO NEW FEATURES/i, "CodexPro tasks must receive the feature freeze");
assert.match(codexProInjectedPolicy, /NO OPTIONAL REFACTORING/i, "CodexPro tasks must forbid optional refactoring");
assert.match(codexProInjectedPolicy, /ROOT CAUSE BEFORE FIX/i, "CodexPro tasks must require root-cause investigation before a fix");
assert.match(codexProInjectedPolicy, /OBSERVABILITY FIRST WHEN EVIDENCE IS INSUFFICIENT/i, "CodexPro tasks must instrument before guessing when evidence is insufficient");
assert.match(codexProInjectedPolicy, /REGRESSION MUST MATCH THE FAILURE MODE/i, "CodexPro tasks must require a failure-mode regression");
assert.match(codexProInjectedPolicy, /AUTOMATED TESTS ARE NOT FINAL ACCEPTANCE FOR USER-VISIBLE BUGS/i, "CodexPro tasks must require real-user acceptance for user-visible bugs");
assert.match(codexProInjectedPolicy, /smoke\/build PASS does not by itself mean the bug is fixed/i, "CodexPro tasks must not equate smoke PASS with fixed");
assert.match(codexProInjectedPolicy, /WAITING_RUNTIME_ACCEPTANCE[\s\S]*BLOCKED[\s\S]*do not fake PASS/i, "CodexPro tasks must block rather than fake runtime acceptance");

assert.doesNotMatch(prompt, /NO NEW FEATURES/i, "the generic task policy must not freeze unrelated repositories");
assert.doesNotMatch(globalRules, /NO NEW FEATURES/i, "global CodexPro rules must not freeze unrelated repositories");
assert.match(codexProAgents, /These rules apply to this CodexPro repository only/i, "the feature freeze must explicitly remain repository-specific");

console.log("task-execution-policy-smoke: ok");
