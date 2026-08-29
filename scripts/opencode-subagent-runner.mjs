import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  CODEXPRO_EXPLORE_AGENT,
  CODEXPRO_ORCHESTRATOR_AGENT,
  CODEXPRO_SCOUT_ORCHESTRATOR_AGENT,
  GEMINI_SCOUT_AGENT,
  analyzeOpenCodeSessionExport,
  analyzeOpenCodeSubagentEvents,
  buildGeminiScoutPrompt,
  buildOpenCodeInvestigationPrompt,
  buildVerifiedInvestigationContext,
  discoverGeminiScoutModels,
  inspectOpenCodeScoutCapability,
  inspectOpenCodeSubagentCapability,
  parseOpenCodeJsonEvents,
  shouldRunGeminiScout
} from './opencode-subagents.mjs';

function isWindowsBatchFile(command) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
}

function quoteWindowsCmdArg(value) {
  const text = String(value).replace(/\r?\n/g, ' ').replace(/%/g, '%%');
  if (!text) return '""';
  return `"${text.replace(/"/g, '""')}"`;
}

function processInvocation(command, args) {
  if (!isWindowsBatchFile(command)) return { command, args };
  const commandLine = `"${[quoteWindowsCmdArg(command), ...args.map(quoteWindowsCmdArg)].join(' ')}"`;
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/q', '/v:off', '/s', '/c', commandLine],
    windowsVerbatimArguments: true
  };
}

function trimUtf8(value, maxBytes) {
  const buffer = Buffer.from(String(value || ''), 'utf8');
  if (buffer.byteLength <= maxBytes) return { text: String(value || ''), truncated: false };
  return { text: buffer.subarray(0, maxBytes).toString('utf8'), truncated: true };
}

function spawnSyncPortable(command, args, options = {}) {
  const invocation = processInvocation(command, args);
  return spawnSync(invocation.command, invocation.args, {
    ...options,
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    ...(process.platform === 'win32' ? { windowsHide: true } : {})
  });
}

function deepMerge(base, overlay) {
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) return overlay;
  const output = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(overlay)) {
    output[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? deepMerge(output[key], value)
      : value;
  }
  return output;
}

function runtimeEnv(configDir = '', configOverlay = null) {
  let configContent = String(process.env.OPENCODE_CONFIG_CONTENT || '').trim();
  if (configOverlay && typeof configOverlay === 'object') {
    let base = {};
    if (configContent) {
      try {
        base = JSON.parse(configContent);
      } catch {
        base = {};
      }
    }
    configContent = JSON.stringify(deepMerge(base, configOverlay));
  }
  return {
    ...process.env,
    NO_COLOR: '1',
    ...(configDir ? { OPENCODE_CONFIG_DIR: configDir } : {}),
    ...(configContent ? { OPENCODE_CONFIG_CONTENT: configContent } : {})
  };
}

function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const killed = spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    });
    if (!killed.error && killed.status === 0) return;
  }
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    try { child.kill('SIGKILL'); } catch {}
  }, 1500).unref();
}

function runProcessCaptured(command, args, options) {
  const timeoutMs = options.timeoutMs;
  const maxOutputBytes = options.maxOutputBytes;
  const retainedOutputBytes = maxOutputBytes + 1;
  const started = Date.now();
  return new Promise((resolve) => {
    const invocation = processInvocation(command, args);
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: runtimeEnv(options.configDir, options.configOverlay),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      ...(process.platform === 'win32' ? { windowsHide: true } : {})
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let closed = false;
    const append = (current, chunk) => {
      if (Buffer.byteLength(current, 'utf8') > retainedOutputBytes) return current;
      const next = current + String(chunk);
      const buffer = Buffer.from(next, 'utf8');
      return buffer.byteLength > retainedOutputBytes ? buffer.subarray(0, retainedOutputBytes).toString('utf8') : next;
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    timer.unref();
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, signal: null, durationMs: Date.now() - started, timedOut, stdout: '', stderr: String(error), spawnError: true });
    });
    child.on('close', (exitCode, signal) => {
      closed = true;
      clearTimeout(timer);
      const out = trimUtf8(stdout, maxOutputBytes);
      const err = trimUtf8(`${stderr}${timedOut ? `\n[codexpro] Command timed out after ${timeoutMs} ms.` : ''}`, maxOutputBytes);
      resolve({
        exitCode,
        signal,
        durationMs: Date.now() - started,
        timedOut,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
        spawnError: false
      });
    });
  });
}

