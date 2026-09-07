import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { CODEXPRO_AUDITOR_AGENT } from './opencode-subagents.mjs';
import {
  inspectCodexProAuditorCapability,
  runCodexProNativeAudit
} from './opencode-subagent-runner.mjs';
import {
  applyCommandTemplate,
  contextDirFromArgs,
  createHandoffExecutionCore,
  splitCommandTemplate
} from './handoff-execution.mjs';
const UNTRACKED_FILE_HASH_BYTES = 64 * 1024;
const UNTRACKED_SYMLINK_TARGET_BYTES = 512;

export function createHandoffRuntimeLauncher(dependencies) {
  const {
    projectRoot,
    parseArgs,
    usage,
    realDir,
    numberOption,
    shellCommandPreview,
    redactForLog,
    managerMaxSubagentsSetting,
    resolveAgentCommand,
    resolveCodexCommand,
    isWindowsBatchFile,
    processInvocation,
    commandAvailableFromRoot,
    statusLine,
    printBox,
    labelValue,
    ask,
    sleep
  } = dependencies;

function isSubpath(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveWorkspaceFile(root, relativePath) {
  const absPath = path.resolve(root, relativePath);
  if (!isSubpath(absPath, root)) {
    throw new Error(`Path escapes workspace root: ${relativePath}`);
  }
  const relative = path.relative(root, absPath);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`Symlink paths are not allowed for local handoff files: ${relativePath}`);
      }
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') break;
      throw error;
    }
  }
  return absPath;
}

function readTextFileBounded(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
  if (stat.size > maxBytes) throw new Error(`File is too large (${stat.size} bytes). Limit: ${maxBytes} bytes.`);
  const sample = fs.readFileSync(filePath, { encoding: null });
  if (sample.includes(0)) throw new Error(`Refusing to read binary file: ${filePath}`);
  return sample.toString('utf8');
}

function handoffMaxReadBytes() {
  return numberOption(process.env.CODEXPRO_MAX_READ_BYTES, 180_000, 4_000, 2_000_000);
}

function trimBytes(value, maxBytes) {
  const redacted = redactForLog(value);
  const buffer = Buffer.from(redacted, 'utf8');
  if (buffer.byteLength <= maxBytes) return { text: redacted, truncated: false };
  return {
    text: `${buffer.subarray(0, maxBytes).toString('utf8')}\n...[output truncated to ${maxBytes} bytes]`,
    truncated: true
  };
}

function codeBlock(label, value) {
  return `## ${label}\n\n\`\`\`text\n${String(value || '').replace(/```/g, '`\\`\\`') || '(empty)'}\n\`\`\`\n`;
}

const {
  executeHandoffRequest,
  loadHandoffExecution,
  printHandoffDryRun,
  runProcessCaptured
} = createHandoffExecutionCore({
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
});
async function runExecuteHandoff(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return;
  }
  const request = loadHandoffExecution(args);

  if (args.dryRun) {
    printHandoffDryRun(request);
    return;
  }

  const execution = await executeHandoffRequest(request, args);
  if (execution.result && execution.result.exitCode !== 0) process.exitCode = execution.result.exitCode ?? 1;
}

function planHash(planText) {
  return createHash('sha256').update(planText).digest('hex');
}

function isScaffoldedHandoffPlan(planText) {
  return String(planText).trim() === '# Current Plan\n\nNo plan written yet.';
}

