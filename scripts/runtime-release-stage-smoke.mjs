import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  createRuntimeReleaseStage,
  resolveStageNpmInvocation,
  runStageNpm,
  RUNTIME_RELEASE_METADATA_FILE,
  RUNTIME_RELEASE_PENDING_FILE
} from './runtime-release-stage.mjs';

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return String(result.stdout || '').trim();
}

function makeRepo(root, origin) {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"codexpro-stage-fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(root, 'scripts', 'codexpro.mjs'), 'console.log("fixture");\n');
  run('git', ['init'], root);
  run('git', ['config', 'user.email', 'runtime-stage@example.invalid'], root);
  run('git', ['config', 'user.name', 'Runtime Stage Smoke'], root);
  run('git', ['remote', 'add', 'origin', origin], root);
  run('git', ['add', 'package.json', 'scripts/codexpro.mjs'], root);
  run('git', ['commit', '-m', 'fixture'], root);
  return run('git', ['rev-parse', 'HEAD'], root);
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function fakeBuild({ root }) {
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'http.js'), 'export const staged = true;\n');
  fs.writeFileSync(path.join(root, 'node_modules', '.runtime-ready'), 'ok\n');
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'codexpro-runtime-stage-smoke-'));
try {
  const npmCwd = path.join(sandbox, 'npm-resolution-cwd');
  fs.mkdirSync(npmCwd, { recursive: true });
  const originalCwd = process.cwd();
  const npmBefore = resolveStageNpmInvocation();
  process.chdir(npmCwd);
  let npmDuring;
  try {
    npmDuring = resolveStageNpmInvocation();
  } finally {
    process.chdir(originalCwd);
  }
  assert.equal(path.isAbsolute(npmDuring.nodeExecutable), true, 'Node executable must be absolute');
  assert.equal(path.isAbsolute(npmDuring.npmCli), true, 'npm CLI must be absolute');
  assert.equal(fs.existsSync(npmDuring.npmCli), true, 'npm CLI must exist');
  assert.equal(npmDuring.nodeExecutable, npmBefore.nodeExecutable, 'npm Node executable resolution must not depend on cwd');
  assert.equal(npmDuring.npmCli, npmBefore.npmCli, 'npm CLI resolution must not depend on cwd');
  assert.equal(npmDuring.nodeExecutable.toLowerCase(), fs.realpathSync(process.execPath).toLowerCase(), 'staging npm must use process.execPath');
  let capturedNpm = null;
  runStageNpm((command, args, options) => {
    capturedNpm = { command, args, options };
    return '';
  }, npmDuring, ['--version'], { cwd: npmCwd });
  assert.equal(capturedNpm.command, npmDuring.nodeExecutable, 'npm command must be the resolved Node executable');
  assert.equal(capturedNpm.args[0], npmDuring.npmCli, 'npm CLI must be the first Node argument');
  assert.equal(capturedNpm.options.cwd, npmCwd, 'npm child cwd must remain the staged directory');
  assert.equal(capturedNpm.options.shell, false, 'npm staging invocation must use shell=false');
  const stageSource = fs.readFileSync(new URL('./runtime-release-stage.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(stageSource, /npm\.cmd/, 'runtime staging must never invoke bare npm.cmd');
  assert.equal((stageSource.match(/^\s{2}runStageNpm\(run, npmInvocation/gm) || []).length, 3, 'ci, build, and prune must use the same resolved npm invocation');

  const repoA = path.join(sandbox, 'repo-a');
  const repoB = path.join(sandbox, 'repo-b');
  const commitA = makeRepo(repoA, 'https://example.invalid/codexpro.git');
  const commitB = makeRepo(repoB, 'https://example.invalid/other.git');
  const home = path.join(sandbox, 'home');
  const releaseRoot = path.join(home, 'runtime-releases');
  const activeRelease = path.join(releaseRoot, 'active-old');
  fs.mkdirSync(activeRelease, { recursive: true });
  fs.writeFileSync(path.join(activeRelease, 'sentinel.txt'), 'do-not-touch\n');
  const activeSentinelBefore = sha256(path.join(activeRelease, 'sentinel.txt'));
  const coordinationPath = path.join(home, 'workspace-coordination.json');
  fs.mkdirSync(home, { recursive: true });
  const coordinationFixture = JSON.stringify({ claims: { 'src/a.ts': 'task-a' }, queue: ['task-b'], integrationLease: { taskId: 'task-c' } }, null, 2);
  fs.writeFileSync(coordinationPath, coordinationFixture);

  const stage = createRuntimeReleaseStage({ expectedRepository: repoA, installAndBuild: fakeBuild, now: () => 1_789_200_000_000 });

  await assert.rejects(
    stage.stage({ sourceRepository: repoB, sourceCommit: commitB, codexProHome: home, releaseId: 'foreign-repo' }),
    /canonical CodexPro repository/,
    'stage must reject an unrelated repository'
  );
  await assert.rejects(
    stage.stage({ sourceRepository: repoA, sourceCommit: '0'.repeat(40), codexProHome: home, releaseId: 'invalid-commit' }),
    /failed|resolve|unknown|bad object|Needed a single revision/i,
    'stage must reject an invalid commit'
  );
  await assert.rejects(
    stage.stage({ sourceRepository: repoA, sourceCommit: commitA, codexProHome: home, releaseId: '../escape' }),
    /Invalid runtime release id/,
    'stage must reject destination traversal'
  );

  const result = await stage.stage({ sourceRepository: repoA, sourceCommit: commitA, codexProHome: home, releaseId: 'runtime-good' });
  assert.equal(path.dirname(result.release_path), releaseRoot, 'release must stay under CODEXPRO_HOME/runtime-releases');
  assert.notEqual(result.release_path, activeRelease, 'staging must create a new release directory');
  assert.equal(fs.existsSync(result.release_path), true);
  assert.equal(sha256(path.join(activeRelease, 'sentinel.txt')), activeSentinelBefore, 'current active release must remain unchanged');
  assert.equal(fs.readFileSync(coordinationPath, 'utf8'), coordinationFixture, 'staging must not mutate coordination claims/queue/lease state');

  const metadata = JSON.parse(fs.readFileSync(path.join(result.release_path, RUNTIME_RELEASE_METADATA_FILE), 'utf8'));
  assert.equal(metadata.verified, true, 'verified stage must include verified metadata');
  assert.equal(metadata.source_commit, commitA, 'staged commit identity must be exact');
  assert.equal(run('git', ['rev-parse', 'HEAD'], result.release_path), commitA, 'staged Git HEAD must equal the requested commit');
  const stagedDist = path.join(result.release_path, 'dist', 'http.js');
  assert.equal(metadata.dist_http_sha256, sha256(stagedDist), 'staged dist/http.js SHA must be exact');
  assert.equal(metadata.runtime_build_id, result.runtime_build_id);
  const pending = JSON.parse(fs.readFileSync(path.join(releaseRoot, RUNTIME_RELEASE_PENDING_FILE), 'utf8'));
  assert.equal(pending.release_path, result.release_path, 'only the fully verified final release may become pending for activation');
  assert.equal(pending.verified, true);
  assert.equal(fs.readdirSync(releaseRoot).some((name) => name.startsWith('.stage-')), false, 'no partial staging directory may remain after success');

  const missingNpmHome = path.join(sandbox, 'missing-npm-home');
  const missingNpmReleaseRoot = path.join(missingNpmHome, 'runtime-releases');
  const missingNpmCurrentRelease = path.join(missingNpmReleaseRoot, 'active-old');
  fs.mkdirSync(missingNpmCurrentRelease, { recursive: true });
  fs.writeFileSync(path.join(missingNpmCurrentRelease, 'sentinel.txt'), 'keep-current-runtime\n');
  const missingNpmSentinelBefore = sha256(path.join(missingNpmCurrentRelease, 'sentinel.txt'));
  const fakeNodeDir = path.join(sandbox, 'fake-node-install');
  fs.mkdirSync(fakeNodeDir, { recursive: true });
  const fakeNode = path.join(fakeNodeDir, path.basename(process.execPath));
  fs.writeFileSync(fakeNode, 'not-a-real-node\n');
  const missingNpmStage = createRuntimeReleaseStage({
    expectedRepository: repoA,
    npmResolutionOptions: { env: {}, execPath: fakeNode },
    now: () => 1_789_200_000_050
  });
  await assert.rejects(
    missingNpmStage.stage({ sourceRepository: repoA, sourceCommit: commitA, codexProHome: missingNpmHome, releaseId: 'missing-npm-cli' }),
    /Unable to resolve npm-cli\.js/,
    'stage must fail closed when npm-cli.js cannot be resolved'
  );
  assert.equal(fs.existsSync(path.join(missingNpmReleaseRoot, 'missing-npm-cli')), false, 'missing npm CLI must not publish a release');
  assert.equal(fs.existsSync(path.join(missingNpmReleaseRoot, RUNTIME_RELEASE_PENDING_FILE)), false, 'missing npm CLI must not publish a pending activation pointer');
  assert.equal(fs.readdirSync(missingNpmReleaseRoot).some((name) => name.startsWith('.stage-')), false, 'missing npm CLI must clean the partial staging directory');
  assert.equal(sha256(path.join(missingNpmCurrentRelease, 'sentinel.txt')), missingNpmSentinelBefore, 'missing npm CLI failure must leave current release untouched');

  const partialHome = path.join(sandbox, 'partial-home');
  const failingStage = createRuntimeReleaseStage({
    expectedRepository: repoA,
    installAndBuild: async () => { throw new Error('intentional build failure'); },
    now: () => 1_789_200_000_100
  });
  await assert.rejects(
    failingStage.stage({ sourceRepository: repoA, sourceCommit: commitA, codexProHome: partialHome, releaseId: 'partial-stage' }),
    /intentional build failure/
  );
  const partialRoot = path.join(partialHome, 'runtime-releases');
  assert.equal(fs.existsSync(path.join(partialRoot, 'partial-stage')), false, 'partial stage must not be activatable');
  assert.equal(fs.existsSync(path.join(partialRoot, RUNTIME_RELEASE_PENDING_FILE)), false, 'partial stage must not publish a pending activation pointer');
  assert.equal(fs.existsSync(partialRoot) ? fs.readdirSync(partialRoot).some((name) => name.startsWith('.stage-')) : false, false, 'partial stage temp directory must be cleaned');

  console.log('runtime-release-stage-smoke: ok');
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
