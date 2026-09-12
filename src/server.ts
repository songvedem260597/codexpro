import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CodexProConfig } from "./config.js";
import { WorkspaceManager, PathGuard, CodexProError, type Workspace } from "./guard.js";
import { readTextFile, writeTextFile, editTextFile } from "./fsOps.js";
import { decodeGitQuotedPath } from "./patchOps.js";


import { runBash } from "./bashOps.js";
import { gitDiff, gitDiffStatus, gitLog, gitStatus } from "./gitOps.js";
import { readAiBridgeContext, workspaceSummary } from "./workspaceOps.js";
import { buildProContext } from "./proContext.js";
import { codexproInventory, loadSkill } from "./capabilitiesOps.js";
import { listCodexSessions, readCodexSession } from "./codexSessions.js";
import { TOOL_CARD_URI, descriptorOptionsForConfig, registerToolCardResource, toolCardMeta, usesToolCard } from "./toolCardRegistration.js";
import { CODEXPRO_GLOBAL_RULES_FILE, readGlobalRulesSnapshot, readGlobalRulesSnapshotSync, withGlobalRules } from "./globalRules.js";

import { errorResult, errorText, textResult } from "./toolResults.js";
import { createToolRegistrationRuntime } from "./toolRegistration.js";
import { createRepoTaskRuntime } from "./repoTaskRuntime.js";
import { registerRepoTaskTools } from "./repoTaskTools.js";
import { registerHandoffTools } from "./handoffTools.js";
import { registerBrowserControlTool } from "./browserControlTool.js";
import { registerWorkspaceFileTools } from "./workspaceFileTools.js";
import { inspectWorkspace, reviewWorkspaceChanges } from "./analysis/index.js";
import { projectCompactGraph } from "./analysis/projection.js";


import { ensureBrowserExtensionBridge, getBrowserExtensionProfileWorkspaceBinding, setBrowserExtensionProfileWorkspace } from "./browserExtensionBridge.js";
import { recordMcpUsage } from "./mcpUsage.js";
import { codexProHome } from "./profileStore.js";

import { createWorkerJobToolDefinitions } from "./workerJobTools.js";
import { readWorkspaceCoordinationStatus, readWorkspaceTaskCoordinationStatus } from "./workspaceCoordination.js";
import { TASK_TRACKING_WORKER_RULE } from "./taskTracking.js";
import { shouldRegisterTool, toolNamesForMode } from "./toolSurface.js";


function countTextLines(value: string | undefined): number {
  if (!value) return 0;
  return value.split(/\r?\n/).filter((line) => line.length > 0).length;
}

function bashTextResult(config: CodexProConfig, result: Awaited<ReturnType<typeof runBash>>): string {
  if (config.bashTranscript === "full") {
    return `# Bash\n\n\`\`\`bash\n$ ${result.command}\n\`\`\`\n\nCWD: ${result.cwd}\nExit: ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}\nDuration: ${result.durationMs} ms\n\n## stdout\n\n\`\`\`text\n${result.stdout || ""}\n\`\`\`\n\n## stderr\n\n\`\`\`text\n${result.stderr || ""}\n\`\`\``;
  }

  const stdoutLines = countTextLines(result.stdout);
  const stderrLines = countTextLines(result.stderr);
  return [
    "# Bash",
    "",
    `\`${result.command}\``,
    "",
    `CWD: ${result.cwd}`,
    `Exit: ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}`,
    `Duration: ${result.durationMs} ms`,
    `Output: stdout ${stdoutLines} line${stdoutLines === 1 ? "" : "s"}, stderr ${stderrLines} line${stderrLines === 1 ? "" : "s"}.`,
    "",
    "Raw stdout/stderr are in the structured CodexPro card. Start with `--bash-transcript full` to print raw output in chat."
  ].join("\n");
}

const SUPERTOOL_NAME = "codexpro";
const SUPERTOOL_ACTION_ALIASES: Record<string, string> = {
  actions: "list_actions",
  config: "server_config",
  self_test: "codexpro_self_test",
  inventory: "codexpro_inventory",
  open: "open_current_workspace",
  snapshot: "workspace_snapshot",
  changes: "show_changes",
  handoff_poll: "wait_for_handoff",
  pro_export: "export_pro_context",
  agent_handoff: "handoff_to_agent",
  codex_handoff: "handoff_to_codex"
};

const runtimeTraceWorkspaceByServer = new WeakMap<object, () => Workspace | undefined>();
const repoTaskRuntime = createRepoTaskRuntime();
const {
  configureServer: configureRepoTaskRuntimeServer,
  resolveWorkerJobProfileIdForServer,
  assertRepoTaskGate,
  assertTaskChecklistReady,
  effectiveWorkspaceForServer,
  workspaceForTool,
  workspaceTaskContextForServer
} = repoTaskRuntime;

const {
  initializeServer: initializeToolRegistrationServer,
  registerCodexTool,
  registeredToolHandler,
  registeredToolNames
} = createToolRegistrationRuntime({
  shouldRegisterTool,
  descriptorOptionsForConfig,
  assertRepoTaskGate,
  runtimeTraceWorkspaceForServer: (server) => runtimeTraceWorkspaceByServer.get(server as object)?.(),
  recordMcpUsage
});

function normalizeSupertoolAction(value: unknown): string {
  const raw = String(value ?? "list_actions").trim();
  const normalized = raw.toLowerCase().replace(/[\s-]+/g, "_");
  return SUPERTOOL_ACTION_ALIASES[normalized] ?? normalized;
}