function readWatchState(statePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeWatchState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function appendBridgeLog(root, contextDir, event) {
  const bridgeDir = resolveWorkspaceFile(root, contextDir);
  fs.mkdirSync(bridgeDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(bridgeDir, 'execution-log.jsonl');
  fs.appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
}

async function waitForStablePlan(planPath, debounceMs) {
  try {
    const before = fs.statSync(planPath);
    await sleep(debounceMs);
    const after = fs.statSync(planPath);
    return before.isFile() && after.isFile() && before.size === after.size && before.mtimeMs === after.mtimeMs;
  } catch {
    return false;
  }
}

async function confirmWatchHandoff(args, root) {
  if (args.yes || args.noConfirm) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Use --yes to start watch-handoff in non-interactive shells.');
  }
  printBox('Confirm handoff watcher', [
    labelValue('Workspace', root),
    labelValue('Agent', args.agent ?? 'opencode'),
    ...(args.model ? [labelValue('Model', args.model)] : []),
    'This starts a local-only watcher. Each new .ai-bridge/current-plan.md hash runs through the configured local agent.',
    'ChatGPT only writes the handoff plan; this terminal-owned process performs execution.'
  ]);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await ask(rl, 'Start automatic local handoff execution?', 'no');
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

async function runWatchHandoff(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return;
  }
  const root = realDir(args.root ?? process.env.CODEXPRO_ROOT ?? process.cwd());
  const contextDir = contextDirFromArgs(args);
  const bridgeDir = resolveWorkspaceFile(root, contextDir);
  const planPath = path.join(bridgeDir, 'current-plan.md');
  const statePath = resolveWorkspaceFile(root, args.stateFile ?? path.posix.join(contextDir, 'watch-handoff-state.json'));
  const pollIntervalMs = numberOption(args.pollIntervalMs ?? args.pollInterval, 2000, 250, 60_000);
  const debounceMs = numberOption(args.debounceMs, 500, 0, 30_000);
  let state = readWatchState(statePath);
  let lastDryRunHash = state.lastPlanHash ?? '';
  let lastSkippedHash = '';
  let stopped = false;

  if (!args.dryRun) {
    const approved = await confirmWatchHandoff(args, root);
    if (!approved) {
      statusLine('warn', 'Watcher cancelled.');
      return;
    }
  }

  printBox('CodexPro watch-handoff', [
    labelValue('Workspace', root),
    labelValue('Plan', path.relative(root, planPath)),
    labelValue('State', path.relative(root, statePath)),
    labelValue('Agent', args.agent ?? 'opencode'),
    ...(args.model ? [labelValue('Model', args.model)] : []),
    labelValue('Poll', `${pollIntervalMs} ms`),
    labelValue('Debounce', `${debounceMs} ms`),
    args.once ? 'Mode: check once and exit.' : 'Mode: watching until Ctrl+C.'
  ]);

  const stop = () => {
    stopped = true;
    statusLine('warn', 'Stopping handoff watcher...');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  while (!stopped) {
    if (!fs.existsSync(planPath)) {
      if (args.once) throw new Error(`No handoff plan found at ${path.relative(root, planPath)}.`);
      await sleep(pollIntervalMs);
      continue;
    }

    const stable = await waitForStablePlan(planPath, debounceMs);
    if (!stable) {
      if (args.once) throw new Error(`Handoff plan did not become stable at ${path.relative(root, planPath)}.`);
      await sleep(pollIntervalMs);
      continue;
    }

    const request = loadHandoffExecution({ ...args, root, contextDir });
    const currentHash = planHash(request.planText);
    if (isScaffoldedHandoffPlan(request.planText)) {
      if (lastSkippedHash !== currentHash) statusLine('wait', 'Ignoring scaffolded empty handoff plan.');
      lastSkippedHash = currentHash;
      if (args.once) return;
      await sleep(pollIntervalMs);
      continue;
    }
    if (state.lastPlanHash === currentHash || lastDryRunHash === currentHash) {
      statusLine(args.once ? 'ok' : 'wait', `No new handoff plan: ${currentHash.slice(0, 12)}`);
      if (args.once) return;
      await sleep(pollIntervalMs);
      continue;
    }

    if (args.dryRun) {
      printHandoffDryRun(request, 'CodexPro watch-handoff dry run');
      lastDryRunHash = currentHash;
      if (args.once) return;
      await sleep(pollIntervalMs);
      continue;
    }

    appendBridgeLog(root, contextDir, {
      event: 'watch_handoff_started',
      plan_hash: currentHash,
      agent: request.commandInfo.agent,
      model: request.commandInfo.model || undefined,
      plan_path: path.posix.join(contextDir, 'current-plan.md')
    });

    const execution = await executeHandoffRequest(request, { ...args, yes: true }, { skipConfirmation: true });
    const exitCode = execution.result?.exitCode ?? null;
    state = {
      lastPlanHash: currentHash,
      lastRanAt: new Date().toISOString(),
      agent: request.commandInfo.agent,
      model: request.commandInfo.model || undefined,
      exitCode,
      planPath: path.posix.join(contextDir, 'current-plan.md')
    };
    writeWatchState(statePath, state);
    appendBridgeLog(root, contextDir, {
      event: 'watch_handoff_finished',
      plan_hash: currentHash,
      agent: request.commandInfo.agent,
      model: request.commandInfo.model || undefined,
      exit_code: exitCode,
      status_path: path.posix.join(contextDir, 'agent-status.md'),
      diff_path: path.posix.join(contextDir, 'implementation-diff.patch')
    });

    if (args.once) {
      if (execution.result && execution.result.exitCode !== 0) process.exitCode = execution.result.exitCode ?? 1;
      return;
    }

    await sleep(pollIntervalMs);
  }
}

function loopArtifactPaths(root, contextDir) {
  const bridgeDir = resolveWorkspaceFile(root, contextDir);
  return {
    bridgeDir,
    planPath: path.join(bridgeDir, 'current-plan.md'),
    statusPath: path.join(bridgeDir, 'agent-status.md'),
    diffPath: path.join(bridgeDir, 'implementation-diff.patch'),
    logPath: path.join(bridgeDir, 'execution-log.jsonl'),
    testsPath: path.join(bridgeDir, 'loop-tests.txt'),
    reviewPath: path.join(bridgeDir, 'loop-review.md'),
    targetPath: path.join(bridgeDir, 'loop-target-plan.md'),
    statePath: path.join(bridgeDir, 'loop-handoff-state.json')
  };
}

function buildTemplateCommand(template, replacements, displayReplacements, label) {
  const parts = splitCommandTemplate(template).map((part) => applyCommandTemplate(part, replacements));
  const displayParts = splitCommandTemplate(template).map((part) => applyCommandTemplate(part, displayReplacements ?? replacements));
  if (!parts.length) throw new Error(`${label} command is empty.`);
  return {
    command: parts[0],
    args: parts.slice(1),
    displayArgs: displayParts.slice(1),
    displayCommand: shellCommandPreview([displayParts[0], ...displayParts.slice(1)])
  };
}

function loopTemplateReplacements(root, contextDir, iteration, paths) {
  return {
    root,
    context_dir: resolveWorkspaceFile(root, contextDir),
    iteration: String(iteration),
    plan_file: paths.planPath,
    status_file: paths.statusPath,
    diff_file: paths.diffPath,
    log_file: paths.logPath,
    tests_file: paths.testsPath,
    review_file: paths.reviewPath,
    target_file: paths.targetPath,
    state_file: paths.statePath
  };
}

function buildReviewerCommand(args, root, contextDir, iteration, paths) {
  const template = String(args.reviewCommand ?? '').trim();
  if (!template) return null;
  const replacements = loopTemplateReplacements(root, contextDir, iteration, paths);
  return buildTemplateCommand(template, replacements, replacements, 'Review');
}

function buildTestCommand(args, root, contextDir, iteration, paths) {
  const template = String(args.runTests ?? '').trim();
  if (!template) return null;
  const replacements = loopTemplateReplacements(root, contextDir, iteration, paths);
  return buildTemplateCommand(template, replacements, replacements, 'Test');
}

function commandDisplay(commandInfo) {
  return shellCommandPreview([commandInfo.command, ...(commandInfo.displayArgs ?? commandInfo.args)]);
}

function gitStatusPorcelain(root, maxBytes = 1_000_000) {
  return runGitText(root, ['status', '--porcelain=v1', '--untracked-files=all', '--', '.'], maxBytes);
}

function normalizedContextDir(contextDir) {
  return String(contextDir || '.ai-bridge').replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '');
}

function normalizeStatusPath(value) {
  return String(value || '').replace(/^"|"$/g, '').replace(/\\"/g, '"');
}

function toPosixPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function statusLinePaths(line) {
  const value = String(line || '').slice(3).trim();
  const renameIndex = value.indexOf(' -> ');
  if (renameIndex < 0) return [normalizeStatusPath(value)];
  return [
    normalizeStatusPath(value.slice(0, renameIndex)),
    normalizeStatusPath(value.slice(renameIndex + 4))
  ];
}

function gitWorkspacePrefix(root) {
  const topLevel = runGitText(root, ['rev-parse', '--show-toplevel'], 100_000).trim();
  return toPosixPath(path.relative(topLevel, root)).replace(/\/+$/, '');
}

function workspacePathFromGitPath(filePath, workspacePrefix) {
  const normalized = toPosixPath(filePath).replace(/^\.?\//, '');
  const prefix = toPosixPath(workspacePrefix).replace(/\/+$/, '');
  if (!prefix) return normalized;
  if (normalized === prefix) return '';
  if (normalized.startsWith(`${prefix}/`)) return normalized.slice(prefix.length + 1);
  return null;
}

function statusLineWorkspacePaths(line, workspacePrefix) {
  return statusLinePaths(line)
    .map((filePath) => workspacePathFromGitPath(filePath, workspacePrefix))
    .filter((filePath) => filePath !== null && filePath !== '');
}

function workspaceStatusLine(line, workspacePaths) {
  return `${String(line || '').slice(0, 3)}${workspacePaths.join(' -> ')}`;
}

function isContextStatusLine(line, contextDir, workspacePrefix = '') {
  const context = normalizedContextDir(contextDir);
  const paths = statusLineWorkspacePaths(line, workspacePrefix);
  return paths.length > 0 && paths.every((filePath) => filePath === context || filePath.startsWith(`${context}/`));
}

function assertCleanGitStart(root, contextDir) {
  const status = gitStatusPorcelain(root);
  const workspacePrefix = gitWorkspacePrefix(root);
  const nonContextStatus = status.split(/\r?\n/).map((line) => {
    if (!line.trim()) return '';
    const paths = statusLineWorkspacePaths(line, workspacePrefix);
    if (!paths.length || paths.every(contextPathPredicate(contextDir))) return '';
    return workspaceStatusLine(line, paths);
  }).filter(Boolean).join('\n');
  if (nonContextStatus.trim()) {
    throw new Error(`--require-clean-git-start refused to start because the workspace has non-handoff changes:\n${nonContextStatus}`);
  }
}

function runGitText(root, args, maxBytes) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: Math.max(maxBytes * 2, 1_000_000),
    shell: false
  });
  if (result.status !== 0) {
    const reason = result.stderr || result.stdout || `git ${args.join(' ')} exited ${result.status}`;
    throw new Error(redactForLog(reason).trim());
  }
  return result.stdout || '';
}