function processFailureReason(result) {
  for (const rawLine of String(result?.stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === 'error') {
        const data = event?.error?.data ?? {};
        const status = data.statusCode ? ` HTTP ${data.statusCode}` : '';
        return `${data.message || event?.error?.name || 'OpenCode error'}${status}`;
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }
  const stderr = String(result?.stderr || '').trim();
  if (stderr) return stderr.split(/\r?\n/)[0];
  if (result?.timedOut) return 'OpenCode timed out';
  return `OpenCode exited with code ${result?.exitCode ?? 'null'}`;
}

export function inspectOpenCodeRuntime(command, root, configDir = '', options = {}) {
  const env = runtimeEnv(configDir, options.configOverlay);
  const spawnOptions = {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 2_000_000,
    env
  };
  const agentList = spawnSyncPortable(command, ['agent', 'list'], spawnOptions);
  const configResult = spawnSyncPortable(command, ['debug', 'config'], spawnOptions);
  const reasons = [];
  if (agentList.error) reasons.push(`opencode agent list failed: ${agentList.error.message}`);
  else if (agentList.status !== 0) reasons.push(`opencode agent list exited ${agentList.status ?? 'null'}`);
  if (configResult.error) reasons.push(`opencode debug config failed: ${configResult.error.message}`);
  else if (configResult.status !== 0) reasons.push(`opencode debug config exited ${configResult.status ?? 'null'}`);
  const inspector = options.inspector || inspectOpenCodeSubagentCapability;
  const capability = inspector(agentList.stdout || '', configResult.stdout || '');
  return {
    ...capability,
    ready: reasons.length === 0 && capability.ready,
    reasons: [...reasons, ...capability.reasons],
    agentListExitCode: agentList.status,
    configExitCode: configResult.status
  };
}

function exportChildSession(command, root, sessionId, maxOutputBytes, configDir = '', configOverlay = null) {
  const result = spawnSyncPortable(command, ['export', sessionId], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: Math.max(maxOutputBytes * 4, 2_000_000),
    env: runtimeEnv(configDir, configOverlay)
  });
  const stdout = trimUtf8(result.stdout || '', Math.max(maxOutputBytes, 120_000)).text;
  return {
    exitCode: result.status,
    stderr: trimUtf8(result.stderr || '', 8000).text,
    analysis: result.status === 0 ? analyzeOpenCodeSessionExport(stdout) : null
  };
}

function event(eventName, data = {}) {
  return { ts: new Date().toISOString(), event: eventName, ...data };
}

function fallback(events, agent, reason, extra = {}) {
  events.push(event('subagent_fallback', { agent, reason, ...extra }));
  return { requested: true, verified: false, agent, fallbackReason: reason, events, ...extra };
}

