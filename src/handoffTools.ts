import fsp from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CodexProConfig } from "./config.js";
import { CodexProError, type PathGuard, type Workspace, type WorkspaceManager } from "./guard.js";
import { ensureAiBridge, writeTextFile } from "./fsOps.js";
import { readAiBridgeContext, readCodexContext } from "./workspaceOps.js";
import { exportProContext } from "./proContext.js";
import { toolCardMeta } from "./toolCardRegistration.js";
import { readGlobalRulesSnapshot, withGlobalRules } from "./globalRules.js";
import { redactSensitiveText } from "./redact.js";
import { textResult } from "./toolResults.js";
import type { CodexToolHandler } from "./toolRegistration.js";

const defaultDependencies = {
  ensureAiBridge,
  writeTextFile,
  readAiBridgeContext,
  readCodexContext,
  exportProContext,
  toolCardMeta,
  readGlobalRulesSnapshot,
  withGlobalRules,
  redactSensitiveText,
  textResult,
  readFile: fsp.readFile.bind(fsp),
  appendFile: fsp.appendFile.bind(fsp)
};

type RegisterCodexTool = (
  config: CodexProConfig,
  server: McpServer,
  name: string,
  options: Record<string, unknown>,
  handler: CodexToolHandler
) => void;

type HandoffHelpers = {
  cleanOneLine: (value: unknown, fallback: string, maxLength?: number) => string;
  parseBool: (value: unknown, fallback?: boolean) => boolean;
  diffBlock: (diff: string) => string;
  previewText: (value: string, maxLines?: number, maxChars?: number) => string;
  limitInt: (value: unknown, fallback: number, min: number, max: number) => number;
};

type HandoffAnnotations = {
  readOnly: Record<string, unknown>;
  handoffWrite: Record<string, unknown>;
};

type HandoffToolsOptions = {
  phase: "context" | "handoff";
  config: CodexProConfig;
  server: McpServer;
  workspaces: WorkspaceManager;
  guard: PathGuard;
  registerCodexTool: RegisterCodexTool;
  workspaceForTool: (server: McpServer, workspaces: WorkspaceManager, workspaceId?: string) => Workspace;
  helpers: HandoffHelpers;
  annotations: HandoffAnnotations;
  dependencies?: Partial<typeof defaultDependencies>;
};

function jsonlEvent(event: string, data: Record<string, unknown>): string {
  return JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n";
}

function normalizeAgentId(value: unknown, cleanOneLine: HandoffHelpers["cleanOneLine"]): string {
  const agent = cleanOneLine(value, "custom", 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(agent)) {
    throw new CodexProError("agent must use only lowercase letters, numbers, dots, underscores, or hyphens.");
  }
  return agent;
}

function displayAgentName(agent: string, agentName: unknown, cleanOneLine: HandoffHelpers["cleanOneLine"]): string {
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

async function readRawTextFileBounded(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  filePath: string,
  readFile: typeof defaultDependencies.readFile
): Promise<string> {
  const resolved = guard.resolve(workspace, filePath);
  await guard.assertTextFile(resolved.absPath, config.maxReadBytes);
  return readFile(resolved.absPath, "utf8") as Promise<string>;
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
  },
  helpers: Pick<HandoffHelpers, "cleanOneLine">,
  dependencies: typeof defaultDependencies
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
  await dependencies.ensureAiBridge(config, guard, workspace);
  const agent = normalizeAgentId(options.agent, helpers.cleanOneLine);
  const agentName = displayAgentName(agent, options.agentName, helpers.cleanOneLine);
  const model = options.model ? helpers.cleanOneLine(options.model, "", 120) : undefined;
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
    const raw = await readRawTextFileBounded(config, guard, workspace, planPath, dependencies.readFile);
    content = `${raw.trimEnd()}\n\n---\n\n${body}`;
  }

  const writeResult = await dependencies.writeTextFile(config, guard, workspace, planPath, content, { createDirs: true, overwrite: true });
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
  await dependencies.appendFile(logResolved.absPath, jsonlEvent(options.eventName, event), "utf8");
  await dependencies.appendFile(executionLogResolved.absPath, jsonlEvent(options.eventName, event), "utf8");

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

