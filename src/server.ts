import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CodexProConfig } from "./config.js";
import { WorkspaceManager, PathGuard, CodexProError, type Workspace } from "./guard.js";
import { repoTree, readTextFile, writeTextFile, editTextFile, ensureAiBridge, withFileWriteLocks } from "./fsOps.js";
import { viewWorkspaceImage } from "./imageOps.js";
import { importAttachmentFile } from "./importOps.js";
import { searchWorkspace } from "./searchOps.js";
import { runBash } from "./bashOps.js";
import { getSharedBrowserAutomation, type BrowserSnapshot } from "./browserOps.js";
import { gitDiff, gitDiffStatus, gitLog, gitStatus } from "./gitOps.js";
import { readAiBridgeContext, readCodexContext, workspaceSummary } from "./workspaceOps.js";
import { buildProContext, exportProContext } from "./proContext.js";
import { codexproInventory, loadSkill } from "./capabilitiesOps.js";
import { listCodexSessions, readCodexSession } from "./codexSessions.js";
import { TOOL_CARD_LEGACY_URIS, TOOL_CARD_MIME_TYPE, TOOL_CARD_URI, toolCardWidgetHtml } from "./toolCardWidget.js";
import { redactSensitiveText, redactStructured } from "./redact.js";
import { inspectWorkspace, invalidateWorkspaceAnalysis, reviewWorkspaceChanges } from "./analysis/index.js";
import { CONTROL_PLANE_TOOL_NAMES, controlPlaneToolDefinitions } from "./controlPlaneOps.js";
import { codexPatchToUnifiedDiff, codexPatchTouchedPaths, isCodexPatchEnvelope } from "./patchOps.js";
import { projectCompactGraph } from "./analysis/projection.js";
import { createRuntimeTraceContext, currentRuntimeTraceContext, recordRuntimeTraceSpan, runWithRuntimeTraceContext, type RuntimeTraceContext } from "./analysis/runtimeTrace.js";
import { recordRuntimeEvent, type RuntimeEventType } from "./runtimeEvents.js";
import { runBrowserControl } from "./browserOps.js";
import { ensureBrowserExtensionBridge, getBrowserExtensionPendingTaskOwner, getBrowserExtensionProfileWorkspaceBinding, listBrowserExtensionProfiles, recordBrowserProfileTaskEvent, runBrowserExtensionCommand, setBrowserExtensionProfilePendingTask, setBrowserExtensionProfileTask, setBrowserExtensionProfileWorkspace, setBrowserExtensionProfileWorkspaceBinding } from "./browserExtensionBridge.js";
import { recordMcpUsage } from "./mcpUsage.js";
import { codexProHome } from "./profileStore.js";
import { bootstrapWorkerJob, finalizeWorkerJob, listWorkerJobs, prepareWorkerJob, readWorkerJob, workerJobPublicRecord, WORKER_POLICY_VERSION } from "./workerPolicy.js";
import { claimWorkspacePaths, finalizeWorkspaceTask, readWorkspaceCoordination, readWorkspaceCoordinationStatus, recordWorkspacePathsTouched, registerWorkspaceTask, releaseWorkspacePaths, type WorkspaceTaskContext } from "./workspaceCoordination.js";

const STRUCTURED_STRING_MAX_CHARS = 30_000;
const CODEXPRO_GLOBAL_RULES_FILE = "CODEXPRO.md";
const WORKER_PROFILE_ID_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,159}|[a-z0-9][a-z0-9._-]{0,63}:[A-Za-z0-9][A-Za-z0-9._-]{0,94})$/;
const DEFAULT_CODEXPRO_GLOBAL_RULES = `# CodexPro Global Rules

<!-- Rule trong file này áp dụng cho mọi repo/dự án được thao tác qua MCP CodexPro. -->
<!-- Thêm hoặc sửa rule bên dưới. Không lưu password, token hoặc API key trong file này. -->

- Đọc và tuân thủ file này trước khi đọc rule riêng của từng repo/dự án.
- Rule riêng của repo có thể bổ sung chi tiết nhưng không được âm thầm bỏ qua rule toàn cục này.
`;

type HeadlessWorkerStateRecord = {
  id?: string;
  label?: string;
  sourceProfileId?: string;
  sourceProfileDirectory?: string;
  pid?: number;
};

function processIdAlive(pid: unknown): boolean {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function runningHeadlessWorkerState(): HeadlessWorkerStateRecord[] {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(codexProHome(), "headless-workers.json"), "utf8"));
    return (Array.isArray(state?.workers) ? state.workers : [])
      .filter((worker: HeadlessWorkerStateRecord) => worker && processIdAlive(worker.pid));
  } catch {
    return [];
  }
}

function browserProfileOwnsActiveTask(profile: any): boolean {
  if (!profile) return false;
  if (String(profile.current_task_id || "").trim()) return true;
  if (profile.activity === "working" || profile.activity === "settling") return true;
  if (Math.max(0, Number(profile.busy_request_count) || 0) > 0) return true;
  return (Array.isArray(profile.conversation_tabs) ? profile.conversation_tabs : []).some((tab: any) =>
    tab?.busy === true || tab?.settling === true || String(tab?.network_state || "") === "generating"
  );
}

async function assertBrowserControlHeadlessExclusive(profileId: string): Promise<void> {
  const id = String(profileId || "").trim();
  if (!id) return;
  const running = runningHeadlessWorkerState();
  const sourceLockedBy = running.find((worker) => String(worker.sourceProfileId || "").trim() === id);
  if (sourceLockedBy) {
    throw new CodexProError(`HEADLESS_EXCLUSIVE_SOURCE_LOCK: Chrome vẫn dùng bình thường, nhưng ChatGPT và task CodexPro trên profile nguồn đang bị khóa bởi headless ${sourceLockedBy.label || sourceLockedBy.id || "worker"}. Hãy dừng headless trước khi dùng ChatGPT.`);
  }
  const targetHeadless = running.find((worker) => String(worker.id || "").trim() === id);
  if (!targetHeadless) return;
  const sourceProfileId = String(targetHeadless.sourceProfileId || "").trim();
  if (!sourceProfileId) {
    throw new CodexProError("HEADLESS_SOURCE_UNBOUND: Headless đang chạy nhưng chưa có source_profile_id xác minh; từ chối thao tác để tránh chạy song song.");
  }
  const sourceProfile = listBrowserExtensionProfiles().find((profile) => profile.profile_id === sourceProfileId && !profile.headless);
  if (!sourceProfile?.connected) return;
  if (browserProfileOwnsActiveTask(sourceProfile)) {
    const taskLabel = String(sourceProfile.current_task_title || sourceProfile.current_task_id || "task hiện tại").trim();
    throw new CodexProError(`WORKER_BUSY: ${sourceProfile.label} đang làm ${taskLabel}; chưa được giao thao tác cho headless.`);
  }
}

type GlobalRulesSnapshot = {
  path: string;
  text: string;
  sha256: string;
  source: "file" | "template";
};

function readGlobalRulesSnapshotSync(): GlobalRulesSnapshot {
  const filePath = path.join(codexProHome(), CODEXPRO_GLOBAL_RULES_FILE);
  let text = DEFAULT_CODEXPRO_GLOBAL_RULES;
  let source: GlobalRulesSnapshot["source"] = "template";
  try {
    text = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n").slice(0, STRUCTURED_STRING_MAX_CHARS);
    source = "file";
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  return {
    path: filePath,
    text,
    sha256: createHash("sha256").update(text).digest("hex"),
    source
  };
}

async function readGlobalRulesSnapshot(): Promise<GlobalRulesSnapshot> {
  return readGlobalRulesSnapshotSync();
}

function withGlobalRules(text: string, rules: GlobalRulesSnapshot): string {
  return [
    "# Mandatory CodexPro Global Rules",
    "",
    `Source: ${rules.path}`,
    `SHA-256: ${rules.sha256}`,
    "Read and follow these rules before repository-specific AGENTS.md instructions or project decisions.",
    "",
    rules.text || "(No global rules configured.)",
    "",
    text
  ].join("\n");
}

function errorText(error: unknown): string {
  if (error instanceof Error) return redactSensitiveText(`${error.name}: ${error.message}`);
  return redactSensitiveText(String(error));
}

function compactStructuredContent<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.length <= STRUCTURED_STRING_MAX_CHARS) return value as T;
    return `${value.slice(0, STRUCTURED_STRING_MAX_CHARS)}\n...[structured field truncated to ${STRUCTURED_STRING_MAX_CHARS} chars]` as T;
  }
  if (Array.isArray(value)) return value.map((item) => compactStructuredContent(item, depth + 1)) as T;
  if (typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = compactStructuredContent(item, depth + 1);
  }
  return out as T;
}

function errorEnvelope(error: unknown): Record<string, unknown> {
  const message = errorText(error);
  if (!(error instanceof Error)) return { name: "Error", message };
  const source = error as Error & { code?: unknown; details?: unknown; cause?: unknown };
  return redactStructured({
    name: error.name || "Error",
    message,
    code: typeof source.code === "string" ? source.code : undefined,
    details: source.details && typeof source.details === "object" && !Array.isArray(source.details)
      ? compactStructuredContent(source.details as Record<string, unknown>)
      : undefined,
    cause: source.cause instanceof Error ? `${source.cause.name}: ${source.cause.message}` : undefined
  }) as Record<string, unknown>;
}

function textResult(text: string, structuredContent: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): any {
  return {
    content: [{ type: "text", text: redactSensitiveText(text) }],
    structuredContent: redactStructured(structuredContent),
    _meta: meta
  };
}

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

function browserSnapshotText(title: string, snapshot: BrowserSnapshot): string {
  const elements = snapshot.elements.length
    ? snapshot.elements.map((element) => {
        const label = element.name || element.text || element.placeholder || element.href || "(unlabeled)";
        const details = [element.type ? `type=${element.type}` : "", element.disabled ? "disabled" : ""].filter(Boolean).join(" ");
        return `- [${element.ref}] <${element.tag}> ${label}${details ? ` (${details})` : ""}`;
      }).join("\n")
    : "- No visible interactive elements.";
  const consoleEntries = snapshot.console.length
    ? snapshot.console.map((entry) => `- ${entry.level}: ${entry.text}`).join("\n")
    : "- No captured console messages.";
  return [
    `# ${title}`,
    "",
    `Title: ${snapshot.title || "(untitled)"}`,
    `URL: ${snapshot.url}`,
    `Truncated: ${snapshot.truncated ? "yes" : "no"}`,
    "",
    "## Page text",
    "",
    snapshot.text || "(no visible text)",
    "",
    "## Interactive elements",
    "",
    elements,
    "",
    "## Console",
    "",
    consoleEntries
  ].join("\n");
}

function errorResult(error: unknown): any {
  return {
    isError: true,
    content: [{ type: "text", text: errorText(error) }],
    structuredContent: { error: errorEnvelope(error) }
  };
}