async function runVerifiedOpenCodeChild(options) {
  const childAgent = options.childAgent;
  const orchestratorAgent = options.orchestratorAgent;
  const configOverlay = options.childModel ? { agent: { [childAgent]: { model: options.childModel } } } : null;
  const events = [event('subagent_requested', {
    agent: childAgent,
    orchestrator: orchestratorAgent,
    model: options.childModel || options.parentModel || undefined
  })];
  const capability = inspectOpenCodeRuntime(options.command, options.root, options.configDir || '', {
    inspector: options.capabilityInspector,
    configOverlay
  });
  if (!capability.ready) {
    return fallback(events, childAgent, capability.reasons.join('; ') || 'OpenCode subagent capability check failed', {
      capability,
      subagentDepth: capability.subagentDepth,
      childModel: options.childModel || ''
    });
  }
  if (options.childModel && capability.scoutModel && capability.scoutModel !== options.childModel) {
    return fallback(events, childAgent, `runtime model override did not resolve to ${options.childModel}`, {
      capability,
      childModel: options.childModel
    });
  }

  const args = [
    'run',
    '--format',
    'json',
    '--agent',
    orchestratorAgent,
    ...(options.parentModel ? ['--model', options.parentModel] : []),
    options.prompt
  ];
  const orchestration = await runProcessCaptured(options.command, args, {
    cwd: options.root,
    configDir: options.configDir || '',
    configOverlay,
    timeoutMs: Math.min(options.timeoutMs ?? 600_000, 180_000),
    maxOutputBytes: options.maxOutputBytes ?? 120_000
  });
  if (orchestration.exitCode !== 0) {
    return fallback(events, childAgent, processFailureReason(orchestration), {
      capability,
      childModel: options.childModel || '',
      orchestratorExitCode: orchestration.exitCode
    });
  }

  const observed = analyzeOpenCodeSubagentEvents(orchestration.stdout, childAgent);
  if (!observed.verified) {
    return fallback(events, childAgent, observed.reason || 'OpenCode returned no verifiable child-session evidence', {
      capability,
      childModel: options.childModel || '',
      parentSessionId: observed.parentSessionId || ''
    });
  }

  events.push(event('subagent_started', {
    agent: childAgent,
    child_session_id: observed.childSessionId,
    parent_session_id: observed.parentSessionId || undefined,
    observed_late: true,
    evidence: 'completed task metadata'
  }));
  events.push(event('child_session_id', {
    agent: childAgent,
    child_session_id: observed.childSessionId,
    parent_session_id: observed.parentSessionId || undefined
  }));

  const exported = exportChildSession(options.command, options.root, observed.childSessionId, options.maxOutputBytes ?? 120_000, options.configDir || '', configOverlay);
  if (exported.exitCode !== 0 || !exported.analysis?.parsed) {
    return fallback(events, childAgent, 'child session was observed but could not be exported for evidence verification', {
      capability,
      childModel: options.childModel || '',
      childSessionId: observed.childSessionId,
      exportExitCode: exported.exitCode
    });
  }

  const deniedTools = new Set([...(options.deniedTools || []), ...exported.analysis.forbiddenTools]);
  const usedDeniedTools = [...new Set(exported.analysis.toolNames.filter((tool) => deniedTools.has(tool)))];
  if (usedDeniedTools.length) {
    return fallback(events, childAgent, `read-only child used forbidden tools: ${usedDeniedTools.join(', ')}`, {
      capability,
      childModel: options.childModel || '',
      childSessionId: observed.childSessionId
    });
  }
  if (options.childModel && exported.analysis.model !== options.childModel) {
    return fallback(events, childAgent, `child session used ${exported.analysis.model || 'an unknown model'} instead of ${options.childModel}`, {
      capability,
      childModel: options.childModel,
      observedChildModel: exported.analysis.model || '',
      childSessionId: observed.childSessionId
    });
  }

  const evidence = {
    requested: true,
    verified: true,
    agent: childAgent,
    orchestrator: orchestratorAgent,
    childModel: exported.analysis.model || options.childModel || '',
    childSessionId: observed.childSessionId,
    parentSessionId: observed.parentSessionId,
    childResult: observed.childResult,
    primaryResult: observed.primaryResult,
    filesInspected: exported.analysis.filesInspected,
    childToolNames: exported.analysis.toolNames,
    capability
  };
  events.push(event('subagent_completed', {
    agent: childAgent,
    child_session_id: evidence.childSessionId,
    child_model: evidence.childModel || undefined,
    child_tools: evidence.childToolNames
  }));
  events.push(event('files_inspected', {
    agent: childAgent,
    child_session_id: evidence.childSessionId,
    files: evidence.filesInspected
  }));
  events.push(event('result_received', {
    agent: childAgent,
    child_session_id: evidence.childSessionId,
    result_excerpt: trimUtf8(evidence.childResult, 12000).text
  }));
  return { ...evidence, events, fallbackReason: '' };
}

export async function runVerifiedOpenCodeInvestigation(options) {
  return runVerifiedOpenCodeChild({
    command: options.command,
    root: options.root,
    configDir: options.configDir || '',
    parentModel: options.model || '',
    childAgent: CODEXPRO_EXPLORE_AGENT,
    orchestratorAgent: CODEXPRO_ORCHESTRATOR_AGENT,
    capabilityInspector: inspectOpenCodeSubagentCapability,
    prompt: buildOpenCodeInvestigationPrompt(options.planText),
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
    deniedTools: []
  });
}

export function inspectGeminiScoutAvailability(command, root, configDir = '', preferredModel = '') {
  const options = {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 2_000_000,
    env: runtimeEnv(configDir)
  };
  const modelList = spawnSyncPortable(command, ['models'], options);
  const authList = spawnSyncPortable(command, ['auth', 'list'], { ...options, maxBuffer: 200_000 });
  const modelsText = String(modelList.stdout || '');
  const authText = String(authList.stdout || '');
  const candidates = modelList.status === 0
    ? discoverGeminiScoutModels(modelsText, authText, preferredModel || process.env.CODEXPRO_GEMINI_SCOUT_MODEL || '')
    : [];
  const authenticatedCandidates = candidates.filter((model) => {
    const provider = model.includes('/') ? model.split('/')[0].toLowerCase() : '';
    return provider && authText.toLowerCase().includes(provider);
  });
  return {
    ready: modelList.status === 0 && authList.status === 0 && authenticatedCandidates.length > 0,
    candidates,
    authenticatedCandidates,
    selectedModel: authenticatedCandidates[0] || '',
    modelListExitCode: modelList.status,
    authListExitCode: authList.status,
    reason: modelList.status !== 0
      ? `opencode models exited ${modelList.status ?? 'null'}`
      : authList.status !== 0
        ? `opencode auth list exited ${authList.status ?? 'null'}`
        : authenticatedCandidates.length
          ? ''
          : candidates.length
            ? 'Gemini Flash models are listed, but no matching provider credential is visible'
            : 'no Gemini Flash model is listed by OpenCode'
  };
}

