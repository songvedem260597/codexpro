import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const worker = readFileSync(new URL('../chrome-extension/service-worker.js', import.meta.url), 'utf8');
const source = worker.slice(worker.indexOf('async function installConnector()'), worker.indexOf('async function checkConnectorInstalled()'));
assert.ok(source.startsWith('async function installConnector()'));

async function runInstall({checked, storedFingerprint = 'same', installerResult = {ok: true}}) {
  let installerCalls = 0;
  const storage = {connectorServerFingerprint: storedFingerprint};
  const chrome = {
    action: {setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {}},
    storage: {local: {get: async () => storage, set: async value => Object.assign(storage, value)}}
  };
  const context = {
    chrome,
    profileInfo: async () => ({}),
    connectorInfo: async () => ({server_url: 'https://example.test/mcp'}),
    connectorFingerprint: async () => 'same',
    openChatGpt: async () => ({id: 1}),
    sendPageMessage: async () => checked,
    sendInstallerMessage: async () => { installerCalls += 1; return installerResult; },
    navigateInstallerTab: async () => {},
    ensureConnectorDetailTab: async () => {},
    probeConnectorEndpoint: async () => ({ok: true})
  };
  const names = Object.keys(context);
  const run = new Function(...names, `let installing = false; ${source}; return installConnector;`)(...Object.values(context));
  let error = '';
  try { await run(); } catch (failure) { error = String(failure.message); }
  return {installerCalls, error};
}

const unknown = await runInstall({checked: {ok: true, installed: false, definition_state: 'inconclusive'}});
assert.equal(unknown.installerCalls, 0, 'unknown verification with an existing fingerprint must not enter create flow');
assert.match(unknown.error, /CODEXPRO_CONNECTOR_VERIFICATION_INCONCLUSIVE/);

const installed = await runInstall({checked: {ok: true, installed: true, definition_state: 'installed'}});
assert.equal(installed.installerCalls, 0, 'confirmed installed connector must not enter create flow');
assert.equal(installed.error, '');

const deleteNotConfirmed = await runInstall({
  checked: {ok: true, deleted: false},
  storedFingerprint: 'older',
  installerResult: {ok: true, migrationRequired: true}
});
assert.equal(deleteNotConfirmed.installerCalls, 1, 'migration must not recreate until Delete is confirmed');
assert.match(deleteNotConfirmed.error, /Chưa xác nhận đã xóa/);

const deleteConfirmed = await runInstall({
  checked: {ok: true, deleted: true},
  storedFingerprint: 'older',
  installerResult: {ok: true, migrationRequired: true}
});
assert.equal(deleteConfirmed.installerCalls, 2, 'confirmed Delete permits exactly one recreate attempt');
assert.equal(deleteConfirmed.error, '');

const duplicateName = await runInstall({
  storedFingerprint: 'older',
  installerResult: {ok: false, error: 'CODEXPRO_CONNECTOR_DUPLICATE_NAME: Connector name already exists'}
});
assert.equal(duplicateName.installerCalls, 1, 'duplicate-name response must not be retried as absence');
assert.match(duplicateName.error, /CODEXPRO_CONNECTOR_DUPLICATE_NAME/);

const checkSource = worker.slice(worker.indexOf('async function checkConnectorInstalled()'), worker.indexOf('let profileEnrichmentInFlight'));
assert.ok(checkSource.startsWith('async function checkConnectorInstalled()'));
async function runCheck(result) {
  const saved = {connectorInstall: {ok: true, message: 'CodexPro READY'}};
  const chrome = {
    tabs: {query: async () => [{id: 2}], update: async () => {}},
    windows: {update: async () => {}},
    storage: {local: {set: async value => Object.assign(saved, value)}}
  };
  const context = {
    chrome,
    profileInfo: async () => ({}),
    connectorInfo: async () => ({}),
    createChatGptTab: async () => ({id: 1, windowId: 1}),
    waitForTab: async () => {},
    sendPageMessage: async () => result,
    auditedRemoveTab: async () => {}
  };
  const run = new Function(...Object.keys(context), `${checkSource}; return checkConnectorInstalled;`)(...Object.values(context));
  let error = '';
  try { await run(); } catch (failure) { error = String(failure.message); }
  return {saved, error};
}

const unknownCheck = await runCheck({ok: true, installed: false, definition_state: 'inconclusive'});
assert.match(unknownCheck.error, /inconclusive/);
assert.equal(unknownCheck.saved.connectorInstall.ok, true, 'unknown verification must not downgrade a READY connector');

const absentCheck = await runCheck({ok: true, installed: false, definition_state: 'absent'});
assert.equal(absentCheck.error, '');
assert.equal(absentCheck.saved.connectorInstall.ok, false, 'explicit absence may mark the connector missing');

console.log('connector verification smoke passed');
