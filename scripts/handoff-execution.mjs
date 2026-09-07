import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { CODEXPRO_EXPLORE_AGENT, GEMINI_SCOUT_AGENT } from './opencode-subagents.mjs';
import {
  buildOpenCodeExecutorArgs,
  executorPromptWithInvestigation,
  runVerifiedGeminiScout,
  runVerifiedOpenCodeInvestigation
} from './opencode-subagent-runner.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function contextDirFromArgs(args) {
  return args.contextDir ?? process.env.CODEXPRO_CONTEXT_DIR ?? '.ai-bridge';
}

export function splitCommandTemplate(input) {
  const tokens = [];
  let current = '';
  let quote = '';
  let tokenStarted = false;
  const text = String(input);
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\\') {
      const next = text[i + 1];
      tokenStarted = true;
      if (next && (next === quote || next === '\\' || (!quote && /\s|["']/.test(next)))) {
        current += next;
        i += 1;
      } else {
        current += char;
      }
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      else {
        tokenStarted = true;
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }
    tokenStarted = true;
    current += char;
  }
  if (quote) throw new Error('Custom command has an unterminated quote.');
  if (tokenStarted) tokens.push(current);
  return tokens;
}

export function applyCommandTemplate(value, replacements) {
  return String(value).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, key) => replacements[key] ?? '');
}

