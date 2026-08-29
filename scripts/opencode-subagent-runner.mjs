import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  CODEXPRO_EXPLORE_AGENT,
  CODEXPRO_ORCHESTRATOR_AGENT,
  analyzeOpenCodeSessionExport,
  analyzeOpenCodeSubagentEvents,
  buildOpenCodeInvestigationPrompt,
  buildVerifiedInvestigationContext,
  inspectOpenCodeSubagentCapability,
  parseOpenCodeJsonEvents
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

function runtimeEnv(configDir = '') {
  return {
    ...process.env,
    NO_COLOR: '1',
    ...(configDir ? { OPENCODE_CONFIG_DIR: configDir } : {})
  };
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
      env: runtimeEnv(options.configDir),
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
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!closed) child.kill('SIGKILL');
      }, 1500).unref();
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
  return `OpenCode exited with code ${result?.exitCode ?? 'null'}`;
}

export function inspectOpenCodeRuntime(command, root, configDir = '') {
  const options = {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 2_000_000,
    env: runtimeEnv(configDir)
  };
  const agentList = spawnSyncPortable(command, ['agent', 'list'], options);
  const configResult = spawnSyncPortable(command, ['debug', 'config'], options);
  const reasons = [];
  if (agentList.error) reasons.push(`opencode agent list failed: ${agentList.error.message}`);
  else if (agentList.status !== 0) reasons.push(`opencode agent list exited ${agentList.status ?? 'null'}`);
  if (configResult.error) reasons.push(`opencode debug config failed: ${configResult.error.message}`);
  else if (configResult.status !== 0) reasons.push(`opencode debug config exited ${configResult.status ?? 'null'}`);
  const capability = inspectOpenCodeSubagentCapability(agentList.stdout || '', configResult.stdout || '');
  return {
    ...capability,
    ready: reasons.length === 0 && capability.ready,
    reasons: [...reasons, ...capability.reasons],
    agentListExitCode: agentList.status,
    configExitCode: configResult.status
  };
}

function exportChildSession(command, root, sessionId, maxOutputBytes, configDir = '') {
  const result = spawnSyncPortable(command, ['export', sessionId], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: Math.max(maxOutputBytes * 4, 2_000_000),
    env: runtimeEnv(configDir)
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

function fallback(events, reason, extra = {}) {
  events.push(event('subagent_fallback', { agent: CODEXPRO_EXPLORE_AGENT, reason, ...extra }));
  return { requested: true, verified: false, fallbackReason: reason, events, ...extra };
}

export async function runVerifiedOpenCodeInvestigation(options) {
  const events = [event('subagent_requested', {
    agent: CODEXPRO_EXPLORE_AGENT,
    orchestrator: CODEXPRO_ORCHESTRATOR_AGENT,
    model: options.model || undefined
  })];
  const capability = inspectOpenCodeRuntime(options.command, options.root, options.configDir || '');
  if (!capability.ready) {
    return fallback(events, capability.reasons.join('; ') || 'OpenCode subagent capability check failed', {
      capability,
      subagentDepth: capability.subagentDepth
    });
  }

  const prompt = buildOpenCodeInvestigationPrompt(options.planText);
  const args = [
    'run',
    '--format',
    'json',
    '--agent',
    CODEXPRO_ORCHESTRATOR_AGENT,
    ...(options.model ? ['--model', options.model] : []),
    prompt
  ];
  const orchestration = await runProcessCaptured(options.command, args, {
    cwd: options.root,
    configDir: options.configDir || '',
    timeoutMs: Math.min(options.timeoutMs ?? 600_000, 180_000),
    maxOutputBytes: options.maxOutputBytes ?? 120_000
  });
  if (orchestration.exitCode !== 0) {
    return fallback(events, processFailureReason(orchestration), {
      capability,
      orchestratorExitCode: orchestration.exitCode
    });
  }

  const observed = analyzeOpenCodeSubagentEvents(orchestration.stdout, CODEXPRO_EXPLORE_AGENT);
  if (!observed.verified) {
    return fallback(events, observed.reason || 'OpenCode returned no verifiable child-session evidence', {
      capability,
      parentSessionId: observed.parentSessionId || ''
    });
  }

  events.push(event('subagent_started', {
    agent: CODEXPRO_EXPLORE_AGENT,
    child_session_id: observed.childSessionId,
    parent_session_id: observed.parentSessionId || undefined,
    observed_late: true,
    evidence: 'completed task metadata'
  }));
  events.push(event('child_session_id', {
    agent: CODEXPRO_EXPLORE_AGENT,
    child_session_id: observed.childSessionId,
    parent_session_id: observed.parentSessionId || undefined
  }));

  const exported = exportChildSession(options.command, options.root, observed.childSessionId, options.maxOutputBytes ?? 120_000, options.configDir || '');
  if (exported.exitCode !== 0 || !exported.analysis?.parsed) {
    return fallback(events, 'child session was observed but could not be exported for evidence verification', {
      capability,
      childSessionId: observed.childSessionId,
      exportExitCode: exported.exitCode
    });
  }
  if (exported.analysis.forbiddenTools.length) {
    return fallback(events, `read-only child used forbidden tools: ${exported.analysis.forbiddenTools.join(', ')}`, {
      capability,
      childSessionId: observed.childSessionId
    });
  }

  const evidence = {
    requested: true,
    verified: true,
    childSessionId: observed.childSessionId,
    parentSessionId: observed.parentSessionId,
    childResult: observed.childResult,
    primaryResult: observed.primaryResult,
    filesInspected: exported.analysis.filesInspected,
    childToolNames: exported.analysis.toolNames,
    capability
  };
  events.push(event('subagent_completed', {
    agent: CODEXPRO_EXPLORE_AGENT,
    child_session_id: evidence.childSessionId,
    child_tools: evidence.childToolNames
  }));
  events.push(event('files_inspected', {
    agent: CODEXPRO_EXPLORE_AGENT,
    child_session_id: evidence.childSessionId,
    files: evidence.filesInspected
  }));
  events.push(event('result_received', {
    agent: CODEXPRO_EXPLORE_AGENT,
    child_session_id: evidence.childSessionId,
    result_excerpt: trimUtf8(evidence.childResult, 12000).text
  }));
  return { ...evidence, events, fallbackReason: '' };
}

export function executorPromptWithInvestigation(basePlanPrompt, evidence) {
  if (!evidence?.verified) return basePlanPrompt;
  return [
    basePlanPrompt,
    '',
    buildVerifiedInvestigationContext(evidence),
    '',
    'Use the verified child investigation as evidence, but independently validate details while implementing. Keep changes scoped and run relevant verification.'
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
    durationMs: result.durationMs
  };
}

export function relativeAgentFiles() {
  return [
    path.join('.opencode', 'agents', 'codexpro-orchestrator.md'),
    path.join('.opencode', 'agents', 'codexpro-explore.md')
  ];
}
