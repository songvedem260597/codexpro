const AGENT_HEADING = /^([^\r\n]+?)\s+\((primary|subagent)\)\s*$/gm;

export const CODEXPRO_ORCHESTRATOR_AGENT = 'codexpro-orchestrator';
export const CODEXPRO_EXPLORE_AGENT = 'codexpro-explore';

export function parseOpenCodeAgentList(text) {
  const source = String(text || '');
  const matches = [...source.matchAll(AGENT_HEADING)];
  const agents = [];
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const bodyStart = (current.index ?? 0) + current[0].length;
    const bodyEnd = index + 1 < matches.length ? (matches[index + 1].index ?? source.length) : source.length;
    const body = source.slice(bodyStart, bodyEnd).trim();
    let permissions = [];
    if (body.startsWith('[')) {
      try {
        const parsed = JSON.parse(body);
        if (Array.isArray(parsed)) permissions = parsed;
      } catch {
        permissions = [];
      }
    }
    agents.push({
      name: String(current[1]).trim(),
      mode: String(current[2]).trim(),
      permissions
    });
  }
  return agents;
}

export function parseOpenCodeConfig(text) {
  const source = String(text || '').trim();
  if (!source) return {};
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end < start) return {};
  try {
    const parsed = JSON.parse(source.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function wildcardRegex(pattern) {
  const escaped = String(pattern ?? '*').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function effectivePermission(agent, permission, target = '*') {
  let action = undefined;
  for (const rule of agent?.permissions ?? []) {
    const rulePermission = String(rule?.permission ?? '');
    if (rulePermission !== permission && rulePermission !== '*') continue;
    const pattern = String(rule?.pattern ?? '*');
    if (!wildcardRegex(pattern).test(String(target))) continue;
    action = String(rule?.action ?? '');
  }
  return action;
}

export function inspectOpenCodeSubagentCapability(agentListText, configText) {
  const agents = parseOpenCodeAgentList(agentListText);
  const config = parseOpenCodeConfig(configText);
  const orchestrator = agents.find((agent) => agent.name === CODEXPRO_ORCHESTRATOR_AGENT);
  const explorer = agents.find((agent) => agent.name === CODEXPRO_EXPLORE_AGENT);
  const depthValue = Number(config.subagent_depth ?? 1);
  const subagentDepth = Number.isFinite(depthValue) ? depthValue : 1;
  const taskPermission = orchestrator ? effectivePermission(orchestrator, 'task', CODEXPRO_EXPLORE_AGENT) : undefined;
  const explorerEdit = explorer ? effectivePermission(explorer, 'edit', '*') : undefined;
  const explorerBash = explorer ? effectivePermission(explorer, 'bash', '*') : undefined;
  const explorerTask = explorer ? effectivePermission(explorer, 'task', '*') : undefined;
  const reasons = [];
  if (!orchestrator) reasons.push(`${CODEXPRO_ORCHESTRATOR_AGENT} is not registered`);
  else if (orchestrator.mode !== 'primary') reasons.push(`${CODEXPRO_ORCHESTRATOR_AGENT} is not a primary agent`);
  if (!explorer) reasons.push(`${CODEXPRO_EXPLORE_AGENT} is not registered`);
  else if (explorer.mode !== 'subagent') reasons.push(`${CODEXPRO_EXPLORE_AGENT} is not a subagent`);
  if (subagentDepth < 1) reasons.push(`subagent_depth=${subagentDepth} blocks child sessions`);
  if (orchestrator && taskPermission !== 'allow') reasons.push(`task permission for ${CODEXPRO_EXPLORE_AGENT} is ${taskPermission || 'not explicitly allowed'}`);
  if (explorer && explorerEdit !== 'deny') reasons.push(`${CODEXPRO_EXPLORE_AGENT} edit permission is ${explorerEdit || 'not denied'}`);
  if (explorer && explorerBash !== 'deny') reasons.push(`${CODEXPRO_EXPLORE_AGENT} bash permission is ${explorerBash || 'not denied'}`);
  if (explorer && explorerTask !== 'deny') reasons.push(`${CODEXPRO_EXPLORE_AGENT} task permission is ${explorerTask || 'not denied'}`);
  return {
    ready: reasons.length === 0,
    reasons,
    agents,
    subagentDepth,
    orchestrator,
    explorer,
    taskPermission,
    explorerEdit,
    explorerBash,
    explorerTask,
    model: typeof config.model === 'string' ? config.model : '',
    smallModel: typeof config.small_model === 'string' ? config.small_model : ''
  };
}

export function parseOpenCodeJsonEvents(text) {
  const events = [];
  const invalid = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    try {
      const event = JSON.parse(line);
      if (event && typeof event === 'object') events.push(event);
    } catch {
      invalid.push(line);
    }
  }
  return { events, invalid };
}

function textParts(events) {
  return events
    .filter((event) => event?.type === 'text' && typeof event?.part?.text === 'string')
    .map((event) => event.part.text)
    .join('\n')
    .trim();
}

export function analyzeOpenCodeSubagentEvents(text, expectedAgent = CODEXPRO_EXPLORE_AGENT) {
  const parsed = parseOpenCodeJsonEvents(text);
  const taskEvents = parsed.events.filter((event) => event?.type === 'tool_use' && event?.part?.tool === 'task');
  const completedTask = taskEvents.find((event) => {
    const state = event?.part?.state ?? {};
    const target = state?.input?.subagent_type ?? state?.input?.subagentType ?? state?.metadata?.agent;
    return state.status === 'completed' && target === expectedAgent;
  });
  const erroredTask = taskEvents.find((event) => {
    const state = event?.part?.state ?? {};
    const target = state?.input?.subagent_type ?? state?.input?.subagentType ?? state?.metadata?.agent;
    return state.status === 'error' && target === expectedAgent;
  });
  const state = completedTask?.part?.state ?? {};
  const childSessionId = state?.metadata?.sessionId ?? state?.metadata?.sessionID ?? '';
  const parentSessionId = completedTask?.sessionID ?? parsed.events.find((event) => event?.sessionID)?.sessionID ?? '';
  const childResult = typeof state.output === 'string' ? state.output.trim() : '';
  const primaryResult = textParts(parsed.events);
  const verified = Boolean(completedTask && childSessionId && childResult);
  let reason = '';
  if (!verified) {
    if (erroredTask) reason = String(erroredTask?.part?.state?.error ?? 'subagent task returned an error');
    else if (!taskEvents.length) reason = 'no task tool event was observed';
    else if (!completedTask) reason = `no completed task event for ${expectedAgent}`;
    else if (!childSessionId) reason = 'completed task event did not include a child session id';
    else if (!childResult) reason = 'completed task event did not include a child result';
  }
  return {
    verified,
    reason,
    events: parsed.events,
    invalidLines: parsed.invalid,
    taskEvents,
    completedTask,
    childSessionId,
    parentSessionId,
    childResult,
    primaryResult
  };
}

function collectToolParts(exportPayload) {
  const parts = [];
  for (const message of exportPayload?.messages ?? []) {
    for (const part of message?.parts ?? []) {
      if (part?.type === 'tool') parts.push(part);
    }
  }
  return parts;
}

function collectPaths(value, key = '') {
  const found = [];
  if (typeof value === 'string') {
    if (/(path|file|filename|target)$/i.test(key) && value.trim()) found.push(value.trim());
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) found.push(...collectPaths(item, key));
    return found;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) found.push(...collectPaths(childValue, childKey));
  }
  return found;
}

