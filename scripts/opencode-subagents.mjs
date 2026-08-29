const AGENT_HEADING = /^([^\r\n]+?)\s+\((primary|subagent)\)\s*$/gm;

export const CODEXPRO_ORCHESTRATOR_AGENT = 'codexpro-orchestrator';
export const CODEXPRO_EXPLORE_AGENT = 'codexpro-explore';
export const CODEXPRO_SCOUT_ORCHESTRATOR_AGENT = 'codexpro-scout-orchestrator';
export const GEMINI_SCOUT_AGENT = 'gemini-scout';
export const CODEXPRO_AUDITOR_AGENT = 'codexpro-auditor';

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

function inspectAgentPair(agents, config, orchestratorName, childName, requiredPermissions = {}) {
  const orchestrator = agents.find((agent) => agent.name === orchestratorName);
  const child = agents.find((agent) => agent.name === childName);
  const depthValue = Number(config.subagent_depth ?? 1);
  const subagentDepth = Number.isFinite(depthValue) ? depthValue : 1;
  const taskPermission = orchestrator ? effectivePermission(orchestrator, 'task', childName) : undefined;
  const childPermissions = {};
  const reasons = [];
  if (!orchestrator) reasons.push(`${orchestratorName} is not registered`);
  else if (orchestrator.mode !== 'primary') reasons.push(`${orchestratorName} is not a primary agent`);
  if (!child) reasons.push(`${childName} is not registered`);
  else if (child.mode !== 'subagent') reasons.push(`${childName} is not a subagent`);
  if (subagentDepth < 1) reasons.push(`subagent_depth=${subagentDepth} blocks child sessions`);
  if (orchestrator && taskPermission !== 'allow') reasons.push(`task permission for ${childName} is ${taskPermission || 'not explicitly allowed'}`);
  if (child) {
    for (const [permission, expected] of Object.entries(requiredPermissions)) {
      const actual = effectivePermission(child, permission, '*');
      childPermissions[permission] = actual;
      if (actual !== expected) reasons.push(`${childName} ${permission} permission is ${actual || `not ${expected}`}`);
    }
  }
  return { ready: reasons.length === 0, reasons, orchestrator, child, subagentDepth, taskPermission, childPermissions };
}

export function inspectOpenCodeSubagentCapability(agentListText, configText) {
  const agents = parseOpenCodeAgentList(agentListText);
  const config = parseOpenCodeConfig(configText);
  const pair = inspectAgentPair(agents, config, CODEXPRO_ORCHESTRATOR_AGENT, CODEXPRO_EXPLORE_AGENT, {
    edit: 'deny',
    bash: 'deny',
    task: 'deny'
  });
  return {
    ...pair,
    agents,
    explorer: pair.child,
    explorerEdit: pair.childPermissions.edit,
    explorerBash: pair.childPermissions.bash,
    explorerTask: pair.childPermissions.task,
    model: typeof config.model === 'string' ? config.model : '',
    smallModel: typeof config.small_model === 'string' ? config.small_model : ''
  };
}

