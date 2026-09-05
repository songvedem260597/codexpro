import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function expandHome(input) {
  if (!input || input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function codexProHome() {
  const customHome = process.env.CODEXPRO_HOME;
  return customHome ? path.resolve(expandHome(customHome)) : path.join(os.homedir(), '.codexpro');
}

function profileDir() {
  return path.join(codexProHome(), 'profiles');
}

function profileIdForRoot(root) {
  return createHash('sha256').update(root).digest('hex').slice(0, 24);
}

function profilePathForRoot(root) {
  return path.join(profileDir(), `${profileIdForRoot(root)}.json`);
}

function runtimeDir() {
  return path.join(codexProHome(), 'runtime');
}

function runtimeStatusPathForRoot(root) {
  return path.join(runtimeDir(), `${profileIdForRoot(root)}.json`);
}

export function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
}

export function loadWorkspaceProfile(root) {
  const profilePath = profilePathForRoot(root);
  if (!fs.existsSync(profilePath)) return {};
  const profile = readJsonFile(profilePath);
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return {};
  if (profile.root && profile.root !== root) return {};
  return { ...profile, profilePath };
}

export function listWorkspaceProfiles() {
  const dir = profileDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const profilePath = path.join(dir, name);
      const profile = readJsonFile(profilePath);
      if (!profile || typeof profile !== 'object' || Array.isArray(profile) || !profile.root) return null;
      return { ...profile, profilePath };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export function deleteWorkspaceProfile(root) {
  const filePath = profilePathForRoot(root);
  if (!fs.existsSync(filePath)) return false;
  fs.rmSync(filePath, { force: true });
  return true;
}

export function saveWorkspaceProfile(root, profile) {
  const dir = profileDir();
  const filePath = profilePathForRoot(root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload = {
    version: 1,
    root,
    updatedAt: new Date().toISOString(),
    ...profile
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
  return filePath;
}

export function saveRuntimeConnection(root, details, options = {}) {
  const filePath = runtimeStatusPathForRoot(root);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const payload = {
    version: 1,
    root,
    pid: process.pid,
    runtimePid: options.runtimePid ?? null,
    tunnelPid: options.tunnelPid ?? null,
    updatedAt: new Date().toISOString(),
    endpoint: details.endpoint,
    localBase: options.localBase ?? '',
    localStatusUrl: details.localStatusUrl ? details.localStatusUrl.replace(/codexpro_token=[^&]+/, 'codexpro_token=<redacted>') : '',
    tunnel: options.tunnel ?? '',
    mode: options.mode ?? '',
    bash: options.bash ?? '',
    bashTranscript: options.bashTranscript ?? '',
    codexSessions: options.codexSessions ?? '',
    bashSession: options.bashSession ?? '',
    requireBashSession: Boolean(options.requireBashSession),
    write: options.write ?? '',
    toolMode: options.toolMode ?? '',
    toolCards: Boolean(options.toolCards)
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
  return filePath;
}

export function clearRuntimeConnection(root) {
  try {
    const filePath = runtimeStatusPathForRoot(root);
    const runtime = readJsonFile(filePath);
    if (runtime?.pid === process.pid) fs.rmSync(filePath, { force: true });
  } catch {}
}

export function sanitizedProfile(profile) {
  if (!profile || !Object.keys(profile).length) return {};
  const { token, cloudflareToken, ...rest } = profile;
  return {
    ...rest,
    ...(token ? { token: '<saved>' } : {}),
    ...(cloudflareToken ? { cloudflareToken: '<saved>' } : {})
  };
}

export function reusableProfilePayload(profile, overrides = {}) {
  const {
    version,
    root,
    updatedAt,
    profilePath,
    allowedRoots,
    ...rest
  } = profile || {};
  return {
    ...rest,
    ...overrides
  };
}