function isContextPath(config: CodexProConfig, relPath: string): boolean {
  const normalized = relPath.split(path.sep).join("/").replace(/^\.\//, "");
  const contextDir = config.contextDir.replace(/^\.\//, "").replace(/\/$/, "");
  return normalized === contextDir || normalized.startsWith(`${contextDir}/`);
}

function assertWriteToolAllowed(config: CodexProConfig, relPath: string): void {
  if (config.writeMode === "workspace") return;
  if (config.writeMode === "handoff" && isContextPath(config, relPath)) return;
  if (config.writeMode === "handoff") {
    throw new CodexProError(
      `Source writes are disabled because CODEXPRO_WRITE_MODE=handoff. ` +
        `Use handoff_to_agent or handoff_to_codex, or write/edit/apply_patch only inside ${config.contextDir}/.`
    );
  }
  throw new CodexProError("write/edit/apply_patch tools are disabled because CODEXPRO_WRITE_MODE=off. handoff_to_agent and handoff_to_codex are still available for planning.");
}

export function serverInstructions(config: CodexProConfig, requireRepoTask = false): string {
  const globalRules = requireRepoTask ? undefined : readGlobalRulesSnapshotSync();
  const editInstruction =
    config.connectionTest
      ? "4. Connection test mode is read-only. Write, patch, export, and handoff-writing tools are unavailable."
      : config.writeMode === "workspace"
      ? "4. Edit source files with write/edit/apply_patch. After edits, call show_changes once for git status, diff stats, and review diff."
      : config.writeMode === "handoff"
        ? "4. Source writes are disabled and generic write/edit/apply_patch tools are unavailable. Use handoff_to_agent/handoff_to_codex for plans."
        : "4. Write/edit/apply_patch tools are disabled. Do not attempt direct file writes; use handoff or context export workflows instead.";
  const bashInstruction =
    config.bashMode === "off"
      ? "5. Bash is disabled and the bash tool is unavailable. Do not attempt shell commands."
      : "5. Use bash only for meaningful verification commands such as npm test, npm run build, lint, typecheck, or an existing project script.";

  return [
    "CodexPro connects ChatGPT to explicitly allowed local development workspaces.",
    "",
    requireRepoTask
      ? `Global rules from ${path.join(codexProHome(), CODEXPRO_GLOBAL_RULES_FILE)} are intentionally not loaded until begin_repo_task declares task_kind="code".`
      : "MANDATORY GLOBAL RULES — loaded before any repository/project tool work:",
    requireRepoTask ? "" : `Source: ${globalRules!.path}`,
    requireRepoTask ? "" : `SHA-256: ${globalRules!.sha256}`,
    requireRepoTask ? "" : (globalRules!.text || "(No global rules configured.)"),
    "",
    "Preferred workflow:",
    requireRepoTask
      ? "1. Every profile-bound ChatGPT task must call begin_repo_task once with a clear 4-6 word task_title, task_kind=general|code, and task_size=small|medium|large. Follow-up messages accepted as adjustments keep the existing Task ID and must not call begin_repo_task again. If Manager supplies an exact task id/root/scope, pass those exact values."
      : "1. Start with open_current_workspace. Use open_workspace only when the user gives a different allowed root or asks to switch projects; that selection stays active for this MCP session.",
    requireRepoTask
      ? `2. task_kind=general records the task title only and does not load global rules or CodexGraph. task_kind=code loads the latest mandatory global rules from ${path.join(codexProHome(), CODEXPRO_GLOBAL_RULES_FILE)}, activates CodexGraph, and binds both to the repository gate. If the rules change, the next gated tool fails closed until begin_repo_task runs again.`
      : `2. The mandatory global rules above come from ${path.join(codexProHome(), CODEXPRO_GLOBAL_RULES_FILE)} and are loaded when the MCP server/session starts. begin_repo_task, open_current_workspace, and open_workspace also return the latest file contents before repo-local AGENTS.md-style instructions.`,
    requireRepoTask
      ? "3. Only after begin_repo_task succeeds with task_kind=code may you use open_current_workspace/open_workspace, tree, search, read, write, or bash. A general task remains workspace-gated."
      : "3. Inspect with tree, search, and read. Do not use bash for git status, git diff, cat, sed, grep, rg, find, ls, or file reading.",
    requireRepoTask ? TASK_TRACKING_WORKER_RULE : "",
    editInstruction,
    bashInstruction,
    "6. Prioritize correctness over minimizing tool calls or context. For non-trivial edits, use structured search with intent=impact/references to inspect CodexGraph callers, state, framework links, and related tests before changing code.",
    "7. write/edit/apply_patch return automatic CodexGraph before/after impact evidence. Treat graph-integrity warnings or removed dependency edges as verification requirements, not harmless noise.",
    "8. CodexGraph augments but never replaces source inspection, typecheck, runtime tests, or broader review when code uses dynamic dispatch, reflection, string-based routing, or unresolved compiler diagnostics.",
    "9. Investigate autonomously before edits. Do not ask the user merely because work is complex or technically ambiguous; use the safest narrow assumption unless product intent, destructive action, credentials, contradictory requirements, or out-of-scope authority truly requires input. Large tasks must report a durable checklist before source writes.",
    config.codexSessions !== "off"
      ? `9. Codex session history access is enabled in ${config.codexSessions} mode. Use it only when the user asks for local Codex session history.`
      : "",
    config.requireBashSession && config.bashSessionId
      ? `10. Bash session guard is enabled. Every bash call must include session_id="${config.bashSessionId}".`
      : config.bashSessionId
        ? `10. Bash session label for this server is "${config.bashSessionId}".`
        : "",
    "",
    `Current modes: tool=${config.toolMode}, bash=${config.bashMode}, write=${config.writeMode}.`
  ].filter(Boolean).join("\n");
}

function limitInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return fallback;
  return ["1", "true", "yes", "y"].includes(String(value).toLowerCase());
}

function diffBlock(diff: string): string {
  return `\n\n\`\`\`diff\n${diff}\n\`\`\``;
}

function diffStats(diff: string): { additions: number; deletions: number; changed: boolean } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions, changed: Boolean(diff.trim()) };
}

async function requireCodexGraphForWorkspace(config: CodexProConfig, guard: PathGuard, workspace: Workspace) {
  if (!config.analysisEnabled) {
    throw new CodexProError("CodexGraph is required for CodexPro Manager repo tasks, but repository analysis is disabled by CODEXPRO_ANALYSIS=0.");
  }
  const analysis = await inspectWorkspace(config, guard, workspace);
  return {
    required: true,
    active: true,
    cache_key: analysis.cache.key,
    cache_hit: analysis.cache.hit,
    fingerprint: analysis.fingerprint,
    coverage: analysis.coverage,
    warnings: analysis.warnings.slice(-8)
  };
}

function reviewCheckpointKey(workspace: Workspace, options: { path?: string; staged: boolean }): string {
  return `${workspace.id}\0${options.path ?? ""}\0${options.staged ? "staged" : "unstaged"}`;
}

function reviewFingerprint(status: string, diff: string): string {
  return createHash("sha256").update(status).update("\0").update(diff).digest("hex");
}

async function untrackedReviewFingerprint(config: CodexProConfig, guard: PathGuard, workspace: Workspace, changedFiles: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const line of changedFiles) {
    const match = line.match(/^\?\?\s+(.+)$/);
    if (!match) continue;
    const relPath = match[1];
    hash.update(relPath).update("\0");
    try {
      const resolved = guard.resolve(workspace, relPath);
      const stat = await fsp.stat(resolved.absPath);
      hash.update(String(stat.size)).update("\0").update(String(Math.floor(stat.mtimeMs))).update("\0");
      if (stat.isFile() && stat.size <= config.maxReadBytes) {
        hash.update(await fsp.readFile(resolved.absPath));
      }
    } catch (error) {
      hash.update(errorText(error));
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function normalizeGitOutput(output: string): string {
  return output.trim() === "(no output)" ? "" : output;
}



function looksLikeGitError(output: string): boolean {
  const trimmed = output.trim();
  const lower = trimmed.toLowerCase();
  return (
    trimmed.startsWith("fatal:") ||
    trimmed.startsWith("error:") ||
    trimmed.startsWith("git unavailable or failed:") ||
    trimmed.startsWith("git exited with status") ||
    trimmed.startsWith("usage: git ") ||
    lower.includes("not a git repository")
  );
}

function previewText(value: string, maxLines = 40, maxChars = 12_000): string {
  const lines = value.replace(/\r\n/g, "\n").split("\n").slice(0, maxLines).join("\n");
  return lines.length > maxChars ? `${lines.slice(0, maxChars)}\n...[preview truncated]` : lines;
}

function changedStatusLines(status: string): string[] {
  return status
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line !== "(no output)" && !line.startsWith("##"));
}

function changedPathsFromStatus(lines: string[]): string[] {
  const paths: string[] = [];
  for (const line of lines) {
    let raw: string;
    if (line.startsWith("?? ")) raw = line.slice(3).trim();
    else if (line.includes("\t")) raw = line.split("\t").pop()?.trim() ?? "";
    else if (/^.{2}\s/.test(line)) raw = line.slice(3).trim();
    else continue;
    if (raw.includes(" -> ")) raw = raw.split(" -> ").pop() ?? raw;
    const decoded = decodeGitQuotedPath(raw);
    if (decoded && !paths.includes(decoded)) paths.push(decoded);
  }
  return paths;
}

function cleanOneLine(value: unknown, fallback: string, maxLength = 120): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, maxLength);
}

