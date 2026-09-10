import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { expandHome } from './cli-options.mjs';

export function commandExists(command) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? [command] : ['-v', command], {
    shell: process.platform !== 'win32',
    stdio: 'ignore'
  });
  return result.status === 0;
}

export function commandPaths(command) {
  if (process.platform === 'win32') {
    const result = spawnSync('where', [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (result.status !== 0) return [];
    return String(result.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
  const result = spawnSync('command', ['-v', command], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.status !== 0) return [];
  return String(result.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function isPathLike(command) {
  return command.includes('/') || command.includes('\\') || command.startsWith('.');
}

export function resolveExecutablePath(command) {
  const expanded = expandHome(command);
  return path.resolve(expanded);
}

export function isWindowsBatchFile(command) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
}

export function isWindowsCommandCandidate(command) {
  return process.platform === 'win32' && /\.(cmd|bat|exe)$/i.test(command);
}

export function resolveCodexCommand() {
  const explicit = String(process.env.CODEXPRO_CODEX_BIN ?? '').trim();
  if (explicit) {
    if (isPathLike(explicit)) return resolveExecutablePath(explicit);
    const candidates = commandPaths(explicit);
    if (process.platform !== 'win32') return candidates[0] || explicit;
    return candidates.find(isWindowsCommandCandidate) || explicit;
  }
  if (process.platform !== 'win32') return 'codex';
  return commandPaths('codex').find(isWindowsCommandCandidate) || 'codex';
}

export function resolveAgentCommand(command) {
  if (process.platform !== 'win32' || isPathLike(command)) return command;
  return commandPaths(command).find(isWindowsCommandCandidate) || command;
}

export function executableFileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function commandAvailable(command) {
  if (isPathLike(command)) return executableFileExists(resolveExecutablePath(command));
  return commandExists(command);
}

export function commandAvailableFromRoot(command, root) {
  if (!isPathLike(command)) return commandExists(command);
  const expanded = expandHome(command);
  const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);
  return executableFileExists(resolved);
}