export function registerHandoffTools(options: HandoffToolsOptions): void {
  const {
    phase,
    config,
    server,
    workspaces,
    guard,
    registerCodexTool,
    workspaceForTool,
    helpers,
    annotations
  } = options;
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const { cleanOneLine, parseBool, diffBlock, previewText, limitInt } = helpers;

  if (phase === "context") {
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
        annotations: annotations.readOnly,
        _meta: {
          ...dependencies.toolCardMeta(),
          "openai/toolInvocation/invoking": "Reading agent handoff context...",
          "openai/toolInvocation/invoked": "Agent handoff context ready"
        }
      },
      async (args) => {
        const workspace = workspaceForTool(server, workspaces, args.workspace_id);
        const context = await dependencies.readAiBridgeContext(config, guard, workspace);
        return dependencies.textResult(context.text, {
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
        annotations: { ...annotations.readOnly, idempotentHint: false },
        _meta: {
          ...dependencies.toolCardMeta(),
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
            const raw = await readRawTextFileBounded(config, guard, workspace, stateRel, dependencies.readFile);
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
            const raw = await readRawTextFileBounded(config, guard, workspace, rel, dependencies.readFile);
            const body = tailLines
              ? raw.split(/\r?\n/).filter(Boolean).slice(-tailLines).join("\n")
              : raw;
            const trimmed = body.length > maxChars ? `${body.slice(0, maxChars)}\n...[excerpt truncated]` : body;
            return dependencies.redactSensitiveText(trimmed);
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
        return dependencies.textResult(lines.join("\n"), structured);
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
        annotations: annotations.readOnly,
        _meta: {
          ...dependencies.toolCardMeta(),
          "openai/toolInvocation/invoking": "Loading Codex context...",
          "openai/toolInvocation/invoked": "Codex context ready"
        }
      },
      async (args) => {
        const workspace = workspaceForTool(server, workspaces, args.workspace_id);
        const globalRules = await dependencies.readGlobalRulesSnapshot();
        const context = await dependencies.readCodexContext(config, guard, workspace, {
          targetPath: args.target_path,
          includeAiBridge: args.include_ai_bridge,
          includeGit: args.include_git,
          includeDiff: parseBool(args.include_diff, false),
          maxAgentBytes: args.max_agent_bytes
        });
        return dependencies.textResult(dependencies.withGlobalRules(context.text, globalRules), {
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
        annotations: annotations.handoffWrite,
        _meta: {
          ...dependencies.toolCardMeta(),
          "openai/toolInvocation/invoking": "Exporting Pro context...",
          "openai/toolInvocation/invoked": "Pro context exported"
        }
      },
      async (args) => {
        const workspace = workspaceForTool(server, workspaces, args.workspace_id);
        const result = await dependencies.exportProContext(config, guard, workspace, {
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
        return dependencies.textResult(text, {
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
    return;
  }

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
      annotations: annotations.handoffWrite,
      _meta: {
        ...dependencies.toolCardMeta(),
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
      }, { cleanOneLine }, dependencies);

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
      return dependencies.textResult(text, {
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
      annotations: annotations.handoffWrite,
      _meta: {
        ...dependencies.toolCardMeta(),
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
      }, { cleanOneLine }, dependencies);
      const text = `# Handoff To Codex

Wrote ${result.planPath}.
Status path: ${result.statusPath}
Diff path: ${result.diffPath}
Diff stats: +${result.writeResult.diff.additions} -${result.writeResult.diff.deletions}

Codex prompt:

\`\`\`text
${result.prompt}
\`\`\`${diffBlock(result.writeResult.diff.diff)}`;
      return dependencies.textResult(text, {
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
}
