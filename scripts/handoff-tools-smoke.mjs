import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexProError } from "../src/guard.js";
import { registerHandoffTools } from "../src/handoffTools.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-handoff-tools-"));
const contextDir = ".ai-bridge";
const bridgeRoot = path.join(tempRoot, contextDir);
fs.mkdirSync(bridgeRoot, { recursive: true });

const workspace = { id: "ws-handoff", root: tempRoot, openedAt: "2026-01-01T00:00:00.000Z" };
const server = {};
const workspaces = {};
const config = { contextDir, maxReadBytes: 200_000 };
const registered = new Map();
const registrationOrder = [];
let exportedOptions;
let codexOptions;

const guard = {
  resolve(_workspace, filePath) {
    const relPath = String(filePath).replace(/\\/g, "/");
    return { absPath: path.join(tempRoot, ...relPath.split("/")), relPath };
  },
  async assertTextFile(absPath, maxBytes) {
    const stat = await fsp.stat(absPath);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("invalid text fixture");
  }
};

function cleanOneLine(value, fallback, maxLength = 120) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, maxLength);
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function diffBlock(diff) {
  return diff ? `\n\n\`\`\`diff\n${diff}\n\`\`\`` : "";
}

function previewText(value, maxLines = 40, maxChars = 12_000) {
  const lines = String(value).split(/\r?\n/).slice(0, maxLines).join("\n");
  return lines.length > maxChars ? `${lines.slice(0, maxChars)}\n...[preview truncated]` : lines;
}

function limitInt(value, fallback, min, max) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, Math.floor(numeric))) : fallback;
}

const helpers = { cleanOneLine, parseBool, diffBlock, previewText, limitInt };
const annotations = { readOnly: { readOnlyHint: true }, handoffWrite: { readOnlyHint: false } };

const dependencies = {
  ensureAiBridge: async () => { await fsp.mkdir(bridgeRoot, { recursive: true }); },
  writeTextFile: async (_config, _guard, _workspace, filePath, content) => {
    const absPath = path.join(tempRoot, ...filePath.split("/"));
    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    const before = fs.existsSync(absPath) ? await fsp.readFile(absPath, "utf8") : "";
    await fsp.writeFile(absPath, content, "utf8");
    return {
      path: filePath,
      bytes: Buffer.byteLength(content),
      diff: {
        additions: content.split(/\r?\n/).length,
        deletions: before ? before.split(/\r?\n/).length : 0,
        diff: `--- before\n+++ after\n@@ fixture @@\n+${content.split(/\r?\n/)[0]}`
      }
    };
  },
  readAiBridgeContext: async () => ({ text: "handoff context body", files: [".ai-bridge/current-plan.md", ".ai-bridge/agent-status.md"] }),
  readCodexContext: async (_config, _guard, _workspace, options) => {
    codexOptions = options;
    return {
      text: "codex context body",
      workspaceId: workspace.id,
      root: workspace.root,
      targetPath: options.targetPath ?? ".",
      agentsFiles: ["AGENTS.md"],
      aiContextFiles: [".ai-bridge/current-plan.md"],
      gitStatus: options.includeGit === false ? undefined : "M fixture",
      gitDiff: options.includeDiff ? "diff fixture" : undefined
    };
  },
  exportProContext: async (_config, _guard, _workspace, options) => {
    exportedOptions = options;
    return {
      path: ".ai-bridge/pro-context.md",
      bytes: 1234,
      filesIncluded: ["AGENTS.md", "src/server.ts"],
      filesSkipped: ["node_modules"],
      truncated: false
    };
  },
  toolCardMeta: () => ({ fixture_meta: true }),
  readGlobalRulesSnapshot: async () => ({ path: "C:/fixture/CODEXPRO.md", text: "global rule", sha256: "rules-hash", source: "file" }),
  withGlobalRules: (text, rules) => `RULES:${rules.sha256}\n${text}`,
  redactSensitiveText: (text) => text,
  textResult: (text, structuredContent = {}) => ({ content: [{ type: "text", text }], structuredContent })
};

function registerCodexTool(_config, _server, name, options, handler) {
  registrationOrder.push(name);
  registered.set(name, { options, handler });
}

const baseOptions = {
  config,
  server,
  workspaces,
  guard,
  registerCodexTool,
  workspaceForTool: () => workspace,
  helpers,
  annotations,
  dependencies
};

function handler(name) {
  const entry = registered.get(name);
  assert.ok(entry, `missing registered handler ${name}`);
  return entry.handler;
}

