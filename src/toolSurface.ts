import type { CodexProConfig } from "./config.js";

const MINIMAL_TOOL_NAMES = [
  "codexpro",
  "server_config",
  "codexpro_self_test",
  "prepare_repo_task",
  "begin_repo_task",
  "resume_repo_task",
  "repo_task_status",
  "workspace_coordination_status",
  "worker_job_status",
  "worker_job_history",
  "worker_context_history",
  "report_worker_job_progress",
  "finalize_worker_job",
  "open_current_workspace",
  "open_workspace",
  "read",
  "write",
  "edit",
  "apply_patch",
  "bash",
  "show_changes"
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
  "browser_control"
] as const;

const FULL_TOOL_NAMES = [
  "codexpro",
  "server_config",
  "codexpro_self_test",
  "prepare_repo_task",
  "begin_repo_task",
  "resume_repo_task",
  "repo_task_status",
  "workspace_coordination_status",
  "worker_job_status",
  "worker_job_history",
  "worker_context_history",
  "report_worker_job_progress",
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
  "write",
  "edit",
  "apply_patch",
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
  "browser_control"
] as const;

const CONNECTION_TEST_HIDDEN_TOOLS = new Set<string>([
  "codexpro",
  "codexpro_self_test",
  "prepare_repo_task",
  "resume_repo_task",
  "report_worker_job_progress",
  "finalize_worker_job",
  "write",
  "edit",
  "apply_patch",
  "bash",
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

export function toolNamesForMode(config: CodexProConfig, requireRepoTask = false): string[] {
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
    for (const writeTool of ["write", "edit", "apply_patch"]) {
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
  return names;
}

const MINIMAL_TOOLS = new Set<string>(MINIMAL_TOOL_NAMES);
const STANDARD_TOOLS = new Set<string>(STANDARD_TOOL_NAMES);

export function shouldRegisterTool(config: CodexProConfig, name: string): boolean {
  if (config.connectionTest && CONNECTION_TEST_HIDDEN_TOOLS.has(name)) return false;
  if (name === "bash" && config.bashMode === "off") return false;
  if ((name === "write" || name === "edit" || name === "apply_patch") && config.writeMode !== "workspace") return false;
  if (name === "codex_sessions") return config.codexSessions !== "off";
  if (name === "read_codex_session") return config.codexSessions === "read";
  if ((name === "inspect_workspace" || name === "code_graph") && !config.analysisEnabled) return false;
  if (name === "browser_control") return config.browserControl && !config.connectionTest && config.toolMode !== "minimal";
  if (name === "handoff_to_agent" && config.writeMode === "handoff") return true;
  if (config.toolMode === "full") return true;
  if (config.toolMode === "minimal") return MINIMAL_TOOLS.has(name);
  return STANDARD_TOOLS.has(name);
}