export function analyzeOpenCodeSessionExport(text) {
  let payload = {};
  try {
    payload = JSON.parse(String(text || ''));
  } catch {
    return { parsed: false, sessionId: '', filesInspected: [], toolNames: [], forbiddenTools: [], resultText: '' };
  }
  const toolParts = collectToolParts(payload);
  const toolNames = toolParts.map((part) => String(part.tool || '')).filter(Boolean);
  const forbidden = new Set(['write', 'edit', 'apply_patch', 'patch', 'bash', 'task']);
  const forbiddenTools = [...new Set(toolNames.filter((name) => forbidden.has(name)))];
  const fileSet = new Set();
  for (const part of toolParts) {
    const input = part?.state?.input ?? part?.input ?? {};
    for (const candidate of collectPaths(input)) fileSet.add(candidate);
  }
  const resultText = (payload?.messages ?? [])
    .flatMap((message) => message?.parts ?? [])
    .filter((part) => part?.type === 'text' && typeof part?.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
  return {
    parsed: true,
    sessionId: String(payload?.info?.id ?? ''),
    filesInspected: [...fileSet],
    toolNames,
    forbiddenTools,
    resultText,
    summary: payload?.info?.summary ?? {}
  };
}

export function buildOpenCodeInvestigationPrompt(planText) {
  return [
    'Investigate the following CodexPro handoff before implementation.',
    `You MUST invoke the ${CODEXPRO_EXPLORE_AGENT} subagent exactly once with the task tool.`,
    'Do not inspect workspace files directly and do not modify any files.',
    'Ask the child to locate the relevant code flow, likely root cause, affected tests, and concrete file evidence.',
    'After the task completes, synthesize only the evidence returned by the child.',
    '',
    'HANDOFF PLAN:',
    String(planText || '').trim()
  ].join('\n');
}

export function buildVerifiedInvestigationContext(evidence, maxChars = 16000) {
  const childResult = String(evidence?.childResult || '').trim();
  const primaryResult = String(evidence?.primaryResult || '').trim();
  const files = Array.isArray(evidence?.filesInspected) ? evidence.filesInspected : [];
  const body = [
    'Verified read-only OpenCode subagent investigation:',
    evidence?.childSessionId ? `Child session: ${evidence.childSessionId}` : '',
    files.length ? `Files inspected: ${files.join(', ')}` : '',
    childResult ? `Child result:\n${childResult}` : '',
    primaryResult && primaryResult !== childResult ? `Primary synthesis:\n${primaryResult}` : ''
  ].filter(Boolean).join('\n\n');
  return body.length > maxChars ? `${body.slice(0, maxChars)}\n[truncated]` : body;
}