try {
  registerHandoffTools({ ...baseOptions, phase: "context" });
  assert.deepEqual(registrationOrder, ["read_handoff", "wait_for_handoff", "codex_context", "export_pro_context"]);
  registrationOrder.push("browser_control");
  registerHandoffTools({ ...baseOptions, phase: "handoff" });
  assert.deepEqual(registrationOrder, [
    "read_handoff",
    "wait_for_handoff",
    "codex_context",
    "export_pro_context",
    "browser_control",
    "handoff_to_agent",
    "handoff_to_codex"
  ]);

  const readResult = await handler("read_handoff")({});
  assert.equal(readResult.structuredContent.workspace_id, workspace.id);
  assert.equal(readResult.structuredContent.file_count, 2);
  assert.equal(readResult.structuredContent.preview, "handoff context body");

  await assert.rejects(
    handler("handoff_to_agent")({ agent: "bad agent!", plan: "do work" }),
    (error) => error instanceof CodexProError && error.message === "agent must use only lowercase letters, numbers, dots, underscores, or hyphens."
  );
  await assert.rejects(
    handler("handoff_to_agent")({ agent: "custom", plan: "   " }),
    (error) => error instanceof CodexProError && error.message === "plan must not be empty."
  );

  const first = await handler("handoff_to_agent")({
    agent: "OpenCode",
    agent_name: "Open Code Worker",
    model: " provider/model ",
    title: " First handoff ",
    plan: "Implement first plan",
    append: false
  });
  assert.equal(first.structuredContent.agent, "opencode");
  assert.equal(first.structuredContent.agent_name, "Open Code Worker");
  assert.equal(first.structuredContent.model, "provider/model");
  assert.equal(first.structuredContent.plan_path, ".ai-bridge/current-plan.md");
  assert.equal(first.structuredContent.status_path, ".ai-bridge/agent-status.md");
  assert.equal(first.structuredContent.diff_path, ".ai-bridge/implementation-diff.patch");
  assert.equal(first.structuredContent.log_path, ".ai-bridge/session-log.jsonl");
  assert.equal(first.structuredContent.execution_log_path, ".ai-bridge/execution-log.jsonl");
  let planBody = await fsp.readFile(path.join(bridgeRoot, "current-plan.md"), "utf8");
  assert.match(planBody, /^# First handoff/m);
  assert.match(planBody, /Target agent: Open Code Worker \(opencode\)/);
  assert.match(planBody, /Model: provider\/model/);
  assert.match(planBody, /## Implementation contract/);
  assert.match(first.content[0].text, /opencode run --model 'provider\/model'/);

  await handler("handoff_to_agent")({ agent: "pi", plan: "Implement second plan", append: true });
  planBody = await fsp.readFile(path.join(bridgeRoot, "current-plan.md"), "utf8");
  assert.match(planBody, /Implement first plan/);
  assert.match(planBody, /\n\n---\n\n# Agent implementation plan/);
  assert.match(planBody, /Implement second plan/);

  const sessionEvents = (await fsp.readFile(path.join(bridgeRoot, "session-log.jsonl"), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  const executionEvents = (await fsp.readFile(path.join(bridgeRoot, "execution-log.jsonl"), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(sessionEvents.length, 2);
  assert.equal(executionEvents.length, 2);
  assert.equal(sessionEvents[0].event, "handoff_to_agent");
  assert.equal(sessionEvents[0].agent, "opencode");
  assert.match(sessionEvents[0].ts, /^\d{4}-\d{2}-\d{2}T/);

  const codex = await handler("handoff_to_codex")({ title: "Codex compatibility", plan: "Implement via Codex", append: false });
  assert.equal(codex.structuredContent.agent, "codex");
  assert.equal(codex.structuredContent.agent_name, "Codex");
  assert.match(codex.content[0].text, /legacy Codex handoffs/);
  const sessionAfterCodex = (await fsp.readFile(path.join(bridgeRoot, "session-log.jsonl"), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(sessionAfterCodex.at(-1).event, "handoff_to_codex");

  const statePath = path.join(bridgeRoot, "handoff-run-state.json");
  await fsp.writeFile(statePath, JSON.stringify({ state: "running", plan_hash: "pending-hash", iteration: 2 }), "utf8");
  const pending = await handler("wait_for_handoff")({ max_wait_seconds: 1, poll_ms: 250 });
  assert.equal(pending.structuredContent.state, "running");
  assert.equal(pending.structuredContent.awaited_terminal, false);
  assert.equal(pending.structuredContent.awaited_completed, false);
  assert.equal(pending.structuredContent.next_poll_after_seconds, 1);

  await fsp.writeFile(path.join(bridgeRoot, "agent-status.md"), "status done", "utf8");
  await fsp.writeFile(path.join(bridgeRoot, "implementation-diff.patch"), "diff done", "utf8");
  await fsp.writeFile(path.join(bridgeRoot, "loop-tests.txt"), "tests pass", "utf8");
  await fsp.writeFile(path.join(bridgeRoot, "execution-log.jsonl"), Array.from({ length: 25 }, (_, index) => `log-${index + 1}`).join("\n") + "\n", "utf8");
  await fsp.writeFile(statePath, JSON.stringify({
    state: "completed",
    plan_hash: "terminal-hash",
    iteration: 3,
    exit_code: 0,
    timed_out: false,
    status_file: ".ai-bridge/agent-status.md",
    diff_file: ".ai-bridge/implementation-diff.patch",
    log_file: ".ai-bridge/execution-log.jsonl",
    tests_file: ".ai-bridge/loop-tests.txt",
    executor: "fixture",
    model: "fixture/model"
  }), "utf8");
  const terminal = await handler("wait_for_handoff")({ plan_hash: "terminal-hash", max_wait_seconds: 1, poll_ms: 250 });
  assert.equal(terminal.structuredContent.state, "completed");
  assert.equal(terminal.structuredContent.awaited_terminal, true);
  assert.equal(terminal.structuredContent.awaited_completed, true);
  assert.equal(terminal.structuredContent.succeeded, true);
  assert.equal(terminal.structuredContent.status_excerpt, "status done");
  assert.equal(terminal.structuredContent.diff_excerpt, "diff done");
  assert.equal(terminal.structuredContent.tests_excerpt, "tests pass");
  assert.match(terminal.structuredContent.log_excerpt, /^log-6/m);
  assert.doesNotMatch(terminal.structuredContent.log_excerpt, /log-5/);
  assert.match(terminal.content[0].text, /## Status/);
  assert.equal("next_poll_after_seconds" in terminal.structuredContent, false);

  const mismatch = await handler("wait_for_handoff")({ plan_hash: "different-hash", max_wait_seconds: 1, poll_ms: 250 });
  assert.equal(mismatch.structuredContent.state, "running");
  assert.equal(mismatch.structuredContent.awaited_terminal, false);
  assert.equal(mismatch.structuredContent.plan_hash_mismatch, true);
  assert.equal(mismatch.structuredContent.expected_plan_hash, "different-hash");

  const contextResult = await handler("codex_context")({
    target_path: "src",
    include_ai_bridge: false,
    include_git: true,
    include_diff: true,
    max_agent_bytes: 4321
  });
  assert.match(contextResult.content[0].text, /^RULES:rules-hash\ncodex context body$/);
  assert.deepEqual(codexOptions, {
    targetPath: "src",
    includeAiBridge: false,
    includeGit: true,
    includeDiff: true,
    maxAgentBytes: 4321
  });
  assert.equal(contextResult.structuredContent.included_git_status, true);
  assert.equal(contextResult.structuredContent.included_git_diff, true);

  const exportResult = await handler("export_pro_context")({
    title: "Bundle",
    selected_paths: ["src/server.ts"],
    extra_globs: ["src/**/*.ts"],
    include_important_files: false,
    include_changed_files: true,
    include_diff: false,
    include_ai_bridge: true,
    max_depth: 4,
    max_files: 12,
    max_file_bytes: 54321,
    max_total_bytes: 123456
  });
  assert.deepEqual(exportedOptions, {
    title: "Bundle",
    selectedPaths: ["src/server.ts"],
    extraGlobs: ["src/**/*.ts"],
    includeImportantFiles: false,
    includeChangedFiles: true,
    includeDiff: false,
    includeAiBridge: true,
    maxDepth: 4,
    maxFiles: 12,
    maxFileBytes: 54321,
    maxTotalBytes: 123456
  });
  assert.equal(exportResult.structuredContent.path, ".ai-bridge/pro-context.md");
  assert.equal(exportResult.structuredContent.bytes, 1234);
  assert.deepEqual(exportResult.structuredContent.files_included, ["AGENTS.md", "src/server.ts"]);

  console.log("handoff-tools smoke passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
