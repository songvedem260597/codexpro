import { assertProvider, mcpToolsToProviderTools, normalizeProviderToolCalls } from "../provider-core/provider-contract.mjs";

const LIFECYCLE_TOOLS = new Set([
  "prepare_repo_task",
  "repo_task_status",
  "worker_job_status",
  "finalize_worker_job"
]);

const BEGIN_TASK_TOOL = "begin_repo_task";

function clean(value, maxLength = 4000) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function assertMcpClient(value, label) {
  if (!value || typeof value !== "object" || typeof value.callTool !== "function") {
    throw new Error(`${label} must provide callTool().`);
  }
}

function bounded(value, fallback, min, max) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(min, Math.min(Math.floor(numeric), max)) : fallback;
}

function toolResultText(value, maxChars) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value ?? {});
  if (serialized.length <= maxChars) return serialized;
  return `${serialized.slice(0, maxChars)}\n[CodexPro truncated the MCP tool result at ${maxChars} characters.]`;
}

function bootstrapMessage(result) {
  const job = result?.worker_job && typeof result.worker_job === "object" ? result.worker_job : {};
  return [
    "CodexPro MCP policy bootstrap succeeded.",
    `Task: ${clean(result?.task_title || job.title, 120)}`,
    `Kind: ${clean(result?.task_kind || job.kind, 20)}`,
    `Workspace: ${clean(result?.root || job.root, 2048) || "none"}`,
    `Policy: ${clean(result?.policy_version || job.policy_version, 100)}`,
    `Rules hash: ${clean(result?.global_rules_sha256 || job.rules_hash, 200) || "not required"}`,
    `AGENTS files: ${Array.isArray(result?.agents_files) ? result.agents_files.join(", ") : "not required"}`,
    `CodexGraph: ${result?.codexgraph_active ? "active" : "not required"}`,
    "All repository actions must use the MCP tools supplied with this conversation."
  ].join("\n");
}

function transientProviderDelay(error, attempt) {
  const message = String(error?.message || error || "");
  const status = Number(error?.status || message.match(/Provider HTTP\s+(429|502|503|504)\b/i)?.[1] || 0);
  if (![429, 502, 503, 504].includes(status)) return 0;
  const reset = message.match(/(?:reset|retry)\s+after\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?)?/i);
  const resetMs = reset ? Number(reset[1]) * (String(reset[2] || "s").toLowerCase() === "ms" ? 1 : 1000) : 0;
  return Math.max(250, Math.min(Number(error?.retryAfterMs) || resetMs || 500 * (2 ** (attempt - 1)), 10_000));
}

async function completeProviderWithRetry(provider, input, onRetry) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await provider.complete(input);
    } catch (error) {
      const delayMs = transientProviderDelay(error, attempt);
      if (!delayMs || attempt >= 3 || input.signal?.aborted) throw error;
      onRetry?.({ attempt, delayMs, error: clean(error?.message || error, 300) });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (input.signal?.aborted) throw input.signal.reason || new Error("Worker job cancelled.");
    }
  }
  throw new Error("Provider retry loop ended unexpectedly.");
}

function titleWordCount(value) {
  return clean(value, 56).split(/\s+/).filter(Boolean).length;
}

function matchingWorkspaceRoot(value, workspaceCandidates) {
  const requested = clean(value, 2048);
  if (!requested) return "";
  return workspaceCandidates.find((candidate) => candidate === requested)
    || workspaceCandidates.find((candidate) => candidate.toLowerCase() === requested.toLowerCase())
    || "";
}

