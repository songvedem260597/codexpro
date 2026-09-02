import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shouldCheckProfileConnector } from '../manager/src/profile-connector-check.js';

const installer = readFileSync(new URL('../chrome-extension/connector-installer.js', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../src/browserExtensionBridge.ts', import.meta.url), 'utf8');
function section(source, start, end) {
  assert.ok(source.includes(start) && source.includes(end), `missing section: ${start}`);
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}
const matches = Function(`${section(installer, 'function connectorActionLabelMatches', 'function installedConnectorAction')}; return connectorActionLabelMatches;`)();
assert.equal(matches('thao tac voi plugin', '', true), false, 'another plugin actions menu must not prove CodexPro is installed');
assert.equal(matches('actions for codexpro', '', true), true);
assert.equal(matches('', 'codexpro allow all', true), true);
assert.equal(matches('', 'codexpro conversation', false), false);

const findAction = Function('document', 'location', 'settingsDialog', 'visible', 'candidates', 'connectorActionLabelMatches', `${section(installer, 'function installedConnectorAction', 'function connectorAlreadyListed')}; return installedConnectorAction;`);
const historicalButton = { closest: () => null, getAttribute: () => '', matches: () => true, innerText: 'CodexPro old tool result' };
assert.equal(findAction({ querySelector: () => null }, { pathname: '/c/old' }, () => null, () => true, () => [historicalButton], matches)(), null,
  'historical interactive CodexPro text outside plugin settings must not be installation evidence');

const connectionStatus = Function(`${section(installer, 'function connectorConnectionStatus', 'async function checkConnectorConnection')}; return connectorConnectionStatus;`)();
for (const value of ['connection disconnected', 'connection not connected', 'ket noi chua ket noi', 'connection connect', 'ket noi ket noi']) {
  assert.equal(connectionStatus(value), 'missing', value);
}
assert.equal(connectionStatus('connection connected'), 'connected');
assert.equal(connectionStatus('ket noi da ket noi'), 'connected');
assert.equal(connectionStatus('connection loading'), 'unknown');
const detailVisible = Function('visible', 'text', 'hasConnectionMarker', `${section(installer, 'function connectorDetailVisible', 'function connectorConnectionStatus')}; return connectorDetailVisible;`)(() => true, element => element?.value || '', value => value.includes('connection'));
assert.equal(detailVisible({ value: 'settings codexpro other connection connected', querySelectorAll: () => [{ value: 'Other' }] }), false,
  'another plugin detail with CodexPro in the sidebar must not pass identity verification');
assert.equal(detailVisible({ value: 'codexpro connection connected', querySelectorAll: () => [{ value: 'codexpro' }] }), true);

const merge = Function('profile', 'source', section(bridge, '  if (source.connector_install && typeof source.connector_install', '  profile.lastSeen = Date.now();'));
const profile = { connectorInstalled: true, connectorCheckedAt: '2026-09-03T01:00:00Z', connectorServerFingerprint: 'bound' };
merge(profile, { connector_install: { ok: false, at: '2026-09-03T02:00:00Z', message: 'Missing' }, connector_server_fingerprint: 'bound' });
assert.equal(profile.connectorInstalled, false);
merge(profile, { connector_install: { ok: true, at: '2026-09-03T02:00:00Z' } });
assert.equal(profile.connectorInstalled, false, 'a same-timestamp positive must not supersede a negative');
merge(profile, { connector_install: { ok: true, at: '2026-09-03T01:00:00Z', message: 'READY' }, connector_server_fingerprint: 'stale' });
assert.equal(profile.connectorInstalled, false, 'an old positive heartbeat must not resurrect READY after a newer negative check');
assert.equal(profile.connectorServerFingerprint, 'bound', 'installation evidence and its fingerprint must be merged atomically');
merge(profile, { connector_install: { ok: true, message: 'READY' } });
assert.equal(profile.connectorInstalled, false, 'undated legacy positives must not replace dated observations');
merge(profile, { connector_install: { ok: true, at: '2026-09-03T03:00:00Z', message: 'READY' }, connector_server_fingerprint: 'new' });
assert.equal(profile.connectorInstalled, true, 'a genuinely newer successful setup may promote READY');
assert.equal(profile.connectorServerFingerprint, 'new');

const now = Date.parse('2026-09-03T03:00:00Z');
const fresh = { connected: true, connector_checked_at: new Date(now - 5000).toISOString() };
assert.equal(shouldCheckProfileConnector(fresh, { now }), true, 'revalidate cached success once after Manager launch');
assert.equal(shouldCheckProfileConnector(fresh, { now, safe: false }), false, 'never interrupt a busy worker');
assert.equal(shouldCheckProfileConnector(fresh, { now, lastCheck: now - 1000 }), false, 'throttle repeated checks');
assert.equal(shouldCheckProfileConnector(fresh, { now, lastCheck: now - 120000 }), false, 'fresh session verification needs no repeat');
assert.equal(shouldCheckProfileConnector({ ...fresh, connector_checked_at: '2026-09-03T01:00:00Z' }, { now, lastCheck: now - 120000 }), true, 'do not trust a cached success for 24 hours');

const summarize = Function('profile', 'expectedFingerprint', 'CONNECTOR_VERIFICATION_TTL_MS', `
  const observedCodexProToolActivity = false;
  ${section(bridge, '      const connectorProfileBound = expectedFingerprint', '      return {\n      profile_id:')}
  return { connectorInstalled, connectorVerificationRequired, connectorUpdateRequired, connectorMessage };
`);
const currentProfile = { connectorInstalled: true, connectorVerificationState: 'connected', connectorServerFingerprint: 'bound', connectorCheckedAt: new Date().toISOString(), connectorMessage: 'CodexPro READY' };
assert.equal(summarize(currentProfile, 'bound', 900000).connectorInstalled, true);
assert.equal(summarize({ ...currentProfile, connectorVerificationState: undefined }, 'bound', 900000).connectorInstalled, false, 'legacy list-only READY must be reverified even if its timestamp is recent');
assert.equal(summarize({ ...currentProfile, connectorVerificationState: 'missing' }, 'bound', 900000).connectorInstalled, false, 'contradictory missing/ok payload must fail closed');
assert.equal(summarize({ ...currentProfile, connectorCheckedAt: '2020-01-01T00:00:00Z' }, 'bound', 900000).connectorInstalled, false, 'expired success must not be displayed as READY');
assert.equal(summarize({ ...currentProfile, connectorInstalled: false }, 'bound', 900000).connectorUpdateRequired, false, 'missing/disconnected is not a URL migration and must not trigger automatic reinstallation');
assert.equal(summarize({ ...currentProfile, connectorVerificationState: 'unknown' }, 'old', 900000).connectorUpdateRequired, false, 'unknown status must not automatically delete/recreate a connector');
assert.equal(shouldCheckProfileConnector({ ...fresh, connector_verification_required: true }, { now, lastCheck: now - 61000 }), true, 'retry an inconclusive check after one minute instead of treating it as verified absence');

const worker = readFileSync(new URL('../chrome-extension/service-worker.js', import.meta.url), 'utf8');
const checkSource = section(worker, 'async function checkConnectorInstalled()', 'async function pollLoop()');
const ownsUrl = Function(`${section(worker, 'function connectorCheckOwnsUrl', 'async function checkConnectorInstalled')}; return connectorCheckOwnsUrl;`)();
assert.equal(ownsUrl('https://chatgpt.com/c/other-conversation'), false);
assert.equal(ownsUrl('https://chatgpt.com/#settings/Plugins/plugin_test'), true);
async function runCheck({ listed = true, connected = true, busy = false, failure = '', navigated = false, unsafeDraft = false } = {}) {
  const writes = [], calls = [];
  const deps = {
    profileInfo: async () => ({ id: 'fixture', connector_install: { ok: true } }),
    tabList: async () => [{ busy }], installing: false,
    connectorInfo: async () => ({ settings_url: 'https://chatgpt.com/plugins?q=CodexPro' }),
    chatGptTabLimit: async () => unsafeDraft ? 1 : 3, MAC_MAX_CHATGPT_TABS: 1,
    chrome: { tabs: { query: async () => unsafeDraft ? [{id: 1, url: 'https://chatgpt.com/c/draft'}] : [], get: async () => ({ url: navigated && calls.length ? 'https://chatgpt.com/c/user-destination' : 'https://chatgpt.com/plugins' }), update: async () => {} }, windows: { update: async () => {} }, scripting: { executeScript: async () => [{ result: { safe: !unsafeDraft } }] }, storage: { local: { set: async value => writes.push(value) } } },
    promiseWithTimeout: async promise => promise, probeConnectorCheckSafetyPage: () => {}, connectorCheckOwnsUrl: ownsUrl,
    createChatGptTab: async () => ({ id: 7 }), waitForTab: async () => {},
    sendPageMessage: async (_id, message) => {
      calls.push(message.type);
      if (failure) throw new Error(failure);
      return message.type === 'codexpro-check-connector'
        ? { ok: true, installed: listed, diagnostic: { matched: listed } }
        : { ok: true, connected, connection_state: connected ? 'connected' : 'missing', message: connected ? 'CodexPro READY' : 'Chưa kết nối', diagnostic: { connection_state: connected ? 'connected' : 'missing' } };
    },
    navigateInstallerTab: async () => calls.push('navigate_detail'), ensureConnectorDetailTab: async () => {},
    removeTabWithReason: async (_id, reason) => calls.push(reason), isChatGptTabUrl: () => false
  };
  const check = Function('deps', `const {${Object.keys(deps).join(',')}} = deps; ${checkSource}; return checkConnectorInstalled;`)(deps);
  let result, error;
  try { result = await check(); } catch (caught) { error = caught; }
  return { result, error, writes, calls };
}
let check = await runCheck({ listed: false });
assert.equal(check.result.installed, false);
assert.equal(check.calls.includes('navigate_detail'), false, 'a missing definition must not open another plugin or connect automatically');
check = await runCheck({ connected: false });
assert.equal(check.result.installed, false, 'a listed but disconnected definition is not READY');
assert.equal(check.writes.at(-1).connectorInstall.ok, false);
assert.equal(check.writes.at(-1).connectorInstall.verification_state, 'missing');
check = await runCheck();
assert.equal(check.result.installed, true, 'READY requires both list and connection evidence');
assert.equal(check.result.diagnostic.connection_state, 'connected');
check = await runCheck({ failure: 'renderer timeout' });
assert.match(check.error.message, /renderer timeout/);
assert.equal(check.writes.at(-1).connectorInstall.ok, false, 'failed verification must invalidate cached READY');
assert.equal(check.writes.at(-1).connectorInstall.verification_state, 'unknown', 'a timeout is not proof of absence');
assert.match(check.writes.at(-1).connectorInstall.message, /Chưa xác minh/);
assert.ok(check.calls.includes('connector_check_cleanup'), 'failed checks must clean up the verification tab');
check = await runCheck({ busy: true });
assert.equal(check.result.deferred, true);
assert.equal(check.calls.length, 0, 'busy workers must not be navigated or have tabs closed');
assert.equal(check.writes.length, 0, 'a deferred check is not negative installation evidence');
check = await runCheck({ unsafeDraft: true });
assert.equal(check.result.deferred, true);
assert.equal(check.calls.length, 0, 'do not navigate the sole Mac tab containing a draft or attachment');
check = await runCheck({ navigated: true });
assert.match(check.error.message, /trang khác/);
assert.equal(check.calls.includes('connector_check_cleanup'), false, 'do not close a tab the user navigated away from the check');

let deadlineCalls = 0;
const sendPage = Function('chrome', 'promiseWithTimeout', 'DOM_ACTION_TIMEOUT_MS', `${section(worker, 'async function sendPageMessage(', 'async function sendInstallerMessage(')}; return sendPageMessage;`)(
  { tabs: { sendMessage: async () => { deadlineCalls += 1; } } }, async promise => promise, 5000);
await assert.rejects(sendPage(1, {}, 30000, Date.now() - 1), /Hết thời gian/);
assert.equal(deadlineCalls, 0, 'an expired check must not send UI messages or reinject a script');

console.log('Connector verification smoke passed');
