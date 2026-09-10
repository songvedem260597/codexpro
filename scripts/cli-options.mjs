import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export function parseArgs(argv) {
  const out = { allowRoots: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const option = raw.slice(2);
    const eq = option.indexOf('=');
    const key = eq >= 0 ? option.slice(0, eq) : option;
    const inlineValue = eq >= 0 ? option.slice(eq + 1) : undefined;
    if (key === 'help') out.help = true;
    else if (key === 'allow-home') out.allowHome = true;
    else if (key === 'no-auth') out.noAuth = true;
    else if (key === 'browser-control') out.browserControl = true;
    else if (key === 'no-browser-control') out.browserControl = false;
    else if (key === 'no-bash') out.bash = 'off';
    else if (key === 'compact-bash-transcript') out.bashTranscript = 'compact';
    else if (key === 'full-bash-transcript') out.bashTranscript = 'full';
    else if (key === 'codex-sessions-read') out.codexSessions = 'read';
    else if (key === 'require-bash-session') out.requireBashSession = true;
    else if (key === 'copy-url') out.copyUrl = true;
    else if (key === 'no-copy-url') out.noCopyUrl = true;
    else if (key === 'dry-run') out.dryRun = true;
    else if (key === 'json') out.json = true;
    else if (key === 'staged') out.staged = true;
    else if (key === 'once') out.once = true;
    else if (key === 'confirm') out.confirm = true;
    else if (key === 'no-confirm') out.noConfirm = true;
    else if (key === 'require-clean-git-start') out.requireCleanGitStart = true;
    else if (key === 'stop-if-no-files-changed') out.stopIfNoFilesChanged = true;
    else if (key === 'stop-if-same-diff') out.stopIfSameDiff = true;
    else if (key === 'require-human-confirmation') out.requireHumanConfirmation = true;
    else if (key === 'allow-implicit-review-verdict') out.allowImplicitReviewVerdict = true;
    else if (key === 'allow-review-pass-on-failure') out.allowReviewPassOnFailure = true;
    else if (key === 'subagents') out.subagents = true;
    else if (key === 'no-subagents') out.subagents = false;
    else if (key === 'live-agent-check') out.liveAgentCheck = true;
    else if (key === 'live-subagent-check') out.liveSubagentCheck = true;
    else if (key === 'live-scout-check') out.liveScoutCheck = true;
    else if (key === 'open-chatgpt') out.openChatgpt = true;
    else if (key === 'headless') out.headless = true;
    else if (key === 'no-profile') out.noProfile = true;
    else if (key === 'clear-projects') out.clearProjects = true;
    else if (key === 'save-config') out.saveConfig = true;
    else if (key === 'no-save-config') out.noSaveConfig = true;
    else if (key === 'yes' || key === 'force') out.yes = true;
    else if (key === 'stable') out.tunnel = 'cloudflare-named';
    else if (key === 'install-cloudflared') out.installCloudflared = true;
    else if (key === 'no-install-cloudflared') out.noInstallCloudflared = true;
    else if (key === 'agent') {
      const next = argv[i + 1];
      if (inlineValue !== undefined || (next && !next.startsWith('--'))) {
        out.agent = inlineValue ?? next;
        if (inlineValue === undefined) i += 1;
      } else {
        out.mode = 'agent';
      }
    }
    else if (key === 'handoff') out.mode = 'handoff';
    else if (key === 'pro-planning' || key === 'pro') out.mode = 'pro';
    else if (key === 'log-requests') out.logRequests = true;
    else if (key === 'print-env') out.printEnv = true;
    else {
      const next = argv[i + 1];
      const value = inlineValue ?? next;
      if (value === undefined || (inlineValue === undefined && value.startsWith('--'))) throw new Error(`Missing value for --${key}`);
      if (inlineValue === undefined) i += 1;
      if (key === 'allow-root' || key === 'project') out.allowRoots.push(value);
      else out[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    }
  }
  return out;
}

export function expandHome(input) {
  if (!input || input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function realDir(input) {
  const resolved = path.resolve(expandHome(input));
  if (!fs.existsSync(resolved)) throw new Error(`Directory does not exist: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
  return fs.realpathSync.native(resolved);
}

export function configuredProjectRoots(root, args = {}, profile = {}) {
  const saved = args.clearProjects
    ? []
    : Array.isArray(profile.allowedRoots)
      ? profile.allowedRoots
      : [];
  const requested = Array.isArray(args.allowRoots) ? args.allowRoots : [];
  return [...new Set([...saved, ...requested].map(realDir))].filter((projectRoot) => projectRoot !== root);
}

export function resolveCodexDir(root, input) {
  if (!input) return '';
  const expanded = expandHome(input);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);
}

export function resolveConfigPath(root, input) {
  if (!input) return '';
  const expanded = expandHome(String(input));
  return path.isAbsolute(expanded) || path.win32.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);
}

export function effectiveWriteMode(mode, requested) {
  const value = requested || (mode === 'agent' ? 'workspace' : 'handoff');
  if (!['off', 'handoff', 'workspace'].includes(value)) {
    throw new Error('--write must be off, handoff, or workspace');
  }
  if (mode === 'agent') return value;
  return value === 'off' ? 'off' : 'handoff';
}

export function optionValue(args, profile, field, envNames = [], fallback = undefined) {
  if (args[field] !== undefined) return args[field];
  for (const envName of envNames) {
    if (process.env[envName] !== undefined && process.env[envName] !== '') return process.env[envName];
  }
  if (profile?.[field] !== undefined && profile[field] !== '') return profile[field];
  return fallback;
}

export function writeOption(args, profile, mode) {
  return effectiveWriteMode(mode, optionValue(args, profile, 'write', ['CODEXPRO_WRITE_MODE'], mode === 'agent' ? 'workspace' : 'handoff'));
}

export function validateChoice(flag, value, allowed) {
  if (allowed.includes(value)) return value;
  throw new Error(`--${flag} must be ${allowed.slice(0, -1).join(', ')}, or ${allowed.at(-1)}`);
}

export function optionalChoice(flag, value, allowed) {
  if (!value) return '';
  return validateChoice(flag, value, allowed);
}

export function optionalWriteOption(args, profile, mode) {
  const requested = optionValue(args, profile, 'write', ['CODEXPRO_WRITE_MODE'], '');
  return requested ? effectiveWriteMode(mode, requested) : '';
}

export function boolFromValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

export function optionBool(args, profile, field, envNames = [], fallback = false) {
  if (args[field] !== undefined) return boolFromValue(args[field], fallback);
  for (const envName of envNames) {
    if (process.env[envName] !== undefined && process.env[envName] !== '') return boolFromValue(process.env[envName], fallback);
  }
  if (profile?.[field] !== undefined && profile[field] !== '') return boolFromValue(profile[field], fallback);
  return fallback;
}
