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
import { ensureBrowserExtensionBridge, forgetBrowserExtensionProfile, listBrowserExtensionProfiles, listDisabledBrowserExtensionProfileIds, runBrowserExtensionCommand } from ${JSON.stringify(bridgeUrl)};
const mode = process.argv[2];
const port = Number(process.env.CODEXPRO_BROWSER_EXTENSION_BRIDGE_PORT);
const trustedOrigin = 'chrome-extension://gndipignbnipohooclcbhjliikamjlpl';
const bridgeHeaders = (origin = trustedOrigin) => ({
  'content-type': 'application/json',
  'origin': origin,
  'x-codexpro-extension': 'profile-bridge-v1'
});
const profilePayload = (enabled) => ({
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
  recent_conversations: [
    { id: 'conversation-0001', title: 'Recent one', updated_at: 101 },
    { id: 'conversation-0002', title: 'Recent two', updated_at: 102 },
    { id: 'conversation-0003', title: 'Recent three', updated_at: 103 },
    { id: 'conversation-0004', title: 'Recent four', updated_at: 104 }
  ]
});
ensureBrowserExtensionBridge();
await new Promise(resolve => setTimeout(resolve, 80));
if (mode === 'register' || mode === 'disable') {
  const enabled = mode === 'register';
  const response = await fetch('http://127.0.0.1:' + port + '/register', {
    method: 'POST',
    headers: bridgeHeaders(),
    body: JSON.stringify(profilePayload(enabled))
  });
  if (!response.ok) throw new Error('register failed: ' + response.status + ' ' + await response.text());
  await new Promise(resolve => setTimeout(resolve, 500));
  if (mode === 'disable') {
    const activate = await fetch('http://127.0.0.1:' + port + '/activate', {
      method: 'POST',
      headers: bridgeHeaders(),
      body: JSON.stringify({ profile: { id: 'persist-smoke-profile' } })
    });
    const commandOutcome = await Promise.race([
      runBrowserExtensionCommand('check_chatgpt', {}, 'persist-smoke-profile').then(
        () => 'resolved',
        (error) => 'rejected:' + String(error?.message || error)
      ),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 150))
    ]);
    console.log(JSON.stringify({
      register_status: response.status,
      activate_status: activate.status,
      command_outcome: commandOutcome
    }));
  } else {
    console.log(JSON.stringify(await response.json()));
  }
} else if (mode === 'untrusted-register') {
  const response = await fetch('http://127.0.0.1:' + port + '/register', {
    method: 'POST',
    headers: bridgeHeaders('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    body: JSON.stringify({ profile: { id: 'untrusted-profile', enabled: true, worker_enabled_updated_at: Date.now() } })
  });
  console.log(JSON.stringify({ status: response.status, body: await response.text() }));
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
  assert.equal('recentConversations' in registry.profiles[0], false, 'profile registry must not persist ChatGPT conversation ids');

  const restored = JSON.parse(run('list', seed + 1));
  const profile = restored.profiles.find(item => item.profile_id === 'persist-smoke-profile');
  assert.ok(profile, 'persisted browser profile must survive bridge restart');
  assert.equal(profile.connected, false, 'restored profile is visible but disconnected until heartbeat returns');
  assert.equal(profile.active, false);
  assert.equal(profile.extension_version, '0.5.105');
  assert.deepEqual(profile.recent_conversations, [], 'restored profile must not resurrect stale ChatGPT conversation ids before the next heartbeat');

  const untrusted = JSON.parse(run('untrusted-register', seed + 2));
  assert.equal(untrusted.status, 403, 'only the signed CodexPro extension origin may access the local profile bridge');

  const disabled = JSON.parse(run('disable', seed + 3));
  assert.equal(disabled.activate_status, 409, 'a disabled profile must not become ACTIVE again');
  assert.match(disabled.command_outcome, /^rejected:/, 'commands targeting a disabled profile must fail immediately instead of timing out');
  assert.match(disabled.command_outcome, /disabled|đã tắt|bị tắt/i);
  const disabledRegistry = JSON.parse(readFileSync(path.join(home, 'browser-profiles.json'), 'utf8'));
  assert.equal(disabledRegistry.profiles[0].enabled, false, 'disabled profile metadata must be persisted');
  const disabledSnapshot = JSON.parse(run('list', seed + 4));
  assert.deepEqual(disabledSnapshot.profiles, [], 'disabled profiles must stay hidden after bridge restart');
  assert.deepEqual(disabledSnapshot.disabled_profile_ids, ['persist-smoke-profile'], 'bridge snapshots must identify explicit disabled removals');
  assert.equal(JSON.parse(run('forget', seed + 5)).forgotten, true, 'a stale profile must be removable without reconnecting its extension');
  const forgottenRegistry = JSON.parse(readFileSync(path.join(home, 'browser-profiles.json'), 'utf8'));
  assert.deepEqual(forgottenRegistry.profiles, [], 'forgetting a profile must immediately persist the empty registry');
  const forgottenSnapshot = JSON.parse(run('list', seed + 6));
  assert.deepEqual(forgottenSnapshot.profiles, [], 'a forgotten profile must stay absent after bridge restart');
  assert.deepEqual(forgottenSnapshot.disabled_profile_ids, [], 'forgetting must remove stale disabled metadata too');
  console.log('✓ Browser profile registry survives runtime restart and reconnect state is safe');
} finally {
  rmSync(home, { recursive: true, force: true });
}