export function createHandoffExecutionCore(deps) {
  const {
    ask,
    codeBlock,
    commandAvailableFromRoot,
    handoffMaxReadBytes,
    isWindowsBatchFile,
    labelValue,
    managerMaxSubagentsSetting,
    numberOption,
    planHash,
    printBox,
    processInvocation,
    readGitDiffExcludingContext,
    readTextFileBounded,
    realDir,
    redactForLog,
    resolveAgentCommand,
    resolveCodexCommand,
    resolveWorkspaceFile,
    shellCommandPreview,
    statusLine,
    trimBytes
  } = deps;

  function buildExecutorCommand(args, root, planPath, planText) {
    const agent = String(args.agent ?? 'opencode').trim().toLowerCase();
    const model = String(args.model ?? process.env.CODEXPRO_AGENT_MODEL ?? '').trim();
    const subagentsRequested = args.subagents === true;
    const maxSubagents = subagentsRequested ? numberOption(args.maxSubagents ?? process.env.CODEXPRO_MAX_SUBAGENTS ?? managerMaxSubagentsSetting(), managerMaxSubagentsSetting(), 1, 1) : 0;
    const replacements = {
      model,
      plan_file: planPath,
      plan_text: planText,
      root
    };

    if (args.command) {
      const template = String(args.command);
      if (!/\{\{\s*(plan_file|plan_text)\s*\}\}/.test(template)) {
        throw new Error('Custom --command must include {{plan_file}} or {{plan_text}} so the agent receives the handoff.');
      }
      const parts = splitCommandTemplate(template).map((part) => applyCommandTemplate(part, replacements));
      const displayParts = splitCommandTemplate(template).map((part) => applyCommandTemplate(part, { ...replacements, plan_text: '<plan_text>' }));
      if (!parts.length) throw new Error('Custom --command is empty.');
      const command = resolveAgentCommand(parts[0]);
      if (isWindowsBatchFile(command) && /\{\{\s*plan_text\s*\}\}/.test(template)) {
        throw new Error('Windows .cmd/.bat adapters must use {{plan_file}} instead of {{plan_text}}.');
      }
      return { agent, model, command, args: parts.slice(1), displayArgs: displayParts.slice(1), custom: true };
    }

    const relativePlanPath = path.relative(root, planPath) || planPath;
    const basePlanPrompt = `Read the handoff plan at ${relativePlanPath} and execute it in this workspace.`;
    if (agent === 'opencode') {
      return {
        agent,
        model,
        subagentsRequested,
        maxSubagents,
        basePlanPrompt,
        command: resolveAgentCommand('opencode'),
        args: ['run', ...(model ? ['--model', model] : []), basePlanPrompt],
        displayArgs: ['run', ...(model ? ['--model', model] : []), `<read ${relativePlanPath}>`],
        custom: false
      };
    }
    if (agent === 'pi') {
      return {
        agent,
        model,
        subagentsRequested: false,
        command: resolveAgentCommand('pi'),
        args: [...(model ? ['--model', model] : []), '-p', basePlanPrompt],
        displayArgs: [...(model ? ['--model', model] : []), '-p', `<read ${relativePlanPath}>`],
        custom: false
      };
    }
    if (agent === 'codex') {
      const codexLastMessagePath = path.join(path.dirname(planPath), 'codex-last-message.md');
      const codexPrompt = [
        `Read the handoff plan at ${relativePlanPath} and execute it in this workspace.`,
        'Keep changes scoped to that plan.',
        'Do not modify .ai-bridge/current-plan.md.',
        'When finished, summarize changed files and verification.'
      ].join(' ');
      return {
        agent,
        model,
        subagentsRequested: false,
        command: resolveCodexCommand(),
        args: [
          'exec',
          '--ephemeral',
          '--sandbox',
          'workspace-write',
          '-c',
          'approval_policy="never"',
          '--output-last-message',
          codexLastMessagePath,
          ...(model ? ['--model', model] : []),
          codexPrompt
        ],
        displayArgs: [
          'exec',
          '--ephemeral',
          '--sandbox',
          'workspace-write',
          '-c',
          'approval_policy="never"',
          '--output-last-message',
          path.relative(root, codexLastMessagePath),
          ...(model ? ['--model', model] : []),
          `<read ${relativePlanPath}>`
        ],
        custom: false
      };
    }
    if (agent === 'custom') {
      throw new Error('Custom agent execution requires --command.');
    }
    throw new Error(`Unsupported --agent ${agent}. Use opencode, pi, codex, or custom with --command.`);
  }

  function executorCommandPreview(commandInfo) {
    return shellCommandPreview([commandInfo.command, ...(commandInfo.displayArgs ?? commandInfo.args)]);
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
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let closed = false;
      const appendBounded = (current, chunk) => {
        if (Buffer.byteLength(current, 'utf8') > retainedOutputBytes) return current;
        const next = current + String(chunk);
        const buffer = Buffer.from(next, 'utf8');
        return buffer.byteLength > retainedOutputBytes
          ? buffer.subarray(0, retainedOutputBytes).toString('utf8')
          : next;
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!closed) child.kill('SIGKILL');
        }, 1500).unref();
      }, timeoutMs);
      timer.unref();

      child.stdout.on('data', (chunk) => {
        stdout = appendBounded(stdout, chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr = appendBounded(stderr, chunk);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({
          exitCode: 127,
          signal: null,
          durationMs: Date.now() - started,
          timedOut,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          spawnError: true
        });
      });
      child.on('close', (exitCode, signal) => {
        closed = true;
        clearTimeout(timer);
        const out = trimBytes(stdout, maxOutputBytes);
        const err = trimBytes(`${stderr}${timedOut ? `\n[codexpro] Command timed out after ${timeoutMs} ms.` : ''}`, maxOutputBytes);
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

  function readGitStatus(root, maxBytes) {
    const result = spawnSync('git', ['status', '--short'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: Math.max(maxBytes * 2, 1_000_000),
      shell: false
    });
    if (result.status !== 0) {
      const reason = result.stderr || result.stdout || `git status exited ${result.status}`;
      return `# git status unavailable\n\n${redactForLog(reason).trim()}\n`;
    }
    const status = result.stdout || '';
    return status.trim() ? trimBytes(status, maxBytes).text : '';
  }

  function appendExecutionTelemetry(root, contextDir, events) {
    if (!Array.isArray(events) || !events.length) return;
    const logPath = resolveWorkspaceFile(root, path.join(contextDir, 'execution-log.jsonl'));
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    for (const event of events) fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }

  function writeExecutionOutputs(root, contextDir, commandInfo, result, diffText, gitStatusText) {
    const bridgeDir = resolveWorkspaceFile(root, contextDir);
    fs.mkdirSync(bridgeDir, { recursive: true, mode: 0o700 });
    const statusPath = resolveWorkspaceFile(root, path.join(contextDir, 'agent-status.md'));
    const diffPath = resolveWorkspaceFile(root, path.join(contextDir, 'implementation-diff.patch'));
    const logPath = resolveWorkspaceFile(root, path.join(contextDir, 'execution-log.jsonl'));
    const commandText = executorCommandPreview(commandInfo);
    const status = [
      '# Agent Execution Status',
      '',
      `Updated: ${new Date().toISOString()}`,
      `Agent: ${commandInfo.agent}`,
      commandInfo.model ? `Model: ${commandInfo.model}` : '',
      commandInfo.subagentRun?.requested ? 'Subagents requested: yes' : '',
      commandInfo.subagentRun?.requested ? `Subagent cap: ${commandInfo.maxSubagents || 1}` : '',
      commandInfo.subagentRun?.requested ? `Explore verified: ${commandInfo.subagentRun.verified ? 'yes' : 'no'}` : '',
      commandInfo.subagentRun?.fallbackReason ? `Explore fallback: ${commandInfo.subagentRun.fallbackReason}` : '',
      commandInfo.subagentRun?.childSessionId ? `Explore child session: ${commandInfo.subagentRun.childSessionId}` : '',
      commandInfo.subagentRun?.filesInspected?.length ? `Files inspected by explore child: ${commandInfo.subagentRun.filesInspected.join(', ')}` : '',
      commandInfo.scoutRun?.requested ? `Gemini scout verified: ${commandInfo.scoutRun.verified ? 'yes' : 'no'}` : '',
      commandInfo.scoutRun?.childModel ? `Gemini scout model: ${commandInfo.scoutRun.childModel}` : '',
      commandInfo.scoutRun?.fallbackReason && commandInfo.scoutRun?.requested ? `Gemini scout fallback: ${commandInfo.scoutRun.fallbackReason}` : '',
      commandInfo.scoutRun?.childSessionId ? `Gemini scout child session: ${commandInfo.scoutRun.childSessionId}` : '',
      `Command: ${commandText}`,
      `Exit code: ${result.exitCode ?? 'null'}`,
      result.signal ? `Signal: ${result.signal}` : '',
      `Timed out: ${result.timedOut ? 'yes' : 'no'}`,
      `Duration: ${result.durationMs} ms`,
      `Diff path: ${path.posix.join(contextDir, 'implementation-diff.patch')}`,
      `Execution log: ${path.posix.join(contextDir, 'execution-log.jsonl')}`,
      '',
      codeBlock('Git status excerpt', gitStatusText),
      '',
      codeBlock('Stdout excerpt', result.stdout),
      codeBlock('Stderr excerpt', result.stderr)
    ].filter(Boolean).join('\n');
    fs.writeFileSync(statusPath, status, { mode: 0o600 });
    fs.writeFileSync(diffPath, diffText || '', { mode: 0o600 });
    const logEvent = {
      ts: new Date().toISOString(),
      event: 'execute_handoff',
      agent: commandInfo.agent,
      model: commandInfo.model || undefined,
      max_subagents: commandInfo.maxSubagents || 0,
      subagents_requested: Boolean(commandInfo.subagentRun?.requested),
      subagent_verified: Boolean(commandInfo.subagentRun?.verified),
      subagent_fallback: commandInfo.subagentRun?.fallbackReason || undefined,
      child_session_id: commandInfo.subagentRun?.childSessionId || undefined,
      files_inspected: commandInfo.subagentRun?.filesInspected?.length ? commandInfo.subagentRun.filesInspected : undefined,
      scout_requested: Boolean(commandInfo.scoutRun?.requested),
      scout_verified: Boolean(commandInfo.scoutRun?.verified),
      scout_model: commandInfo.scoutRun?.childModel || undefined,
      scout_fallback: commandInfo.scoutRun?.requested ? commandInfo.scoutRun?.fallbackReason || undefined : undefined,
      scout_child_session_id: commandInfo.scoutRun?.childSessionId || undefined,
      command: commandText,
      exit_code: result.exitCode,
      signal: result.signal,
      timed_out: result.timedOut,
      duration_ms: result.durationMs,
      stdout_excerpt: result.stdout,
      stderr_excerpt: result.stderr,
      git_status_excerpt: gitStatusText || undefined,
      diff_path: path.posix.join(contextDir, 'implementation-diff.patch'),
      status_path: path.posix.join(contextDir, 'agent-status.md')
    };
    fs.appendFileSync(logPath, `${JSON.stringify(logEvent)}\n`, { mode: 0o600 });
    return { statusPath, diffPath, logPath };
  }

  function handoffRunStatePath(root, contextDir) {
    return resolveWorkspaceFile(root, path.posix.join(contextDir, 'handoff-run-state.json'));
  }

  function writeHandoffRunState(root, contextDir, state) {
    const statePath = handoffRunStatePath(root, contextDir);
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    const payload = { version: 1, updated_at: new Date().toISOString(), ...state };
    fs.writeFileSync(statePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  }

  async function confirmLocalExecution(args, root, commandInfo) {
    if (args.yes) return true;
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('Use --yes to execute a local handoff in non-interactive shells, or use --dry-run to preview.');
    }
    printBox('Confirm local execution', [
      labelValue('Workspace', root),
      labelValue('Agent', commandInfo.agent),
      ...(commandInfo.model ? [labelValue('Model', commandInfo.model)] : []),
      labelValue('Command', executorCommandPreview(commandInfo)),
      'This runs a local process in the workspace. CodexPro will collect status, logs, and git diff into .ai-bridge.'
    ]);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await ask(rl, 'Run this local agent now?', 'no');
      return ['y', 'yes'].includes(answer.trim().toLowerCase());
    } finally {
      rl.close();
    }
  }

  function loadHandoffExecution(args) {
    const root = realDir(args.root ?? process.env.CODEXPRO_ROOT ?? process.cwd());
    const contextDir = contextDirFromArgs(args);
    const bridgeDir = resolveWorkspaceFile(root, contextDir);
    const planPath = resolveWorkspaceFile(root, path.join(contextDir, 'current-plan.md'));
    const maxReadBytes = handoffMaxReadBytes();
    const maxOutputBytes = numberOption(args.maxOutputBytes ?? process.env.CODEXPRO_MAX_OUTPUT_BYTES, 120_000, 4_000, 2_000_000);
    const timeoutMs = numberOption(args.timeoutMs ?? args.timeout, 600_000, 1_000, 24 * 60 * 60_000);
    if (!fs.existsSync(planPath)) {
      throw new Error(`No handoff plan found at ${path.relative(root, planPath)}. Ask ChatGPT to call handoff_to_agent first.`);
    }
    const planText = readTextFileBounded(planPath, maxReadBytes);
    const commandInfo = buildExecutorCommand(args, root, planPath, planText);
    const commandText = executorCommandPreview(commandInfo);
    return {
      root,
      contextDir,
      bridgeDir,
      planPath,
      planText,
      commandInfo,
      commandText,
      maxOutputBytes,
      timeoutMs
    };
  }

  function printHandoffDryRun(request, title = 'CodexPro execute-handoff dry run') {
    printBox(title, [
      labelValue('Workspace', request.root),
      labelValue('Plan', path.relative(request.root, request.planPath)),
      labelValue('Agent', request.commandInfo.agent),
      ...(request.commandInfo.model ? [labelValue('Model', request.commandInfo.model)] : []),
      ...(request.commandInfo.subagentsRequested ? [labelValue('Subagents', `requested; max=${request.commandInfo.maxSubagents}; runtime Task/child-session verification deferred until execution`)] : []),
      labelValue('Command', request.commandText),
      'No command was executed and no .ai-bridge result files were changed.'
    ]);
  }

  async function executeHandoffRequest(request, args, options = {}) {
    const confirmed = options.skipConfirmation ? true : await confirmLocalExecution(args, request.root, request.commandInfo);
    if (!confirmed) {
      statusLine('warn', 'Execution cancelled.');
      return { cancelled: true, result: null, outputs: null };
    }

    if (!commandAvailableFromRoot(request.commandInfo.command, request.root)) {
      throw new Error(`${request.commandInfo.command} was not found. Install it, add it to PATH, pass an absolute path, or use --command.`);
    }

    const iteration = Number.isFinite(options.iteration) ? options.iteration : 1;
    const runPlanHash = planHash(request.planText);
    const startedAt = new Date().toISOString();
    writeHandoffRunState(request.root, request.contextDir, {
      state: 'running',
      iteration,
      started_at: startedAt,
      finished_at: null,
      plan_hash: runPlanHash,
      executor: request.commandInfo.agent,
      model: request.commandInfo.model || undefined,
      subagents_requested: Boolean(request.commandInfo.subagentsRequested),
      max_subagents: request.commandInfo.maxSubagents || 0,
      pid: process.pid
    });

    let subagentRun = { requested: false, verified: false, fallbackReason: '', events: [] };
    let scoutRun = { requested: false, verified: false, fallbackReason: '', events: [] };
    let subagentAttempts = 0;
    if (request.commandInfo.agent === 'opencode' && request.commandInfo.subagentsRequested) {
      const openCodeConfigDir = path.join(projectRoot, '.opencode');
      statusLine('wait', `Verifying OpenCode Task delegation through ${CODEXPRO_EXPLORE_AGENT} (max subagents=${request.commandInfo.maxSubagents})...`);
      subagentRun = await runVerifiedOpenCodeInvestigation({
        command: request.commandInfo.command,
        root: request.root,
        planText: request.planText,
        model: request.commandInfo.model,
        configDir: openCodeConfigDir,
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes
      });
      subagentAttempts += 1;
      appendExecutionTelemetry(request.root, request.contextDir, subagentRun.events);
      if (subagentRun.verified) statusLine('ok', `Verified child session ${subagentRun.childSessionId} from ${CODEXPRO_EXPLORE_AGENT}.`);
      else statusLine('warn', `Repository explore unavailable; continuing without child evidence: ${subagentRun.fallbackReason}`);

      if (subagentAttempts < request.commandInfo.maxSubagents) {
        scoutRun = await runVerifiedGeminiScout({
          command: request.commandInfo.command,
          root: request.root,
          planText: request.planText,
          model: request.commandInfo.model,
          configDir: openCodeConfigDir,
          timeoutMs: request.timeoutMs,
          maxOutputBytes: request.maxOutputBytes
        });
        if (scoutRun.requested) subagentAttempts += 1;
        appendExecutionTelemetry(request.root, request.contextDir, scoutRun.events);
        if (scoutRun.verified) statusLine('ok', `Verified ${GEMINI_SCOUT_AGENT} child ${scoutRun.childSessionId} using ${scoutRun.childModel}.`);
        else if (scoutRun.requested) statusLine('warn', `Gemini scout unavailable; continuing without external scout evidence: ${scoutRun.fallbackReason}`);
      } else {
        const limitEvent = {
          ts: new Date().toISOString(),
          event: 'subagent_limit_reached',
          max_subagents: request.commandInfo.maxSubagents,
          attempts_used: subagentAttempts,
          skipped_agent: GEMINI_SCOUT_AGENT
        };
        scoutRun = { requested: false, verified: false, skipped: true, fallbackReason: `subagent limit ${request.commandInfo.maxSubagents} reached`, events: [limitEvent] };
        appendExecutionTelemetry(request.root, request.contextDir, scoutRun.events);
        statusLine('warn', `Subagent cap reached (${subagentAttempts}/${request.commandInfo.maxSubagents}); ${GEMINI_SCOUT_AGENT} skipped.`);
      }
    }

    let effectiveCommandInfo = { ...request.commandInfo, subagentRun, scoutRun };
    if ((subagentRun.verified || scoutRun.verified) && request.commandInfo.agent === 'opencode') {
      const prompt = executorPromptWithInvestigation(request.commandInfo.basePlanPrompt, [subagentRun, scoutRun]);
      effectiveCommandInfo = {
        ...effectiveCommandInfo,
        args: buildOpenCodeExecutorArgs(request.commandInfo.model, prompt),
        displayArgs: ['run', ...(request.commandInfo.model ? ['--model', request.commandInfo.model] : []), '<read handoff + verified child evidence>']
      };
    }
    const effectiveCommandText = executorCommandPreview(effectiveCommandInfo);
    statusLine('wait', `Running ${effectiveCommandInfo.agent}: ${effectiveCommandText}`);
    const result = await runProcessCaptured(effectiveCommandInfo.command, effectiveCommandInfo.args, {
      cwd: request.root,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes
    });
    const diffText = readGitDiffExcludingContext(request.root, request.contextDir, request.maxOutputBytes);
    const gitStatusText = readGitStatus(request.root, request.maxOutputBytes);
    const outputs = writeExecutionOutputs(request.root, request.contextDir, effectiveCommandInfo, result, diffText, gitStatusText);

    const runState = result.timedOut ? 'timed_out' : (result.exitCode === 0 ? 'completed' : 'failed');
    const testsAbsPath = path.join(request.bridgeDir, 'loop-tests.txt');
    writeHandoffRunState(request.root, request.contextDir, {
      state: runState,
      iteration,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      plan_hash: runPlanHash,
      executor: effectiveCommandInfo.agent,
      model: effectiveCommandInfo.model || undefined,
      max_subagents: effectiveCommandInfo.maxSubagents || 0,
      subagent_attempts: subagentAttempts,
      subagents_requested: Boolean(subagentRun.requested),
      subagent_verified: Boolean(subagentRun.verified),
      subagent_fallback: subagentRun.fallbackReason || undefined,
      child_session_id: subagentRun.childSessionId || undefined,
      files_inspected: subagentRun.filesInspected?.length ? subagentRun.filesInspected : undefined,
      scout_requested: Boolean(scoutRun.requested),
      scout_verified: Boolean(scoutRun.verified),
      scout_model: scoutRun.childModel || undefined,
      scout_fallback: scoutRun.requested ? scoutRun.fallbackReason || undefined : undefined,
      scout_child_session_id: scoutRun.childSessionId || undefined,
      exit_code: result.exitCode ?? null,
      timed_out: Boolean(result.timedOut),
      duration_ms: result.durationMs,
      status_file: path.posix.join(request.contextDir, 'agent-status.md'),
      diff_file: path.posix.join(request.contextDir, 'implementation-diff.patch'),
      log_file: path.posix.join(request.contextDir, 'execution-log.jsonl'),
      ...(fs.existsSync(testsAbsPath) ? { tests_file: path.posix.join(request.contextDir, 'loop-tests.txt') } : {})
    });
    statusLine(result.exitCode === 0 ? 'ok' : 'warn', `Agent exited with code ${result.exitCode ?? 'null'}${result.signal ? ` signal=${result.signal}` : ''}`);
    console.log(`Status: ${path.relative(request.root, outputs.statusPath)}`);
    console.log(`Diff:   ${path.relative(request.root, outputs.diffPath)}`);
    console.log(`Log:    ${path.relative(request.root, outputs.logPath)}`);
    return { cancelled: false, result, outputs, subagentRun, scoutRun };
  }

  return {
    buildExecutorCommand,
    executeHandoffRequest,
    executorCommandPreview,
    loadHandoffExecution,
    printHandoffDryRun,
    runProcessCaptured,
    writeExecutionOutputs
  };
}
