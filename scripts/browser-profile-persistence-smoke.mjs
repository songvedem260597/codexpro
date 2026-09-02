import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { browserProfileRetentionState } from '../dist/browserExtensionBridge.js';

const now = Date.now();
assert.equal(browserProfileRetentionState({ lastSeen: now - 2 * 60_000 }, now).connected, true);
assert.equal(browserProfileRetentionState({ lastSeen: now - 4 * 60_000 }, now).connected, false);
assert.equal(browserProfileRetentionState({ lastSeen: now - 4 * 60_000 }, now).visible, true);
assert.equal(browserProfileRetentionState({ lastSeen: now - 25 * 60 * 60_000 }, now).visible, false);

const home = mkdtempSync(path.join(tmpdir(), 'codexpro-profile-persist-'));
const childPath = path.join(home, 'bridge-child.mjs');
const bridgeUrl = pathToFileURL(path.resolve('dist/browserExtensionBridge.js')).href;
writeFileSync(childPath, `
import { ensureBrowserExtensionBridge, forgetBrowserExtensionProfile, listBrowserExtensionProfiles, listDisabledBrowserExtensionProfileIds } from ${JSON.stringify(bridgeUrl)};
const mode = process.argv[2];
const port = Number(process.env.CODEXPRO_BROWSER_EXTENSION_BRIDGE_PORT);
ensureBrowserExtensionBridge();
await new Promise(resolve => setTimeout(resolve, 80));
if (mode === 'register' || mode === 'disable') {
  const enabled = mode === 'register';
  const response = await fetch('http://127.0.0.1:' + port + '/register', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'origin': 'chrome-extension://gndipignbnipohooclcbhjliikamjlpl',
      'x-codexpro-extension': 'profile-bridge-v1'
    },
    body: JSON.stringify({
      profile: {
        id: 'persist-smoke-profile',
        email: 'persist@example.test',
        label: 'Persist Smoke',
        version: '0.5.105',
        enabled,
        worker_enabled_updated_at: Date.now(),
        connector_server_fingerprint: 'fixture-fingerprint'
      },
      tabs: [],
      recent_conversations: []
    })
  });
  if (!response.ok) throw new Error('register failed: ' + response.status + ' ' + await response.text());
  await new Promise(resolve => setTimeout(resolve, 500));
  console.log(JSON.stringify(await response.json()));
} else if (mode === 'list') {
  console.log(JSON.stringify({ profiles: listBrowserExtensionProfiles(), disabled_profile_ids: listDisabledBrowserExtensionProfileIds() }));
} else if (mode === 'forget') {
  console.log(JSON.stringify({ forgotten: forgetBrowserExtensionProfile('persist-smoke-profile') }));
} else {
  throw new Error('unknown mode');
}
process.exit(0);
`, 'utf8');

function run(mode, port) {
  const result = spawnSync(process.execPath, [childPath, mode], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEXPRO_HOME: home,
      CODEXPRO_BROWSER_EXTENSION_BRIDGE_PORT: String(port)
    },
    timeout: 10_000
  });
  assert.equal(result.status, 0, `${mode} child failed: ${result.stderr || result.stdout}`);
  return String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1) || '';
}

try {
  const seed = 20_000 + Math.floor(Math.random() * 20_000);
  run('register', seed);
  const registry = JSON.parse(readFileSync(path.join(home, 'browser-profiles.json'), 'utf8'));
  assert.equal(registry.version, 1);
  assert.equal(registry.profiles.length, 1);
  assert.equal(registry.profiles[0].id, 'persist-smoke-profile');
  assert.equal(registry.profiles[0].extensionVersion, '0.5.105');

  const restored = JSON.parse(run('list', seed + 1));
  const profile = restored.profiles.find(item => item.profile_id === 'persist-smoke-profile');
  assert.ok(profile, 'persisted browser profile must survive bridge restart');
  assert.equal(profile.connected, false, 'restored profile is visible but disconnected until heartbeat returns');
  assert.equal(profile.active, false);
  assert.equal(profile.extension_version, '0.5.105');

  run('disable', seed + 2);
  const disabledRegistry = JSON.parse(readFileSync(path.join(home, 'browser-profiles.json'), 'utf8'));
  assert.equal(disabledRegistry.profiles[0].enabled, false, 'disabled profile metadata must be persisted');
  const disabledSnapshot = JSON.parse(run('list', seed + 3));
  assert.deepEqual(disabledSnapshot.profiles, [], 'disabled profiles must stay hidden after bridge restart');
  assert.deepEqual(disabledSnapshot.disabled_profile_ids, ['persist-smoke-profile'], 'bridge snapshots must identify explicit disabled removals');
  assert.equal(JSON.parse(run('forget', seed + 4)).forgotten, true, 'a stale profile must be removable without reconnecting its extension');
  const forgottenRegistry = JSON.parse(readFileSync(path.join(home, 'browser-profiles.json'), 'utf8'));
  assert.deepEqual(forgottenRegistry.profiles, [], 'forgetting a profile must immediately persist the empty registry');
  const forgottenSnapshot = JSON.parse(run('list', seed + 5));
  assert.deepEqual(forgottenSnapshot.profiles, [], 'a forgotten profile must stay absent after bridge restart');
  assert.deepEqual(forgottenSnapshot.disabled_profile_ids, [], 'forgetting must remove stale disabled metadata too');
  console.log('✓ Browser profile registry survives runtime restart and reconnect state is safe');
} finally {
  rmSync(home, { recursive: true, force: true });
}