export function inspectOpenCodeScoutCapability(agentListText, configText) {
  const agents = parseOpenCodeAgentList(agentListText);
  const config = parseOpenCodeConfig(configText);
  const pair = inspectAgentPair(agents, config, CODEXPRO_SCOUT_ORCHESTRATOR_AGENT, GEMINI_SCOUT_AGENT, {
    read: 'deny',
    grep: 'deny',
    glob: 'deny',
    list: 'deny',
    edit: 'deny',
    bash: 'deny',
    task: 'deny',
    webfetch: 'allow',
    websearch: 'allow'
  });
  return {
    ...pair,
    agents,
    scout: pair.child,
    model: typeof config.model === 'string' ? config.model : '',
    scoutModel: typeof config?.agent?.[GEMINI_SCOUT_AGENT]?.model === 'string' ? config.agent[GEMINI_SCOUT_AGENT].model : ''
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
    return { parsed: false, sessionId: '', filesInspected: [], toolNames: [], forbiddenTools: [], resultText: '', model: '' };
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
  const providerId = String(payload?.info?.model?.providerID ?? '');
  const modelId = String(payload?.info?.model?.id ?? '');
  const model = providerId && modelId ? `${providerId}/${modelId}` : '';
  return {
    parsed: true,
    sessionId: String(payload?.info?.id ?? ''),
    filesInspected: [...fileSet],
    toolNames,
    forbiddenTools,
    resultText,
    summary: payload?.info?.summary ?? {},
    model
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

export function shouldRunGeminiScout(planText) {
  const source = String(planText || '');
  return /https?:\/\/|\b(api|sdk|dependency|dependencies|upstream|documentation|docs|provider|endpoint|library|framework|npm|pypi|github|external|third[- ]party)\b|\brelease\s+notes?\b|\bupstream\s+changelog\b/i.test(source);
}

export function buildGeminiScoutPrompt(planText) {
  return [
    'Research the external facts needed for the following CodexPro handoff.',
    `You MUST invoke the ${GEMINI_SCOUT_AGENT} subagent exactly once with the task tool.`,
    'Do not inspect workspace files and do not modify anything.',
    'Ask the child to verify only dependency/API/SDK/provider/upstream/documentation facts that matter to the handoff, preferring primary sources.',
    'After the task completes, synthesize only the external evidence returned by the child.',
    '',
    'HANDOFF PLAN:',
    String(planText || '').trim()
  ].join('\n');
}

function geminiVersionScore(model) {
  const match = String(model).match(/gemini-(\d+(?:\.\d+)?)/i);
  return match ? Number(match[1]) : 0;
}

function geminiQualityScore(model) {
  const value = String(model).toLowerCase();
  if (value.includes('high')) return 40;
  if (value.includes('medium')) return 30;
  if (value.includes('agent')) return 20;
  if (value.includes('low') && !value.includes('extra-low')) return 10;
  if (value.includes('extra-low')) return 0;
  return 25;
}

export function discoverGeminiScoutModels(modelsText, authText = '', preferredModel = '') {
  const models = [...new Set(String(modelsText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean))]
    .filter((model) => /gemini/i.test(model) && /flash/i.test(model));
  const auth = String(authText || '').toLowerCase();
  const preferred = String(preferredModel || '').trim();
  return models.sort((a, b) => {
    if (a === preferred && b !== preferred) return -1;
    if (b === preferred && a !== preferred) return 1;
    const providerA = a.includes('/') ? a.split('/')[0].toLowerCase() : '';
    const providerB = b.includes('/') ? b.split('/')[0].toLowerCase() : '';
    const authA = providerA && auth.includes(providerA) ? 1 : 0;
    const authB = providerB && auth.includes(providerB) ? 1 : 0;
    if (authA !== authB) return authB - authA;
    const versionDelta = geminiVersionScore(b) - geminiVersionScore(a);
    if (versionDelta) return versionDelta;
    const qualityDelta = geminiQualityScore(b) - geminiQualityScore(a);
    if (qualityDelta) return qualityDelta;
    return a.localeCompare(b);
  });
}

export function parseCodexProAudit(text) {
  const source = String(text || '').trim();
  const verdictMatch = source.match(/^CODEXPRO_AUDIT\s*=\s*(PASS|FAIL)\s*$/im);
  const summaryMatch = source.match(/^SUMMARY\s*=\s*(.+)$/im);
  const fixesMarker = source.search(/^REQUIRED_FIXES\s*:/im);
  const fixes = fixesMarker >= 0
    ? source.slice(fixesMarker).split(/\r?\n/).slice(1).map((line) => line.trim()).filter((line) => /^[-*]\s+/.test(line)).map((line) => line.replace(/^[-*]\s+/, '').trim()).filter(Boolean)
    : [];
  const verdict = verdictMatch ? verdictMatch[1].toUpperCase() : '';
  return {
    verdict,
    summary: summaryMatch ? summaryMatch[1].trim() : '',
    fixes,
    valid: verdict === 'PASS' || (verdict === 'FAIL' && fixes.length > 0),
    raw: source
  };
}

export function buildCodexProAuditPrompt({ originalTask, iterationPlan, diffPath, statusPath, testsPath, testsRan }) {
  return [
    'Audit the current implementation independently.',
    'The ORIGINAL TASK is the immutable acceptance target. The ITERATION PLAN is only the latest remediation instruction and must not replace the original requirements.',
    `Implementation diff evidence: ${diffPath}`,
    `Executor status evidence: ${statusPath}`,
    testsRan ? `Test evidence: ${testsPath}` : 'Test evidence: no explicit loop test command was run; verify whether the original task required tests and fail if required verification is missing.',
    'Inspect repository files as needed, but do not modify anything.',
    '',
    'ORIGINAL TASK:',
    String(originalTask || '').trim(),
    '',
    'ITERATION PLAN:',
    String(iterationPlan || '').trim()
  ].join('\n');
}

export function buildVerifiedInvestigationContext(evidence, maxChars = 16000) {
  const childResult = String(evidence?.childResult || '').trim();
  const primaryResult = String(evidence?.primaryResult || '').trim();
  const files = Array.isArray(evidence?.filesInspected) ? evidence.filesInspected : [];
  const body = [
    'Verified read-only OpenCode subagent investigation:',
    evidence?.agent ? `Agent: ${evidence.agent}` : '',
    evidence?.childModel ? `Child model: ${evidence.childModel}` : '',
    evidence?.childSessionId ? `Child session: ${evidence.childSessionId}` : '',
    files.length ? `Files inspected: ${files.join(', ')}` : '',
    childResult ? `Child result:\n${childResult}` : '',
    primaryResult && primaryResult !== childResult ? `Primary synthesis:\n${primaryResult}` : ''
  ].filter(Boolean).join('\n\n');
  return body.length > maxChars ? `${body.slice(0, maxChars)}\n[truncated]` : body;
}
