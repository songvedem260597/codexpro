import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCliProcessRuntime } from './cli-process-runtime.mjs';

export const RUNTIME_RELEASE_METADATA_FILE = 'runtime-release.json';
export const RUNTIME_RELEASE_PENDING_FILE = 'pending-runtime-release.json';

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleRepositoryRoot = path.resolve(here, '..');

function realPath(value) {
  const resolved = path.resolve(String(value || ''));
  return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
}

function assertInside(parent, child, label = 'path') {
  const parentPath = path.resolve(parent);
  const childPath = path.resolve(child);
  const relative = path.relative(parentPath, childPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a child of ${parentPath}`);
  }
  return childPath;
}

function normalizeOrigin(value) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

function validateReleaseId(value) {
  const releaseId = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,95}$/i.test(releaseId) || releaseId.includes('..')) {
    throw new Error(`Invalid runtime release id: ${releaseId || '(empty)'}`);
  }
  return releaseId;
}

function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function runtimeBuildId(filePath) {
  const stat = fs.statSync(filePath);
  return `${Math.floor(stat.mtimeMs)}:${stat.size}`;
}

function writeJsonAtomic(filePath, value) {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true });
  const temp = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, filePath);
}

function npmCliFile(value) {
  const candidate = String(value || '').trim();
  if (!candidate || !path.isAbsolute(candidate) || path.basename(candidate).toLowerCase() !== 'npm-cli.js') return '';
  try {
    if (!fs.statSync(candidate).isFile()) return '';
    return realPath(candidate);
  } catch {
    return '';
  }
}

export function resolveStageNpmInvocation(options = {}) {
  const env = options.env || process.env;
  const nodeExecutable = realPath(options.execPath || process.execPath);
  if (!path.isAbsolute(nodeExecutable)) throw new Error(`Node executable must be absolute for runtime staging: ${nodeExecutable}`);

  const fromEnvironment = npmCliFile(env.npm_execpath);
  if (fromEnvironment) {
    return { nodeExecutable, npmCli: fromEnvironment, source: 'npm_execpath' };
  }

  const fromNodeInstallation = npmCliFile(path.join(path.dirname(nodeExecutable), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  if (fromNodeInstallation) {
    return { nodeExecutable, npmCli: fromNodeInstallation, source: 'node-installation' };
  }

  throw new Error(`Unable to resolve npm-cli.js for runtime staging from npm_execpath or Node installation: ${nodeExecutable}`);
}

export function runStageNpm(run, npmInvocation, args, options = {}) {
  if (typeof run !== 'function') throw new Error('runStageNpm requires a process runner.');
  if (!npmInvocation?.nodeExecutable || !npmInvocation?.npmCli) throw new Error('runStageNpm requires a resolved npm invocation.');
  return run(npmInvocation.nodeExecutable, [npmInvocation.npmCli, ...args], { ...options, shell: false });
}

export function createRuntimeReleaseStage(options = {}) {
  const processRuntime = options.processRuntime || createCliProcessRuntime();
  const spawnSyncPortable = options.spawnSyncPortable || processRuntime.spawnSyncPortable;
  const now = options.now || Date.now;
  const expectedRepository = options.expectedRepository || moduleRepositoryRoot;
  const installAndBuild = options.installAndBuild || defaultInstallAndBuild;

  function run(command, args, runOptions = {}) {
    const result = spawnSyncPortable(command, args, {
      cwd: runOptions.cwd,
      shell: false,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: runOptions.timeout ?? 180_000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        NO_COLOR: '1',
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
        ...(runOptions.env || {})
      }
    });
    if (result.error || result.status !== 0) {
      const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
      throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
    }
    return String(result.stdout || '').trim();
  }

  function git(root, args, runOptions = {}) {
    return run(process.platform === 'win32' ? 'git.exe' : 'git', ['-C', root, ...args], runOptions);
  }

  function repositoryIdentity(root) {
    const requestedRoot = realPath(root);
    const commonRaw = git(requestedRoot, ['rev-parse', '--git-common-dir']);
    const commonDir = realPath(path.isAbsolute(commonRaw) ? commonRaw : path.resolve(requestedRoot, commonRaw));
    const topLevel = realPath(git(requestedRoot, ['rev-parse', '--show-toplevel']));
    const origin = git(requestedRoot, ['remote', 'get-url', 'origin']);
    return {
      requestedRoot,
      topLevel,
      commonDir,
      canonicalRoot: path.basename(commonDir).toLowerCase() === '.git' ? path.dirname(commonDir) : topLevel,
      origin,
      normalizedOrigin: normalizeOrigin(origin)
    };
  }

  async function stage(stageOptions = {}) {
    const sourceRepository = stageOptions.sourceRepository;
    const sourceCommit = String(stageOptions.sourceCommit || '').trim().toLowerCase();
    const codexProHome = path.resolve(stageOptions.codexProHome || process.env.CODEXPRO_HOME || path.join(os.homedir(), '.codexpro'));
    if (!sourceRepository) throw new Error('sourceRepository is required.');
    if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('sourceCommit must be an exact 40-character Git SHA.');

    const expectedIdentity = repositoryIdentity(expectedRepository);
    const sourceIdentity = repositoryIdentity(sourceRepository);
    if (sourceIdentity.commonDir.toLowerCase() !== expectedIdentity.commonDir.toLowerCase()
      || sourceIdentity.normalizedOrigin !== expectedIdentity.normalizedOrigin) {
      throw new Error('Runtime staging source must belong to the canonical CodexPro repository.');
    }

    const resolvedCommit = git(sourceIdentity.requestedRoot, ['rev-parse', `${sourceCommit}^{commit}`]).toLowerCase();
    if (resolvedCommit !== sourceCommit) throw new Error(`Runtime staging commit does not resolve exactly: ${sourceCommit}`);
    git(sourceIdentity.requestedRoot, ['cat-file', '-e', `${sourceCommit}^{commit}`]);

    const releaseRoot = path.join(codexProHome, 'runtime-releases');
    fs.mkdirSync(releaseRoot, { recursive: true });
    const releaseId = validateReleaseId(stageOptions.releaseId || `checkpoint-${sourceCommit.slice(0, 12)}-${Number(now()).toString(36)}`);
    const finalPath = assertInside(releaseRoot, path.join(releaseRoot, releaseId), 'runtime release destination');
    if (fs.existsSync(finalPath)) throw new Error(`Runtime release already exists: ${finalPath}`);
    const tempPath = assertInside(releaseRoot, path.join(releaseRoot, `.stage-${releaseId}-${randomBytes(4).toString('hex')}`), 'runtime stage destination');
    const pendingPath = path.join(releaseRoot, RUNTIME_RELEASE_PENDING_FILE);
    let finalCreated = false;

    try {
      run(process.platform === 'win32' ? 'git.exe' : 'git', ['clone', '--no-checkout', '--local', sourceIdentity.canonicalRoot, tempPath], { timeout: 120_000 });
      git(tempPath, ['checkout', '--detach', sourceCommit]);
      const stagedHead = git(tempPath, ['rev-parse', 'HEAD']).toLowerCase();
      if (stagedHead !== sourceCommit) throw new Error(`Staged commit mismatch: expected ${sourceCommit}, got ${stagedHead}`);

      await installAndBuild({ root: tempPath, run, spawnSyncPortable, npmResolutionOptions: options.npmResolutionOptions });

      const codexproScript = path.join(tempPath, 'scripts', 'codexpro.mjs');
      const distHttp = path.join(tempPath, 'dist', 'http.js');
      const packageJson = path.join(tempPath, 'package.json');
      const nodeModules = path.join(tempPath, 'node_modules');
      for (const required of [codexproScript, distHttp, packageJson, nodeModules]) {
        if (!fs.existsSync(required)) throw new Error(`Staged runtime is missing required path: ${required}`);
      }

      const metadata = {
        version: 1,
        release_id: releaseId,
        source_commit: sourceCommit,
        source_repository: sourceIdentity.origin,
        created_at: new Date(Number(now())).toISOString(),
        dist_http_sha256: sha256File(distHttp),
        runtime_build_id: runtimeBuildId(distHttp),
        verified: true
      };
      fs.writeFileSync(path.join(tempPath, RUNTIME_RELEASE_METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
      fs.renameSync(tempPath, finalPath);
      finalCreated = true;

      const finalDistHttp = path.join(finalPath, 'dist', 'http.js');
      if (sha256File(finalDistHttp) !== metadata.dist_http_sha256 || runtimeBuildId(finalDistHttp) !== metadata.runtime_build_id) {
        throw new Error('Runtime release identity changed during atomic publish.');
      }

      writeJsonAtomic(pendingPath, {
        version: 1,
        release_id: releaseId,
        release_path: finalPath,
        source_commit: sourceCommit,
        dist_http_sha256: metadata.dist_http_sha256,
        runtime_build_id: metadata.runtime_build_id,
        verified: true
      });

      return { ...metadata, release_path: finalPath, pending_path: pendingPath };
    } catch (error) {
      try { if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { recursive: true, force: true }); } catch {}
      if (finalCreated) {
        try { fs.rmSync(finalPath, { recursive: true, force: true }); } catch {}
      }
      throw error;
    }
  }

  return { stage, repositoryIdentity };
}

async function defaultInstallAndBuild({ root, run, npmResolutionOptions }) {
  const npmInvocation = resolveStageNpmInvocation(npmResolutionOptions);
  runStageNpm(run, npmInvocation, ['ci', '--ignore-scripts'], { cwd: root, timeout: 180_000 });
  runStageNpm(run, npmInvocation, ['run', 'build'], { cwd: root, timeout: 180_000 });
  runStageNpm(run, npmInvocation, ['prune', '--omit=dev', '--ignore-scripts'], { cwd: root, timeout: 180_000 });
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    result[key.slice(2)] = value;
    i += 1;
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stage = createRuntimeReleaseStage();
  const result = await stage.stage({
    sourceRepository: args['source-repository'],
    sourceCommit: args['source-commit'],
    codexProHome: args['codexpro-home'],
    releaseId: args['release-id']
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