const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const SESSION_READ_ANNOTATIONS = { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: false };
const LOCAL_WRITE_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: true, idempotentHint: false };
const BASH_ANNOTATIONS = { readOnlyHint: false, openWorldHint: true, destructiveHint: true, idempotentHint: false };
const HANDOFF_WRITE_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false };
export function createCodexProServer(config: CodexProConfig, options: { browserProfileId?: string; requireRepoTask?: boolean } = {}): McpServer {
  let browserProfileId = String(options.browserProfileId || "").trim();
  const requireRepoTask = options.requireRepoTask ?? Boolean(browserProfileId);
  let selectedRuntimeTraceWorkspace: Workspace | undefined;
  const workspaces = new WorkspaceManager(
    config,
    (workspace) => {
      selectedRuntimeTraceWorkspace = workspace;
      if (browserProfileId) setBrowserExtensionProfileWorkspace(browserProfileId, workspace.root);
    },
    browserProfileId ? () => getBrowserExtensionProfileWorkspaceBinding(browserProfileId) : undefined
  );
  const reviewCheckpoints = new Map<string, string>();
  const guard = new PathGuard(config);
  const server = new McpServer({ name: "CodexPro", version: "0.29.12" }, { instructions: serverInstructions(config, requireRepoTask) });
  runtimeTraceWorkspaceByServer.set(server as object, () => selectedRuntimeTraceWorkspace ?? workspaces.defaultWorkspace());
  configureRepoTaskRuntimeServer(server, {
    requireRepoTask,
    profileId: browserProfileId,
    workspaceSelector: (root) => workspaces.openWorkspace(root)
  });
  if (config.browserControl) ensureBrowserExtensionBridge();
  initializeToolRegistrationServer(server);
  registerToolCardResource(server, config);

  registerCodexTool(
    config,
    server,
    SUPERTOOL_NAME,
    {
      title: "CodexPro Supertool",
      description:
        "Stable wrapper for advanced ChatGPT connector setups. Pass action plus args to call an already-registered CodexPro tool without changing the visible schema; it cannot call tools disabled by the current mode.",
      inputSchema: {
        action: z.string().optional().describe("Action or registered tool name. Use list_actions to see what this server mode allows."),
        args: z.record(z.any()).optional().describe("Arguments for the selected action. Same shape as the wrapped CodexPro tool.")
      },
      annotations: BASH_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Running CodexPro supertool action...",
        "openai/toolInvocation/invoked": "CodexPro supertool action complete"
      }
    },
    async (args) => {
      const action = normalizeSupertoolAction(args.action);
      const names = registeredToolNames(server).filter((name) => name !== SUPERTOOL_NAME);
      if (action === "list_actions" || action === "help") {
        const text = [
          "# CodexPro Supertool",
          "",
          "Use `codexpro` only when a stable wrapper is useful for ChatGPT connector caching or custom workflows. The explicit tools remain the preferred default because they give clearer descriptions and validation.",
          "",
          "## Available actions",
          "",
          names.length ? names.map((name) => `- ${name}`).join("\n") : "- none",
          "",
          "## Usage",
          "",
          "```json",
          JSON.stringify({ action: "search", args: { workspace_id: "ws_...", query: "needle", path: "src" } }, null, 2),
          "```"
        ].join("\n");
        return textResult(text, {
          actions: names,
          action_count: names.length,
          aliases: SUPERTOOL_ACTION_ALIASES,
          tool_mode: config.toolMode,
          bash_mode: config.bashMode,
          write_mode: config.writeMode
        });
      }

      if (action === SUPERTOOL_NAME) {
        throw new CodexProError("codexpro cannot call itself. Use action=list_actions to inspect available wrapped actions.");
      }

      const handler = registeredToolHandler(server, action);
      if (!handler) {
        throw new CodexProError(
          `CodexPro action is not available in the current mode: ${action}. ` +
            "Call codexpro with action=list_actions, or restart CodexPro with a broader tool mode if that action should be exposed."
        );
      }

      const childArgs =
        args.args && typeof args.args === "object" && !Array.isArray(args.args)
          ? args.args
          : {};
      let result: any;
      try {
        result = await handler(childArgs);
      } catch (error) {
        result = errorResult(error);
      }
      if (result && typeof result === "object") {
        const structured = result.structuredContent;
        result.structuredContent = {
          codexpro_tool: action,
          codexpro_title: action,
          codexpro_super_action: action,
          wrapped_tool: action,
          ...(structured && typeof structured === "object" && !Array.isArray(structured) ? structured : {})
        };
      }
      return result;
    }
  );

  registerCodexTool(
    config,
    server,
    "server_config",
    {
      title: "Server Config",
      description: "Show CodexPro server configuration, safety modes, limits, and blocked paths. Does not reveal auth tokens.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading CodexPro server config...",
        "openai/toolInvocation/invoked": "CodexPro server config ready"
      }
    },
    async () => {
      const safeConfig = {
        defaultRoot: config.defaultRoot,
        allowedRoots: config.allowedRoots,
        host: config.host,
        port: config.port,
        widgetDomain: config.widgetDomain,
        authEnabled: Boolean(config.authToken),
        bashMode: config.bashMode,
        safeGitWrites: {
          enabled: config.bashMode !== "off",
          add: "git add <relative files>",
          commit: "git commit -m <message> (hooks and GPG signing disabled)",
          push: "git push origin <branch> (no options; force/delete/tag/alternate remote blocked)"
        },
        bashTranscript: config.bashTranscript,
        bashSessionId: config.bashSessionId ?? null,
        requireBashSession: config.requireBashSession,
        codexSessions: config.codexSessions,
        codexDir: config.codexDir,
        writeMode: config.writeMode,
        toolMode: config.toolMode,
        browserControl: config.browserControl,
        browserDebugUrl: config.browserControl ? config.browserDebugUrl : null,
        toolCards: config.toolCards,
        connectionTest: config.connectionTest,
        analysisEnabled: config.analysisEnabled,
        analysisLimits: config.analysisLimits,
        inheritEnv: config.inheritEnv,
        contextDir: config.contextDir,
        maxReadBytes: config.maxReadBytes,
        maxWriteBytes: config.maxWriteBytes,
        maxOutputBytes: config.maxOutputBytes,
        maxSearchResults: config.maxSearchResults,
        blockedGlobs: config.blockedGlobs,
        registeredTools: registeredToolNames(server),
        registeredToolCount: registeredToolNames(server).length
      };
      return textResult(`# CodexPro Server Config\n\n${JSON.stringify(safeConfig, null, 2)}`, safeConfig);
    }
  );

  registerCodexTool(
    config,
    server,
    "codexpro_self_test",
    {
      title: "CodexPro Self Test",
      description:
        "Run one controlled, local-only CodexPro diagnostic. It checks modes, expected tools, workspace access, skills, git, safe bash policy, selected-only Pro context, and optional .ai-bridge write/edit probe without touching source files.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        write_probe: z.boolean().optional().describe("Create/edit only .ai-bridge/codexpro-self-test.md. Default: true."),
        bash_probe: z.boolean().optional().describe("Check bash policy with safe local commands only. Default: true."),
        pro_context_probe: z.boolean().optional().describe("Build a selected-only Pro context bundle in memory without writing pro-context.md. Default: true."),
        include_global_skills: z.boolean().optional().describe("Include user/plugin skill discovery in the inventory check. Default: true."),
        max_skills: z.number().int().min(1).max(120).optional().describe("Maximum skills to inspect during the inventory check. Default: 40.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Running CodexPro self-test...",
        "openai/toolInvocation/invoked": "CodexPro self-test complete"
      }
    },
    async (args) => {
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const started = Date.now();
      const checks: Array<{ name: string; status: "pass" | "warn" | "fail"; detail: string }> = [];
      const filesTouched: string[] = [];
      const probePath = `${config.contextDir}/codexpro-self-test.md`;

      const check = (name: string, status: "pass" | "warn" | "fail", detail: string) => {
        checks.push({ name, status, detail: cleanOneLine(detail, detail, 260) });
      };

      check("workspace", "pass", workspace.root);
      check("tool mode", config.toolMode === "full" ? "pass" : "warn", `${config.toolMode}; expected tools: ${toolNamesForMode(config, requireRepoTask).length}`);
      check("write mode", config.writeMode === "off" ? "warn" : "pass", config.writeMode);
      check("bash mode", config.bashMode === "full" ? "warn" : "pass", config.bashMode);
      check(
        "http auth",
        "pass",
        config.authToken
          ? "token configured"
          : config.requireHttpToken
            ? "token required when serving HTTP"
            : "token auth explicitly disabled"
      );
      const expectedTools = toolNamesForMode(config, requireRepoTask).sort();
      const actualTools = registeredToolNames(server).sort();
      const missingTools = expectedTools.filter((name) => !actualTools.includes(name));
      const extraTools = actualTools.filter((name) => !expectedTools.includes(name));
      check(
        "registered tool set",
        missingTools.length || extraTools.length ? "fail" : "pass",
        missingTools.length || extraTools.length
          ? `missing: ${missingTools.join(", ") || "none"}; extra: ${extraTools.join(", ") || "none"}`
          : `${actualTools.length} tools registered for ${config.toolMode} mode`
      );

      try {
        const inventory = await codexproInventory(config, workspace, {
          includeGlobalSkills: parseBool(args.include_global_skills, true),
          includeMcpServers: true,
          maxSkills: limitInt(args.max_skills, 40, 1, 120)
        });
        check("inventory", "pass", `${inventory.skills.length} skills inspected, ${inventory.mcpServers.length} MCP server names visible`);
      } catch (error) {
        check("inventory", "fail", errorText(error));
      }

      try {
        const status = await gitStatus(config, workspace);
        const gitFailed = looksLikeGitError(status);
        const changed = gitFailed ? 0 : changedStatusLines(status).length;
        check("git status", gitFailed ? "warn" : "pass", gitFailed ? status : `${changed} changed entries`);
      } catch (error) {
        check("git status", "fail", errorText(error));
      }

      if (parseBool(args.write_probe, true)) {
        if (config.writeMode === "off") {
          check("write/edit probe", "warn", "skipped because CODEXPRO_WRITE_MODE=off");
        } else {
          try {
            assertWriteToolAllowed(config, probePath);
            const content = [
              "# CodexPro Self Test",
              "",
              `Updated: ${new Date().toISOString()}`,
              `Workspace: ${workspace.root}`,
              "marker: before",
              ""
            ].join("\n");
            await writeTextFile(config, guard, workspace, probePath, content, { createDirs: true, overwrite: true });
            await editTextFile(config, guard, workspace, probePath, "marker: before", "marker: after", { expectedReplacements: 1 });
            const readBack = await readTextFile(config, guard, workspace, probePath, { maxBytes: 20_000 });
            if (!readBack.text.includes("marker: after")) throw new CodexProError("self-test edit marker was not found after edit.");
            const scopedStatus = await gitStatus(config, workspace, guard, probePath);
            const scopedFiles = changedStatusLines(scopedStatus);
            filesTouched.push(probePath);
            check(
              "write/edit probe",
              scopedFiles.length && scopedFiles.every((line) => line.includes(probePath)) ? "pass" : "warn",
              scopedFiles.length ? `path-scoped status: ${scopedFiles.join(", ")}` : "path-scoped status clean after write/edit"
            );
          } catch (error) {
            check("write/edit probe", "fail", errorText(error));
          }
        }
      } else {
        check("write/edit probe", "warn", "skipped by request");
      }

      if (parseBool(args.pro_context_probe, true)) {
        try {
          if (!filesTouched.includes(probePath)) {
            check("selected-only pro context", "warn", "skipped because write probe did not create the selected file");
          } else {
            const context = await buildProContext(config, guard, workspace, {
              title: "CodexPro Self Test Context",
              selectedPaths: [probePath],
              includeImportantFiles: false,
              includeChangedFiles: false,
              includeDiff: false,
              includeAiBridge: false,
              maxFiles: 4,
              maxTotalBytes: 80_000
            });
            const exactOnly = context.filesIncluded.length === 1 && context.filesIncluded[0] === probePath;
            check(
              "selected-only pro context",
              exactOnly ? "pass" : "fail",
              exactOnly ? `included only ${probePath}` : `included ${context.filesIncluded.join(", ") || "no files"}`
            );
          }
        } catch (error) {
          check("selected-only pro context", "fail", errorText(error));
        }
      } else {
        check("selected-only pro context", "warn", "skipped by request");
      }

      if (parseBool(args.bash_probe, true)) {
        try {
          if (config.bashMode === "off") {
            check("bash policy", "warn", "bash disabled");
          } else {
            const bashProbeOptions = { timeoutMs: 10_000, sessionId: config.bashSessionId };
            const pwd = await runBash(config, guard, workspace, "pwd", bashProbeOptions);
            if (config.bashMode === "safe") {
              try {
                await runBash(config, guard, workspace, "ls $HOME", bashProbeOptions);
                check("bash policy", "fail", "safe bash allowed environment expansion unexpectedly");
              } catch {
                check("bash policy", pwd.exitCode === 0 ? "pass" : "warn", "safe bash allowed pwd and blocked environment expansion");
              }
            } else {
              check("bash policy", pwd.exitCode === 0 ? "warn" : "fail", "full bash is enabled; use only for trusted local repos");
            }
          }
        } catch (error) {
          check("bash policy", "fail", errorText(error));
        }
      } else {
        check("bash policy", "warn", "skipped by request");
      }

      check(
        "terms boundary",
        "pass",
        "local workspace bridge only; does not provide models, proxy model access, bypass quotas, or execute remote/local agents from MCP"
      );

      const failed = checks.filter((item) => item.status === "fail").length;
      const warned = checks.filter((item) => item.status === "warn").length;
      const passed = checks.filter((item) => item.status === "pass").length;
      const status = failed ? "fail" : warned ? "warn" : "pass";
      const text = [
        "# CodexPro Self Test",
        "",
        `Status: ${status}`,
        `Workspace: ${workspace.root}`,
        `Mode: tools=${config.toolMode}, write=${config.writeMode}, bash=${config.bashMode}${config.bashSessionId ? `, bash_session=${config.bashSessionId}${config.requireBashSession ? " required" : ""}` : ""}`,
        `Expected tools: ${expectedTools.length}`,
        `Registered tools: ${actualTools.length}`,
        `Duration: ${Date.now() - started} ms`,
        "",
        "## Checks",
        "",
        ...checks.map((item) => `- ${item.status.toUpperCase()} ${item.name}: ${item.detail}`),
        "",
        "## Terms Boundary",
        "",
        "CodexPro exposes local repo tools to the ChatGPT session the user controls. It does not provide models, proxy model access, resell access, modify quotas, bypass limits, or run local implementation agents through remote MCP tools."
      ].join("\n");

      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        status,
        passed,
        warned,
        failed,
        duration_ms: Date.now() - started,
        expected_tools: expectedTools,
        expected_tool_count: expectedTools.length,
        registered_tools: actualTools,
        registered_tool_count: actualTools.length,
        bash_mode: config.bashMode,
        bash_session_id: config.bashSessionId ?? null,
        require_bash_session: config.requireBashSession,
        write_mode: config.writeMode,
        tool_mode: config.toolMode,
        files_touched: filesTouched,
        checks,
        terms_boundary: {
          local_workspace_bridge: true,
          provides_models: false,
          proxies_model_access: false,
          bypasses_quotas: false,
          remote_agent_execution: false
        }
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "codexpro_inventory",
    {
      title: "CodexPro Inventory",
      description:
        "List CodexPro modes plus discovered skill names and configured MCP server names. Use this early when planning needs local agent capabilities.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        include_global_skills: z.boolean().optional().describe("Include user and plugin skill folders. Default: true."),
        include_mcp_servers: z.boolean().optional().describe("Include configured MCP server names from safe config files. Default: true."),
        max_skills: z.number().int().min(1).max(500).optional().describe("Maximum skills to list. Default: 120.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading CodexPro inventory...",
        "openai/toolInvocation/invoked": "CodexPro inventory ready"
      }
    },
    async (args) => {
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const inventory = await codexproInventory(config, workspace, {
        includeGlobalSkills: parseBool(args.include_global_skills, true),
        includeMcpServers: parseBool(args.include_mcp_servers, true),
        maxSkills: limitInt(args.max_skills, 120, 1, 500)
      });
      return textResult(inventory.text, {
        workspace_id: workspace.id,
        root: workspace.root,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode,
        skills: inventory.skills,
        skill_count: inventory.skills.length,
        mcp_servers: inventory.mcpServers,
        mcp_server_count: inventory.mcpServers.length,
        widget_uri: TOOL_CARD_URI
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "load_skill",
    {
      title: "Load Skill",
      description:
        "Load the bounded SKILL.md body for a discovered workspace, user, or plugin skill by name. Does not accept arbitrary paths; use after open_current_workspace/open_workspace shows skill_inventory.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        name: z.string().describe("Exact skill name from skill_inventory or codexpro_inventory."),
        source: z.enum(["workspace", "user", "plugin", "other"]).optional().describe("Optional source override. Without it, the highest-precedence skill is loaded."),
        path: z.string().optional().describe("Optional exact sanitized path override for diagnostics or an explicitly selected suppressed duplicate."),
        include_global_skills: z.boolean().optional().describe("Also scan installed user/plugin skills. Default: auto when source/path is not workspace."),
        max_skills: z.number().int().min(1).max(500).optional().describe("Maximum skills to scan while resolving the requested skill. Default: 500."),
        max_bytes: z.number().int().min(1000).max(100000).optional().describe("Maximum bytes to return from SKILL.md. Default: 40000.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Loading skill instructions...",
        "openai/toolInvocation/invoked": "Skill instructions loaded"
      }
    },
    async (args) => {
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const requestedPath = typeof args.path === "string" ? args.path : undefined;
      const includeGlobalDefault =
        args.source === undefined ||
        (args.source !== undefined && args.source !== "workspace") ||
        Boolean(requestedPath && !requestedPath.startsWith("$WORKSPACE/"));
      const loaded = await loadSkill(workspace, {
        name: String(args.name ?? ""),
        source: args.source,
        path: requestedPath,
        includeGlobal: parseBool(args.include_global_skills, includeGlobalDefault),
        maxSkills: limitInt(args.max_skills, 500, 1, 500),
        maxBytes: limitInt(args.max_bytes, 40_000, 1_000, 100_000)
      });
      const truncated = loaded.truncated ? "\n\n[truncated: increase max_bytes if more context is required]" : "";
      const text = `# Load Skill\n\nName: ${loaded.skill.name}\nSource: ${loaded.skill.source}\nPath: ${loaded.skill.path}\nBytes: ${loaded.bytes}/${loaded.totalBytes}\n\n\`\`\`markdown\n${loaded.text}${truncated}\n\`\`\``;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        skill: loaded.skill,
        bytes: loaded.bytes,
        total_bytes: loaded.totalBytes,
        truncated: loaded.truncated,
        text: loaded.text
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "list_workspaces",
    {
      title: "List Workspaces",
      description: "List workspaces opened in this MCP session and identify the currently selected workspace.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Listing CodexPro workspaces...",
        "openai/toolInvocation/invoked": "CodexPro workspaces listed"
      }
    },
    async () => {
      const selectedWorkspaceId = workspaces.currentWorkspaceId();
      const current = workspaces.listWorkspaces();
      const text = current
        .map((workspace) => `- ${workspace.id} — ${workspace.root}${workspace.id === selectedWorkspaceId ? " (selected)" : ""} (opened ${workspace.openedAt})`)
        .join("\n");
      return textResult(text, {
        workspaces: current,
        count: current.length,
        selected_workspace_id: selectedWorkspaceId
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "open_current_workspace",
    {
      title: "Open Current Workspace",
      description:
        "Open and select the configured default workspace for this MCP session. Use this to return to the launch workspace after switching roots.",
      inputSchema: {
        include_tree: z.boolean().optional().describe("Include a compact file tree. Default: false for speed."),
        max_depth: z.number().int().min(1).max(8).optional().describe("Tree depth when include_tree=true. Default: 2."),
        include_skills: z.boolean().optional().describe("Discover skills by name/description. Default: false for speed."),
        include_global_skills: z.boolean().optional().describe("Also scan installed user/plugin skills when include_skills=true. Default: false.")
      },
      annotations: SESSION_READ_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Opening current CodexPro workspace...",
        "openai/toolInvocation/invoked": "Current CodexPro workspace opened"
      }
    },
    async (args) => {
      const workspace = effectiveWorkspaceForServer(server, workspaces.selectDefaultWorkspace());
      const globalRules = await readGlobalRulesSnapshot();
      const summary = await workspaceSummary(config, guard, workspace, {
        includeTree: parseBool(args.include_tree, false),
        maxDepth: limitInt(args.max_depth, 2, 1, 8),
        includeSkills: parseBool(args.include_skills, false),
        includeGlobalSkills: parseBool(args.include_global_skills, false),
        bootstrapContext: false
      });
      return textResult(withGlobalRules(summary.text, globalRules), {
        workspace_id: summary.workspaceId,
        selected_workspace_id: summary.workspaceId,
        root: summary.root,
        agents_loaded: summary.agentsLoaded,
        agents_path: summary.agentsPath,
        skills: summary.skills,
        skill_inventory: summary.skillInventory,
        skill_counts: summary.skillCounts,
        tree: summary.tree,
        git_status: summary.gitStatus,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode
      });
    }
  );

  registerRepoTaskTools({
    config,
    server,
    workspaces,
    guard,
    requireRepoTask,
    registerCodexTool,
    runtime: repoTaskRuntime,
    requireCodexGraphForWorkspace,
    setBrowserProfileId: (profileId) => { browserProfileId = profileId; },
    annotations: {
      readOnly: READ_ONLY_ANNOTATIONS,
      sessionRead: SESSION_READ_ANNOTATIONS,
      handoffWrite: HANDOFF_WRITE_ANNOTATIONS
    }
  });
  registerCodexTool(
    config,
    server,
    "workspace_coordination_status",
    {
      title: "Workspace Coordination Status",
      description: "Read multi-agent workspace ownership, worktree, stale-base, conflict, and integration queue state for a repo. Pass task_id for a bounded authoritative delivery decision for exactly one task.",
      inputSchema: {
        root: z.string().min(1).optional(),
        task_id: z.string().regex(/^cpt_[a-f0-9]{24}$/).optional().describe("Optional exact task id. When present, return compact task coordination state instead of the full workspace overview.")
      },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) => {
      const workspace = workspaces.openWorkspace(args.root, { select: false });
      if (args.task_id) {
        const snapshot = await readWorkspaceTaskCoordinationStatus(workspace.root, args.task_id);
        return textResult(`# Task Coordination\n\n${args.task_id}: ${snapshot.safe_for_delivery ? "SAFE" : "BLOCKED"} for delivery.`, snapshot);
      }
      const snapshot = await readWorkspaceCoordinationStatus(workspace.root);
      const activeTasks = snapshot.tasks.filter((task) => task.status === "running").length;
      const conflicts = snapshot.tasks.filter((task) => task.integration_status === "conflict" || task.stale_base).length;
      return textResult(`# Workspace Coordination\n\n${activeTasks} active task(s), ${snapshot.claims.length} claimed path(s), ${snapshot.integration_queue.length} queued integration(s).`, {
        ...snapshot,
        active_task_count: activeTasks,
        conflict_count: conflicts
      });
    }
  );

  for (const tool of createWorkerJobToolDefinitions({
    serverKey: server as object,
    resolveProfileId: resolveWorkerJobProfileIdForServer,
    textResult,
    readOnlyAnnotations: READ_ONLY_ANNOTATIONS,
    handoffWriteAnnotations: HANDOFF_WRITE_ANNOTATIONS
  })) {
    registerCodexTool(config, server, tool.name, tool.options, tool.handler);
  }

  registerCodexTool(
    config,
    server,
    "open_workspace",
    {
      title: "Open Workspace",
      description:
        "Open and select an allowed local project for this MCP session. Later tool calls may omit workspace_id to use this selection.",
      inputSchema: {
        root: z.string().optional().describe("Project directory to open. Omit to use CODEXPRO_ROOT/current working directory. Supports ~/ paths."),
        path: z.string().optional().describe("Alias for root. Useful for clients that naturally send path instead of root."),
        include_tree: z.boolean().optional().describe("Include a compact file tree. Default: true."),
        max_depth: z.number().int().min(1).max(8).optional().describe("Tree depth. Default: 3."),
        max_files: z.number().int().min(1).max(3000).optional().describe("Alias for maximum tree entries. Default: 500."),
        include_skills: z.boolean().optional().describe("Discover skills by name/description. Default: false for speed."),
        include_global_skills: z.boolean().optional().describe("Also scan installed user/plugin skills when include_skills=true. Default: false."),
        bootstrap_context: z.boolean().optional().describe("Deprecated and ignored. Use handoff_to_agent to create .ai-bridge files.")
      },
      annotations: SESSION_READ_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Opening CodexPro workspace...",
        "openai/toolInvocation/invoked": "CodexPro workspace opened"
      }
    },
    async (args) => {
      if (args.root && args.path && args.root !== args.path) {
        throw new CodexProError("open_workspace accepts either root or path. If both are provided, they must match.");
      }
      const workspace = effectiveWorkspaceForServer(server, workspaces.openWorkspace(args.root ?? args.path));
      const globalRules = await readGlobalRulesSnapshot();
      const summary = await workspaceSummary(config, guard, workspace, {
        includeTree: args.include_tree !== false,
        maxDepth: limitInt(args.max_depth, 3, 1, 8),
        maxEntries: limitInt(args.max_files, 500, 1, 3000),
        includeSkills: parseBool(args.include_skills, false),
        includeGlobalSkills: parseBool(args.include_global_skills, false),
        bootstrapContext: false
      });
      return textResult(withGlobalRules(summary.text, globalRules), {
        workspace_id: summary.workspaceId,
        selected_workspace_id: summary.workspaceId,
        root: summary.root,
        agents_loaded: summary.agentsLoaded,
        agents_path: summary.agentsPath,
        skills: summary.skills,
        skill_inventory: summary.skillInventory,
        skill_counts: summary.skillCounts,
        tree: summary.tree,
        git_status: summary.gitStatus,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "workspace_snapshot",
    {
      title: "Workspace Snapshot",
      description: "Return git status, recent commits, .ai-bridge context, and a compact tree for an opened workspace.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        max_depth: z.number().int().min(1).max(8).optional().describe("Tree depth. Default: 3."),
        max_files: z.number().int().min(1).max(3000).optional().describe("Alias for maximum tree entries. Default: 500."),
        include_skills: z.boolean().optional().describe("Discover repo-local skills. Default: false for speed."),
        include_global_skills: z.boolean().optional().describe("Also scan home-level skill folders when include_skills=true. Default: false.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Collecting workspace snapshot...",
        "openai/toolInvocation/invoked": "Workspace snapshot ready"
      }
    },
    async (args) => {
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const summary = await workspaceSummary(config, guard, workspace, {
        includeTree: true,
        maxDepth: limitInt(args.max_depth, 3, 1, 8),
        maxEntries: limitInt(args.max_files, 500, 1, 3000),
        includeSkills: parseBool(args.include_skills, false),
        includeGlobalSkills: parseBool(args.include_global_skills, false)
      });
      const ai = await readAiBridgeContext(config, guard, workspace);
      const globalRules = await readGlobalRulesSnapshot();
      const text = withGlobalRules(`${summary.text}\n\n## AI handoff context\n\n${ai.text}`, globalRules);
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        agents_loaded: summary.agentsLoaded,
        agents_path: summary.agentsPath,
        skills: summary.skills,
        skill_inventory: summary.skillInventory,
        skill_counts: summary.skillCounts,
        tree: summary.tree,
        git_status: summary.gitStatus,
        ai_context_files: ai.files,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "inspect_workspace",
    {
      title: "Inspect Workspace",
      description: "Build a bounded repository map with languages, project types, entrypoints, areas, symbols, relationships, and coverage warnings.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().optional().describe("Optional workspace-relative area to emphasize. Default: entire workspace."),
        max_files: z.number().int().min(1).max(100000).optional().describe("Maximum returned file records. Default: 300."),
        include_symbols: z.boolean().optional().describe("Include symbols in structured output. Default: true."),
        include_relationships: z.boolean().optional().describe("Include relationships in structured output. Default: true."),
        max_symbols: z.number().int().min(1).max(100000).optional().describe("Maximum returned symbols. Analysis remains bounded by server config."),
        max_relationships: z.number().int().min(1).max(250000).optional().describe("Maximum returned relationships. Analysis remains bounded by server config.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Inspecting workspace analysis...",
        "openai/toolInvocation/invoked": "Workspace analysis ready"
      }
    },
    async (args) => {
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      if (args.path) guard.resolve(workspace, args.path);
      const result = await inspectWorkspace(config, guard, workspace);
      const prefix = typeof args.path === "string" && args.path.trim()
        ? guard.resolve(workspace, args.path).relPath.replace(/^\.\/?$/, "")
        : "";
      const inScope = (filePath: string) => !prefix || filePath === prefix || filePath.startsWith(`${prefix}/`);
      const areaInScope = (areaPath: string) => !prefix || areaPath === "." || inScope(areaPath) || prefix.startsWith(`${areaPath}/`);
      const cardWorkspaceAnalysis = usesToolCard(config, "inspect_workspace");
      const fileLimit = cardWorkspaceAnalysis ? 120 : limitInt(args.max_files, 300, 1, config.analysisLimits.maxInventoryFiles);
      const symbolLimit = cardWorkspaceAnalysis ? 80 : limitInt(args.max_symbols, 500, 1, config.analysisLimits.maxSymbols);
      const relationshipLimit = cardWorkspaceAnalysis ? 120 : limitInt(args.max_relationships, 800, 1, config.analysisLimits.maxRelationships);
      const scopedFiles = result.files.filter((file) => inScope(file.path));
      const scopedSymbols = result.symbols.filter((symbol) => inScope(symbol.path));
      const scopedRelationships = result.relationships.filter((relationship) => inScope(relationship.from) || inScope(relationship.to));
      const files = scopedFiles.slice(0, fileLimit);
      const symbols = args.include_symbols === false
        ? []
        : scopedSymbols.slice(0, symbolLimit);
      const relationships = args.include_relationships === false
        ? []
        : scopedRelationships.slice(0, relationshipLimit);
      const outputLimited = files.length < scopedFiles.length ||
        (args.include_symbols !== false && symbols.length < scopedSymbols.length) ||
        (args.include_relationships !== false && relationships.length < scopedRelationships.length);
      const outputWarnings = [
        ...result.warnings,
        ...(outputLimited ? ["Structured output was limited. Use path or max_* arguments to request a narrower or larger result."] : [])
      ];
      const text = [
        "# Workspace Analysis",
        "",
        `Workspace: ${workspace.root}`,
        `Projects: ${result.projectTypes.join(", ") || "unknown"}`,
        `Languages: ${result.languages.join(", ") || "unknown"}`,
        `Entrypoints: ${result.entrypoints.filter(inScope).join(", ") || "none detected"}`,
        `Coverage: ${result.coverage.analyzedFiles}/${result.coverage.inventoryFiles} files analyzed, ${result.coverage.symbolCount} symbols, ${result.coverage.relationshipCount} relationships${result.coverage.truncated ? " (partial)" : ""}`,
        `Returned: ${files.length} files, ${symbols.length} symbols, ${relationships.length} relationships`,
        ...(outputWarnings.length ? ["", "## Warnings", "", ...outputWarnings.map((warning) => `- ${warning}`)] : [])
      ].join("\n");
      return textResult(text, {
        schema_version: 1,
        workspace_id: workspace.id,
        root: workspace.root,
        path: args.path ?? ".",
        languages: result.languages,
        project_types: result.projectTypes,
        entrypoints: result.entrypoints.filter(inScope),
        important_files: result.importantFiles.filter(inScope),
        areas: result.areas.filter((area) => areaInScope(area.path)),
        files,
        symbols,
        relationships,
        coverage: result.coverage,
        warnings: outputWarnings,
        output_limited: outputLimited,
        returned: { files: files.length, symbols: symbols.length, relationships: relationships.length },
        cache: result.cache
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "code_graph",
    {
      title: "CodexGraph Map",
      description: "Return a compact node/edge projection of the live CodexGraph for interactive visualization without duplicating the repository analysis engine.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().optional().describe("Optional workspace-relative area to visualize. Default: entire workspace."),
        max_nodes: z.number().int().min(1).max(50000).optional().describe("Maximum compact graph nodes. Default: 15000."),
        max_edges: z.number().int().min(1).max(100000).optional().describe("Maximum compact graph edges. Default: 40000."),
        max_payload_bytes: z.number().int().min(262144).max(8388608).optional().describe("Maximum compact graph payload bytes. Default: 6291456 (6 MiB).")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Building compact CodexGraph map...",
        "openai/toolInvocation/invoked": "CodexGraph map ready"
      }
    },
    async (args) => {
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      if (args.path) guard.resolve(workspace, args.path);
      const result = await inspectWorkspace(config, guard, workspace);
      const prefix = typeof args.path === "string" && args.path.trim()
        ? guard.resolve(workspace, args.path).relPath.replace(/^\.\/?$/, "")
        : "";
      const inScope = (filePath: string) => !prefix || filePath === prefix || filePath.startsWith(`${prefix}/`);
      const nodeLimit = limitInt(args.max_nodes, 15000, 1, Math.min(50000, config.analysisLimits.maxSymbols));
      const edgeLimit = limitInt(args.max_edges, 40000, 1, Math.min(100000, config.analysisLimits.maxRelationships));
      const payloadLimit = limitInt(args.max_payload_bytes, 6 * 1024 * 1024, 256 * 1024, 8 * 1024 * 1024);
      const scopedSymbols = result.symbols.filter((symbol) => Boolean(symbol.id) && inScope(symbol.path));
      const projection = projectCompactGraph(scopedSymbols, result.relationships, {
        maxNodes: nodeLimit,
        maxEdges: edgeLimit,
        maxPayloadBytes: payloadLimit
      });
      const { nodes, edges } = projection;
      const outputLimited = projection.outputLimited || result.coverage.truncated;
      const outputWarnings = [
        ...result.warnings,
        ...(outputLimited ? [projection.byteLimited
          ? "CodexGraph map payload reached the byte cap; high-priority nodes and edges were preserved first."
          : "CodexGraph map payload was limited by max_nodes/max_edges or repository analysis limits; high-priority nodes and edges were preserved first."] : [])
      ];
      const text = [
        "# CodexGraph Map",
        "",
        `Workspace: ${workspace.root}`,
        `Source: CodexGraph engine (${result.coverage.symbolCount} symbols, ${result.coverage.relationshipCount} relationships)`,
        `Returned: ${nodes.length} compact nodes, ${edges.length} compact edges${outputLimited ? " (partial)" : ""}`
      ].join("\n");
      return textResult(text, {
        schema_version: 1,
        source: "CodexGraph",
        workspace_id: workspace.id,
        root: workspace.root,
        path: args.path ?? ".",
        nodes,
        edges,
        coverage: result.coverage,
        warnings: outputWarnings,
        output_limited: outputLimited,
        returned: { nodes: nodes.length, edges: edges.length },
        eligible: { nodes: projection.eligibleNodes, edges: projection.eligibleEdges },
        limits: projection.limits,
        cache: result.cache
      });
    }
  );

  registerWorkspaceFileTools({
    config,
    server,
    workspaces,
    guard,
    registerCodexTool,
    helpers: {
      workspaceForTool,
      assertWriteToolAllowed,
      assertTaskChecklistReady,
      workspaceTaskContextForServer,
      diffBlock,
      parseBool,
      limitInt
    },
    annotations: { readOnly: READ_ONLY_ANNOTATIONS, localWrite: LOCAL_WRITE_ANNOTATIONS }
  });
  registerCodexTool(
    config,
    server,
    "bash",
    {
      title: process.platform === "win32" ? "Safe PowerShell" : "Bash",
      description:
        config.bashMode === "full"
          ? "Run a full shell command with hidden Windows terminals and captured logs. Never commit or push .env files, API keys, tokens, private keys, credentials, databases, or other sensitive data. CodexPro scans direct git commit/push calls for high-confidence secrets even in full mode. Run each Git write as a separate command so the scan cannot be bypassed accidentally."
          : "Run one deny-by-default command in the workspace. Safe mode allows verification commands plus explicit-file git add, hook-disabled unsigned git commit -m, and option-free git push origin <branch> for verified local branches and HTTPS origins. Broad staging, force/deleting/tag/alternate-remote pushes, and destructive Git operations remain blocked. Do not chain commands with &&, pipes, redirects, or shell file readers.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        command: z.string().describe("Command to run."),
        session_id: z.string().optional().describe(config.requireBashSession && config.bashSessionId ? `Required bash session id for this server: ${config.bashSessionId}.` : "Optional bash session id. If configured on the server, a provided value must match it."),
        cwd: z.string().optional().describe("Working directory relative to workspace root. Default: ."),
        timeout_ms: z.number().int().min(1000).max(180000).optional().describe("Timeout in milliseconds. Default: 30000.")
      },
      annotations: BASH_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Running bash command...",
        "openai/toolInvocation/invoked": "Bash command finished"
      }
    },
    async (args) => {
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const result = await runBash(config, guard, workspace, String(args.command ?? ""), {
        repoTask: workspaceTaskContextForServer(server, workspace),
        cwd: args.cwd,
        timeoutMs: args.timeout_ms,
        sessionId: args.session_id
      });
      const text = bashTextResult(config, result);
      return textResult(text, { workspace_id: workspace.id, root: workspace.root, ...result, bash_session_id: result.bashSessionId ?? null });
    }
  );

  registerCodexTool(
    config,
    server,
    "git_status",
    {
      title: "Git Status",
      description: "Show git branch and changed files for the workspace.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().optional().describe("Optional file path relative to workspace root.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading git status...",
        "openai/toolInvocation/invoked": "Git status ready"
      }
    },
    async (args) => {
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const scopedPath = typeof args.path === "string" ? args.path : undefined;
      const status = await gitStatus(config, workspace, guard, scopedPath);
      const statusError = looksLikeGitError(status) ? status : "";
      const changedFiles = statusError ? [] : changedStatusLines(status);
      return textResult(status, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: args.path ?? "workspace status",
        status,
        status_error: statusError || undefined,
        changed_files: changedFiles,
        changed: !statusError && changedFiles.length > 0
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "git_diff",
    {
      title: "Git Diff",
      description: "Show current unstaged or staged git diff, optionally scoped to a file.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().optional().describe("Optional file path relative to workspace root."),
        staged: z.boolean().optional().describe("Show staged diff. Default: false."),
        include_diff: z.boolean().optional().describe("Include the raw unified diff in the response. Default: true. Set false for stats-only checks.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading git diff...",
        "openai/toolInvocation/invoked": "Git diff ready"
      }
    },
    async (args) => {
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const rawDiff = normalizeGitOutput(await gitDiff(config, guard, workspace, args.path, parseBool(args.staged, false)));
      const diffError = rawDiff && looksLikeGitError(rawDiff) ? rawDiff : "";
      const stats = diffError ? { additions: 0, deletions: 0, changed: false } : diffStats(rawDiff);
      const includeDiff = parseBool(args.include_diff, true);
      const text = diffError
        ? diffError
        : includeDiff
        ? rawDiff
        : [
            "# Git Diff",
            "",
            `Workspace: ${workspace.root}`,
            `Path: ${args.path ?? "workspace diff"}`,
            `Staged: ${parseBool(args.staged, false)}`,
            `Diff stats: +${stats.additions} -${stats.deletions}`,
            "",
            "Raw diff omitted by include_diff=false."
          ].join("\n");
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: args.path ?? "workspace diff",
        staged: parseBool(args.staged, false),
        include_diff: includeDiff,
        diff_error: diffError || undefined,
        additions: stats.additions,
        deletions: stats.deletions,
        changed: !diffError && stats.changed,
        diff: diffError || includeDiff ? rawDiff : ""
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "show_changes",
    {
      title: "Show Changes",
      description: "Summarize the current workspace changes in one review-oriented result with git status, diff stats, and optional diff. Use this instead of bash git status, bash git diff, git_status, or git_diff when reviewing work.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().optional().describe("Optional file path relative to workspace root."),
        staged: z.boolean().optional().describe("Show staged diff. Default: false."),
        include_diff: z.boolean().optional().describe("Include the unified diff. Default: true."),
        since: z.enum(["last_shown", "workspace"]).optional().describe("Use last_shown to suppress unchanged repeated reviews. Default: last_shown."),
        mark_reviewed: z.boolean().optional().describe("Update the last-shown review checkpoint after this call. Default: true.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Summarizing workspace changes...",
        "openai/toolInvocation/invoked": "Workspace changes summarized"
      }
    },
    async (args) => {
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const scopedPath = typeof args.path === "string" ? args.path : undefined;
      const staged = parseBool(args.staged, false);
      const normalizedScopedPath = scopedPath?.trim() ? guard.resolve(workspace, scopedPath).relPath : undefined;
      const status = normalizeGitOutput(await gitDiffStatus(config, guard, workspace, normalizedScopedPath, staged));
      const includeDiff = parseBool(args.include_diff, true);
      const rawDiff = normalizeGitOutput(await gitDiff(config, guard, workspace, normalizedScopedPath, staged));
      const statusError = looksLikeGitError(status) ? status : "";
      const diffError = rawDiff && looksLikeGitError(rawDiff) ? rawDiff : "";
      const diff = diffError ? "" : rawDiff;
      const stats = diffStats(diff);
      const changedFiles = statusError ? [] : changedStatusLines(status);
      const untrackedFingerprint = statusError ? "" : await untrackedReviewFingerprint(config, guard, workspace, changedFiles);
      const since = args.since === "workspace" ? "workspace" : "last_shown";
      const markReviewed = parseBool(args.mark_reviewed, true);
      const checkpointKey = reviewCheckpointKey(workspace, { path: normalizedScopedPath, staged });
      const fingerprint = reviewFingerprint(status, `${diff}\0${untrackedFingerprint}`);
      const checkpointHit = includeDiff && since === "last_shown" && reviewCheckpoints.get(checkpointKey) === fingerprint;
      const checkpointWritten = markReviewed && includeDiff;
      if (checkpointWritten) reviewCheckpoints.set(checkpointKey, fingerprint);
      const responseDiff = checkpointHit ? "" : includeDiff ? diff : "";
      const responseStats = checkpointHit ? { additions: 0, deletions: 0, changed: false } : stats;
      const changedPaths = statusError ? [] : changedPathsFromStatus(changedFiles);
      let analysis: Record<string, unknown> | undefined;
      if (config.analysisEnabled && changedPaths.length && !checkpointHit) {
        try {
          const impact = await reviewWorkspaceChanges(config, guard, workspace, { changedPaths });
          analysis = {
            schema_version: impact.schemaVersion,
            changed_paths: impact.changedPaths,
            affected_areas: impact.affectedAreas,
            dependent_files: impact.dependentFiles,
            related_tests: impact.relatedTests,
            risk_signals: impact.riskSignals,
            graph_diff: impact.graphDiff,
            recommended_commands: impact.recommendedCommands,
            coverage: impact.coverage,
            warnings: impact.warnings,
            cache: impact.cache
          };
        } catch (error) {
          analysis = {
            schema_version: 1,
            changed_paths: changedPaths,
            affected_areas: [],
            dependent_files: [],
            related_tests: [],
            risk_signals: [],
            recommended_commands: [],
            warnings: [`Change analysis unavailable: ${errorText(error)}`]
          };
        }
      }
      const changedText = statusError
        ? `- Git status unavailable: ${statusError}`
        : checkpointHit
          ? "- No changes since last shown review."
          : changedFiles.length
          ? changedFiles.map((line) => `- ${line}`).join("\n")
          : "- No changed files.";
      const diffText = checkpointHit
        ? "\n\nNo new diff since last shown review."
        : includeDiff
        ? diffError
          ? `\n\nGit diff unavailable: ${diffError}`
          : diff
          ? diffBlock(diff)
            : "\n\nNo diff output."
        : "\n\nDiff omitted by request.";
      const analysisText = analysis
        ? `\n\n## Analysis\n\nAffected areas: ${(analysis.affected_areas as string[]).join(", ") || "none"}\nRisks: ${((analysis.risk_signals as Array<{ label?: string }>) ?? []).map((risk) => risk.label).filter(Boolean).join(", ") || "none"}\nRelated tests: ${((analysis.related_tests as Array<{ path?: string }>) ?? []).map((file) => file.path).filter(Boolean).join(", ") || "none"}`
        : "";
      const text = `# Show Changes\n\nWorkspace: ${workspace.root}\n\n## Changed\n\n${changedText}\n\n## Diff stats\n\n+${responseStats.additions} -${responseStats.deletions}${diffText}${analysisText}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: args.path ?? "workspace changes",
        status,
        status_error: statusError || undefined,
        diff_error: diffError || undefined,
        changed_files: checkpointHit ? [] : changedFiles,
        staged,
        include_diff: includeDiff,
        additions: responseStats.additions,
        deletions: responseStats.deletions,
        changed: !statusError && (checkpointHit ? false : changedFiles.length > 0 || responseStats.changed),
        diff: responseDiff,
        review_since: since,
        review_marked: checkpointWritten,
        review_checkpoint_hit: checkpointHit,
        ...(analysis ? { analysis } : {})
      });
    }
  );

  registerHandoffTools({
    phase: "context",
    config,
    server,
    workspaces,
    guard,
    registerCodexTool,
    workspaceForTool,
    helpers: { cleanOneLine, parseBool, diffBlock, previewText, limitInt },
    annotations: { readOnly: READ_ONLY_ANNOTATIONS, handoffWrite: HANDOFF_WRITE_ANNOTATIONS }
  });
  if (config.codexSessions !== "off") {
    registerCodexTool(
      config,
      server,
      "codex_sessions",
      {
        title: "Codex Sessions",
        description:
          "Opt-in, read-only local Codex session history browser. Lists metadata from the user's configured Codex session JSONL files without reading full transcripts.",
        inputSchema: {
          max_sessions: z.number().int().min(1).max(200).optional().describe("Maximum sessions to return. Default: 30."),
          query: z.string().optional().describe("Optional case-insensitive search over session id, title, cwd, and source path.")
        },
        annotations: READ_ONLY_ANNOTATIONS,
        _meta: {
          ...toolCardMeta(),
          "openai/toolInvocation/invoking": "Listing local Codex sessions...",
          "openai/toolInvocation/invoked": "Codex sessions ready"
        }
      },
      async (args) => {
        const result = await listCodexSessions(config, {
          maxSessions: args.max_sessions,
          query: args.query
        });
        const rows = result.sessions.length
          ? result.sessions.map((session) => `- ${session.session_id}  ${session.title || "(untitled)"}${session.project_dir ? `  cwd=${session.project_dir}` : ""}`).join("\n")
          : "- No Codex sessions found.";
        const text = `# Codex Sessions\n\nCodex dir: ${result.codex_dir}\nMode: ${config.codexSessions}\nTotal matched: ${result.total_found}\n\n${rows}`;
        return textResult(text, {
          codex_dir: result.codex_dir,
          roots: result.roots,
          sessions: result.sessions,
          total_found: result.total_found,
          codex_sessions_mode: config.codexSessions
        });
      }
    );

    if (config.codexSessions === "read") {
      registerCodexTool(
        config,
        server,
        "read_codex_session",
        {
          title: "Read Codex Session",
          description:
            "Opt-in, read-only local Codex transcript reader. Requires --codex-sessions read. It selects the newest page by default, returns that page chronologically, and reads the file in blocks instead of loading the full JSONL. Memory use still scales with the largest individual JSONL record scanned.",
          inputSchema: {
            session_id: z.string().optional().describe("Codex session id from codex_sessions."),
            source_path: z.string().optional().describe("Source path from codex_sessions. Must be inside the configured Codex session roots."),
            direction: z.enum(["head", "tail"]).optional().describe("Page direction. tail selects the newest page and is the default; head reads from the start. Messages inside each page are returned chronologically."),
            cursor: z.number().int().min(0).optional().describe("Opaque byte cursor returned as next_cursor or resume_cursor by a previous page. Reuse it only with the same session and direction. Omit for the newest tail page or the first head page."),
            max_messages: z.number().int().min(1).max(400).optional().describe("Maximum transcript messages. Default: 80."),
            max_total_bytes: z.number().int().min(4000).max(400000).optional().describe("Maximum returned transcript content bytes. Default: 80000."),
            exclude_tool_outputs: z.boolean().optional().describe("Exclude function_call_output messages. Default: false."),
            max_tool_output_bytes: z.number().int().min(0).max(400000).optional().describe("Maximum bytes retained per tool output before it is truncated. Default: 20000.")
          },
          annotations: READ_ONLY_ANNOTATIONS,
          _meta: {
            ...toolCardMeta(),
            "openai/toolInvocation/invoking": "Reading local Codex session...",
            "openai/toolInvocation/invoked": "Codex session read"
          }
        },
        async (args) => {
          const result = await readCodexSession(config, {
            sessionId: args.session_id,
            sourcePath: args.source_path,
            direction: args.direction,
            cursor: args.cursor,
            maxMessages: args.max_messages,
            maxTotalBytes: args.max_total_bytes,
            excludeToolOutputs: args.exclude_tool_outputs,
            maxToolOutputBytes: args.max_tool_output_bytes
          });
          return textResult(result.text, {
            session: result.session,
            messages: result.messages,
            message_count: result.messages.length,
            truncated: result.truncated,
            direction: result.direction,
            cursor: result.cursor,
            resume_cursor: result.resume_cursor,
            next_cursor: result.next_cursor ?? null,
            has_more: result.has_more,
            source_size_bytes: result.source_size_bytes,
            codex_sessions_mode: config.codexSessions
          });
        }
      );
    }
  }

  registerBrowserControlTool({
    config,
    server,
    workspaces,
    registerCodexTool,
    annotations: BASH_ANNOTATIONS
  });
  registerHandoffTools({
    phase: "handoff",
    config,
    server,
    workspaces,
    guard,
    registerCodexTool,
    workspaceForTool,
    helpers: { cleanOneLine, parseBool, diffBlock, previewText, limitInt },
    annotations: { readOnly: READ_ONLY_ANNOTATIONS, handoffWrite: HANDOFF_WRITE_ANNOTATIONS }
  });

  return server;
}