export async function runVerifiedGeminiScout(options) {
  if (!shouldRunGeminiScout(options.planText)) {
    return { requested: false, verified: false, skipped: true, agent: GEMINI_SCOUT_AGENT, fallbackReason: 'handoff has no external dependency/API/upstream research signal', events: [] };
  }
  const availability = inspectGeminiScoutAvailability(options.command, options.root, options.configDir || '', options.scoutModel || '');
  const events = [event('subagent_requested', {
    agent: GEMINI_SCOUT_AGENT,
    orchestrator: CODEXPRO_SCOUT_ORCHESTRATOR_AGENT,
    purpose: 'external_research'
  })];
  if (!availability.ready) {
    return fallback(events, GEMINI_SCOUT_AGENT, availability.reason, { availability, childModel: '' });
  }

  const providerCandidates = [];
  const seenProviders = new Set();
  for (const model of availability.authenticatedCandidates) {
    const provider = model.includes('/') ? model.split('/')[0].toLowerCase() : model.toLowerCase();
    if (seenProviders.has(provider)) continue;
    seenProviders.add(provider);
    providerCandidates.push(model);
    if (providerCandidates.length >= 2) break;
  }

  let selectedModel = '';
  let lastProbe = null;
  for (const model of providerCandidates) {
    const probe = await runOpenCodeModelProbe({
      command: options.command,
      root: options.root,
      configDir: options.configDir || '',
      model,
      timeoutMs: options.probeTimeoutMs ?? 12_000,
      maxOutputBytes: 40_000
    });
    lastProbe = probe;
    events.push(event('scout_model_probe', { agent: GEMINI_SCOUT_AGENT, model, ok: probe.ok, duration_ms: probe.durationMs, reason: probe.reason || undefined }));
    if (probe.ok) {
      selectedModel = model;
      break;
    }
  }
  if (!selectedModel) {
    return fallback(events, GEMINI_SCOUT_AGENT, `no Gemini Flash candidate passed the bounded live probe${lastProbe?.reason ? `: ${lastProbe.reason}` : ''}`, {
      availability,
      childModel: '',
      probe: lastProbe
    });
  }

  const childRun = await runVerifiedOpenCodeChild({
    command: options.command,
    root: options.root,
    configDir: options.configDir || '',
    parentModel: options.model || '',
    childModel: selectedModel,
    childAgent: GEMINI_SCOUT_AGENT,
    orchestratorAgent: CODEXPRO_SCOUT_ORCHESTRATOR_AGENT,
    capabilityInspector: inspectOpenCodeScoutCapability,
    prompt: buildGeminiScoutPrompt(options.planText),
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
    deniedTools: ['read', 'grep', 'glob', 'list']
  });
  return {
    ...childRun,
    availability,
    events: [...events, ...(childRun.events || [])]
  };
}

export function executorPromptWithInvestigation(basePlanPrompt, evidence) {
  const verified = (Array.isArray(evidence) ? evidence : [evidence]).filter((item) => item?.verified);
  if (!verified.length) return basePlanPrompt;
  return [
    basePlanPrompt,
    '',
    ...verified.flatMap((item) => [buildVerifiedInvestigationContext(item), '']),
    'Use the verified child investigations as evidence, but independently validate details while implementing. Keep changes scoped and run relevant verification.'
  ].join('\n');
}

export function buildOpenCodeExecutorArgs(model, prompt) {
  return ['run', ...(model ? ['--model', model] : []), prompt];
}

export async function runOpenCodeModelProbe(options) {
  const marker = 'CODEXPRO_MODEL_OK';
  const result = await runProcessCaptured(options.command, [
    'run',
    '--format',
    'json',
    ...(options.model ? ['--model', options.model] : []),
    `Reply exactly ${marker}`
  ], {
    cwd: options.root,
    configDir: options.configDir || '',
    timeoutMs: options.timeoutMs ?? 45_000,
    maxOutputBytes: options.maxOutputBytes ?? 40_000
  });
  const parsed = parseOpenCodeJsonEvents(result.stdout);
  const text = parsed.events
    .filter((event) => event?.type === 'text' && typeof event?.part?.text === 'string')
    .map((event) => event.part.text)
    .join('\n')
    .trim();
  const ok = result.exitCode === 0 && text.includes(marker);
  return {
    ok,
    model: options.model || '',
    text,
    reason: ok ? '' : processFailureReason(result),
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut
  };
}

export function relativeAgentFiles() {
  return [
    path.join('.opencode', 'agents', 'codexpro-orchestrator.md'),
    path.join('.opencode', 'agents', 'codexpro-explore.md'),
    path.join('.opencode', 'agents', 'codexpro-scout-orchestrator.md'),
    path.join('.opencode', 'agents', 'gemini-scout.md')
  ];
}