function parseTitleSelection(value) {
  const text = clean(value, 12_000);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  try {
    const parsed = JSON.parse(fenced.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function titleBootstrapMessage({ jobId, kind, scope, root, workspaceCandidates }) {
  const lines = [
    "Before doing anything else, you must create the task title through CodexPro MCP.",
    "Choose a clear, natural, easy-to-understand task_title of 4-6 words from the user's request. The user must never be asked to provide this title.",
    `Call ${BEGIN_TASK_TOOL} now with task_id=${jobId}, task_kind=${kind}, scope=${scope}${root ? `, root=${root}` : ""}.`,
  ];
  if (kind === "code" && scope === "all_allowed" && !root) {
    lines.push("Choose the one workspace that best matches the request and include its exact root in begin_repo_task.");
    lines.push(`Allowed workspace roots:\n${workspaceCandidates.map((candidate) => `- ${candidate}`).join("\n")}`);
  }
  lines.push(`Only ${BEGIN_TASK_TOOL} is available in this bootstrap turn. Do not answer the user before that MCP call succeeds.`);
  return lines.join("\n");
}

export async function runMcpAgentJob(input = {}) {
  const providerManifest = assertProvider(input.provider);
  assertMcpClient(input.controlMcp, "controlMcp");
  assertMcpClient(input.jobMcp, "jobMcp");
  if (typeof input.jobMcp.listTools !== "function") throw new Error("jobMcp must provide listTools().");
  const job = input.job && typeof input.job === "object" ? input.job : {};
  const jobId = clean(job.id || job.taskId || job.task_id, 40);
  if (!/^cpt_[a-f0-9]{24}$/.test(jobId)) throw new Error("API worker job id is invalid.");
  const workerId = clean(job.workerId || job.worker_id, 160);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}:[A-Za-z0-9][A-Za-z0-9._-]{0,94}$/.test(workerId)) {
    throw new Error("API worker id must be namespaced as <plugin>:<worker>.");
  }
  const kind = job.kind === "code" ? "code" : "general";
  if (kind === "code" && !providerManifest.capabilities.tool_calling) {
    throw new Error(`Provider ${providerManifest.id} cannot run code jobs without tool calling.`);
  }
  const scope = job.scope === "all_allowed" ? "all_allowed" : "workspace";
  let root = clean(job.root, 2048);
  const workspaceCandidates = [...new Set((Array.isArray(job.workspaceCandidates) ? job.workspaceCandidates : []).map((candidate) => clean(candidate, 2048)).filter(Boolean))].slice(0, 80);
  if (scope === "workspace" && !root) throw new Error("Workspace-scoped API jobs require an exact root.");
  if (kind === "code" && scope === "all_allowed" && !root && !workspaceCandidates.length) throw new Error("All-allowed code API jobs require at least one workspace candidate.");

  const limits = {
    maxTurns: bounded(input.limits?.maxTurns, 24, 1, 100),
    maxToolCalls: bounded(input.limits?.maxToolCalls, 64, 0, 500),
    maxToolResultChars: bounded(input.limits?.maxToolResultChars, 60_000, 1_000, 500_000),
    maxOutputChars: bounded(input.limits?.maxOutputChars, 200_000, 1_000, 2_000_000)
  };
  const emit = (type, details = {}) => input.onEvent?.({ at: new Date().toISOString(), type, ...details });
  try {
    const prepareArgs = { profile_id: workerId, task_id: jobId, scope, ...(root ? { root } : {}) };
    emit("preparing", { job_id: jobId, worker_id: workerId });
    await input.controlMcp.callTool("prepare_repo_task", prepareArgs, { signal: input.signal });

    const listed = await input.jobMcp.listTools({ signal: input.signal });
    const allMcpTools = Array.isArray(listed) ? listed : Array.isArray(listed?.tools) ? listed.tools : [];
    const beginTaskTool = allMcpTools.find((tool) => String(tool?.name || "") === BEGIN_TASK_TOOL);
    if (!beginTaskTool) throw new Error("CodexPro MCP did not expose begin_repo_task for AI title bootstrap.");

    const messages = [
      { role: "system", content: titleBootstrapMessage({ jobId, kind, scope, root, workspaceCandidates }) },
      ...(Array.isArray(input.messages) ? input.messages : [{ role: "user", content: clean(input.request, 200_000) }])
    ];
    const bootstrapTools = mcpToolsToProviderTools([beginTaskTool]);
    let bootstrap;
    let title = "";
    let providerState;
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0 };
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      emit("title_bootstrap_turn", { job_id: jobId, attempt });
      const completion = await completeProviderWithRetry(input.provider, {
        messages,
        tools: bootstrapTools,
        toolChoice: "auto",
        signal: input.signal,
        // The title bootstrap is control-plane work. Never expose its text as the
        // user-visible answer stream.
      }, (retry) => emit("provider_retry", { phase: "title_bootstrap", ...retry }));
      providerState = completion?.providerState || providerState;
      for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "cost"]) {
        usage[key] += Number(completion?.usage?.[key] || 0);
      }
      const toolCalls = normalizeProviderToolCalls(completion?.toolCalls || [], {
        maxCalls: 2,
        maxArgumentsChars: 10_000
      });
      const call = toolCalls.length === 1 && toolCalls[0].name === BEGIN_TASK_TOOL ? toolCalls[0] : null;
      const requestedTitle = clean(call?.arguments?.task_title, 56);
      const requestedRoot = clean(call?.arguments?.root, 2048);
      const selectedCandidate = scope === "all_allowed" && kind === "code" && !root
        ? matchingWorkspaceRoot(requestedRoot, workspaceCandidates)
        : root;
      const assistantMessage = {
        role: "assistant",
        content: String(completion?.text || ""),
        ...(toolCalls.length ? {
          tool_calls: toolCalls.map((item) => ({
            id: item.id,
            type: "function",
            function: { name: item.name, arguments: item.raw_arguments || JSON.stringify(item.arguments || {}) }
          }))
        } : {})
      };
      messages.push(assistantMessage);
      if (!call || titleWordCount(requestedTitle) < 4 || titleWordCount(requestedTitle) > 6 || (kind === "code" && !selectedCandidate)) {
        if (call) messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: kind === "code" && !selectedCandidate ? "root must exactly match one allowed workspace candidate" : "task_title must contain 4-6 clear words chosen by the AI" }) });
        if (attempt < 2) {
          messages.push({ role: "system", content: `Retry: call ${BEGIN_TASK_TOOL} exactly once with a clear, easy-to-understand task_title containing 4-6 words${kind === "code" && !root ? " and an exact root from the allowed workspace list" : ""}.` });
          continue;
        }
        break;
      }
      root = selectedCandidate;
      const beginArgs = { task_id: jobId, task_title: requestedTitle, task_kind: kind, scope, ...(root ? { root } : {}) };
      emit("bootstrapping", { job_id: jobId, kind, title: requestedTitle });
      bootstrap = await input.jobMcp.callTool(BEGIN_TASK_TOOL, beginArgs, { signal: input.signal });
      messages.push({ role: "tool", tool_call_id: call.id, content: toolResultText(bootstrap, limits.maxToolResultChars) });
      title = clean(bootstrap?.task_title || requestedTitle, 56);
      if (titleWordCount(title) < 4 || titleWordCount(title) > 6) throw new Error("CodexPro MCP returned an invalid AI task title.");
      break;
    }
    if (!bootstrap) {
      emit("title_bootstrap_fallback", { job_id: jobId });
      const rootInstruction = kind === "code" && scope === "all_allowed" && !root
        ? ` Include \"root\" using exactly one of these values: ${JSON.stringify(workspaceCandidates)}.`
        : root ? ` Include \"root\": ${JSON.stringify(root)}.` : " Do not include root.";
      const fallbackCompletion = await completeProviderWithRetry(input.provider, {
        messages: [...messages, { role: "system", content: `Tool calling was not emitted. Return only one JSON object with a clear, easy-to-understand \"task_title\" containing 4-6 words.${rootInstruction} Do not add Markdown or explanation.` }],
        tools: [],
        signal: input.signal
      }, (retry) => emit("provider_retry", { phase: "title_fallback", ...retry }));
      providerState = fallbackCompletion?.providerState || providerState;
      for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "cost"]) {
        usage[key] += Number(fallbackCompletion?.usage?.[key] || 0);
      }
      const selection = parseTitleSelection(fallbackCompletion?.text);
      const requestedTitle = clean(selection.task_title, 56);
      const selectedCandidate = scope === "all_allowed" && kind === "code" && !root
        ? matchingWorkspaceRoot(selection.root, workspaceCandidates)
        : root;
      if (titleWordCount(requestedTitle) < 4 || titleWordCount(requestedTitle) > 6) {
        throw new Error("API worker AI did not return a valid 4-6 word task title in its MCP bootstrap fallback.");
      }
      if (kind === "code" && !selectedCandidate) {
        throw new Error("API worker AI did not select an allowed workspace root in its MCP bootstrap fallback.");
      }
      root = selectedCandidate;
      const beginArgs = { task_id: jobId, task_title: requestedTitle, task_kind: kind, scope, ...(root ? { root } : {}) };
      emit("bootstrapping", { job_id: jobId, kind, title: requestedTitle, source: "json_fallback" });
      bootstrap = await input.jobMcp.callTool(BEGIN_TASK_TOOL, beginArgs, { signal: input.signal });
      messages.push({ role: "assistant", content: JSON.stringify({ task_title: requestedTitle, ...(root ? { root } : {}) }) });
      title = clean(bootstrap?.task_title || requestedTitle, 56);
      if (titleWordCount(title) < 4 || titleWordCount(title) > 6) throw new Error("CodexPro MCP returned an invalid AI task title.");
    }
    if (!bootstrap?.verified) throw new Error("CodexPro MCP did not verify the worker job bootstrap.");
    if (kind === "code" && (!bootstrap.gate_active || !bootstrap.global_rules_loaded || !bootstrap.agents_loaded || !bootstrap.codexgraph_active)) {
      throw new Error("CodexPro MCP did not provide complete rules, AGENTS, and CodexGraph evidence for the code job.");
    }

    input.onTaskTitle?.(title, bootstrap);
    input.onPhase?.("agent", { title });
    const mcpTools = allMcpTools
      .filter((tool) => !LIFECYCLE_TOOLS.has(String(tool?.name || "")));
    const runnableMcpTools = mcpTools.filter((tool) => String(tool?.name || "") !== BEGIN_TASK_TOOL);
    const providerTools = mcpToolsToProviderTools(runnableMcpTools);
    if (kind === "code" && !providerTools.length) throw new Error("CodexPro MCP exposed no tools for a code job.");
    const allowedTools = new Set(runnableMcpTools.map((tool) => String(tool.name)));
    messages.push({ role: "system", content: bootstrapMessage(bootstrap) });
    let toolCallCount = 0;
    let finalText = "";

    for (let turn = 1; turn <= limits.maxTurns; turn += 1) {
      if (input.signal?.aborted) throw input.signal.reason || new Error("Worker job cancelled.");
      emit("provider_turn", { turn, tool_call_count: toolCallCount });
      input.onVisibleTurnStart?.({ turn });
      const completion = await completeProviderWithRetry(input.provider, {
        messages,
        tools: providerTools,
        toolChoice: kind === "code" && turn === 1 ? "auto" : "auto",
        signal: input.signal,
        onDelta: input.onVisibleDelta
      }, (retry) => emit("provider_retry", { phase: "agent_turn", turn, ...retry }));
      providerState = completion?.providerState || providerState;
      for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "cost"]) {
        usage[key] += Number(completion?.usage?.[key] || 0);
      }
      const toolCalls = normalizeProviderToolCalls(completion?.toolCalls || [], {
        maxCalls: Math.max(1, limits.maxToolCalls),
        maxArgumentsChars: limits.maxToolResultChars
      });
      const assistantMessage = {
        role: "assistant",
        content: String(completion?.text || ""),
        ...(toolCalls.length ? {
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.raw_arguments || JSON.stringify(call.arguments || {}) }
          }))
        } : {})
      };
      messages.push(assistantMessage);
      if (!toolCalls.length) {
        finalText = String(completion?.text || "");
        if (finalText.length > limits.maxOutputChars) throw new Error("Provider output exceeded the configured job limit.");
        const finalized = await input.jobMcp.callTool("finalize_worker_job", {
          task_id: jobId,
          outcome: "completed",
          summary: clean(finalText, 4000)
        }, { signal: input.signal });
        emit("completed", { turn, tool_call_count: toolCallCount });
        return { job_id: jobId, worker_id: workerId, task_title: title, text: finalText, usage, provider_state: providerState, bootstrap, finalized };
      }
      input.onPhase?.("tool", { names: toolCalls.map((call) => call.name) });
      if (toolCallCount + toolCalls.length > limits.maxToolCalls) throw new Error("Provider exceeded the configured MCP tool-call limit.");
      for (const call of toolCalls) {
        if (!allowedTools.has(call.name)) throw new Error(`Provider requested MCP tool ${call.name}, which is not allowed for this job.`);
        toolCallCount += 1;
        emit("tool_call", { name: call.name, tool_call_id: call.id, tool_call_count: toolCallCount });
        let result;
        try {
          result = await input.jobMcp.callTool(call.name, call.arguments || {}, { signal: input.signal });
        } catch (error) {
          result = { error: { name: clean(error?.name, 120), code: clean(error?.code, 120), message: clean(error?.message || error, 4000) } };
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: toolResultText(result, limits.maxToolResultChars)
        });
      }
    }
    throw new Error("Provider exceeded the configured agent-turn limit.");
  } catch (error) {
    const cancelled = Boolean(input.signal?.aborted);
    await input.jobMcp.callTool("finalize_worker_job", {
      task_id: jobId,
      outcome: cancelled ? "cancelled" : "failed",
      error: clean(error?.message || error, 4000)
    }).catch(() => undefined);
    emit(cancelled ? "cancelled" : "failed", { error: clean(error?.message || error, 1000) });
    throw error;
  }
}