function validateToolArgs(name: string, options: Record<string, unknown>, args: unknown): any {
  const inputSchema = options.inputSchema;
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) return args ?? {};
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, value] of Object.entries(inputSchema)) {
    if (value && typeof (value as { safeParse?: unknown }).safeParse === "function") {
      shape[key] = value as z.ZodTypeAny;
    }
  }
  if (!Object.keys(shape).length) return {};
  const parsed = z.object(shape).safeParse(args ?? {});
  if (parsed.success) return parsed.data;
  const details = parsed.error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "arguments"}: ${issue.message}`)
    .join("; ");
  throw new CodexProError(`Invalid arguments for ${name}: ${details}`);
}

function tagToolResult(result: any, name: string, options: Record<string, unknown>): any {
  if (!result || typeof result !== "object") return result;
  const structured = result.structuredContent;
  const base =
    structured && typeof structured === "object" && !Array.isArray(structured)
      ? structured
      : {};
  const tagged = {
    codexpro_tool: name,
    codexpro_title: options.title ?? name,
    ...base
  };
  const meta = (options._meta as Record<string, unknown> | undefined) ?? {};
  result.structuredContent = meta.ui || meta["openai/outputTemplate"] ? compactStructuredContent(tagged) : tagged;
  return result;
}

function toolCardMeta(): Record<string, unknown> {
  return {
    ui: { resourceUri: TOOL_CARD_URI },
    "openai/outputTemplate": TOOL_CARD_URI
  };
}

const TOOL_CARD_RENDER_TOOL_NAMES = new Set<string>([
  "open_current_workspace",
  "open_workspace",
  "workspace_snapshot",
  "inspect_workspace",
  "show_changes",
  "git_status",
  "handoff_to_agent",
  "handoff_to_codex",
  "bash"
]);

const OPTIONAL_TOOL_CARD_META = [
  "ui",
  "openai/outputTemplate",
  "openai/toolInvocation/invoking",
  "openai/toolInvocation/invoked"
] as const;

function usesToolCard(config: CodexProConfig, name: string): boolean {
  return config.toolCards && TOOL_CARD_RENDER_TOOL_NAMES.has(name);
}

function descriptorOptionsForConfig(config: CodexProConfig, name: string, options: Record<string, unknown>): Record<string, unknown> {
  if (usesToolCard(config, name)) return options;
  const meta = { ...((options._meta as Record<string, unknown> | undefined) ?? {}) };
  for (const key of OPTIONAL_TOOL_CARD_META) delete meta[key];
  return { ...options, _meta: meta };
}

function toolCallLoggingEnabled(): boolean {
  return process.env.CODEXPRO_LOG_TOOL_CALLS === "1" || process.env.CODEXPRO_LOG_REQUESTS === "1";
}

function logToolCall(name: string, status: "ok" | "error", started: number): void {
  if (!toolCallLoggingEnabled()) return;
  console.error(`[CodexProTool] ${name} ${status} ${Date.now() - started}ms`);
}

function registerToolCardResource(server: McpServer, config: CodexProConfig): void {
  if (config.connectionTest) return;
  const s = server as any;
  if (typeof s.registerResource !== "function") {
    throw new Error("Unsupported MCP SDK: CodexPro widgets require registerResource.");
  }

  const registerUri = (uri: string, name: string): void => {
    s.registerResource(
      name,
      uri,
      {
        title: "CodexPro Tool Card",
        description: "Compact visual renderer for CodexPro workspace orientation, source changes, and handoffs.",
        mimeType: TOOL_CARD_MIME_TYPE
      },
      async () => ({
        contents: [
          {
            uri,
            mimeType: TOOL_CARD_MIME_TYPE,
            text: toolCardWidgetHtml,
            _meta: {
              ui: {
                prefersBorder: true,
                domain: config.widgetDomain,
                csp: {
                  connectDomains: [],
                  resourceDomains: []
                }
              },
              "openai/widgetDescription": "Renders CodexPro workspace orientation, diagnostics, file diffs, change reviews, terminal checks, Pro context exports, and handoff plans as compact developer cards with bounded previews.",
              "openai/widgetPrefersBorder": true,
              "openai/widgetDomain": config.widgetDomain,
              "openai/widgetCSP": {
                connect_domains: [],
                resource_domains: []
              }
            }
          }
        ]
      })
    );
  };

  registerUri(TOOL_CARD_URI, "codexpro-tool-card");
  for (const legacyUri of TOOL_CARD_LEGACY_URIS) {
    registerUri(legacyUri, `codexpro-tool-card-${legacyUri.match(/v\d+/)?.[0] ?? "legacy"}`);
  }
}

type CodexToolHandler = (args: any) => Promise<any> | any;

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

const registeredToolHandlersByServer = new WeakMap<object, Map<string, CodexToolHandler>>();
const runtimeTraceWorkspaceByServer = new WeakMap<object, () => Workspace | undefined>();
const runtimeWorkerIdByServer = new WeakMap<object, string>();
const repoTaskGateRequiredByServer = new WeakMap<object, boolean>();
const repoTaskGateProfileByServer = new WeakMap<object, string>();
type ActiveRepoTask = {
  taskId: string;
  taskTitle: string;
  root: string;
  workspaceId: string;
  scope: "workspace" | "all_allowed";
  globalRulesSha256: string;
  worktreeRoot?: string;
  worktreeBranch?: string;
};
const activeRepoTaskByServer = new WeakMap<object, ActiveRepoTask>();
const activeRepoTaskByProfile = new Map<string, ActiveRepoTask>();
const repoTaskWorkspaceSelectorByServer = new WeakMap<object, (root: string) => Workspace>();
type ExpectedRepoTask = {
  taskId: string;
  root?: string;
  scope: "workspace" | "all_allowed";
  preparedAt: number;
};
const expectedRepoTaskByProfile = new Map<string, ExpectedRepoTask>();


function canonicalResolvedRoot(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function sameResolvedRoot(left: string, right: string): boolean {
  const resolvedLeft = canonicalResolvedRoot(left);
  const resolvedRight = canonicalResolvedRoot(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function expectedRepoTask(profileId: string): ExpectedRepoTask | undefined {
  return expectedRepoTaskByProfile.get(profileId);
}

function expectedRepoTaskOwner(taskId: string): { profileId: string; expected: ExpectedRepoTask } | undefined {
  let owner: { profileId: string; expected: ExpectedRepoTask } | undefined;
  for (const [profileId, expected] of expectedRepoTaskByProfile) {
    if (expected.taskId !== taskId) continue;
    if (owner) return undefined;
    owner = { profileId, expected };
  }
  return owner;
}

function rememberExpectedRepoTask(profileId: string, expected: Omit<ExpectedRepoTask, "preparedAt">): ExpectedRepoTask {
  const prepared = { ...expected, preparedAt: Date.now() };
  activeRepoTaskByProfile.delete(profileId);
  expectedRepoTaskByProfile.delete(profileId);
  expectedRepoTaskByProfile.set(profileId, prepared);
  if (expectedRepoTaskByProfile.size > 500) {
    for (const staleProfileId of [...expectedRepoTaskByProfile.keys()].slice(0, expectedRepoTaskByProfile.size - 400)) {
      expectedRepoTaskByProfile.delete(staleProfileId);
    }
  }
  return prepared;
}

function repoTaskRootMatches(leftRoot: string, right: ExpectedRepoTask | ActiveRepoTask): boolean {
  if (right.scope === "all_allowed" && !right.root) return true;
  return Boolean(right.root && sameResolvedRoot(leftRoot, right.root));
}

function sameRepoTask(left: ActiveRepoTask | undefined, right: ExpectedRepoTask | ActiveRepoTask | undefined): boolean {
  return Boolean(
    left
    && right
    && left.taskId === right.taskId
    && left.scope === right.scope
    && repoTaskRootMatches(left.root, right)
  );
}

const REPO_TASK_GATE_EXEMPT_TOOLS = new Set<string>([
  SUPERTOOL_NAME,
  "begin_repo_task",
  "repo_task_status",
  "workspace_coordination_status",
  "worker_job_status",
  "worker_job_history",
  "finalize_worker_job"
]);

function assertRepoTaskGate(server: McpServer, name: string): void {
  if (!repoTaskGateRequiredByServer.get(server as object) || REPO_TASK_GATE_EXEMPT_TOOLS.has(name)) return;
  const profileId = repoTaskGateProfileByServer.get(server as object) || "";
  const expected = profileId ? expectedRepoTask(profileId) : undefined;
  const active = profileId ? activeRepoTaskByProfile.get(profileId) : activeRepoTaskByServer.get(server as object);
  if (!active || !sameRepoTask(active, expected)) {
    activeRepoTaskByServer.delete(server as object);
    if (profileId) activeRepoTaskByProfile.delete(profileId);
    throw new CodexProError(
      `BEGIN_REPO_TASK_REQUIRED: ${name} is blocked until the current CodexPro Manager task is activated with begin_repo_task.`,
      {
        code: "BEGIN_REPO_TASK_REQUIRED",
        details: {
          tool: name,
          profile_id: profileId || undefined,
          expected_task_id: expected?.taskId,
          active_task_id: active?.taskId
        }
      }
    );
  }
  const latestRules = readGlobalRulesSnapshotSync();
  if (latestRules.sha256 !== active.globalRulesSha256) {
    activeRepoTaskByServer.delete(server as object);
    if (profileId) activeRepoTaskByProfile.delete(profileId);
    throw new CodexProError(
      `BEGIN_REPO_TASK_RULES_CHANGED: ${CODEXPRO_GLOBAL_RULES_FILE} changed after task ${active.taskId} began. Call begin_repo_task again before using ${name}.`,
      {
        code: "BEGIN_REPO_TASK_RULES_CHANGED",
        details: {
          tool: name,
          task_id: active.taskId,
          previous_global_rules_sha256: active.globalRulesSha256,
          current_global_rules_sha256: latestRules.sha256,
          global_rules_path: latestRules.path
        }
      }
    );
  }
  const sessionActive = activeRepoTaskByServer.get(server as object);
  if (!sameRepoTask(sessionActive, active) || sessionActive?.globalRulesSha256 !== active.globalRulesSha256) {
    repoTaskWorkspaceSelectorByServer.get(server as object)?.(active.root);
    activeRepoTaskByServer.set(server as object, active);
  }
}

function repoTaskWorktree(active: ActiveRepoTask): { root?: string; branch?: string } {
  if (active.worktreeRoot && fs.existsSync(active.worktreeRoot)) {
    return { root: active.worktreeRoot, branch: active.worktreeBranch };
  }
  try {
    const record = readWorkspaceCoordination(active.root).tasks[active.taskId];
    if (record?.worktreeRoot && fs.existsSync(record.worktreeRoot)) {
      active.worktreeRoot = record.worktreeRoot;
      active.worktreeBranch = record.worktreeBranch;
      return { root: record.worktreeRoot, branch: record.worktreeBranch };
    }
  } catch {
    // Coordination state is best-effort here; normal workspace access remains available as a fallback.
  }
  return {};
}

function effectiveWorkspaceForServer(server: McpServer, workspace: Workspace): Workspace {
  const active = activeRepoTaskForServer(server);
  if (!active) return workspace;
  const worktree = repoTaskWorktree(active);
  if (!worktree.root) return workspace;
  if (sameResolvedRoot(workspace.root, worktree.root)) return workspace;
  if (!sameResolvedRoot(workspace.root, active.root)) return workspace;
  return { ...workspace, root: worktree.root };
}

function workspaceForTool(server: McpServer, workspaces: WorkspaceManager, workspaceId?: string): Workspace {
  return effectiveWorkspaceForServer(server, workspaces.getWorkspace(workspaceId));
}

function workspaceTaskContextForServer(server: McpServer, workspace: Workspace): WorkspaceTaskContext | undefined {
  const profileId = repoTaskGateProfileByServer.get(server as object) || "";
  const active = profileId ? activeRepoTaskByProfile.get(profileId) : activeRepoTaskByServer.get(server as object);
  if (!active) return undefined;
  const worktree = repoTaskWorktree(active);
  const matchesPrimary = sameResolvedRoot(active.root, workspace.root);
  const matchesWorktree = Boolean(worktree.root && sameResolvedRoot(worktree.root, workspace.root));
  if (!matchesPrimary && !matchesWorktree) return undefined;
  return {
    taskId: active.taskId,
    workerId: profileId || `direct.${active.taskId}`,
    title: active.taskTitle,
    root: active.root,
    ...(worktree.root ? { worktreeRoot: worktree.root } : {})
  };
}

function rememberRegisteredToolHandler(server: McpServer, name: string, handler: CodexToolHandler): void {
  const key = server as object;
  const handlers = registeredToolHandlersByServer.get(key) ?? new Map<string, CodexToolHandler>();
  if (!registeredToolHandlersByServer.has(key)) registeredToolHandlersByServer.set(key, handlers);
  handlers.set(name, handler);
}

function registeredToolHandler(server: McpServer, name: string): CodexToolHandler | undefined {
  return registeredToolHandlersByServer.get(server as object)?.get(name);
}

async function recordToolRuntimeTrace(
  server: McpServer,
  name: string,
  args: any,
  status: "ok" | "error",
  startedAtMs: number,
  endedAtMs: number,
  context?: RuntimeTraceContext
): Promise<void> {
  let workspace: Workspace | undefined;
  try {
    workspace = runtimeTraceWorkspaceByServer.get(server as object)?.();
  } catch {
    workspace = undefined;
  }
  if (!workspace) return;
  const matchingContext = context?.workspaceId === workspace.id ? context : undefined;
  const rawAction = typeof args?.action === "string" ? args.action.trim() : "";
  await recordRuntimeTraceSpan(workspace, {
    ...(matchingContext ? { traceId: matchingContext.traceId, spanId: matchingContext.spanId } : {}),
    kind: "tool",
    name,
    ...(rawAction ? { action: rawAction.slice(0, 160) } : {}),
    source: "mcp-tool",
    status,
    startedAtMs,
    endedAtMs
  }).catch(() => undefined);
}

function activeRepoTaskForServer(server: McpServer): ActiveRepoTask | undefined {
  const profileId = repoTaskGateProfileByServer.get(server as object) || "";
  return (profileId ? activeRepoTaskByProfile.get(profileId) : undefined)
    ?? activeRepoTaskByServer.get(server as object);
}

async function recordServerRuntimeEvent(
  server: McpServer,
  type: RuntimeEventType,
  options: {
    workspace?: Workspace;
    context?: RuntimeTraceContext;
    task?: ActiveRepoTask;
    source?: string;
    timestampMs?: number;
    payload?: Record<string, string | number | boolean | null>;
  } = {}
): Promise<void> {
  let workspace = options.workspace;
  if (!workspace) {
    try {
      workspace = runtimeTraceWorkspaceByServer.get(server as object)?.();
    } catch {
      workspace = undefined;
    }
  }
  if (!workspace) return;

  const task = options.task ?? activeRepoTaskForServer(server);
  const context = options.context?.workspaceId === workspace.id ? options.context : undefined;
  const profileId = repoTaskGateProfileByServer.get(server as object) || "";
  const workerId = runtimeWorkerIdByServer.get(server as object) || "";
  await recordRuntimeEvent(workspace, {
    type,
    source: options.source ?? "mcp-runtime",
    ...(options.timestampMs !== undefined ? { timestampMs: options.timestampMs } : {}),
    ...(context ? {
      traceId: context.traceId,
      spanId: context.spanId,
      ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {})
    } : {}),
    ...(task ? { taskId: task.taskId, taskTitle: task.taskTitle } : {}),
    ...(profileId ? { profileId } : {}),
    ...(workerId ? { workerId } : {}),
    ...(options.payload ? { payload: options.payload } : {})
  }).catch(() => undefined);
}

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

function registerToolCompat(
  server: McpServer,
  name: string,
  options: Record<string, unknown>,
  handler: (args: any) => Promise<any> | any
): void {
  const wrapped = async (args: any) => {
    const started = Date.now();
    const usageArgs = args ?? {};
    let initialWorkspace: Workspace | undefined;
    try {
      initialWorkspace = runtimeTraceWorkspaceByServer.get(server as object)?.();
    } catch {
      initialWorkspace = undefined;
    }
    const traceContext = initialWorkspace ? createRuntimeTraceContext(initialWorkspace) : undefined;
    const rawAction = typeof usageArgs?.action === "string" ? usageArgs.action.trim().slice(0, 160) : "";
    const eventPayload = {
      tool: name,
      ...(rawAction ? { action: rawAction } : {})
    };
    if (initialWorkspace) {
      void recordServerRuntimeEvent(server, "tool.started", {
        workspace: initialWorkspace,
        context: traceContext,
        timestampMs: started,
        payload: eventPayload
      });
    }
    const invokeHandler = () => handler(usageArgs);
    try {
      const handled = traceContext
        ? await runWithRuntimeTraceContext(traceContext, invokeHandler)
        : await invokeHandler();
      const result = tagToolResult(handled, name, options);
      const status = result?.isError ? "error" : "ok";
      const durationMs = Date.now() - started;
      logToolCall(name, status, started);
      recordMcpUsage(name, usageArgs, result, status, durationMs);
      await recordToolRuntimeTrace(server, name, usageArgs, status, started, started + durationMs, traceContext);
      await recordServerRuntimeEvent(server, status === "ok" ? "tool.completed" : "tool.failed", {
        workspace: initialWorkspace,
        context: traceContext,
        timestampMs: started + durationMs,
        payload: { ...eventPayload, durationMs }
      });
      return result;
    } catch (error) {
      const result = tagToolResult(errorResult(error), name, options);
      const durationMs = Date.now() - started;
      logToolCall(name, "error", started);
      recordMcpUsage(name, usageArgs, result, "error", durationMs);
      await recordToolRuntimeTrace(server, name, usageArgs, "error", started, started + durationMs, traceContext);
      await recordServerRuntimeEvent(server, "tool.failed", {
        workspace: initialWorkspace,
        context: traceContext,
        timestampMs: started + durationMs,
        payload: { ...eventPayload, durationMs }
      });
      return result;
    }
  };

  const securitySchemes = [{ type: "noauth" }];
  const fullOptions: Record<string, unknown> = {
    securitySchemes,
    ...options,
    _meta: {
      securitySchemes,
      ...(options._meta as Record<string, unknown> | undefined)
    }
  };

  const s = server as any;
  if (typeof s.registerTool === "function") {
    s.registerTool(name, fullOptions, wrapped);
    return;
  }

  if (typeof s.tool === "function") {
    s.tool(name, (fullOptions.description as string | undefined) ?? name, fullOptions.inputSchema ?? {}, wrapped);
    return;
  }

  throw new Error("Unsupported MCP SDK: McpServer has neither registerTool nor tool.");
}

const MINIMAL_TOOL_NAMES = [
  SUPERTOOL_NAME,
  "server_config",
  "codexpro_self_test",
  "prepare_repo_task",
  "begin_repo_task",
  "repo_task_status",
  "workspace_coordination_status",
  "worker_job_status",
  "worker_job_history",
  "finalize_worker_job",
  "open_current_workspace",
  "open_workspace",
  "read",
  "create",
  "write",
  "edit",
  "apply_patch",
  "import_file",
  "bash",
  "show_changes"
] as const;

const BROWSER_TOOL_NAMES = [
  "browser_open",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_select",
  "browser_screenshot",
  "browser_close"
] as const;

const STANDARD_TOOL_NAMES = [
  ...MINIMAL_TOOL_NAMES,
  "inspect_workspace",
  "code_graph",
  "tree",
  "search",
  "load_skill",
  "view_image",
  "read_handoff",
  "wait_for_handoff",
  "export_pro_context",
  "handoff_to_agent",
  ...CONTROL_PLANE_TOOL_NAMES,
  ...BROWSER_TOOL_NAMES,
  "browser_control"
] as const;

const FULL_TOOL_NAMES = [
  SUPERTOOL_NAME,
  "server_config",
  "codexpro_self_test",
  "prepare_repo_task",
  "begin_repo_task",
  "repo_task_status",
  "workspace_coordination_status",
  "worker_job_status",
  "worker_job_history",
  "finalize_worker_job",
  "codexpro_inventory",
  "load_skill",
  "list_workspaces",
  "open_current_workspace",
  "open_workspace",
  "workspace_snapshot",
  "inspect_workspace",
  "code_graph",
  "tree",
  "search",
  "read",
  "view_image",
  "create",
  "write",
  "edit",
  "apply_patch",
  "import_file",
  "bash",
  "git_status",
  "git_diff",
  "show_changes",
  "read_handoff",
  "wait_for_handoff",
  "codex_context",
  "export_pro_context",
  "handoff_to_agent",
  "handoff_to_codex",
  ...CONTROL_PLANE_TOOL_NAMES,
  ...BROWSER_TOOL_NAMES,
  "browser_control"
] as const;

const CONNECTION_TEST_HIDDEN_TOOLS = new Set<string>([
  SUPERTOOL_NAME,
  "codexpro_self_test",
  "prepare_repo_task",
  "create",
  "finalize_worker_job",
  "write",
  "edit",
  "apply_patch",
  "import_file",
  "bash",
  ...BROWSER_TOOL_NAMES,
  "export_pro_context",
  "handoff_to_agent",
  "handoff_to_codex"
]);

function codexSessionToolNames(config: CodexProConfig): string[] {
  if (config.codexSessions === "off") return [];
  return config.codexSessions === "read"
    ? ["codex_sessions", "read_codex_session"]
    : ["codex_sessions"];
}

function toolNamesForMode(config: CodexProConfig, requireRepoTask = false): string[] {
  const names: string[] =
    config.toolMode === "full"
      ? [...FULL_TOOL_NAMES]
      : config.toolMode === "minimal"
        ? [...MINIMAL_TOOL_NAMES]
        : [...STANDARD_TOOL_NAMES];
  if (requireRepoTask) {
    const prepareIndex = names.indexOf("prepare_repo_task");
    if (prepareIndex !== -1) names.splice(prepareIndex, 1);
  }
  if (config.bashMode === "off") {
    const bashIndex = names.indexOf("bash");
    if (bashIndex !== -1) names.splice(bashIndex, 1);
  }
  if (config.writeMode !== "workspace") {
    for (const writeTool of ["create", "write", "edit", "apply_patch", "import_file"]) {
      const toolIndex = names.indexOf(writeTool);
      if (toolIndex !== -1) names.splice(toolIndex, 1);
    }
  }
  if (config.writeMode === "handoff" && !names.includes("handoff_to_agent")) names.push("handoff_to_agent");
  if (!config.analysisEnabled) {
    for (const analysisTool of ["inspect_workspace", "code_graph"]) {
      const analysisIndex = names.indexOf(analysisTool);
      if (analysisIndex !== -1) names.splice(analysisIndex, 1);
    }
  }
  if (!config.browserControl || config.connectionTest || config.toolMode === "minimal") {
    const browserIndex = names.indexOf("browser_control");
    if (browserIndex !== -1) names.splice(browserIndex, 1);
  }
  if (config.connectionTest) {
    for (const hiddenTool of CONNECTION_TEST_HIDDEN_TOOLS) {
      const toolIndex = names.indexOf(hiddenTool);
      if (toolIndex !== -1) names.splice(toolIndex, 1);
    }
  }
  for (const name of codexSessionToolNames(config)) {
    if (!names.includes(name)) names.push(name);
  }
  if (!config.controlPlaneUrl || !config.controlPlaneToken) {
    for (const name of CONTROL_PLANE_TOOL_NAMES) {
      const toolIndex = names.indexOf(name);
      if (toolIndex !== -1) names.splice(toolIndex, 1);
    }
  }
  return names;
}

const MINIMAL_TOOLS = new Set<string>(MINIMAL_TOOL_NAMES);
const STANDARD_TOOLS = new Set<string>(STANDARD_TOOL_NAMES);
const registeredToolNamesByServer = new WeakMap<object, string[]>();

function rememberRegisteredTool(server: McpServer, name: string): void {
  const key = server as object;
  const names = registeredToolNamesByServer.get(key) ?? [];
  if (!registeredToolNamesByServer.has(key)) registeredToolNamesByServer.set(key, names);
  if (!names.includes(name)) names.push(name);
}

function registeredToolNames(server: McpServer): string[] {
  return [...(registeredToolNamesByServer.get(server as object) ?? [])];
}

function shouldRegisterTool(config: CodexProConfig, name: string): boolean {
  if (config.connectionTest && CONNECTION_TEST_HIDDEN_TOOLS.has(name)) return false;
  if (name === "bash" && config.bashMode === "off") return false;
  if ((name === "create" || name === "write" || name === "edit" || name === "apply_patch" || name === "import_file") && config.writeMode !== "workspace") return false;
  if (name === "codex_sessions") return config.codexSessions !== "off";
  if (name === "read_codex_session") return config.codexSessions === "read";
  if ((name === "inspect_workspace" || name === "code_graph") && !config.analysisEnabled) return false;
  if (name === "browser_control") return config.browserControl && !config.connectionTest && config.toolMode !== "minimal";
  if (name === "handoff_to_agent" && config.writeMode === "handoff") return true;
  if (config.toolMode === "full") return true;
  if (config.toolMode === "minimal") return MINIMAL_TOOLS.has(name);
  return STANDARD_TOOLS.has(name);
}

function registerCodexTool(
  config: CodexProConfig,
  server: McpServer,
  name: string,
  options: Record<string, unknown>,
  handler: CodexToolHandler
): void {
  if (!shouldRegisterTool(config, name)) return;
  const validatedHandler: CodexToolHandler = (args) => {
    assertRepoTaskGate(server, name);
    return handler(validateToolArgs(name, options, args));
  };
  registerToolCompat(server, name, descriptorOptionsForConfig(config, name, options), validatedHandler);
  rememberRegisteredTool(server, name);
  rememberRegisteredToolHandler(server, name, validatedHandler);
}

function serverInstructions(config: CodexProConfig, requireRepoTask = false): string {
  const globalRules = requireRepoTask ? undefined : readGlobalRulesSnapshotSync();
  const editInstruction =
    config.connectionTest
      ? "5. Connection test mode is read-only. Write, patch, export, and handoff-writing tools are unavailable."
      : config.writeMode === "workspace"
      ? "5. Create new source files with create; edit existing files with write/edit/apply_patch. After edits, call show_changes once for git status, diff stats, and review diff."
      : config.writeMode === "handoff"
        ? "5. Source writes are disabled and generic write/edit/apply_patch tools are unavailable. Use handoff_to_agent/handoff_to_codex for plans."
        : "5. Write/edit/apply_patch tools are disabled. Do not attempt direct file writes; use handoff or context export workflows instead.";
  const bashInstruction =
    config.bashMode === "off"
      ? "6. Bash is disabled and the bash tool is unavailable. Do not attempt shell commands."
      : "6. Use bash only for meaningful verification commands such as npm test, npm run build, lint, typecheck, or an existing project script.";

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
      ? "1. Every profile-bound ChatGPT task must call begin_repo_task once with a clear, natural, easy-to-understand AI-generated task_title of 4-6 words and task_kind=general or code. Use general for answers/research that do not touch source; use code before any repository/workspace tool. If a CodexPro Manager prompt supplies an exact task id/root/scope, pass those exact values. For a direct ChatGPT request, omit task_id and root; CodexPro generates the task id and uses this profile's locked workspace. A newly begun task invalidates the previous active task immediately. The codexpro wrapper may be used for action=list_actions/help and action=begin_repo_task; repo_task_status is also available before activation."
      : config.controlPlaneUrl && config.toolMode !== "minimal"
        ? "1. In a role-bound CodexPro Worker Chat, call worker_cycle_start exactly once for each Control Plane wake job. It automatically ACKs governance and claims the next role-compatible task without a schedule. If it returns TASK_CLAIMED, open_workspace with the returned workerBinding.worktreePath and continue tool calls until its nextAction and pendingInstructions are completed or a real blocker is recorded; do not stop after narrating what you will do. If it returns IDLE, stop cleanly. In an ordinary session, start with open_current_workspace."
        : "1. Start with open_current_workspace. Use open_workspace only when the user gives a different allowed root or asks to switch projects; that selection stays active for this MCP session.",
    requireRepoTask
      ? `2. task_kind=general records the task title only and does not load global rules or CodexGraph. task_kind=code loads the latest mandatory global rules from ${path.join(codexProHome(), CODEXPRO_GLOBAL_RULES_FILE)}, activates CodexGraph, and binds both to the repository gate. If the rules change, the next gated tool fails closed until begin_repo_task runs again.`
      : `2. The mandatory global rules above come from ${path.join(codexProHome(), CODEXPRO_GLOBAL_RULES_FILE)} and are loaded when the MCP server/session starts. begin_repo_task, open_current_workspace, and open_workspace also return the latest file contents before repo-local AGENTS.md-style instructions.`,
    "3. Follow any AGENTS.md-style instructions returned by the workspace open call before editing files.",
    requireRepoTask
      ? "4. Only after begin_repo_task succeeds with task_kind=code may you use open_current_workspace/open_workspace, tree, search, read, write, or bash. A general task remains workspace-gated. Do not use bash for git status, git diff, cat, sed, grep, rg, find, ls, or file reading."
      : "4. Inspect with tree, search, and read. Do not use bash for git status, git diff, cat, sed, grep, rg, find, ls, or file reading.",
    editInstruction,
    bashInstruction,
    "7. Prioritize correctness over minimizing tool calls or context. For non-trivial edits, use structured search with intent=impact/references to inspect CodexGraph callers, state, framework links, and related tests before changing code.",
    "8. write/edit/apply_patch return automatic CodexGraph before/after impact evidence. Treat graph-integrity warnings or removed dependency edges as verification requirements, not harmless noise.",
    "9. CodexGraph augments but never replaces source inspection, typecheck, runtime tests, or broader review when code uses dynamic dispatch, reflection, string-based routing, or unresolved compiler diagnostics.",
    "10. For rendered web UI verification, call browser_open, use refs from browser_snapshot with browser_click/browser_type/browser_select, and close the browser when finished.",
    "11. Keep tool calls minimal. Prefer one targeted search plus show_changes instead of repeated broad inspection calls.",
    config.codexSessions !== "off"
      ? `12. Codex session history access is enabled in ${config.codexSessions} mode. Use it only when the user asks for local Codex session history.`
      : "",
    config.requireBashSession && config.bashSessionId
      ? `13. Bash session guard is enabled. Every bash call must include session_id="${config.bashSessionId}".`
      : config.bashSessionId
        ? `13. Bash session label for this server is "${config.bashSessionId}".`
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

async function mutationCodexGraphImpact(config: CodexProConfig, guard: PathGuard, workspace: Workspace, changedPaths: string[]) {
  if (!config.analysisEnabled || !changedPaths.length) return undefined;
  try {
    return await reviewWorkspaceChanges(config, guard, workspace, { changedPaths });
  } catch {
    return undefined;
  }
}

function compactMutationCodexGraphImpact(impact: Awaited<ReturnType<typeof reviewWorkspaceChanges>> | undefined) {
  if (!impact) return undefined;
  return {
    dependent_files: impact.dependentFiles.slice(0, 40),
    related_tests: impact.relatedTests.slice(0, 40),
    risk_signals: impact.riskSignals,
    graph_diff: impact.graphDiff,
    warnings: impact.warnings.slice(-8)
  };
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

function decodeGitQuotedPath(pathText: string): string {
  const input = pathText.startsWith('"') && pathText.endsWith('"') ? pathText.slice(1, -1) : pathText;
  let decoded = "";
  let escapedBytes: number[] = [];
  const flushEscapedBytes = () => {
    if (!escapedBytes.length) return;
    decoded += Buffer.from(escapedBytes).toString("utf8");
    escapedBytes = [];
  };
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char !== "\\") {
      flushEscapedBytes();
      decoded += char;
      continue;
    }
    i += 1;
    const escaped = input[i];
    if (escaped === undefined) throw new CodexProError(`Invalid quoted Git path: ${pathText}`);
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      for (let j = 0; j < 2 && i + 1 < input.length && /[0-7]/.test(input[i + 1]); j += 1) {
        i += 1;
        octal += input[i];
      }
      escapedBytes.push(Number.parseInt(octal, 8));
    } else {
      flushEscapedBytes();
      decoded += ({ a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" } as Record<string, string>)[escaped] ?? escaped;
    }
  }
  flushEscapedBytes();
  return decoded;
}

function stripPatchPathComponents(filePath: string, stripComponents: number): string {
  if (path.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) return filePath;
  let stripped = filePath;
  for (let i = 0; i < stripComponents; i += 1) {
    const slash = stripped.indexOf("/");
    if (slash < 0) return stripped;
    stripped = stripped.slice(slash + 1);
  }
  return stripped;
}

function normalizePatchPath(rawPath: string, stripComponents = 1): string | undefined {
  const raw = rawPath.trim().split("\t")[0]?.trim();
  if (!raw || raw === "/dev/null") return undefined;
  const unquoted = raw.startsWith('"') && raw.endsWith('"') ? decodeGitQuotedPath(raw.slice(1, -1)) : raw;
  return stripPatchPathComponents(unquoted, stripComponents);
}

function patchHasSymlinkMode(patch: string): boolean {
  return patch.split(/\r?\n/).some((line) => /^(?:new|old|deleted) file mode 120000\s*$/.test(line) || /^new mode 120000\s*$/.test(line) || /^old mode 120000\s*$/.test(line));
}

function patchTouchedPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const normalized = normalizePatchPath(line.slice(4));
      if (normalized) paths.add(normalized);
    } else if (line.startsWith("rename from ") || line.startsWith("rename to ") || line.startsWith("copy from ") || line.startsWith("copy to ")) {
      const normalized = normalizePatchPath(line.replace(/^(?:rename|copy) (?:from|to) /, ""), 0);
      if (normalized) paths.add(normalized);
    }
  }
  return [...paths];
}

async function applyWorkspacePatch(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  patch: string
): Promise<{ paths: string[]; stdout: string; stderr: string; diff: string; additions: number; deletions: number; changed: boolean }> {
  if (!patch.trim()) throw new CodexProError("patch is required.");
  if (Buffer.byteLength(patch, "utf8") > config.maxWriteBytes) {
    throw new CodexProError(`Patch is too large. Limit: ${config.maxWriteBytes} bytes.`);
  }
  if (patchHasSymlinkMode(patch)) {
    throw new CodexProError("Symlink patches are blocked from apply_patch.");
  }

  const codexEnvelope = isCodexPatchEnvelope(patch);
  const paths = codexEnvelope ? codexPatchTouchedPaths(patch) : patchTouchedPaths(patch);
  if (!paths.length) throw new CodexProError("Patch must include at least one file path.");
  const absPaths: string[] = [];
  for (const touchedPath of paths) {
    absPaths.push(guard.resolve(workspace, touchedPath, { forWrite: true }).absPath);
    assertWriteToolAllowed(config, touchedPath);
  }

  return withFileWriteLocks(absPaths, async () => {
    for (const touchedPath of paths) {
      guard.resolve(workspace, touchedPath, { forWrite: true });
      assertWriteToolAllowed(config, touchedPath);
    }

    const normalizedPatch = codexEnvelope
      ? await codexPatchToUnifiedDiff(patch, workspace.root, fsp.readFile)
      : patch;
    if (Buffer.byteLength(normalizedPatch, "utf8") > config.maxWriteBytes) {
      throw new CodexProError(`Normalized patch is too large. Limit: ${config.maxWriteBytes} bytes.`);
    }
    if (patchHasSymlinkMode(normalizedPatch)) {
      throw new CodexProError("Symlink patches are blocked from apply_patch.");
    }

    const check = spawnSync("git", ["apply", "--check", "--whitespace=nowarn"], {
      cwd: workspace.root,
      input: normalizedPatch,
      encoding: "utf8",
      maxBuffer: config.maxOutputBytes,
      env: { ...process.env, NO_COLOR: "1" }
    });
    if (check.error || check.status !== 0) {
      throw new CodexProError(redactSensitiveText(check.stderr?.trim() || check.stdout?.trim() || check.error?.message || "git apply --check failed"));
    }

    const applied = spawnSync("git", ["apply", "--whitespace=nowarn"], {
      cwd: workspace.root,
      input: normalizedPatch,
      encoding: "utf8",
      maxBuffer: config.maxOutputBytes,
      env: { ...process.env, NO_COLOR: "1" }
    });
    if (applied.error || applied.status !== 0) {
      throw new CodexProError(redactSensitiveText(applied.stderr?.trim() || applied.stdout?.trim() || applied.error?.message || "git apply failed"));
    }

    const diff = redactSensitiveText(normalizedPatch.trimEnd());
    const stats = diffStats(diff);
    return {
      paths,
      stdout: redactSensitiveText(applied.stdout?.trim() || ""),
      stderr: redactSensitiveText(applied.stderr?.trim() || ""),
      diff,
      additions: stats.additions,
      deletions: stats.deletions,
      changed: true
    };
  });
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

function jsonlEvent(event: string, data: Record<string, unknown>): string {
  return JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n";
}

function cleanOneLine(value: unknown, fallback: string, maxLength = 120): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, maxLength);
}

function normalizeAgentId(value: unknown): string {
  const agent = cleanOneLine(value, "custom", 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(agent)) {
    throw new CodexProError("agent must use only lowercase letters, numbers, dots, underscores, or hyphens.");
  }
  return agent;
}

function displayAgentName(agent: string, agentName?: unknown): string {
  const explicit = cleanOneLine(agentName, "", 80);
  if (explicit) return explicit;
  if (agent === "codex") return "Codex";
  if (agent === "opencode") return "OpenCode";
  if (agent === "pi") return "Pi";
  return agent;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function agentCommandHint(agent: string, planPath: string, model?: string): string {
  const modelArg = model ? ` --model ${shellQuote(model)}` : " --model '<provider/model>'";
  const quotedPlanPath = shellQuote(planPath);
  if (agent === "opencode") return `opencode run${modelArg} "$(cat ${quotedPlanPath})"`;
  if (agent === "pi") return `pi run${modelArg} "$(cat ${quotedPlanPath})"`;
  if (agent === "codex") return `Read ${planPath} and execute it in small, reviewable steps.`;
  return `Run your local implementation agent manually with ${planPath} as the task input.`;
}

async function readRawTextFileBounded(config: CodexProConfig, guard: PathGuard, workspace: Workspace, filePath: string): Promise<string> {
  const resolved = guard.resolve(workspace, filePath);
  await guard.assertTextFile(resolved.absPath, config.maxReadBytes);
  return fsp.readFile(resolved.absPath, "utf8");
}

function buildAgentPlanBody(options: {
  title: string;
  plan: string;
  workspace: Workspace;
  agent: string;
  agentName: string;
  model?: string;
  statusPath: string;
  diffPath: string;
  executionLogPath: string;
}): string {
  const modelLine = options.model ? `Model: ${options.model}\n` : "";
  return `# ${options.title}

