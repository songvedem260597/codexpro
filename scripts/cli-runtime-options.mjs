import process from 'node:process';
import { optionBool, optionValue } from './cli-options.mjs';

export function hasToolCardsInput(args, profile = {}) {
  return args.toolCards !== undefined || profile.toolCards !== undefined || (process.env.CODEXPRO_TOOL_CARDS !== undefined && process.env.CODEXPRO_TOOL_CARDS !== '');
}

export function toolCardsProfileEntry(args, profile = {}) {
  const hasInput = hasToolCardsInput(args, profile);
  return hasInput ? { toolCards: optionBool(args, profile, 'toolCards', ['CODEXPRO_TOOL_CARDS'], false) } : {};
}

export function toolCardsCliArgs(args, profile = {}) {
  if (!hasToolCardsInput(args, profile)) return [];
  return ['--tool-cards', optionBool(args, profile, 'toolCards', ['CODEXPRO_TOOL_CARDS'], false) ? 'on' : 'off'];
}

export function validateBashSession(value) {
  if (!value) return '';
  const trimmed = String(value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(trimmed)) {
    throw new Error('--bash-session must be 1-64 characters using letters, numbers, dot, underscore, or dash, and must start with a letter or number.');
  }
  return trimmed;
}

export function bashSessionOptions(args, profile = {}) {
  const bashSession = validateBashSession(optionValue(args, profile, 'bashSession', ['CODEXPRO_BASH_SESSION_ID'], ''));
  const requireBashSession = optionBool(args, profile, 'requireBashSession', ['CODEXPRO_REQUIRE_BASH_SESSION'], false);
  if (requireBashSession && !bashSession) {
    throw new Error('--require-bash-session requires --bash-session <id>.');
  }
  return { bashSession, requireBashSession };
}

export function bashTranscriptOption(args, profile = {}) {
  const value = optionValue(args, profile, 'bashTranscript', ['CODEXPRO_BASH_TRANSCRIPT'], 'compact');
  if (value === 'compact' || value === 'full') return value;
  throw new Error('--bash-transcript must be compact or full.');
}

export function codexSessionsOption(args, profile = {}) {
  const value = optionValue(args, profile, 'codexSessions', ['CODEXPRO_CODEX_SESSIONS'], 'off');
  if (value === 'off' || value === 'metadata' || value === 'read') return value;
  throw new Error('--codex-sessions must be off, metadata, or read.');
}