function singleLineSummary(value) {
  return String(value).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

function fileSha256(filePath) {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function boundedFileFingerprint(filePath, stat) {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  let remaining = Math.min(stat.size, UNTRACKED_FILE_HASH_BYTES);
  try {
    while (remaining > 0) {
      const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      remaining -= bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }
  const hashLabel = stat.size > UNTRACKED_FILE_HASH_BYTES ? `sha256_first_${UNTRACKED_FILE_HASH_BYTES}` : 'sha256';
  const truncated = stat.size > UNTRACKED_FILE_HASH_BYTES ? ', fingerprint_truncated=true' : '';
  return `${stat.size} bytes, ${hashLabel}=${hash.digest('hex')}${truncated}`;
}

function untrackedEntrySummary(root, relPath) {
  const absPath = path.resolve(root, relPath);
  try {
    const stat = fs.lstatSync(absPath);
    if (stat.isSymbolicLink()) {
      const target = singleLineSummary(trimBytes(fs.readlinkSync(absPath), UNTRACKED_SYMLINK_TARGET_BYTES).text);
      return `- ${relPath} (symlink, target=${target})`;
    }
    if (!stat.isFile()) return `- ${relPath} (${stat.isDirectory() ? 'directory' : 'non-file'})`;
    return `- ${relPath} (${boundedFileFingerprint(absPath, stat)})`;
  } catch (error) {
    return `- ${relPath} (unavailable: ${singleLineSummary(redactForLog(error instanceof Error ? error.message : String(error)))})`;
  }
}

function untrackedFilesSummary(root, contextDir, maxBytes) {
  const context = normalizedContextDir(contextDir);
  const output = runGitText(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'], 1_000_000);
  const entries = output.split('\0').filter(Boolean).filter((relPath) => relPath !== context && !relPath.startsWith(`${context}/`));
  if (!entries.length) return '';
  const lines = [];
  let usedBytes = 0;
  let omitted = 0;
  const budget = Math.max(1_024, maxBytes);
  for (const relPath of entries.sort()) {
    const line = untrackedEntrySummary(root, relPath);
    const lineBytes = Buffer.byteLength(`${line}\n`, 'utf8');
    if (usedBytes + lineBytes > budget) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    usedBytes += lineBytes;
  }
  if (omitted) lines.push(`- ... ${omitted} untracked entries omitted after ${budget} bytes`);
  return `${lines.join('\n')}\n`;
}

function contextPathPredicate(contextDir) {
  const context = normalizedContextDir(contextDir);
  return (filePath) => filePath === context || filePath.startsWith(`${context}/`);
}

function pathStateForFingerprint(root, relPath, options = {}) {
  const absPath = path.resolve(root, relPath);
  try {
    const stat = fs.lstatSync(absPath);
    const type = stat.isSymbolicLink()
      ? 'symlink'
      : stat.isFile()
        ? 'file'
        : stat.isDirectory()
          ? 'directory'
          : 'non-file';
    const parts = [
      `type=${type}`,
      `mode=${stat.mode}`,
      `size=${stat.size}`
    ];
    if (stat.isSymbolicLink()) parts.push(`target=${singleLineSummary(fs.readlinkSync(absPath))}`);
    if (stat.isFile()) {
      parts.push(options.fullFileHash ? `sha256=${fileSha256(absPath)}` : boundedFileFingerprint(absPath, stat));
    }
    return parts.join(';');
  } catch (error) {
    return `unavailable:${singleLineSummary(redactForLog(error instanceof Error ? error.message : String(error)))}`;
  }
}

function changeFingerprintExcludingContext(root, contextDir) {
  const context = normalizedContextDir(contextDir);
  const isContextPath = contextPathPredicate(contextDir);
  const workspacePrefix = gitWorkspacePrefix(root);
  const status = gitStatusPorcelain(root, 25_000_000);
  const stagedRaw = runGitText(root, ['diff', '--cached', '--raw', '-z', '--no-ext-diff', '--', '.', `:(exclude)${context}`], 25_000_000);
  const hash = createHash('sha256');
  hash.update(`staged-raw\0${stagedRaw}\0`);
  for (const line of status.split(/\r?\n/).filter(Boolean).sort()) {
    const paths = statusLineWorkspacePaths(line, workspacePrefix);
    if (!paths.length) continue;
    if (paths.length && paths.every(isContextPath)) continue;
    hash.update(`status\0${workspaceStatusLine(line, paths)}\0`);
    const fullFileHash = !line.startsWith('?? ');
    for (const filePath of paths) {
      hash.update(`path\0${filePath}\0${pathStateForFingerprint(root, filePath, { fullFileHash })}\0`);
    }
  }
  return hash.digest('hex');
}

function readGitDiffExcludingContext(root, contextDir, maxBytes) {
  const context = normalizedContextDir(contextDir);
  try {
    const staged = runGitText(root, ['diff', '--cached', '--no-ext-diff', '--', '.', `:(exclude)${context}`], maxBytes);
    const unstaged = runGitText(root, ['diff', '--no-ext-diff', '--', '.', `:(exclude)${context}`], maxBytes);
    const untracked = untrackedFilesSummary(root, contextDir, maxBytes);
    const sections = [];
    if (staged.trim()) sections.push(`# Staged diff\n\n${staged}`);
    if (unstaged.trim()) sections.push(`# Unstaged diff\n\n${unstaged}`);
    if (untracked.trim()) sections.push(`# Untracked files\n\n${untracked}`);
    if (!sections.length) return '';
    return trimBytes(sections.join('\n\n'), maxBytes).text;
  } catch (error) {
    return `# git changes unavailable\n\n${error instanceof Error ? error.message : String(error)}\n`;
  }
}

function writeLoopTestOutput(paths, result, commandText) {
  fs.mkdirSync(paths.bridgeDir, { recursive: true, mode: 0o700 });
  const content = [
    '# Loop Test Output',
    '',
    `Updated: ${new Date().toISOString()}`,
    `Command: ${commandText}`,
    `Exit code: ${result.exitCode ?? 'null'}`,
    result.signal ? `Signal: ${result.signal}` : '',
    `Timed out: ${result.timedOut ? 'yes' : 'no'}`,
    `Duration: ${result.durationMs} ms`,
    '',
    codeBlock('Stdout excerpt', result.stdout),
    codeBlock('Stderr excerpt', result.stderr)
  ].filter(Boolean).join('\n');
  fs.writeFileSync(paths.testsPath, content, { mode: 0o600 });
}

function explicitReviewVerdict(text) {
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const assignment = line.match(/^CODEXPRO_REVIEW\s*=\s*(PASS|FAIL)\b/i);
    if (assignment) return assignment[1].toUpperCase();
  }
  return '';
}

function writeLoopReviewOutput(paths, result, commandText, verdict, nextPlanChanged) {
  fs.mkdirSync(paths.bridgeDir, { recursive: true, mode: 0o700 });
  const content = [
    '# Loop Review',
    '',
    `Updated: ${new Date().toISOString()}`,
    `Command: ${commandText}`,
    `Verdict: ${verdict || 'unknown'}`,
    `Next plan changed: ${nextPlanChanged ? 'yes' : 'no'}`,
    `Exit code: ${result.exitCode ?? 'null'}`,
    result.signal ? `Signal: ${result.signal}` : '',
    `Timed out: ${result.timedOut ? 'yes' : 'no'}`,
    `Duration: ${result.durationMs} ms`,
    '',
    codeBlock('Stdout excerpt', result.stdout),
    codeBlock('Stderr excerpt', result.stderr)
  ].filter(Boolean).join('\n');
  fs.writeFileSync(paths.reviewPath, content, { mode: 0o600 });
}

function writeNativeAuditOutput(paths, audit, iteration, nextPlanChanged) {
  fs.mkdirSync(paths.bridgeDir, { recursive: true, mode: 0o700 });
  const content = [
    '# CodexPro Native Audit',
    '',
    `Updated: ${new Date().toISOString()}`,
    `Iteration: ${iteration}`,
    `Auditor: ${CODEXPRO_AUDITOR_AGENT}`,
    audit.model ? `Model: ${audit.model}` : '',
    audit.sessionId ? `Audit session: ${audit.sessionId}` : '',
    `Verdict: ${audit.verdict || 'unknown'}`,
    audit.summary ? `Summary: ${audit.summary}` : '',
    `Next plan changed: ${nextPlanChanged ? 'yes' : 'no'}`,
    audit.durationMs != null ? `Duration: ${audit.durationMs} ms` : '',
    audit.reason ? `Audit error: ${audit.reason}` : '',
    '',
    audit.fixes?.length ? `## Required fixes\n\n${audit.fixes.map((fix) => `- ${fix}`).join('\n')}` : '',
    '',
    codeBlock('Raw auditor result', audit.raw || '')
  ].filter(Boolean).join('\n');
  fs.writeFileSync(paths.reviewPath, content, { mode: 0o600 });
}

function nativeAuditFollowupPlan(originalTask, audit, iteration) {
  return [
    '# CodexPro Audit Remediation',
    '',
    `Audit iteration: ${iteration}`,
    '',
    '## Original acceptance target',
    '',
    String(originalTask || '').trim(),
    '',
    '## Audit summary',
    '',
    audit.summary || 'The implementation did not satisfy the acceptance target.',
    '',
    '## Required fixes',
    '',
    ...(audit.fixes?.length ? audit.fixes.map((fix) => `- ${fix}`) : ['- Re-check the implementation against every original requirement and address the failed audit evidence.']),
    '',
    '## Execution instruction',
    '',
    'Implement the required fixes only, preserve already-correct behavior, and run the relevant verification before returning control to CodexPro for another independent audit.',
    ''
  ].join('\n');
}

function nativeAuditConfig(args, request) {
  return {
    command: resolveAgentCommand('opencode'),
    model: String(args.auditModel ?? process.env.CODEXPRO_AUDIT_MODEL ?? (request.commandInfo.agent === 'opencode' ? request.commandInfo.model : '') ?? '').trim(),
    configDir: path.join(projectRoot, '.opencode')
  };
}

async function runLoopCommand(commandInfo, root, timeoutMs, maxOutputBytes, label) {
  if (!commandAvailableFromRoot(commandInfo.command, root)) {
    throw new Error(`${label} command was not found: ${commandInfo.command}`);
  }
  statusLine('wait', `Running ${label.toLowerCase()}: ${commandDisplay(commandInfo)}`);
  return runProcessCaptured(commandInfo.command, commandInfo.args, {
    cwd: root,
    timeoutMs,
    maxOutputBytes
  });
}

function assertLoopCommandAvailable(commandInfo, root, label) {
  if (!commandAvailableFromRoot(commandInfo.command, root)) {
    throw new Error(`${label} command was not found before starting loop-handoff: ${commandInfo.command}`);
  }
}

function preflightLoopCommands(request, reviewCommand, testCommand, args) {
  assertLoopCommandAvailable(request.commandInfo, request.root, 'Executor');
  if (reviewCommand) {
    assertLoopCommandAvailable(reviewCommand, request.root, 'Review');
  } else {
    const audit = nativeAuditConfig(args, request);
    if (!commandAvailableFromRoot(audit.command, request.root)) {
      throw new Error(`CodexPro native audit requires OpenCode, but the command was not found: ${audit.command}`);
    }
    const capability = inspectCodexProAuditorCapability(audit.command, request.root, audit.configDir);
    if (!capability.ready) throw new Error(`CodexPro native auditor is unavailable: ${capability.reason}`);
  }
  if (testCommand) assertLoopCommandAvailable(testCommand, request.root, 'Test');
}

async function confirmLoopHandoff(args, root) {
  if (args.yes || args.noConfirm || args.dryRun) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Use --yes to start loop-handoff in non-interactive shells, or use --dry-run to preview.');
  }
  printBox('Confirm handoff loop', [
    labelValue('Workspace', root),
    labelValue('Agent', args.agent ?? 'opencode'),
    ...(args.model ? [labelValue('Model', args.model)] : []),
    labelValue('Max iters', args.maxIters ?? '3'),
    labelValue('Audit', args.reviewCommand ? `external: ${args.reviewCommand}` : `CodexPro native: ${CODEXPRO_AUDITOR_AGENT}`),
    'This runs a bounded local execute/audit loop. CodexPro only completes when the audit passes; it does not automate ChatGPT or any browser session.'
  ]);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await ask(rl, 'Start local execute/review loop?', 'no');
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

async function confirmLoopContinuation(args, root, iteration, planPath) {
  if (!args.requireHumanConfirmation) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('--require-human-confirmation needs an interactive terminal before running follow-up plans.');
  }
  printBox('Confirm follow-up plan', [
    labelValue('Workspace', root),
    labelValue('Iteration', String(iteration)),
    labelValue('Plan', path.relative(root, planPath)),
    'The reviewer wrote or kept a follow-up plan. Review it before continuing.'
  ]);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await ask(rl, 'Run the next local executor iteration?', 'no');
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

function printLoopDryRun(request, reviewCommand, testCommand, maxIters, args) {
  const audit = reviewCommand ? `external: ${commandDisplay(reviewCommand)}` : `CodexPro native: ${CODEXPRO_AUDITOR_AGENT}${args.auditModel ? ` (${args.auditModel})` : ''}`;
  printBox('CodexPro loop-handoff dry run', [
    labelValue('Workspace', request.root),
    labelValue('Plan', path.relative(request.root, request.planPath)),
    labelValue('Agent', request.commandInfo.agent),
    ...(request.commandInfo.model ? [labelValue('Model', request.commandInfo.model)] : []),
    labelValue('Max iters', String(maxIters)),
    labelValue('Executor', request.commandText),
    ...(testCommand ? [labelValue('Tests', commandDisplay(testCommand))] : []),
    labelValue('Audit', audit),
    'Flow: CodexPro assigns -> agent executes -> CodexPro audits -> FAIL loops with a remediation plan -> PASS completes.',
    'No command was executed and no .ai-bridge result files were changed.'
  ]);
}

function writeLoopState(paths, state) {
  fs.mkdirSync(paths.bridgeDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

async function runLoopHandoff(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return;
  }

  const root = realDir(args.root ?? process.env.CODEXPRO_ROOT ?? process.cwd());
  const contextDir = contextDirFromArgs(args);
  const paths = loopArtifactPaths(root, contextDir);
  const maxIters = numberOption(args.maxIters ?? args.maxIterations, 3, 1, 25);
  const maxReadBytes = handoffMaxReadBytes();
  const maxOutputBytes = numberOption(args.maxOutputBytes ?? process.env.CODEXPRO_MAX_OUTPUT_BYTES, 120_000, 4_000, 2_000_000);
  const reviewTimeoutMs = numberOption(args.reviewTimeoutMs, 600_000, 1_000, 24 * 60 * 60_000);
  const testTimeoutMs = numberOption(args.testTimeoutMs, 600_000, 1_000, 24 * 60 * 60_000);

  if (args.requireCleanGitStart) assertCleanGitStart(root, contextDir);

  let request = loadHandoffExecution({ ...args, root, contextDir });
  const originalTask = request.planText;
  const reviewCommand = buildReviewerCommand(args, root, contextDir, 1, paths);
  const testCommand = buildTestCommand(args, root, contextDir, 1, paths);
  const nativeAudit = !reviewCommand;
  const auditConfig = nativeAudit ? nativeAuditConfig(args, request) : null;

  if (args.dryRun) {
    printLoopDryRun(request, reviewCommand, testCommand, maxIters, args);
    return;
  }

  preflightLoopCommands(request, reviewCommand, testCommand, args);

  const approved = await confirmLoopHandoff(args, root);
  if (!approved) {
    statusLine('warn', 'Loop cancelled.');
    return;
  }

  fs.mkdirSync(paths.bridgeDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.targetPath, originalTask, { mode: 0o600 });

  printBox('CodexPro loop-handoff', [
    labelValue('Workspace', root),
    labelValue('Plan', path.relative(root, paths.planPath)),
    labelValue('Agent', request.commandInfo.agent),
    ...(request.commandInfo.model ? [labelValue('Model', request.commandInfo.model)] : []),
    labelValue('Max iters', String(maxIters)),
    labelValue('Audit', nativeAudit ? `CodexPro native: ${CODEXPRO_AUDITOR_AGENT}${auditConfig?.model ? ` (${auditConfig.model})` : ''}` : `external: ${commandDisplay(reviewCommand)}`),
    ...(testCommand ? [labelValue('Tests', commandDisplay(testCommand))] : []),
    'Mode: CodexPro assigns -> agent executes -> CodexPro audits -> FAIL loops -> PASS completes. No ChatGPT or browser session is automated.'
  ]);

  let previousChangeFingerprint = '';
  let finalVerdict = 'FAIL';
  let stopReason = 'max_iters';

  for (let iteration = 1; iteration <= maxIters; iteration += 1) {
    if (iteration > 1) {
      const continueLoop = await confirmLoopContinuation(args, root, iteration, paths.planPath);
      if (!continueLoop) {
        stopReason = 'human_cancelled';
        break;
      }
    }

    request = loadHandoffExecution({ ...args, root, contextDir });
    const currentPlanHash = planHash(request.planText);
    if (isScaffoldedHandoffPlan(request.planText)) {
      stopReason = 'scaffolded_plan';
      statusLine('warn', 'Stopping because current-plan.md is still the empty scaffold.');
      break;
    }

    appendBridgeLog(root, contextDir, {
      event: 'loop_handoff_iteration_started',
      iteration,
      plan_hash: currentPlanHash,
      agent: request.commandInfo.agent,
      model: request.commandInfo.model || undefined
    });

    const beforeExecutionFingerprint = changeFingerprintExcludingContext(root, contextDir);
    const execution = await executeHandoffRequest(request, { ...args, yes: true }, { skipConfirmation: true, iteration });
    const diffText = readGitDiffExcludingContext(root, contextDir, maxOutputBytes);
    fs.writeFileSync(paths.diffPath, diffText || '', { mode: 0o600 });
    const currentChangeFingerprint = changeFingerprintExcludingContext(root, contextDir);
    const changedThisIteration = currentChangeFingerprint !== beforeExecutionFingerprint;

    if (args.stopIfNoFilesChanged && !changedThisIteration) {
      finalVerdict = 'FAIL';
      stopReason = 'no_files_changed';
      statusLine('warn', 'Stopping because the executor produced no new git changes.');
      break;
    }
    if (args.stopIfSameDiff && previousChangeFingerprint && currentChangeFingerprint === previousChangeFingerprint) {
      finalVerdict = 'FAIL';
      stopReason = 'same_diff';
      statusLine('warn', 'Stopping because the executor repeated the previous diff.');
      break;
    }
    previousChangeFingerprint = currentChangeFingerprint;

    const iterationTestCommand = buildTestCommand(args, root, contextDir, iteration, paths);
    let testResult = null;
    if (iterationTestCommand) {
      testResult = await runLoopCommand(iterationTestCommand, root, testTimeoutMs, maxOutputBytes, 'Test');
      writeLoopTestOutput(paths, testResult, commandDisplay(iterationTestCommand));
      statusLine(testResult.exitCode === 0 ? 'ok' : 'warn', `Tests exited with code ${testResult.exitCode ?? 'null'}${testResult.signal ? ` signal=${testResult.signal}` : ''}`);
    }

    const iterationReviewCommand = buildReviewerCommand(args, root, contextDir, iteration, paths);
    const beforeReviewPlanExists = fs.existsSync(paths.planPath);
    const beforeReviewPlan = beforeReviewPlanExists ? readTextFileBounded(paths.planPath, maxReadBytes) : '';
    let reviewResult = null;
    let auditResult = null;
    let verdict = '';
    let nextPlanChanged = false;
    let afterReviewPlanExists = beforeReviewPlanExists;
    let afterReviewPlan = beforeReviewPlan;
    let hasUsableFollowupPlan = false;
    let reviewExitCode = 0;

    if (nativeAudit) {
      statusLine('wait', `CodexPro auditing iteration ${iteration} with ${CODEXPRO_AUDITOR_AGENT}...`);
      auditResult = await runCodexProNativeAudit({
        command: auditConfig.command,
        root,
        configDir: auditConfig.configDir,
        model: auditConfig.model,
        originalTask,
        iterationPlan: request.planText,
        diffPath: paths.diffPath,
        statusPath: paths.statusPath,
        testsPath: paths.testsPath,
        testsRan: Boolean(iterationTestCommand),
        timeoutMs: reviewTimeoutMs,
        maxOutputBytes
      });
      reviewExitCode = auditResult.ok ? 0 : (auditResult.result?.exitCode ?? 1);
      verdict = auditResult.ok ? auditResult.verdict : '';
      if (auditResult.ok && verdict === 'FAIL') {
        const followupPlan = nativeAuditFollowupPlan(originalTask, auditResult, iteration);
        fs.writeFileSync(paths.planPath, followupPlan, { mode: 0o600 });
      }
      afterReviewPlanExists = fs.existsSync(paths.planPath);
      afterReviewPlan = afterReviewPlanExists ? readTextFileBounded(paths.planPath, maxReadBytes) : '';
      nextPlanChanged = afterReviewPlanExists && planHash(afterReviewPlan) !== planHash(beforeReviewPlan);
      hasUsableFollowupPlan = afterReviewPlanExists && afterReviewPlan.trim() && !isScaffoldedHandoffPlan(afterReviewPlan);
      writeNativeAuditOutput(paths, auditResult, iteration, nextPlanChanged);
      if (auditResult.ok) {
        statusLine(verdict === 'PASS' ? 'ok' : 'warn', `CodexPro audit ${verdict} on iteration ${iteration}${auditResult.summary ? `: ${auditResult.summary}` : ''}`);
      }
    } else {
      reviewResult = await runLoopCommand(iterationReviewCommand, root, reviewTimeoutMs, maxOutputBytes, 'Review');
      reviewExitCode = reviewResult.exitCode;
      afterReviewPlanExists = fs.existsSync(paths.planPath);
      afterReviewPlan = afterReviewPlanExists ? readTextFileBounded(paths.planPath, maxReadBytes) : '';
      const planDeletedByReview = beforeReviewPlanExists && !afterReviewPlanExists;
      nextPlanChanged = planDeletedByReview || (afterReviewPlanExists && planHash(afterReviewPlan) !== planHash(beforeReviewPlan));
      hasUsableFollowupPlan = afterReviewPlanExists && afterReviewPlan.trim() && !isScaffoldedHandoffPlan(afterReviewPlan);
      verdict = explicitReviewVerdict(`${reviewResult.stdout}\n${reviewResult.stderr}`);
      if (!verdict && args.allowImplicitReviewVerdict && nextPlanChanged && reviewResult.exitCode === 0) verdict = 'FAIL';
      if (!verdict && args.allowImplicitReviewVerdict && afterReviewPlanExists && reviewResult.exitCode === 0 && execution.result?.exitCode === 0 && (!testResult || testResult.exitCode === 0)) verdict = 'PASS';
      writeLoopReviewOutput(paths, reviewResult, commandDisplay(iterationReviewCommand), verdict, nextPlanChanged);
    }

    let acceptedVerdict = verdict;
    let rejectedPassReason = '';
    if (verdict === 'PASS' && reviewExitCode !== 0) {
      acceptedVerdict = 'FAIL';
      rejectedPassReason = nativeAudit ? 'audit_failed' : 'reviewer_failed';
    } else if (verdict === 'PASS' && !args.allowReviewPassOnFailure && execution.result?.exitCode !== 0) {
      acceptedVerdict = 'FAIL';
      rejectedPassReason = 'executor_failed';
    } else if (verdict === 'PASS' && !args.allowReviewPassOnFailure && testResult && testResult.exitCode !== 0) {
      acceptedVerdict = 'FAIL';
      rejectedPassReason = 'tests_failed';
    }

    appendBridgeLog(root, contextDir, {
      event: 'loop_handoff_iteration_finished',
      iteration,
      plan_hash: currentPlanHash,
      agent: request.commandInfo.agent,
      model: request.commandInfo.model || undefined,
      audit_mode: nativeAudit ? 'codexpro_native' : 'external_reviewer',
      audit_agent: nativeAudit ? CODEXPRO_AUDITOR_AGENT : undefined,
      audit_model: nativeAudit ? auditResult?.model || auditConfig?.model || undefined : undefined,
      audit_session_id: nativeAudit ? auditResult?.sessionId || undefined : undefined,
      executor_exit_code: execution.result?.exitCode ?? null,
      test_exit_code: testResult?.exitCode ?? null,
      reviewer_exit_code: reviewExitCode,
      reviewer_verdict: verdict,
      verdict: acceptedVerdict,
      rejected_pass_reason: rejectedPassReason || undefined,
      next_plan_changed: nextPlanChanged,
      followup_plan_exists: afterReviewPlanExists,
      has_usable_followup_plan: Boolean(hasUsableFollowupPlan),
      changed_this_iteration: changedThisIteration,
      status_path: path.posix.join(contextDir, 'agent-status.md'),
      diff_path: path.posix.join(contextDir, 'implementation-diff.patch'),
      tests_path: iterationTestCommand ? path.posix.join(contextDir, 'loop-tests.txt') : undefined,
      review_path: path.posix.join(contextDir, 'loop-review.md')
    });
    writeLoopState(paths, {
      updatedAt: new Date().toISOString(),
      iteration,
      maxIters,
      auditMode: nativeAudit ? 'codexpro_native' : 'external_reviewer',
      auditAgent: nativeAudit ? CODEXPRO_AUDITOR_AGENT : undefined,
      auditModel: nativeAudit ? auditResult?.model || auditConfig?.model || undefined : undefined,
      auditSessionId: nativeAudit ? auditResult?.sessionId || undefined : undefined,
      reviewerVerdict: verdict,
      verdict: acceptedVerdict,
      rejectedPassReason: rejectedPassReason || undefined,
      planHash: currentPlanHash,
      nextPlanChanged,
      followupPlanExists: afterReviewPlanExists,
      hasUsableFollowupPlan: Boolean(hasUsableFollowupPlan),
      changedThisIteration,
      executorExitCode: execution.result?.exitCode ?? null,
      reviewerExitCode: reviewExitCode
    });

    if (acceptedVerdict === 'PASS') {
      finalVerdict = 'PASS';
      stopReason = 'pass';
      statusLine('ok', `CodexPro accepted the task on iteration ${iteration}.`);
      break;
    }

    if (rejectedPassReason) {
      if (rejectedPassReason === 'reviewer_failed' || rejectedPassReason === 'audit_failed') {
        finalVerdict = 'FAIL';
        stopReason = nativeAudit ? 'audit_error' : 'reviewer_error';
        statusLine('warn', `${nativeAudit ? 'CodexPro auditor' : 'Reviewer'} returned PASS, but the audit process was not healthy (exit ${reviewExitCode ?? 'null'}).`);
        break;
      }
      if (rejectedPassReason === 'executor_failed') {
        finalVerdict = 'FAIL';
        stopReason = 'executor_failed';
        statusLine('warn', `Audit returned PASS, but executor exited with code ${execution.result?.exitCode ?? 'null'}.`);
        break;
      }
      finalVerdict = 'FAIL';
      stopReason = 'tests_failed';
      statusLine('warn', `Audit returned PASS, but tests exited with code ${testResult?.exitCode ?? 'null'}.`);
      break;
    }

    if (acceptedVerdict !== 'FAIL') {
      finalVerdict = 'FAIL';
      stopReason = reviewExitCode === 0 ? 'unknown_verdict' : (nativeAudit ? 'audit_error' : 'reviewer_error');
      statusLine('warn', `Stopping because ${nativeAudit ? 'CodexPro auditor' : 'reviewer'} did not return a usable verdict. Exit code: ${reviewExitCode ?? 'null'}${auditResult?.reason ? `; ${auditResult.reason}` : ''}`);
      break;
    }

    if (reviewExitCode !== 0) {
      finalVerdict = 'FAIL';
      stopReason = nativeAudit ? 'audit_error' : 'reviewer_error';
      statusLine('warn', `Stopping because ${nativeAudit ? 'CodexPro auditor' : 'reviewer'} failed with code ${reviewExitCode ?? 'null'}.`);
      break;
    }

    if (!nextPlanChanged || !hasUsableFollowupPlan) {
      finalVerdict = 'FAIL';
      stopReason = 'no_followup_plan';
      statusLine('warn', `${nativeAudit ? 'CodexPro audit' : 'Reviewer'} returned FAIL but no usable remediation plan is available.`);
      break;
    }

    statusLine('wait', `CodexPro audit requested another execution iteration (${iteration}/${maxIters}).`);
  }

  appendBridgeLog(root, contextDir, {
    event: 'loop_handoff_finished',
    verdict: finalVerdict,
    stop_reason: stopReason
  });
  statusLine(finalVerdict === 'PASS' ? 'ok' : 'warn', `Loop finished: ${finalVerdict} (${stopReason}).`);
  console.log(`Status: ${path.relative(root, paths.statusPath)}`);
  console.log(`Diff:   ${path.relative(root, paths.diffPath)}`);
  console.log(`Review: ${path.relative(root, paths.reviewPath)}`);
  console.log(`Log:    ${path.relative(root, paths.logPath)}`);
  if (finalVerdict !== 'PASS') process.exitCode = 1;
}

  return { runExecuteHandoff, runWatchHandoff, runLoopHandoff };
}