Updated: ${new Date().toISOString()}
Workspace: ${options.workspace.root}
Target agent: ${options.agentName} (${options.agent})
${modelLine}
## Plan

${options.plan.trim()}

## Implementation contract

- Work from this plan in small, reviewable steps.
- Keep edits scoped to the requested task and existing project conventions.
- Run focused verification before handing work back.
- Update ${options.statusPath} with files touched, checks run, results, blockers, and review notes.
- Save the final review diff to ${options.diffPath} when practical.
- Append notable execution events to ${options.executionLogPath} when the implementation agent supports logging.
`;
}

async function writeAgentHandoff(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: {
    agent: string;
    agentName?: string;
    model?: string;
    title: string;
    plan: string;
    append: boolean;
    eventName: string;
  }
): Promise<{
  agent: string;
  agentName: string;
  model?: string;
  title: string;
  planPath: string;
  statusPath: string;
  diffPath: string;
  logPath: string;
  executionLogPath: string;
  prompt: string;
  writeResult: Awaited<ReturnType<typeof writeTextFile>>;
}> {
  await ensureAiBridge(config, guard, workspace);
  const agent = normalizeAgentId(options.agent);
  const agentName = displayAgentName(agent, options.agentName);
  const model = options.model ? cleanOneLine(options.model, "", 120) : undefined;
  const plan = String(options.plan ?? "").trim();
  if (!plan) throw new CodexProError("plan must not be empty.");
  const planPath = `${config.contextDir}/current-plan.md`;
  const statusPath = `${config.contextDir}/agent-status.md`;
  const legacyCodexStatusPath = `${config.contextDir}/codex-status.md`;
  const diffPath = `${config.contextDir}/implementation-diff.patch`;
  const logPath = `${config.contextDir}/session-log.jsonl`;
  const executionLogPath = `${config.contextDir}/execution-log.jsonl`;
  const body = buildAgentPlanBody({
    title: options.title,
    plan,
    workspace,
    agent,
    agentName,
    model,
    statusPath,
    diffPath,
    executionLogPath
  });

  let content = body;
  if (options.append) {
    const raw = await readRawTextFileBounded(config, guard, workspace, planPath);
    content = `${raw.trimEnd()}\n\n---\n\n${body}`;
  }

  const writeResult = await writeTextFile(config, guard, workspace, planPath, content, { createDirs: true, overwrite: true });
  const event = {
    agent,
    agent_name: agentName,
    model,
    title: options.title,
    plan_path: planPath,
    status_path: statusPath,
    diff_path: diffPath
  };
  const logResolved = guard.resolve(workspace, logPath, { forWrite: true });
  const executionLogResolved = guard.resolve(workspace, executionLogPath, { forWrite: true });
  await fsp.appendFile(logResolved.absPath, jsonlEvent(options.eventName, event), "utf8");
  await fsp.appendFile(executionLogResolved.absPath, jsonlEvent(options.eventName, event), "utf8");

  const promptLines = [
    `Read ${planPath} and execute it in small, reviewable steps.`,
    `After each meaningful change, update ${statusPath} with files touched, checks run, results, blockers, and the next review focus.`,
    `Before review, write the final diff to ${diffPath} when practical.`,
    agentCommandHint(agent, planPath, model)
  ];
  if (agent === "codex") {
    promptLines.splice(2, 0, `For legacy Codex handoffs, mirror key status notes to ${legacyCodexStatusPath} if your workflow expects that file.`);
  }
  const prompt = promptLines.join("\n");

  return {
    agent,
    agentName,
    model,
    title: options.title,
    planPath,
    statusPath,
    diffPath,
    logPath,
    executionLogPath,
    prompt,
    writeResult
  };
}

const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const SESSION_READ_ANNOTATIONS = { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: false };
const LOCAL_WRITE_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: true, idempotentHint: false };
const CREATE_FILE_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false };
const BASH_ANNOTATIONS = { readOnlyHint: false, openWorldHint: true, destructiveHint: true, idempotentHint: false };
const BROWSER_READ_ANNOTATIONS = { readOnlyHint: true, openWorldHint: true, destructiveHint: false, idempotentHint: false };
const BROWSER_ACTION_ANNOTATIONS = { readOnlyHint: false, openWorldHint: true, destructiveHint: true, idempotentHint: false };
const HANDOFF_WRITE_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false };
type RepoTaskProof = {
  taskId: string;
  taskTitle: string;
  taskKind: "general" | "code";
  taskSource: "manager" | "chatgpt_direct";
  root: string;
  workspaceId: string;
  startedAt: string;
  scope: "workspace" | "all_allowed";
  globalRulesPath?: string;
  globalRulesSha256?: string;
  globalRulesLoadedAt?: string;
  agentsFiles?: string[];
  agentsSha256?: string;
  codexGraph?: Awaited<ReturnType<typeof requireCodexGraphForWorkspace>>;
};

const repoTaskProofs = new Map<string, RepoTaskProof>();

function responseHasStrongerNetworkStreamEvidence(result: Record<string, any>): boolean {
  const audit = result?.response_audit;
  const dom = audit?.chatgpt_dom;
  const stream = audit?.network_stream;
  if (!dom?.available || !stream?.available) return false;
  const domAssistant = dom.assistant_after_latest_user || dom.latest_assistant;
  const streamAssistant = stream.assistant_after_latest_user || stream.latest_assistant;
  const domLength = Math.max(0, Number(domAssistant?.length) || 0);
  const streamLength = Math.max(0, Number(streamAssistant?.length) || 0);
  if (!streamLength || streamLength <= domLength) return false;

  const generationStartedMs = Date.parse(String(result?.network_last_started_at || ""));
  if (Number.isFinite(generationStartedMs)) {
    const streamUpdatedMs = Date.parse(String(result?.network_stream_updated_at || ""));
    if (!Number.isFinite(streamUpdatedMs) || streamUpdatedMs < generationStartedMs) return false;
  }

  return streamLength >= Math.max(domLength + 24, Math.ceil(domLength * 1.5)) && domLength < 160;
}

function rememberRepoTaskProof(proof: RepoTaskProof): void {
  repoTaskProofs.set(proof.taskId, proof);
  if (repoTaskProofs.size <= 500) return;
  for (const taskId of [...repoTaskProofs.keys()].slice(0, repoTaskProofs.size - 400)) repoTaskProofs.delete(taskId);
}

export interface CodexProServerContext {
  workerId?: string | null;
  browserProfileId?: string;
  requireRepoTask?: boolean;
  onWorkspaceSelected?: (workspace: Workspace) => void;
}

export function createCodexProServer(config: CodexProConfig, context: CodexProServerContext = {}): McpServer {
  let browserProfileId = String(context.browserProfileId || "").trim();
  const requireRepoTask = context.requireRepoTask ?? Boolean(browserProfileId);
  let selectedRuntimeTraceWorkspace: Workspace | undefined;
  const workspaces = new WorkspaceManager(
    config,
    (workspace) => {
      selectedRuntimeTraceWorkspace = workspace;
      context.onWorkspaceSelected?.(workspace);
      if (browserProfileId) setBrowserExtensionProfileWorkspace(browserProfileId, workspace.root);
    },
    browserProfileId ? () => getBrowserExtensionProfileWorkspaceBinding(browserProfileId) : undefined
  );
  const reviewCheckpoints = new Map<string, string>();
  const guard = new PathGuard(config);
  const browser = getSharedBrowserAutomation();
  const server = new McpServer({ name: "CodexPro", version: "0.30.0" }, { instructions: serverInstructions(config, requireRepoTask) });
  runtimeTraceWorkspaceByServer.set(server as object, () => selectedRuntimeTraceWorkspace ?? workspaces.defaultWorkspace());
  if (context.workerId) runtimeWorkerIdByServer.set(server as object, String(context.workerId));
  repoTaskWorkspaceSelectorByServer.set(server as object, (root) => workspaces.openWorkspace(root));
  repoTaskGateRequiredByServer.set(server as object, requireRepoTask);
  if (browserProfileId) repoTaskGateProfileByServer.set(server as object, browserProfileId);
  if (config.browserControl) ensureBrowserExtensionBridge();
  registeredToolNamesByServer.set(server as object, []);
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

  if (config.controlPlaneUrl && config.controlPlaneToken) {
    for (const definition of controlPlaneToolDefinitions({
      baseUrl: config.controlPlaneUrl,
      workerId: context.workerId ?? null,
      token: config.controlPlaneToken,
      allowedRoots: config.allowedRoots
    })) {
      registerCodexTool(config, server, definition.name, definition.options, definition.handler);
    }
  }

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
        controlPlane: {
          enabled: Boolean(config.controlPlaneUrl),
          url: config.controlPlaneUrl ?? null,
          signedBridgeAuth: Boolean(config.controlPlaneToken),
          boundWorkerId: context.workerId ?? null
        },
        browserControl: config.browserControl,
        browserDebugUrl: config.browserControl ? config.browserDebugUrl : null,
        toolCards: config.toolCards,
        connectionTest: config.connectionTest,
        analysisEnabled: config.analysisEnabled,
        analysisLimits: config.analysisLimits,
        browserAutomation: {
          enabled: true,
          engine: "playwright-chromium",
          headless: process.env.CODEXPRO_BROWSER_HEADLESS !== "0",
          sessionScope: "shared across MCP transport reconnects within this CodexPro process",
          networkPolicy: "public web plus localhost; private LAN and metadata endpoints blocked"
        },
        inheritEnv: config.inheritEnv,
        contextDir: config.contextDir,
        maxReadBytes: config.maxReadBytes,
        maxWriteBytes: config.maxWriteBytes,
        maxImportBytes: config.maxImportBytes,
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

  if (!requireRepoTask) registerCodexTool(
    config,
    server,
    "prepare_repo_task",
    {
      title: "Prepare Manager Repo Task",
      description: "Manager-only control-plane action. Bind the next CodexPro Manager task id/scope to a worker before dispatch. A workspace-scoped task must include root; all_allowed deliberately leaves root unbound so the worker can choose the correct allowed workspace.",
      inputSchema: {
        profile_id: z.string().regex(WORKER_PROFILE_ID_PATTERN).describe("Profile-bound worker id receiving the Manager request. API workers use <plugin>:<worker>; legacy Chrome profile ids remain supported."),
        task_id: z.string().regex(/^cpt_[a-f0-9]{24}$/).describe("Exact task id generated by CodexPro Manager."),
        root: z.string().min(1).optional().describe("Locked workspace root for workspace scope. Omit for all_allowed so the AI chooses the actual workspace."),
        scope: z.enum(["workspace", "all_allowed"]).optional().describe("Task scope. Default: workspace.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS
    },
    async (args) => {
      const scope: "workspace" | "all_allowed" = args.scope === "all_allowed" ? "all_allowed" : "workspace";
      if (scope === "workspace" && !args.root) {
        throw new CodexProError("REPO_TASK_ROOT_REQUIRED: workspace-scoped Manager tasks must prepare an exact root.", { code: "REPO_TASK_ROOT_REQUIRED" });
      }
      const preparedRoot = args.root ? workspaces.openWorkspace(args.root, { select: false }).root : undefined;
      const expected: ExpectedRepoTask = {
        taskId: args.task_id,
        root: scope === "workspace" ? preparedRoot : undefined,
        scope,
        preparedAt: Date.now()
      };
      rememberExpectedRepoTask(args.profile_id, expected);
      setBrowserExtensionProfilePendingTask(args.profile_id, expected.taskId, expected.root || "", expected.scope, expected.preparedAt);
      const workerJob = await prepareWorkerJob({
        jobId: expected.taskId,
        workerId: args.profile_id,
        root: expected.root,
        scope: expected.scope
      });
      recordBrowserProfileTaskEvent("repo_task_prepared", {
        profile_id: args.profile_id,
        task_id: expected.taskId,
        root: expected.root,
        scope: expected.scope,
        prepared_at: new Date(expected.preparedAt).toISOString(),
        policy_version: workerJob.policyVersion
      });
      return textResult(`# Repo Task Prepared\n\nProfile: ${args.profile_id}\nTask: ${expected.taskId}\nRoot: ${expected.root || "(AI chooses an allowed workspace)"}\nScope: ${expected.scope}`, {
        prepared: true,
        profile_id: args.profile_id,
        task_id: expected.taskId,
        root: expected.root,
        root_unbound: scope === "all_allowed",
        scope: expected.scope,
        prepared_at: new Date(expected.preparedAt).toISOString()
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "begin_repo_task",
    {
      title: "Register Profile Task",
      description: "Mandatory lightweight first call for every profile-bound worker task. Always provide a clear, natural, easy-to-understand 4-6 word task_title. Use task_kind=general for answers/research without source access; only task_kind=code loads global rules, activates CodexGraph, and unlocks repository tools.",
      inputSchema: {
        task_id: z.string().regex(/^cpt_[a-f0-9]{24}$/).optional().describe("Exact task id included by CodexPro Manager. Omit only for a request typed directly in ChatGPT."),
        task_title: z.string().trim().min(4).max(56)
          .refine((value) => { const words = value.split(/\s+/).filter(Boolean).length; return words >= 4 && words <= 6; }, "Task title must contain 4-6 words.")
          .refine((value) => !/^(?:làm sao|sửa đi|làm đi|fix đi|check lỗi|kiểm tra|tiếp tục)$/iu.test(value.trim()), "Task title must describe the actual work, not a vague request.")
          .describe("Required title chosen and returned by the AI: 4-6 short, clear, natural words describing the actual work."),
        task_kind: z.enum(["general", "code"]).describe("Use general when no source/workspace tool is needed. Use code before reading, changing, building, or testing a repository."),
        root: z.string().min(1).optional().describe("Initial workspace root included by CodexPro Manager. Omit for a direct ChatGPT request to use the profile's locked workspace."),
        scope: z.enum(["workspace", "all_allowed"]).optional().describe("Task scope. Omit or use workspace for a locked workspace; use all_allowed only when Manager explicitly enables all allowed roots.")
      },
      annotations: SESSION_READ_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Registering the CodexPro task...",
        "openai/toolInvocation/invoked": "CodexPro task registered"
      }
    },
    async (args) => {
      const sessionProfileId = repoTaskGateProfileByServer.get(server as object) || "";
      let gateProfileId = sessionProfileId;
      let expected = gateProfileId ? expectedRepoTask(gateProfileId) : undefined;
      const managerPrepared = Boolean(args.task_id);
      const taskId = args.task_id || (gateProfileId ? `cpt_${randomBytes(12).toString("hex")}` : "");
      let preparedOwner = managerPrepared && taskId ? expectedRepoTaskOwner(taskId) : undefined;
      if (managerPrepared && taskId && !preparedOwner) {
        const persistedOwner = getBrowserExtensionPendingTaskOwner(taskId);
        if (persistedOwner) {
          const recoveredExpected = rememberExpectedRepoTask(persistedOwner.profile_id, {
            taskId: persistedOwner.task_id,
            root: persistedOwner.scope === "workspace" ? persistedOwner.root || undefined : undefined,
            scope: persistedOwner.scope
          });
          preparedOwner = { profileId: persistedOwner.profile_id, expected: recoveredExpected };
          if (gateProfileId === persistedOwner.profile_id) expected = recoveredExpected;
          recordBrowserProfileTaskEvent("repo_task_prepared_rehydrated", {
            profile_id: persistedOwner.profile_id,
            session_profile_id: sessionProfileId,
            task_id: taskId,
            root: recoveredExpected.root,
            scope: recoveredExpected.scope,
            prepared_at: persistedOwner.prepared_at,
            reason: "runtime_restart"
          });
        }
      }
      if (preparedOwner && preparedOwner.profileId !== gateProfileId) {
        gateProfileId = preparedOwner.profileId;
        expected = preparedOwner.expected;
        browserProfileId = gateProfileId;
        repoTaskGateProfileByServer.set(server as object, gateProfileId);
        recordBrowserProfileTaskEvent("repo_task_profile_rerouted", {
          task_id: taskId,
          task_title: String(args.task_title || ""),
          session_profile_id: sessionProfileId,
          task_owner_profile_id: gateProfileId,
          reason: "prepared_task_id_owner"
        });
      }
      if (managerPrepared && !preparedOwner && !gateProfileId) {
        recordBrowserProfileTaskEvent("repo_task_owner_missing", {
          task_id: taskId,
          task_title: String(args.task_title || ""),
          session_profile_id: sessionProfileId,
          reason: "prepared_task_id_not_found"
        });
        throw new CodexProError(
          "REPO_TASK_NOT_PREPARED: This Manager task id has no owning Chrome profile. Refresh the Manager task and call begin_repo_task with the newly prepared id.",
          { code: "REPO_TASK_NOT_PREPARED", details: { task_id: taskId } }
        );
      }
      const scope: "workspace" | "all_allowed" = managerPrepared && args.scope === "all_allowed" ? "all_allowed" : "workspace";
      if (gateProfileId) await assertBrowserControlHeadlessExclusive(gateProfileId);
      if (requireRepoTask) {
        if (!gateProfileId) {
          throw new CodexProError(
            "REPO_TASK_PROFILE_REQUIRED: The MCP connector is not bound to a worker profile.",
            { code: "REPO_TASK_PROFILE_REQUIRED", details: { task_id: taskId || undefined } }
          );
        }
        if (managerPrepared && !expected) {
          recordBrowserProfileTaskEvent("repo_task_begin_rejected", {
            profile_id: gateProfileId,
            session_profile_id: sessionProfileId,
            task_id: taskId,
            reason: "task_not_prepared"
          });
          throw new CodexProError(
            "REPO_TASK_NOT_PREPARED: CodexPro Manager has not prepared the supplied task for this worker profile.",
            { code: "REPO_TASK_NOT_PREPARED", details: { profile_id: gateProfileId, task_id: taskId } }
          );
        }
        if (managerPrepared && expected && (expected.taskId !== taskId || expected.scope !== scope)) {
          recordBrowserProfileTaskEvent("repo_task_begin_rejected", {
            profile_id: gateProfileId,
            session_profile_id: sessionProfileId,
            task_id: taskId,
            expected_task_id: expected.taskId,
            expected_scope: expected.scope,
            received_scope: scope,
            reason: "task_mismatch"
          });
          throw new CodexProError(
            `REPO_TASK_MISMATCH: begin_repo_task must use the exact task id and scope prepared by CodexPro Manager (${expected.taskId}, ${expected.scope}).`,
            {
              code: "REPO_TASK_MISMATCH",
              details: {
                profile_id: gateProfileId,
                expected_task_id: expected.taskId,
                received_task_id: taskId,
                expected_scope: expected.scope,
                received_scope: scope
              }
            }
          );
        }
      }
      if (!taskId) {
        throw new CodexProError("REPO_TASK_ID_REQUIRED: task_id is required outside a profile-bound ChatGPT connector.", { code: "REPO_TASK_ID_REQUIRED" });
      }
      const managerAllAllowed = Boolean(managerPrepared && expected?.scope === "all_allowed");
      if (managerAllAllowed && args.task_kind === "code" && !args.root) {
        throw new CodexProError(
          "REPO_TASK_ROOT_REQUIRED: all_allowed code tasks must choose the actual allowed workspace root instead of inheriting the Manager default workspace.",
          { code: "REPO_TASK_ROOT_REQUIRED", details: { profile_id: gateProfileId, task_id: taskId, scope } }
        );
      }
      let requestedRoot = String(args.root || "").trim();
      if (!requestedRoot && !managerAllAllowed) {
        requestedRoot = getBrowserExtensionProfileWorkspaceBinding(gateProfileId) || expected?.root || config.defaultRoot;
      }
      const workspace = args.task_kind === "code" ? workspaces.openWorkspace(requestedRoot) : undefined;
      const resolvedRoot = workspace?.root || (requestedRoot ? path.resolve(requestedRoot) : "");
      if (managerPrepared && expected?.root && !sameResolvedRoot(resolvedRoot, expected.root)) {
        throw new CodexProError(
          `REPO_TASK_ROOT_MISMATCH: begin_repo_task must open the exact workspace prepared by CodexPro Manager: ${expected.root}`,
          {
            code: "REPO_TASK_ROOT_MISMATCH",
            details: { profile_id: gateProfileId, task_id: taskId, expected_root: expected.root, received_root: resolvedRoot }
          }
        );
      }
      if (gateProfileId && !managerPrepared) {
        expected = rememberExpectedRepoTask(gateProfileId, { taskId, root: resolvedRoot, scope: "workspace" });
      }
      const taskSource: RepoTaskProof["taskSource"] = managerPrepared ? "manager" : "chatgpt_direct";
      const startedAt = new Date().toISOString();
      const globalRules = args.task_kind === "code" ? await readGlobalRulesSnapshot() : undefined;
      const globalRulesLoadedAt = globalRules ? new Date().toISOString() : undefined;
      const codexGraph = args.task_kind === "code" ? await requireCodexGraphForWorkspace(config, guard, workspace!) : undefined;
      const codexContext = args.task_kind === "code" ? await readCodexContext(config, guard, workspace!, {
        targetPath: ".",
        includeAiBridge: false,
        includeGit: false,
        includeDiff: false
      }) : undefined;
      const agentsSha256 = codexContext ? createHash("sha256").update(codexContext.text).digest("hex") : undefined;
      const proof: RepoTaskProof = {
        taskId,
        taskTitle: args.task_title.trim(),
        taskKind: args.task_kind,
        taskSource,
        root: resolvedRoot,
        workspaceId: workspace?.id || "",
        startedAt,
        scope,
        globalRulesPath: globalRules?.path,
        globalRulesSha256: globalRules?.sha256,
        globalRulesLoadedAt,
        agentsFiles: codexContext?.agentsFiles || [],
        agentsSha256,
        codexGraph
      };
      const durableJob = await bootstrapWorkerJob({
        jobId: proof.taskId,
        workerId: gateProfileId || `direct.${proof.taskId}`,
        title: proof.taskTitle,
        kind: proof.taskKind,
        root: proof.root,
        workspaceId: proof.workspaceId,
        scope: proof.scope,
        rulesHash: proof.globalRulesSha256,
        rulesPath: proof.globalRulesPath,
        agentsFiles: proof.agentsFiles,
        agentsHash: proof.agentsSha256,
        codexGraphActive: Boolean(proof.codexGraph),
        codexGraphSymbolCount: proof.codexGraph?.coverage.symbolCount,
        codexGraphRelationshipCount: proof.codexGraph?.coverage.relationshipCount
      });
      if (gateProfileId) setBrowserExtensionProfileTask(gateProfileId, proof.taskId, proof.taskTitle);
      recordBrowserProfileTaskEvent("repo_task_started", {
        profile_id: gateProfileId,
        session_profile_id: sessionProfileId,
        profile_rerouted: Boolean(sessionProfileId && sessionProfileId !== gateProfileId),
        task_id: proof.taskId,
        task_title: proof.taskTitle,
        task_title_requested_by: "mcp_server",
        task_title_returned_by: "ai",
        task_kind: proof.taskKind,
        task_source: taskSource,
        root: proof.root,
        global_rules_loaded: Boolean(globalRules),
        global_rules_path: globalRules?.path,
        global_rules_sha256: globalRules?.sha256,
        global_rules_loaded_at: globalRulesLoadedAt,
        codexgraph_active: Boolean(codexGraph),
        codexgraph_workspace_id: codexGraph ? proof.workspaceId : undefined,
        codexgraph_symbol_count: codexGraph?.coverage.symbolCount,
        codexgraph_relationship_count: codexGraph?.coverage.relationshipCount
      });
      rememberRepoTaskProof(proof);
      activeRepoTaskByServer.delete(server as object);
      if (gateProfileId) activeRepoTaskByProfile.delete(gateProfileId);
      if (proof.taskKind === "general") {
        return textResult(`# Profile Task Registered\n\nTask: ${proof.taskId}\nTitle: ${proof.taskTitle}\nKind: general\n\nGlobal rules and CodexGraph were not loaded because this task does not use repository tools.`, {
          task_id: proof.taskId,
          task_title: proof.taskTitle,
          task_title_source: "ai",
          task_title_requested_by: "mcp_server",
          task_title_returned_by: "ai",
          task_kind: proof.taskKind,
          task_source: proof.taskSource,
          profile_id: gateProfileId,
          session_profile_id: sessionProfileId,
          profile_rerouted: Boolean(sessionProfileId && sessionProfileId !== gateProfileId),
          verified: true,
          gate_active: false,
          workspace_access: false,
          root: proof.root,
          workspace_id: proof.workspaceId,
          started_at: proof.startedAt,
          scope: proof.scope,
          global_rules_loaded: false,
          codexgraph_active: false,
          policy_version: durableJob.policyVersion,
          worker_job: workerJobPublicRecord(durableJob)
        });
      }
      if (!workspace || !globalRules || !codexGraph) {
        throw new CodexProError("REPO_TASK_CODE_CONTEXT_MISSING: code task activation requires a workspace, global rules, and CodexGraph.", { code: "REPO_TASK_CODE_CONTEXT_MISSING" });
      }
      const coordinationTask = await registerWorkspaceTask({
        taskId: proof.taskId,
        workerId: gateProfileId || `direct.${proof.taskId}`,
        title: proof.taskTitle,
        root: proof.root
      });
      const activeTask: ActiveRepoTask = {
        taskId: proof.taskId,
        taskTitle: proof.taskTitle,
        root: proof.root,
        workspaceId: proof.workspaceId,
        scope: proof.scope,
        globalRulesSha256: proof.globalRulesSha256!,
        worktreeRoot: coordinationTask.worktreeRoot,
        worktreeBranch: coordinationTask.worktreeBranch
      };
      activeRepoTaskByServer.set(server as object, activeTask);
      if (gateProfileId) {
        activeRepoTaskByProfile.delete(gateProfileId);
        activeRepoTaskByProfile.set(gateProfileId, activeTask);
      }
      await recordServerRuntimeEvent(server, "task.started", {
        workspace,
        context: currentRuntimeTraceContext(),
        task: activeTask,
        source: "repo-task",
        timestampMs: Date.parse(proof.startedAt),
        payload: { scope: proof.scope }
      });
      return textResult(withGlobalRules(`# Repo Task Verified\n\nTask: ${proof.taskId}\nRoot: ${proof.root}\nWorkspace: ${proof.workspaceId}\nScope: ${proof.scope}\nCodexGraph: active (${codexGraph.coverage.symbolCount} symbols, ${codexGraph.coverage.relationshipCount} relationships)`, globalRules), {
        task_id: proof.taskId,
        task_title: proof.taskTitle,
        task_title_source: "ai",
        task_title_requested_by: "mcp_server",
        task_title_returned_by: "ai",
        task_kind: proof.taskKind,
        task_source: proof.taskSource,
        profile_id: gateProfileId,
        session_profile_id: sessionProfileId,
        profile_rerouted: Boolean(sessionProfileId && sessionProfileId !== gateProfileId),
        verified: true,
        gate_active: true,
        workspace_access: true,
        root: proof.root,
        workspace_id: proof.workspaceId,
        worktree_root: coordinationTask.worktreeRoot,
        worktree_branch: coordinationTask.worktreeBranch,
        integration_status: coordinationTask.integrationStatus,
        started_at: proof.startedAt,
        scope: proof.scope,
        global_rules_loaded: true,
        global_rules_loaded_at: proof.globalRulesLoadedAt,
        global_rules_path: globalRules!.path,
        global_rules_sha256: globalRules!.sha256,
        global_rules_source: globalRules!.source,
        global_rules: globalRules!.text,
        agents_loaded: true,
        agents_files: proof.agentsFiles,
        agents_sha256: proof.agentsSha256,
        codexgraph_active: true,
        codexgraph: codexGraph,
        policy_version: durableJob.policyVersion,
        worker_job: workerJobPublicRecord(durableJob)
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "repo_task_status",
    {
      title: "Repo Task Status",
      description: "Check server-side proof that begin_repo_task was called for a CodexPro Manager task.",
      inputSchema: { task_id: z.string().regex(/^cpt_[a-f0-9]{24}$/) },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) => {
      const proof = repoTaskProofs.get(args.task_id);
      const gateProfileId = repoTaskGateProfileByServer.get(server as object) || "";
      const expected = gateProfileId ? expectedRepoTask(gateProfileId) : undefined;
      const active = gateProfileId ? activeRepoTaskByProfile.get(gateProfileId) : activeRepoTaskByServer.get(server as object);
      const rulesMatch = Boolean(active && readGlobalRulesSnapshotSync().sha256 === active.globalRulesSha256);
      let coordinationTask;
      if (proof?.taskKind === "code" && proof.root) {
        try {
          coordinationTask = readWorkspaceCoordination(proof.root).tasks[args.task_id];
        } catch {
          coordinationTask = undefined;
        }
      }
      const taskVerified = requireRepoTask
        ? Boolean(proof && expected && expected.taskId === args.task_id && expected.scope === proof.scope && repoTaskRootMatches(proof.root, expected))
        : Boolean(proof);
      const gateActive = Boolean(taskVerified && proof?.taskKind === "code" && sameRepoTask(active, expected) && rulesMatch);
      const workerJob = readWorkerJob(args.task_id);
      if (taskVerified && gateProfileId && proof?.taskTitle) {
        setBrowserExtensionProfileTask(gateProfileId, proof.taskId, proof.taskTitle);
      }
      return textResult(taskVerified ? `# Profile Task Verified\n\n${proof!.taskId} registered “${proof!.taskTitle}” as ${proof!.taskKind}.` : `# Profile Task Missing\n\nNo begin_repo_task proof was found for ${args.task_id}.`, {
        task_id: args.task_id,
        verified: taskVerified,
        gate_active: gateActive,
        profile_id: gateProfileId || undefined,
        expected_task_id: expected?.taskId,
        active_task_id: active?.taskId,
        ...(proof ? {
          task_title: proof.taskTitle,
          task_title_source: "ai",
          task_title_requested_by: "mcp_server",
          task_title_returned_by: "ai",
          task_kind: proof.taskKind,
          task_source: proof.taskSource,
          root: proof.root,
          workspace_id: proof.workspaceId,
          started_at: proof.startedAt,
          scope: proof.scope,
          global_rules_loaded: Boolean(proof.globalRulesSha256),
          global_rules_path: proof.globalRulesPath,
          global_rules_sha256: proof.globalRulesSha256,
          global_rules_loaded_at: proof.globalRulesLoadedAt,
          agents_loaded: Boolean(proof.agentsFiles),
          agents_files: proof.agentsFiles,
          agents_sha256: proof.agentsSha256,
          codexgraph_active: Boolean(proof.codexGraph),
          codexgraph: proof.codexGraph,
          worktree_root: coordinationTask?.worktreeRoot,
          worktree_branch: coordinationTask?.worktreeBranch,
          integration_status: coordinationTask?.integrationStatus,
          integration_branch: coordinationTask?.integrationBranch,
          integration_requested_at: coordinationTask?.integrationRequestedAt,
          integration_started_at: coordinationTask?.integrationStartedAt,
          integration_finished_at: coordinationTask?.integrationFinishedAt,
          integrated_head: coordinationTask?.integratedHead
        } : {}),
        policy_version: workerJob?.policyVersion || WORKER_POLICY_VERSION,
        worker_job: workerJobPublicRecord(workerJob)
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "workspace_coordination_status",
    {
      title: "Workspace Coordination Status",
      description: "Read multi-agent workspace ownership, worktree, stale-base, conflict, and integration queue state for a repo.",
      inputSchema: { root: z.string().min(1).optional() },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) => {
      const workspace = workspaces.openWorkspace(args.root, { select: false });
      const snapshot = readWorkspaceCoordinationStatus(workspace.root);
      const activeTasks = snapshot.tasks.filter((task) => task.status === "running").length;
      const conflicts = snapshot.tasks.filter((task) => task.integration_status === "conflict" || task.stale_base).length;
      return textResult(`# Workspace Coordination\n\n${activeTasks} active task(s), ${snapshot.claims.length} claimed path(s), ${snapshot.integration_queue.length} queued integration(s).`, {
        ...snapshot,
        active_task_count: activeTasks,
        conflict_count: conflicts
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "worker_job_status",
    {
      title: "Worker Job Status",
      description: "Read the durable MCP policy record for a Browser or API worker job, including bootstrap evidence and outstanding completion obligations.",
      inputSchema: { task_id: z.string().regex(/^cpt_[a-f0-9]{24}$/) },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) => {
      const record = readWorkerJob(args.task_id);
      return textResult(record ? `# Worker Job\n\n${args.task_id}: ${record.status}` : `# Worker Job Missing\n\n${args.task_id} has no durable worker policy record.`, {
        found: Boolean(record),
        policy_version: record?.policyVersion || WORKER_POLICY_VERSION,
        job: workerJobPublicRecord(record)
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "worker_job_history",
    {
      title: "Worker Job History",
      description: "List recent durable worker jobs for the CodexPro control center, including terminal status and start/finish timestamps.",
      inputSchema: {
        statuses: z.array(z.enum(["prepared", "running", "completed", "failed", "cancelled", "blocked"])).max(6).optional(),
        limit: z.number().int().min(1).max(200).optional()
      },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) => {
      const jobs = listWorkerJobs({ statuses: args.statuses, limit: args.limit });
      return textResult(`# Worker Job History\n\n${jobs.length} recent job(s).`, {
        count: jobs.length,
        jobs: jobs.map((record) => workerJobPublicRecord(record))
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "finalize_worker_job",
    {
      title: "Finalize Worker Job",
      description: "Finalize a profile-bound worker job only after the MCP policy record proves all required bootstrap and completion obligations.",
      inputSchema: {
        task_id: z.string().regex(/^cpt_[a-f0-9]{24}$/),
        outcome: z.enum(["completed", "failed", "cancelled"]),
        completed_obligations: z.array(z.string().min(1).max(100)).max(100).optional(),
        summary: z.string().max(4000).optional(),
        error: z.string().max(4000).optional()
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS
    },
    async (args) => {
      const gateProfileId = repoTaskGateProfileByServer.get(server as object) || undefined;
      if (!gateProfileId) {
        throw new CodexProError("WORKER_JOB_PROFILE_REQUIRED: finalize_worker_job requires a profile-bound Browser or API worker MCP session.", {
          code: "WORKER_JOB_PROFILE_REQUIRED",
          details: { task_id: args.task_id }
        });
      }
      try {
        const record = await finalizeWorkerJob({
          jobId: args.task_id,
          workerId: gateProfileId,
          outcome: args.outcome,
          completedObligations: args.completed_obligations,
          summary: args.summary,
          error: args.error
        });
        if (record.root) {
          const coordinationStatus = record.status === "completed" || record.status === "failed" || record.status === "cancelled" ? record.status : args.outcome;
          await finalizeWorkspaceTask({
            taskId: record.jobId,
            workerId: gateProfileId,
            title: record.title,
            root: record.root
          }, coordinationStatus);
        }
        return textResult(`# Worker Job Finalized\n\n${record.jobId}: ${record.status}`, {
          finalized: true,
          policy_version: record.policyVersion,
          job: workerJobPublicRecord(record)
        });
      } catch (error) {
        throw new CodexProError(`WORKER_JOB_FINALIZE_REJECTED: ${error instanceof Error ? error.message : String(error)}`, {
          code: "WORKER_JOB_FINALIZE_REJECTED",
          details: { task_id: args.task_id, profile_id: gateProfileId }
        });
      }
    }
  );

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

  registerCodexTool(
    config,
    server,
    "tree",
    {
      title: "File Tree",
      description: "List files and directories inside the workspace, excluding blocked paths.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().optional().describe("Directory relative to workspace root. Default: ."),
        max_depth: z.number().int().min(1).max(12).optional().describe("Maximum depth. Default: 4."),
        include_hidden: z.boolean().optional().describe("Include dotfiles/dotfolders that are not blocked. Default: false."),
        max_entries: z.number().int().min(1).max(3000).optional().describe("Maximum entries. Default: 800.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Listing workspace files...",
        "openai/toolInvocation/invoked": "Workspace files listed"
      }
    },
    async (args) => {
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const result = await repoTree(config, guard, workspace, {
        path: args.path ?? ".",
        maxDepth: limitInt(args.max_depth, 4, 1, 12),
        includeHidden: parseBool(args.include_hidden, false),
        maxEntries: limitInt(args.max_entries, 800, 1, 3000)
      });
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "search",
    {
      title: "Search Files",
      description: "Use this for targeted verification or code lookup. Prefer one specific final search instead of repeated broad verification searches.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        query: z.string().describe("Text or regex to search for."),
        regex: z.boolean().optional().describe("Treat query as a regular expression. Requires ripgrep. Default: false."),
        path: z.string().optional().describe("Directory or file relative to workspace root. Default: ."),
        glob: z.string().optional().describe("Optional glob, for example src/**/*.ts."),
        include_hidden: z.boolean().optional().describe("Include hidden files that are not blocked. Default: false."),
        max_results: z.number().int().min(1).max(2000).optional().describe("Maximum results. Default from config."),
        intent: z.enum(["auto", "text", "symbol", "references", "impact"]).optional().describe("Optional structured search intent. Omit for legacy lexical behavior."),
        symbol: z.string().optional().describe("Optional symbol query. Uses repository analysis and overrides query text."),
        include_tests: z.boolean().optional().describe("Include related tests in structured results. Default: false.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Searching workspace...",
        "openai/toolInvocation/invoked": "Workspace search complete"
      }
    },
    async (args) => {
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const result = await searchWorkspace(config, guard, workspace, {
        query: args.query,
        regex: parseBool(args.regex, false),
        root: args.path ?? ".",
        glob: args.glob,
        includeHidden: parseBool(args.include_hidden, false),
        maxResults: limitInt(args.max_results, config.maxSearchResults, 1, config.maxSearchResults),
        intent: args.intent,
        symbol: args.symbol,
        includeTests: args.include_tests === undefined ? undefined : parseBool(args.include_tests, false)
      });
      const structured: Record<string, unknown> = {
        workspace_id: workspace.id,
        root: workspace.root,
        matches: result.matches,
        truncated: result.truncated,
        used: result.used
      };
      if (result.analysis) structured.analysis = result.analysis;
      return textResult(result.text, structured);
    }
  );

  registerCodexTool(
    config,
    server,
    "read",
    {
      title: "Read File",
      description: "Read a specific text file with line numbers. Avoid rereading files after write/edit/apply_patch unless exact final content is needed.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().describe("File path relative to workspace root."),
        start_line: z.number().int().min(1).optional().describe("First line to read. Default: 1."),
        end_line: z.number().int().min(1).optional().describe("Last line to read. Default: end of file."),
        max_bytes: z.number().int().min(1000).max(2000000).optional().describe("Maximum file bytes. Capped by server config.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading file...",
        "openai/toolInvocation/invoked": "File read"
      }
    },
    async (args) => {
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const result = await readTextFile(config, guard, workspace, args.path, {
        startLine: args.start_line,
        endLine: args.end_line,
        maxBytes: args.max_bytes
      });
      const text = `# Read File\n\nPath: ${result.path}\nLines: ${result.startLine}-${result.endLine} of ${result.totalLines}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}\n\n\`\`\`text\n${result.text}\n\`\`\``;
      return textResult(text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "view_image",
    {
      title: "View Image",
      description: "Inspect a PNG, JPEG, GIF, or WebP image from the active workspace. Returns native MCP image content plus dimensions and SHA-256.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().describe("Image path relative to workspace root."),
        max_bytes: z.number().int().min(4096).max(2000000).optional().describe("Maximum image bytes. Default: at least 1 MB, capped at 2 MB.")
      },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) => {
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const result = await viewWorkspaceImage(config, guard, workspace, args.path, args.max_bytes);
      const dimensions = result.width && result.height ? `${result.width}x${result.height}` : "unknown";
      return {
        content: [
          {
            type: "text",
            text: `Image: ${result.path}\nType: ${result.mimeType}\nDimensions: ${dimensions}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}`
          },
          { type: "image", data: result.data, mimeType: result.mimeType }
        ],
        structuredContent: redactStructured({
          workspace_id: workspace.id,
          root: workspace.root,
          path: result.path,
          mime_type: result.mimeType,
          width: result.width ?? null,
          height: result.height ?? null,
          bytes: result.bytes,
          sha256: result.sha256
        })
      };
    }
  );

  registerCodexTool(
    config,
    server,
    "create",
    {
      title: "Create New File",
      description: "Create one new meaningful text file inside the workspace. This tool never overwrites an existing path, uses an atomic rename, and returns a unified diff.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().describe("New file path relative to workspace root."),
        content: z.string().describe("Complete file contents to create."),
        create_dirs: z.boolean().optional().describe("Create parent directories if missing. Default: true.")
      },
      annotations: CREATE_FILE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Creating file...",
        "openai/toolInvocation/invoked": "File created"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const resolved = guard.resolve(workspace, args.path, { forWrite: true });
      assertWriteToolAllowed(config, resolved.relPath);
      const result = await writeTextFile(config, guard, workspace, args.path, String(args.content ?? ""), {
        createDirs: args.create_dirs !== false,
        overwrite: false
      });
      if (result.diff.changed) invalidateWorkspaceAnalysis(workspace.id);
      const text = `# Create New File\n\nPath: ${result.path}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}\nDiff stats: +${result.diff.additions} -${result.diff.deletions}${diffBlock(result.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        bytes: result.bytes,
        sha256: result.sha256,
        additions: result.diff.additions,
        deletions: result.diff.deletions,
        diff: result.diff.diff
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "write",
    {
      title: "Write File",
      description: "Create or overwrite a meaningful text file inside the workspace. New files use an atomic rename; existing files retain their inode and metadata. Returns a unified diff; pass the SHA from read when overwriting shared files.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().describe("File path relative to workspace root."),
        content: z.string().describe("Complete file contents to write."),
        create_dirs: z.boolean().optional().describe("Create parent directories if missing. Default: true."),
        overwrite: z.boolean().optional().describe("Allow overwriting existing files. Default: true."),
        expected_sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional().describe("Optional SHA-256 from read. Fails instead of overwriting if another session changed the file.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Writing file...",
        "openai/toolInvocation/invoked": "File written"
      }
    },
    async (args) => {
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const resolved = guard.resolve(workspace, args.path, { forWrite: true });
      assertWriteToolAllowed(config, resolved.relPath);
      const taskContext = workspaceTaskContextForServer(server, workspace);
      if (taskContext) await claimWorkspacePaths(taskContext, [resolved.relPath]);
      const codexGraphBefore = await mutationCodexGraphImpact(config, guard, workspace, [resolved.relPath]);
      let result;
      try {
        result = await writeTextFile(config, guard, workspace, args.path, String(args.content ?? ""), {
          createDirs: args.create_dirs !== false,
          overwrite: args.overwrite !== false,
          expectedSha256: args.expected_sha256
        });
      } catch (error) {
        if (taskContext) await releaseWorkspacePaths(taskContext, [resolved.relPath], { onlyUntouched: true });
        throw error;
      }
      if (taskContext) {
        if (result.diff.changed) await recordWorkspacePathsTouched(taskContext, [resolved.relPath]);
        else await releaseWorkspacePaths(taskContext, [resolved.relPath], { onlyUntouched: true });
      }
      if (result.diff.changed) invalidateWorkspaceAnalysis(workspace.id);
      const codexGraphAfter = result.diff.changed ? await mutationCodexGraphImpact(config, guard, workspace, [resolved.relPath]) : codexGraphBefore;
      const text = `# Write File\n\nPath: ${result.path}\nExisted before: ${result.existed}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}\nDiff stats: +${result.diff.additions} -${result.diff.deletions}${diffBlock(result.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        existed: result.existed,
        codexgraph: { before: compactMutationCodexGraphImpact(codexGraphBefore), after: compactMutationCodexGraphImpact(codexGraphAfter) },
        bytes: result.bytes,
        sha256: result.sha256,
        additions: result.diff.additions,
        deletions: result.diff.deletions,
        diff: result.diff.diff
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "edit",
    {
      title: "Edit File",
      description: "Apply a targeted exact text replacement while retaining the existing file inode and metadata. Returns a unified diff; pass the SHA from read to reject stale multi-session edits.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().describe("File path relative to workspace root."),
        old_text: z.string().describe("Exact text to replace. Must match once unless replace_all=true."),
        new_text: z.string().describe("Replacement text."),
        replace_all: z.boolean().optional().describe("Replace all occurrences. Default: false."),
        expected_replacements: z.number().int().min(1).optional().describe("Fail if actual replacement count differs."),
        expected_sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional().describe("Optional SHA-256 from read. Fails if another session changed the file.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Editing file...",
        "openai/toolInvocation/invoked": "File edited"
      }
    },
    async (args) => {
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const resolved = guard.resolve(workspace, args.path, { forWrite: true });
      assertWriteToolAllowed(config, resolved.relPath);
      const taskContext = workspaceTaskContextForServer(server, workspace);
      if (taskContext) await claimWorkspacePaths(taskContext, [resolved.relPath]);
      const codexGraphBefore = await mutationCodexGraphImpact(config, guard, workspace, [resolved.relPath]);
      let result;
      try {
        result = await editTextFile(config, guard, workspace, args.path, String(args.old_text ?? ""), String(args.new_text ?? ""), {
          replaceAll: parseBool(args.replace_all, false),
          expectedReplacements: args.expected_replacements,
          expectedSha256: args.expected_sha256
        });
      } catch (error) {
        if (taskContext) await releaseWorkspacePaths(taskContext, [resolved.relPath], { onlyUntouched: true });
        throw error;
      }
      if (taskContext) {
        if (result.diff.changed) await recordWorkspacePathsTouched(taskContext, [resolved.relPath]);
        else await releaseWorkspacePaths(taskContext, [resolved.relPath], { onlyUntouched: true });
      }
      if (result.diff.changed) invalidateWorkspaceAnalysis(workspace.id);
      const codexGraphAfter = result.diff.changed ? await mutationCodexGraphImpact(config, guard, workspace, [resolved.relPath]) : codexGraphBefore;
      const text = `# Edit File\n\nPath: ${result.path}\nReplacements: ${result.replacements}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}\nDiff stats: +${result.diff.additions} -${result.diff.deletions}${diffBlock(result.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        replacements: result.replacements,
        codexgraph: { before: compactMutationCodexGraphImpact(codexGraphBefore), after: compactMutationCodexGraphImpact(codexGraphAfter) },
        bytes: result.bytes,
        sha256: result.sha256,
        additions: result.diff.additions,
        deletions: result.diff.deletions,
        diff: result.diff.diff
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "apply_patch",
    {
      title: "Apply Patch",
      description:
        "Apply one unified diff or *** Begin Patch envelope inside the workspace. Paths are validated before applying. Prefer edit for tiny replacements and apply_patch for multi-file changes.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        patch: z.string().describe("Unified diff or *** Begin Patch envelope to apply. File paths must stay inside the workspace and avoid blocked paths.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Applying patch...",
        "openai/toolInvocation/invoked": "Patch applied"
      }
    },
    async (args) => {
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const patchText = String(args.patch ?? "");
      const codexGraphPaths = patchTouchedPaths(patchText);
      const taskContext = workspaceTaskContextForServer(server, workspace);
      if (taskContext && codexGraphPaths.length) await claimWorkspacePaths(taskContext, codexGraphPaths);
      const codexGraphBefore = await mutationCodexGraphImpact(config, guard, workspace, codexGraphPaths);
      let result;
      try {
        result = await applyWorkspacePatch(config, guard, workspace, patchText);
      } catch (error) {
        if (taskContext && codexGraphPaths.length) await releaseWorkspacePaths(taskContext, codexGraphPaths, { onlyUntouched: true });
        throw error;
      }
      if (taskContext && codexGraphPaths.length) {
        if (result.changed) await recordWorkspacePathsTouched(taskContext, codexGraphPaths);
        else await releaseWorkspacePaths(taskContext, codexGraphPaths, { onlyUntouched: true });
      }
      if (result.changed) invalidateWorkspaceAnalysis(workspace.id);
      const codexGraphAfter = result.changed ? await mutationCodexGraphImpact(config, guard, workspace, result.paths) : codexGraphBefore;
      const text = [
        "# Apply Patch",
        "",
        `Paths: ${result.paths.join(", ")}`,
        `Diff stats: +${result.additions} -${result.deletions}`,
        result.stderr ? `stderr: ${result.stderr}` : "",
        result.diff ? diffBlock(result.diff) : "No diff output."
      ].filter(Boolean).join("\n");
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        paths: result.paths,
        stdout: result.stdout,
        stderr: result.stderr,
        additions: result.additions,
        deletions: result.deletions,
        changed: result.changed,
        codexgraph: { before: compactMutationCodexGraphImpact(codexGraphBefore), after: compactMutationCodexGraphImpact(codexGraphAfter) },
        diff: result.diff
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "import_file",
    {
      title: "Import Attachment File",
      description:
        "Import a ChatGPT Apps SDK attachment into the workspace. Accepts only a platform file object with download_url and file_id. Not a general URL downloader. Overwrite is off by default.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        file: z
          .object({
            download_url: z.string().describe("Temporary HTTPS download URL provided by ChatGPT."),
            file_id: z.string().describe("ChatGPT file id for this attachment."),
            mime_type: z.string().optional().describe("Optional MIME type declared by ChatGPT."),
            file_name: z.string().optional().describe("Optional original file name declared by ChatGPT.")
          })
          .describe("ChatGPT Apps SDK file reference from openai/fileParams."),
        destination: z.string().describe("Destination path relative to the workspace root."),
        overwrite: z.boolean().optional().describe("Replace an existing destination file. Default: false."),
        expected_sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional().describe("Optional SHA-256 of the attachment bytes. Import fails on mismatch.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/fileParams": ["file"],
        "openai/toolInvocation/invoking": "Importing attachment...",
        "openai/toolInvocation/invoked": "Attachment imported"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const resolved = guard.resolve(workspace, args.destination, { forWrite: true });
      assertWriteToolAllowed(config, resolved.relPath);
      const result = await importAttachmentFile(config, guard, workspace, {
        file: args.file,
        destination: String(args.destination ?? ""),
        overwrite: args.overwrite === true,
        expectedSha256: args.expected_sha256
      });
      invalidateWorkspaceAnalysis(workspace.id);
      const text = [
        "# Import File",
        "",
        `Path: ${result.path}`,
        `Bytes: ${result.bytes}`,
        `SHA-256: ${result.sha256}`,
        `Declared MIME: ${result.declared_mime_type ?? "unknown"}`,
        `Detected MIME: ${result.detected_mime_type ?? "unknown"}`,
        `MIME status: ${result.mime_type_status}`,
        `Verified: ${result.verified}`,
        `Overwritten: ${result.overwritten}`
      ].join("\n");
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        bytes: result.bytes,
        declared_mime_type: result.declared_mime_type,
        detected_mime_type: result.detected_mime_type,
        mime_type_status: result.mime_type_status,
        sha256: result.sha256,
        verified: result.verified,
        file_id: result.file_id,
        file_name: result.file_name,
        overwritten: result.overwritten
      });
    }
  );

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
        timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(config.maxBashTimeoutMs)
          .optional()
          .describe(`Timeout in milliseconds. Default: 30000. Max: ${config.maxBashTimeoutMs}.`)
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
    "browser_open",
    {
      title: "Open Browser Page",
      description:
        "Open a public website or localhost URL in server-side Playwright Chromium and return visible text, interactive element refs, and recent console messages. Private LAN and cloud metadata destinations are blocked.",
      inputSchema: {
        url: z.string().min(1).max(4_000).describe("HTTP(S) URL to open. Public websites and localhost are allowed."),
        wait_until: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional().describe("Navigation readiness event. Default: domcontentloaded."),
        timeout_ms: z.number().int().min(1_000).max(180_000).optional().describe("Navigation timeout. Default: 30000."),
        max_text_chars: z.number().int().min(1_000).max(50_000).optional().describe("Maximum visible page text. Default: 12000."),
        max_elements: z.number().int().min(1).max(300).optional().describe("Maximum interactive elements. Default: 120.")
      },
      annotations: BROWSER_READ_ANNOTATIONS
    },
    async (args) => {
      const result = await browser.open(String(args.url ?? ""), {
        waitUntil: args.wait_until,
        timeoutMs: args.timeout_ms,
        maxTextChars: args.max_text_chars,
        maxElements: args.max_elements
      });
      return textResult(browserSnapshotText("Browser Open", result), { ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "browser_snapshot",
    {
      title: "Browser Snapshot",
      description: "Inspect the currently open Playwright page and refresh stable element refs for later click, type, or select calls.",
      inputSchema: {
        max_text_chars: z.number().int().min(1_000).max(50_000).optional().describe("Maximum visible page text. Default: 12000."),
        max_elements: z.number().int().min(1).max(300).optional().describe("Maximum interactive elements. Default: 120.")
      },
      annotations: BROWSER_READ_ANNOTATIONS
    },
    async (args) => {
      const result = await browser.snapshot({ maxTextChars: args.max_text_chars, maxElements: args.max_elements });
      return textResult(browserSnapshotText("Browser Snapshot", result), { ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "browser_click",
    {
      title: "Browser Click",
      description: "Click exactly one element using a ref from browser_snapshot or a precise CSS selector, then return the updated page snapshot.",
      inputSchema: {
        ref: z.string().optional().describe("Element ref such as e1 from the latest browser snapshot."),
        selector: z.string().max(2_000).optional().describe("Precise CSS selector. Prefer ref when available."),
        timeout_ms: z.number().int().min(1_000).max(180_000).optional().describe("Action timeout. Default: 30000.")
      },
      annotations: BROWSER_ACTION_ANNOTATIONS
    },
    async (args) => {
      const result = await browser.click({ ref: args.ref, selector: args.selector, timeoutMs: args.timeout_ms });
      return textResult(browserSnapshotText("Browser Click", result), { ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "browser_type",
    {
      title: "Browser Type",
      description: "Fill or type into exactly one input using a browser ref or CSS selector. Optionally press Enter, then return the updated snapshot.",
      inputSchema: {
        ref: z.string().optional().describe("Element ref such as e1 from the latest browser snapshot."),
        selector: z.string().max(2_000).optional().describe("Precise CSS selector. Prefer ref when available."),
        value: z.string().max(100_000).describe("Text to enter."),
        clear: z.boolean().optional().describe("Replace existing input value. Default: true."),
        press_enter: z.boolean().optional().describe("Press Enter after typing. Default: false."),
        timeout_ms: z.number().int().min(1_000).max(180_000).optional().describe("Action timeout. Default: 30000.")
      },
      annotations: BROWSER_ACTION_ANNOTATIONS
    },
    async (args) => {
      const result = await browser.type({
        ref: args.ref,
        selector: args.selector,
        value: String(args.value ?? ""),
        clear: args.clear,
        pressEnter: args.press_enter,
        timeoutMs: args.timeout_ms
      });
      return textResult(browserSnapshotText("Browser Type", result), { ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "browser_select",
    {
      title: "Browser Select",
      description: "Select an option in exactly one native select element using its value, then return the updated page snapshot.",
      inputSchema: {
        ref: z.string().optional().describe("Element ref such as e1 from the latest browser snapshot."),
        selector: z.string().max(2_000).optional().describe("Precise CSS selector. Prefer ref when available."),
        value: z.string().max(10_000).describe("Option value to select."),
        timeout_ms: z.number().int().min(1_000).max(180_000).optional().describe("Action timeout. Default: 30000.")
      },
      annotations: BROWSER_ACTION_ANNOTATIONS
    },
    async (args) => {
      const result = await browser.select({
        ref: args.ref,
        selector: args.selector,
        value: String(args.value ?? ""),
        timeoutMs: args.timeout_ms
      });
      return textResult(browserSnapshotText("Browser Select", result), { ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "browser_screenshot",
    {
      title: "Browser Screenshot",
      description: "Capture the current Playwright page as a PNG image for visual UI verification.",
      inputSchema: {
        full_page: z.boolean().optional().describe("Capture the full document instead of the viewport. Default: false."),
        timeout_ms: z.number().int().min(1_000).max(180_000).optional().describe("Screenshot timeout. Default: 30000.")
      },
      annotations: BROWSER_READ_ANNOTATIONS
    },
    async (args) => {
      const result = await browser.screenshot({ fullPage: args.full_page, timeoutMs: args.timeout_ms });
      return {
        content: [
          { type: "text", text: redactSensitiveText(`Browser screenshot\nTitle: ${result.title || "(untitled)"}\nURL: ${result.url}\nFormat: image/png\nBytes: ${result.data.length}`) },
          { type: "image", data: result.data.toString("base64"), mimeType: "image/png" }
        ],
        structuredContent: redactStructured({ title: result.title, url: result.url, mime_type: "image/png", bytes: result.data.length })
      };
    }
  );

  registerCodexTool(
    config,
    server,
    "browser_close",
    {
      title: "Close Browser",
      description: "Close the Playwright page, context, and Chromium process for this MCP session.",
      inputSchema: {},
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true }
    },
    async () => {
      const result = await browser.close();
      return textResult(result.closed ? "Playwright browser closed." : "No Playwright browser was open.", result);
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

  registerCodexTool(
    config,
    server,
    "read_handoff",
    {
      title: "Read Handoff",
      description: "Read the shared .ai-bridge planning files used for ChatGPT-to-agent coordination.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading agent handoff context...",
        "openai/toolInvocation/invoked": "Agent handoff context ready"
      }
    },
    async (args) => {
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const context = await readAiBridgeContext(config, guard, workspace);
      return textResult(context.text, {
        workspace_id: workspace.id,
        root: workspace.root,
        files: context.files,
        file_count: context.files.length,
        preview: previewText(context.text)
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "wait_for_handoff",
    {
      title: "Wait For Handoff",
      description:
        "Read-only long-poll of the local handoff run state so ChatGPT can stay the planner/reviewer while a local executor runs. Reads .ai-bridge/handoff-run-state.json and returns the run status plus status/diff/log/test excerpts. It never starts processes or runs shell commands; it only observes local handoff state written by execute-handoff/watch-handoff/loop-handoff.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        plan_hash: z.string().optional().describe("Expected current-plan.md hash. If set, only a terminal run with this plan_hash counts as completed."),
        since_iteration: z.number().int().min(0).optional().describe("Only treat a run with iteration greater than this as the awaited completion."),
        max_wait_seconds: z.number().int().min(1).max(60).optional().describe("Maximum seconds to long-poll before returning the current state. Default: 20."),
        poll_ms: z.number().int().min(250).max(5000).optional().describe("Poll interval in milliseconds. Default: 1000."),
        include_diff: z.boolean().optional().describe("Include the implementation diff excerpt when completed. Default: true."),
        include_log_excerpt: z.boolean().optional().describe("Include the tail of execution-log.jsonl when completed. Default: true."),
        include_tests: z.boolean().optional().describe("Include the loop-tests.txt excerpt when completed. Default: true.")
      },
      annotations: { ...READ_ONLY_ANNOTATIONS, idempotentHint: false },
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Waiting for local handoff result...",
        "openai/toolInvocation/invoked": "Local handoff state ready"
      }
    },
    async (args) => {
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const maxWaitSeconds = limitInt(args.max_wait_seconds, 20, 1, 60);
      const pollMs = limitInt(args.poll_ms, 1000, 250, 5000);
      const includeDiff = parseBool(args.include_diff, true);
      const includeLog = parseBool(args.include_log_excerpt, true);
      const includeTests = parseBool(args.include_tests, true);
      const expectedPlanHash =
        typeof args.plan_hash === "string" && args.plan_hash.trim() ? args.plan_hash.trim() : undefined;
      const sinceIteration =
        Number.isFinite(Number(args.since_iteration)) && args.since_iteration !== undefined
          ? Math.floor(Number(args.since_iteration))
          : undefined;

      const stateRel = `${config.contextDir}/handoff-run-state.json`;
      const contextPrefix = `${config.contextDir.replace(/\/+$/, "")}/`;
      const terminalStates = new Set(["completed", "failed", "timed_out"]);

      const readState = async (): Promise<Record<string, any> | undefined> => {
        try {
          const raw = await readRawTextFileBounded(config, guard, workspace, stateRel);
          const parsed = JSON.parse(raw);
          return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
        } catch {
          return undefined;
        }
      };

      const isAwaited = (state: Record<string, any> | undefined): boolean =>
        Boolean(
          state &&
            terminalStates.has(state.state) &&
            (!expectedPlanHash || state.plan_hash === expectedPlanHash) &&
            (sinceIteration === undefined || (typeof state.iteration === "number" && state.iteration > sinceIteration))
        );

      const deadline = Date.now() + maxWaitSeconds * 1000;
      let state = await readState();
      while (Date.now() < deadline && !isAwaited(state)) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
        state = await readState();
      }

      const awaitedTerminal = isAwaited(state);
      const awaitedCompleted = awaitedTerminal && state?.state === "completed";
      const planHashMismatch = Boolean(expectedPlanHash && state && state.plan_hash !== expectedPlanHash);
      const reportedState = awaitedTerminal
        ? String(state?.state)
        : state
          ? state.state === "running" || planHashMismatch || sinceIteration !== undefined
            ? "running"
            : String(state.state)
          : "unknown";

      const excerpt = async (rel: string, maxChars: number, tailLines?: number): Promise<string | undefined> => {
        try {
          const raw = await readRawTextFileBounded(config, guard, workspace, rel);
          const body = tailLines
            ? raw.split(/\r?\n/).filter(Boolean).slice(-tailLines).join("\n")
            : raw;
          const trimmed = body.length > maxChars ? `${body.slice(0, maxChars)}\n...[excerpt truncated]` : body;
          return redactSensitiveText(trimmed);
        } catch {
          return undefined;
        }
      };
      const bridgeArtifact = (value: unknown, fallback: string): string => {
        const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
        const normalized = path.posix.normalize(raw.split(path.sep).join("/")).replace(/^\.\//, "");
        return normalized.startsWith(contextPrefix) ? normalized : fallback;
      };

      const structured: Record<string, unknown> = {
        workspace_id: workspace.id,
        root: workspace.root,
        state: reportedState,
        awaited_completed: awaitedCompleted,
        awaited_terminal: awaitedTerminal,
        succeeded: awaitedCompleted,
        state_file: stateRel,
        ...(state ? { run_state: state.state } : {}),
        ...(typeof state?.iteration === "number" ? { iteration: state.iteration } : {}),
        ...(state?.plan_hash ? { plan_hash: state.plan_hash } : {}),
        ...(expectedPlanHash ? { expected_plan_hash: expectedPlanHash, plan_hash_mismatch: planHashMismatch } : {}),
        ...(state && "exit_code" in state ? { exit_code: state.exit_code } : {}),
        ...(state && "timed_out" in state ? { timed_out: state.timed_out } : {}),
        ...(state?.started_at ? { started_at: state.started_at } : {}),
        ...(state?.finished_at ? { finished_at: state.finished_at } : {}),
        ...(state?.executor ? { executor: state.executor } : {}),
        ...(state?.model ? { model: state.model } : {}),
        ...(awaitedTerminal ? {} : { next_poll_after_seconds: Math.max(1, Math.ceil(pollMs / 1000)) })
      };

      if (awaitedTerminal) {
        const statusFile = bridgeArtifact(state?.status_file, `${config.contextDir}/agent-status.md`);
        const diffFile = bridgeArtifact(state?.diff_file, `${config.contextDir}/implementation-diff.patch`);
        const logFile = bridgeArtifact(state?.log_file, `${config.contextDir}/execution-log.jsonl`);
        const testsFile = bridgeArtifact(state?.tests_file, `${config.contextDir}/loop-tests.txt`);
        structured.status_file = statusFile;
        structured.diff_file = diffFile;
        structured.log_file = logFile;
        const status = await excerpt(statusFile, 6_000);
        if (status) structured.status_excerpt = status;
        if (includeDiff) {
          const diff = await excerpt(diffFile, 12_000);
          if (diff) structured.diff_excerpt = diff;
        }
        if (includeLog) {
          const log = await excerpt(logFile, 6_000, 20);
          if (log) structured.log_excerpt = log;
        }
        if (includeTests) {
          const tests = await excerpt(testsFile, 4_000);
          if (tests) {
            structured.tests_file = testsFile;
            structured.tests_excerpt = tests;
          }
        }
      }

      const summary = !state
        ? `No handoff run state found at ${stateRel}. Start a run with handoff_to_agent + local execute-handoff/watch-handoff, then call wait_for_handoff again.`
        : awaitedTerminal
          ? `Handoff run ${state.state} (iteration ${state.iteration ?? 1}, exit ${state.exit_code ?? "null"}).`
          : planHashMismatch
            ? `Executor has not completed the expected plan yet (last known run plan_hash=${state.plan_hash ?? "unknown"}). Still waiting.`
            : `Handoff run is ${state.state}. Re-poll after ~${Math.max(1, Math.ceil(pollMs / 1000))}s.`;

      const lines = [
        "# Wait For Handoff",
        "",
        summary,
        "",
        `State file: ${stateRel}`,
        ...(state?.plan_hash ? [`Plan hash: ${state.plan_hash}`] : []),
        ...(awaitedTerminal && structured.status_excerpt ? ["", "## Status", "", `\`\`\`text\n${structured.status_excerpt}\n\`\`\``] : []),
        ...(awaitedTerminal && structured.diff_excerpt ? ["", "## Diff", "", `\`\`\`diff\n${structured.diff_excerpt}\n\`\`\``] : []),
        ...(awaitedTerminal && structured.tests_excerpt ? ["", "## Tests", "", `\`\`\`text\n${structured.tests_excerpt}\n\`\`\``] : []),
        ...(awaitedTerminal && structured.log_excerpt ? ["", "## Log tail", "", `\`\`\`text\n${structured.log_excerpt}\n\`\`\``] : [])
      ];
      return textResult(lines.join("\n"), structured);
    }
  );

  registerCodexTool(
    config,
    server,
    "codex_context",
    {
      title: "Codex Context",
      description:
        "Load Codex-style workspace context in one call: AGENTS instructions for a target path, .ai-bridge handoff files, and optional git status/diff.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        target_path: z.string().optional().describe("Workspace-relative file or directory whose AGENTS instruction chain should be loaded. Default: ."),
        include_ai_bridge: z.boolean().optional().describe("Include .ai-bridge plan, agent status, diff, decisions, questions, and execution log. Default: true."),
        include_git: z.boolean().optional().describe("Include git status. Default: true."),
        include_diff: z.boolean().optional().describe("Include full git diff. Default: false for speed/noise."),
        max_agent_bytes: z.number().int().min(1000).max(200000).optional().describe("Maximum bytes per AGENTS file. Default: 60000.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Loading Codex context...",
        "openai/toolInvocation/invoked": "Codex context ready"
      }
    },
    async (args) => {
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const globalRules = await readGlobalRulesSnapshot();
      const context = await readCodexContext(config, guard, workspace, {
        targetPath: args.target_path,
        includeAiBridge: args.include_ai_bridge,
        includeGit: args.include_git,
        includeDiff: parseBool(args.include_diff, false),
        maxAgentBytes: args.max_agent_bytes
      });
      return textResult(withGlobalRules(context.text, globalRules), {
        workspace_id: context.workspaceId,
        root: context.root,
        target_path: context.targetPath,
        agents_files: context.agentsFiles,
        ai_context_files: context.aiContextFiles,
        included_git_status: context.gitStatus !== undefined,
        included_git_diff: context.gitDiff !== undefined,
        preview: previewText(context.text)
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "export_pro_context",
    {
      title: "Export Pro Context",
      description:
        "Create .ai-bridge/pro-context.md with repo tree, git state, selected files, and handoff context for high-context ChatGPT planning without live MCP tool calls.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        title: z.string().optional().describe("Markdown title for the context bundle."),
        selected_paths: z.array(z.string()).optional().describe("Specific workspace-relative files to include."),
        extra_globs: z.array(z.string()).optional().describe("Additional workspace-relative glob patterns to include, for example src/**/*.ts."),
        include_important_files: z.boolean().optional().describe("Auto-include important root config/docs such as AGENTS.md, README.md, and package.json. Default: true."),
        include_changed_files: z.boolean().optional().describe("Auto-include currently changed files from git status. Default: true."),
        include_diff: z.boolean().optional().describe("Include the current git diff. Default: true."),
        include_ai_bridge: z.boolean().optional().describe("Include existing .ai-bridge planning files. Default: true."),
        max_depth: z.number().int().min(1).max(6).optional().describe("Repository tree depth. Default: 3."),
        max_files: z.number().int().min(1).max(80).optional().describe("Maximum file contents to include. Default: 24."),
        max_file_bytes: z.number().int().min(1000).max(250000).optional().describe("Maximum bytes per included file. Default: 60000."),
        max_total_bytes: z.number().int().min(20000).max(2000000).optional().describe("Maximum bytes in the generated bundle.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Exporting Pro context...",
        "openai/toolInvocation/invoked": "Pro context exported"
      }
    },
    async (args) => {
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const result = await exportProContext(config, guard, workspace, {
        title: args.title,
        selectedPaths: args.selected_paths,
        extraGlobs: args.extra_globs,
        includeImportantFiles: args.include_important_files,
        includeChangedFiles: args.include_changed_files,
        includeDiff: args.include_diff,
        includeAiBridge: args.include_ai_bridge,
        maxDepth: args.max_depth,
        maxFiles: args.max_files,
        maxFileBytes: args.max_file_bytes,
        maxTotalBytes: args.max_total_bytes
      });
      const text = `# Export Pro Context\n\nWrote ${result.path}.\nBytes: ${result.bytes}\nFiles included: ${result.filesIncluded.length}\nFiles skipped: ${result.filesSkipped.length}\nTruncated: ${result.truncated}\n\nPaste ${result.path} into a high-context planning model when MCP tools are unavailable, then save the returned plan with codexpro pro-apply.`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        bytes: result.bytes,
        files_included: result.filesIncluded,
        files_skipped: result.filesSkipped,
        truncated: result.truncated
      });
    }
  );

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

  registerCodexTool(
    config,
    server,
    "browser_control",
    {
      title: "Browser Control",
      description:
        "Fast browser-agent control for the Chrome profile explicitly marked ACTIVE, with dedicated port-9223 Chrome as fallback. Supports persistent CDP/debugger sessions, trusted input, batch actions, wait_for, inspect_element, evaluate, hover/scroll, screenshots, and existing ChatGPT-specific actions.",
      inputSchema: {
        action: z.enum(["status", "list_profiles", "select_workspace", "check_chatgpt", "setup_chatgpt", "reload_extension", "set_headless_lock", "clear_headless_lock", "close_profile", "stop_chat_generation", "audit_long_running_chat", "recover_chat_tab", "send_chat_request", "rename_chat", "hide_chat", "get_chat_response", "list_tabs", "open_tab", "activate_tab", "close_tab", "snapshot", "navigate", "click", "trusted_click", "type", "press", "hover", "scroll", "wait_for", "inspect_element", "evaluate", "batch", "screenshot"]),
        profile_id: z.string().optional().describe("Optional extension profile id. Omit to use the profile marked ACTIVE. Ignored for the dedicated fallback browser."),
        root: z.string().optional().describe("Workspace root for select_workspace. The selected profile is locked to this root until changed by CodexPro Manager."),
        browser: z.enum(["active", "dedicated"]).optional().describe("Use the ACTIVE extension profile when available (default), or force the dedicated port-9223 Chrome."),
        target_id: z.string().optional().describe("Tab id from list_tabs. Omit to use the first page tab."),
        conversation_id: z.string().optional().describe("Exact ChatGPT conversation id for send_chat_request, rename_chat, get_chat_response, recovery, or a long-task audit."),
        task_id: z.string().regex(/^cpt_[a-f0-9]{24}$/).optional().describe("Exact Manager task id to finalize when a ChatGPT response reaches a terminal state."),
        headless_worker_id: z.string().max(160).optional().describe("Owning headless worker id for source-profile ChatGPT exclusivity locks."),
        started_at: z.string().max(80).optional().describe("Stable task start timestamp for a one-shot long-task audit."),
        attempt_key: z.string().max(300).optional().describe("Persistent deduplication key for a one-shot long-task audit."),
        read_dom: z.boolean().optional().describe("For get_chat_response, read transcript text from the page DOM. Set false to return network state only."),
        canonical_only: z.boolean().optional().describe("For get_chat_response, read the authenticated canonical conversation without querying the rendered DOM."),
        recover_stale_dom: z.boolean().optional().describe("For get_chat_response after network completion, compare the live DOM with the canonical ChatGPT conversation and reload the exact tab when the rendered stream is stale."),
        new_chat: z.boolean().optional().describe("For send_chat_request, create a new ChatGPT conversation in a background tab without focusing the profile."),
        one_shot_recovery: z.boolean().optional().describe("For an interrupted-task continuation, disable renderer replacement and stop after the first send preparation failure."),
        title: z.string().max(120).optional().describe("New conversation title for rename_chat."),
        attachments: z.array(z.object({
          name: z.string().min(1).max(255),
          mime_type: z.string().min(1).max(160),
          data_base64: z.string().min(1).max(14_000_000)
        })).max(4).optional().describe("Files to attach to send_chat_request. Base64 payload; maximum 4 files."),
        url: z.string().optional().describe("HTTP(S) URL for open_tab or navigate."),
        selector: z.string().optional().describe("CSS selector or semantic @e ref from snapshot."),
        ref: z.string().max(80).optional().describe("Stable semantic element ref such as @e3 from snapshot."),
        role: z.string().max(80).optional().describe("Semantic ARIA or implicit role locator, for example button or textbox."),
        name: z.string().max(500).optional().describe("Accessible-name locator, optionally combined with role."),
        placeholder: z.string().max(500).optional().describe("Input placeholder locator."),
        label: z.string().max(500).optional().describe("Associated label or aria-label locator."),
        test_id: z.string().max(500).optional().describe("Exact data-testid or data-test locator."),
        nth: z.number().int().min(0).max(1000).optional().describe("Zero-based match index for a semantic locator. Default: 0."),
        text: z.string().optional().describe("Text to enter for type."),
        key: z.string().optional().describe("Key for press, such as Enter, Tab, Escape, or ArrowDown."),
        expression: z.string().max(100000).optional().describe("JavaScript expression for evaluate. Runs in the selected page context."),
        state: z.enum(["attached", "visible", "hidden", "detached"]).optional().describe("Target state for wait_for. Default: visible."),
        timeout_ms: z.number().int().min(100).max(60000).optional().describe("Timeout for wait_for. Default: 10000 ms."),
        delta_x: z.number().optional().describe("Horizontal mouse-wheel delta for scroll. Default: 0."),
        delta_y: z.number().optional().describe("Vertical mouse-wheel delta for scroll. Default: 600."),
        steps: z.array(z.object({
          action: z.enum(["snapshot", "navigate", "click", "trusted_click", "type", "press", "hover", "scroll", "wait_for", "inspect_element", "evaluate", "screenshot"]),
          url: z.string().optional(),
          selector: z.string().optional(),
          ref: z.string().max(80).optional(),
          role: z.string().max(80).optional(),
          name: z.string().max(500).optional(),
          placeholder: z.string().max(500).optional(),
          label: z.string().max(500).optional(),
          test_id: z.string().max(500).optional(),
          nth: z.number().int().min(0).max(1000).optional(),
          text: z.string().optional(),
          key: z.string().optional(),
          expression: z.string().max(100000).optional(),
          state: z.enum(["attached", "visible", "hidden", "detached"]).optional(),
          timeout_ms: z.number().int().min(100).max(60000).optional(),
          delta_x: z.number().optional(),
          delta_y: z.number().optional(),
          max_chars: z.number().int().min(500).max(50000).optional(),
          full_page: z.boolean().optional(),
          delta: z.boolean().optional()
        })).max(50).optional().describe("Batch up to 50 browser actions without extra MCP round-trips."),
        max_chars: z.number().int().min(500).max(50000).optional().describe("Maximum visible page text returned by snapshot. Default: 20000."),
        full_page: z.boolean().optional().describe("Capture beyond the viewport for screenshot. Default: false."),
        delta: z.boolean().optional().describe("For snapshot, return only semantic elements/text changed since the previous snapshot on this tab."),
        trace: z.boolean().optional().describe("Collect sanitized CDP network, console, and page lifecycle events around this action."),
        trace_ms: z.number().int().min(0).max(10000).optional().describe("Milliseconds to keep collecting trace events after the action. Default: 750.")
      },
      annotations: BASH_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Controlling CodexPro Chrome...",
        "openai/toolInvocation/invoked": "Browser action complete"
      }
    },
    async (args) => {
      const profiles = listBrowserExtensionProfiles();
      if (args.action === "list_profiles") {
        return textResult(`# Browser Profiles\n\n${profiles.length ? profiles.map((profile) => `- ${profile.active ? "ACTIVE" : "idle"} · ${profile.label} · ${profile.connected ? "online" : "offline"} · ${profile.profile_id}`).join("\n") : "No extension profiles connected."}`, { action: args.action, profiles });
      }
      if (args.action === "status") {
        let dedicated: Record<string, any>;
        try {
          dedicated = await runBrowserControl(config.browserDebugUrl, { action: "status" });
        } catch (error) {
          dedicated = { connected: false, error: error instanceof Error ? error.message : String(error) };
        }
        return textResult(`# Browser Control Status\n\nDedicated Chrome: ${dedicated.connected ? "online" : "offline"}\nExtension profiles: ${profiles.length}\nACTIVE: ${profiles.find((profile) => profile.active)?.label ?? "none"}`, {
          action: args.action,
          dedicated,
          profiles,
          active_profile_id: profiles.find((profile) => profile.active)?.profile_id ?? null
        });
      }
      if ((args.action === "open_tab" || args.action === "navigate") && args.url) {
        const parsed = new URL(args.url);
        const extensionReloadUrl = parsed.protocol === "chrome-extension:" && parsed.hostname === "gndipignbnipohooclcbhjliikamjlpl" && parsed.pathname === "/popup.html";
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && !extensionReloadUrl) {
          throw new CodexProError("Browser navigation only allows http, https, and the signed CodexPro reload page.");
        }
      }
      let result: Record<string, any>;
      const selectedProfile = args.profile_id || profiles.find((profile) => profile.active && profile.connected)?.profile_id;
      if ((args.action === "select_workspace" || args.action === "check_chatgpt" || args.action === "setup_chatgpt" || args.action === "set_headless_lock" || args.action === "clear_headless_lock" || args.action === "close_profile" || args.action === "stop_chat_generation" || args.action === "audit_long_running_chat" || args.action === "send_chat_request" || args.action === "rename_chat" || args.action === "hide_chat" || args.action === "get_chat_response") && !selectedProfile) {
        throw new CodexProError("Choose an online Chrome extension profile before setting up CodexPro in ChatGPT.");
      }
      if (args.action === "select_workspace") {
        const workspace = workspaces.openWorkspace(String(args.root || ""));
        setBrowserExtensionProfileWorkspaceBinding(selectedProfile!, workspace.root);
        setBrowserExtensionProfileWorkspace(selectedProfile!, workspace.root);
        return textResult(`# Workspace Locked\n\nProfile: ${selectedProfile}\nRoot: ${workspace.root}`, {
          action: args.action,
          profile_id: selectedProfile,
          workspace_id: workspace.id,
          root: workspace.root,
          locked: true
        });
      }
      if (args.action === "close_profile") {
        const closingProfile = profiles.find((profile) => profile.profile_id === selectedProfile);
        if (!closingProfile) throw new CodexProError("Chrome profile cần đóng không còn kết nối.");
        const busy = Boolean(String(closingProfile.current_task_id || "").trim())
          || closingProfile.activity === "working"
          || closingProfile.activity === "settling"
          || Math.max(0, Number(closingProfile.busy_request_count) || 0) > 0
          || closingProfile.conversation_tabs.some((tab) => tab.busy || tab.settling || tab.network_state === "generating");
        if (busy) {
          const taskLabel = String(closingProfile.current_task_title || closingProfile.current_task_id || "task hiện tại").trim();
          throw new CodexProError(`WORKER_BUSY: ${closingProfile.label} đang làm ${taskLabel}; không được đóng profile trước khi task hoàn tất.`);
        }
      }
      const useExtension = args.browser !== "dedicated" && Boolean(selectedProfile);
      if (useExtension) {
        if (!["close_profile", "set_headless_lock", "clear_headless_lock"].includes(args.action)) await assertBrowserControlHeadlessExclusive(selectedProfile!);
        result = await runBrowserExtensionCommand(args.action, {
          target_id: args.target_id,
          conversation_id: args.conversation_id,
          task_id: args.task_id,
          headless_worker_id: args.headless_worker_id,
          started_at: args.started_at,
          attempt_key: args.attempt_key,
          read_dom: args.read_dom,
          canonical_only: args.canonical_only,
          recover_stale_dom: args.recover_stale_dom,
          new_chat: args.new_chat,
          one_shot_recovery: args.one_shot_recovery,
          title: args.title,
          attachments: args.attachments,
          expression: args.expression,
          state: args.state,
          timeout_ms: args.timeout_ms,
          delta_x: args.delta_x,
          delta_y: args.delta_y,
          steps: args.steps,
          url: args.url,
          selector: args.selector,
          ref: args.ref,
          role: args.role,
          name: args.name,
          placeholder: args.placeholder,
          label: args.label,
          test_id: args.test_id,
          nth: args.nth,
          text: args.text,
          key: args.key,
          max_chars: args.max_chars,
          full_page: args.full_page,
          delta: args.delta,
          trace: args.trace,
          trace_ms: args.trace_ms
        }, selectedProfile);
        result.browser_backend = "extension";
        result.profile_id = selectedProfile;
      } else {
        result = await runBrowserControl(config.browserDebugUrl, {
          action: args.action,
          targetId: args.target_id,
          expression: args.expression,
          state: args.state,
          timeoutMs: args.timeout_ms,
          deltaX: args.delta_x,
          deltaY: args.delta_y,
          steps: Array.isArray(args.steps) ? args.steps.map((step: any) => ({
            action: step.action,
            url: step.url,
            selector: step.selector,
            ref: step.ref,
            role: step.role,
            name: step.name,
            placeholder: step.placeholder,
            label: step.label,
            testId: step.test_id,
            nth: step.nth,
            text: step.text,
            key: step.key,
            expression: step.expression,
            state: step.state,
            timeoutMs: step.timeout_ms,
            deltaX: step.delta_x,
            deltaY: step.delta_y,
            maxChars: step.max_chars,
            fullPage: step.full_page,
            delta: step.delta
          })) : undefined,
          url: args.url,
          selector: args.selector,
          ref: args.ref,
          role: args.role,
          name: args.name,
          placeholder: args.placeholder,
          label: args.label,
          testId: args.test_id,
          nth: args.nth,
          text: args.text,
          key: args.key,
          maxChars: args.max_chars,
          fullPage: args.full_page,
          delta: args.delta,
          trace: args.trace,
          traceMs: args.trace_ms
        });
        result.browser_backend = "dedicated";
      }
      if (selectedProfile && args.task_id && (args.action === "get_chat_response" || args.action === "stop_chat_generation")) {
        const workerJob = readWorkerJob(args.task_id);
        const terminalOutcome = args.action === "stop_chat_generation"
          ? "cancelled"
          : String(result.network_state || "").toLowerCase() === "failed" || result.network_error
            ? "failed"
            : result.response_ready === true && result.busy !== true && result.network_stream_in_progress !== true && !responseHasStrongerNetworkStreamEvidence(result)
              ? "completed"
              : null;
        if (workerJob?.status === "running" && workerJob.workerId === selectedProfile && terminalOutcome) {
          const finalized = await finalizeWorkerJob({
            jobId: args.task_id,
            workerId: selectedProfile,
            outcome: terminalOutcome,
            summary: terminalOutcome === "completed" ? "ChatGPT response finalized." : undefined,
            error: terminalOutcome === "failed" ? String(result.network_error || result.error || "ChatGPT generation failed.") : undefined
          });
          if (finalized.root) {
            await finalizeWorkspaceTask({
              taskId: finalized.jobId,
              workerId: selectedProfile,
              title: finalized.title,
              root: finalized.root
            }, terminalOutcome);
          }
          result.worker_job_finalized = true;
          result.worker_job_status = finalized.status;
          result.worker_job_finished_at = finalized.finishedAt;
        }
      }
      if (result.image_base64) {
        const { image_base64, ...structured } = result;
        return {
          content: [
            { type: "image", data: image_base64, mimeType: result.mime_type ?? "image/png" },
            { type: "text", text: `Browser screenshot captured for tab ${result.target_id}.` }
          ],
          structuredContent: structured
        };
      }
      return textResult(`# Browser Control\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``, result);
    }
  );

  registerCodexTool(
    config,
    server,
    "handoff_to_agent",
    {
      title: "Handoff To Agent",
      description:
        "Write .ai-bridge/current-plan.md for Codex, OpenCode, Pi, or another local implementation agent. This only creates handoff files; it does not execute local agent commands.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        agent: z.string().optional().describe("Target agent id, for example codex, opencode, pi, or custom. Default: custom."),
        agent_name: z.string().optional().describe("Human-readable agent name for custom agents."),
        model: z.string().optional().describe("Optional model identifier to include in the handoff plan."),
        title: z.string().optional().describe("Short task title."),
        plan: z.string().describe("Detailed implementation plan for the local agent."),
        append: z.boolean().optional().describe("Append to existing current-plan.md instead of overwriting. Default: false.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Writing agent handoff plan...",
        "openai/toolInvocation/invoked": "Agent handoff plan written"
      }
    },
    async (args) => {
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const result = await writeAgentHandoff(config, guard, workspace, {
        agent: args.agent ?? "custom",
        agentName: args.agent_name,
        model: args.model,
        title: cleanOneLine(args.title, "Agent implementation plan"),
        plan: String(args.plan ?? ""),
        append: parseBool(args.append, false),
        eventName: "handoff_to_agent"
      });

      const text = `# Handoff To Agent

Agent: ${result.agentName} (${result.agent})
${result.model ? `Model: ${result.model}\n` : ""}Wrote ${result.planPath}.
Status path: ${result.statusPath}
Diff path: ${result.diffPath}
Execution log: ${result.executionLogPath}
Diff stats: +${result.writeResult.diff.additions} -${result.writeResult.diff.deletions}

Agent prompt:

\`\`\`text
${result.prompt}
\`\`\`${diffBlock(result.writeResult.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        agent: result.agent,
        agent_name: result.agentName,
        model: result.model,
        plan_path: result.planPath,
        status_path: result.statusPath,
        diff_path: result.diffPath,
        log_path: result.logPath,
        execution_log_path: result.executionLogPath,
        additions: result.writeResult.diff.additions,
        deletions: result.writeResult.diff.deletions,
        diff: result.writeResult.diff.diff
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "handoff_to_codex",
    {
      title: "Handoff To Codex",
      description: "Compatibility wrapper for handoff_to_agent with agent=codex.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        title: z.string().optional().describe("Short task title."),
        plan: z.string().describe("Detailed implementation plan for Codex."),
        append: z.boolean().optional().describe("Append to existing current-plan.md instead of overwriting. Default: false.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Writing Codex handoff plan...",
        "openai/toolInvocation/invoked": "Codex handoff plan written"
      }
    },
    async (args) => {
      const workspace = workspaceForTool(server, workspaces, args.workspace_id);
      const result = await writeAgentHandoff(config, guard, workspace, {
        agent: "codex",
        title: cleanOneLine(args.title, "Codex implementation plan"),
        plan: String(args.plan ?? ""),
        append: parseBool(args.append, false),
        eventName: "handoff_to_codex"
      });
      const text = `# Handoff To Codex

Wrote ${result.planPath}.
Status path: ${result.statusPath}
Diff path: ${result.diffPath}
Diff stats: +${result.writeResult.diff.additions} -${result.writeResult.diff.deletions}

Codex prompt:

\`\`\`text
${result.prompt}
\`\`\`${diffBlock(result.writeResult.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        agent: result.agent,
        agent_name: result.agentName,
        plan_path: result.planPath,
        status_path: result.statusPath,
        diff_path: result.diffPath,
        log_path: result.logPath,
        execution_log_path: result.executionLogPath,
        additions: result.writeResult.diff.additions,
        deletions: result.writeResult.diff.deletions,
        diff: result.writeResult.diff.diff
      });
    }
  );

  return server;
}
