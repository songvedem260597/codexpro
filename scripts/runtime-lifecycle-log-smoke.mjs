import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendRuntimeLifecycleLog,
  cloudflaredOutputLevel,
  createRuntimeLifecycleLogger,
  runtimeLifecycleLogPaths
} from './runtime-lifecycle-log.mjs';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-runtime-lifecycle-'));

try {
  assert.equal(cloudflaredOutputLevel('ERR failed to serve incoming request error="Failed to proxy HTTP: context canceled"'), null);
  assert.equal(cloudflaredOutputLevel('ERR tunnel connection failed: authentication failure'), 'error');
  assert.equal(cloudflaredOutputLevel('WRN reconnect retry after timeout'), 'warn');
  assert.equal(cloudflaredOutputLevel('INF registered tunnel connection'), 'info');
  const launcherSource = await fs.readFile(new URL('./codexpro.mjs', import.meta.url), 'utf8');
  assert.match(launcherSource, /const level = cloudflaredOutputLevel\(line\);\s*if \(!level\) continue;/, 'launcher must suppress benign cloudflared context-cancel noise');
  assert.match(launcherSource, /await waitForHealth\(`\$\{localBase\}\/healthz`, token, 30000\);/, 'local MCP startup must allow slow-but-valid boots beyond the old 15 second boundary');

  const logger = createRuntimeLifecycleLogger({ home, runId: 'run-fixture', pid: 4321 });
  logger.append('launcher-start', 'launcher started', {
    root: 'C:/fixture',
    token: 'fixture-sensitive-token',
    endpoint: 'https://example.test/healthz?codexpro_token=fixture-query-secret'
  });
  logger.append('child-exit', 'codexpro exited', {
    child_name: 'codexpro',
    child_pid: 9876,
    exit_code: 1,
    signal: '',
    output_tail: 'Authorization: Bearer fixture-bearer-secret'
  }, 'error');

  const [, current] = runtimeLifecycleLogPaths(home);
  const records = (await fs.readFile(current, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.equal(records[0].details.run_id, 'run-fixture');
  assert.equal(records[0].details.launcher_pid, 4321);
  assert.equal(records[1].action, 'child-exit');
  assert.equal(records[1].details.exit_code, 1);
  const serialized = JSON.stringify(records);
  assert.ok(!serialized.includes('fixture-sensitive-token'));
  assert.ok(!serialized.includes('fixture-query-secret'));
  assert.ok(!serialized.includes('fixture-bearer-secret'));
  assert.ok(serialized.includes('[REDACTED]'));

  const [previous] = runtimeLifecycleLogPaths(home);
  const staleAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await fs.writeFile(previous, `${JSON.stringify({ timestamp: staleAt.toISOString(), action: 'stale-previous' })}\n`, 'utf8');
  await fs.utimes(previous, staleAt, staleAt);
  appendRuntimeLifecycleLog(home, { action: 'retention-prune-previous', message: 'fresh' });
  await assert.rejects(fs.stat(previous), { code: 'ENOENT' });

  await fs.utimes(current, staleAt, staleAt);
  appendRuntimeLifecycleLog(home, { action: 'retention-reset-current', message: 'fresh' });
  const retained = (await fs.readFile(current, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(retained.length, 1, 'fully stale current runtime lifecycle log should be reset before append');
  assert.equal(retained[0].action, 'retention-reset-current');

  const large = 'x'.repeat(3900);
  for (let index = 0; index < 1200; index += 1) {
    appendRuntimeLifecycleLog(home, {
      action: 'rotation-fixture',
      message: large,
      details: { index }
    });
  }
  const [currentStat, previousStat] = await Promise.all([fs.stat(current), fs.stat(previous)]);
  assert.ok(currentStat.size <= 4 * 1024 * 1024);
  assert.ok(previousStat.size <= 4 * 1024 * 1024);

  console.log('✓ runtime lifecycle logging/redaction/rotation smoke test passed');
} finally {
  await fs.rm(home, { recursive: true, force: true });
}
