import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const content = readFileSync(join(here, 'content.js'), 'utf8');
const network = readFileSync(join(here, 'upload-network.js'), 'utf8');
const diagnosticsUi = readFileSync(join(here, 'diagnostics-ui.js'), 'utf8');
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));

assert.equal(manifest.content_scripts?.[0]?.run_at, 'document_start', 'network hook must install at document_start');
assert.deepEqual(
  manifest.content_scripts?.[0]?.js,
  ['upload-network.js'],
  'document_start script must contain only the network hook'
);
assert.equal(manifest.content_scripts?.[0]?.world, 'MAIN', 'network hook must run in ChatGPT MAIN world');
assert.equal(manifest.content_scripts?.[1]?.run_at, 'document_idle', 'UI scripts should wait for the document');
assert.deepEqual(
  manifest.content_scripts?.[1]?.js,
  ['content.js', 'diagnostics-ui.js'],
  'upload UI and diagnostics UI must load after the early hook'
);
assert.equal(manifest.content_scripts?.[1]?.world, 'MAIN', 'upload UI must run in ChatGPT MAIN world');

assert.match(content, /codexproLocalSourceReaderBaselinesV2/, 'confirmed baseline must use V2 storage');
assert.match(content, /codexproLocalSourceReaderV2/, 'snapshot history must use IndexedDB');
assert.match(content, /Upload thay đổi/, 'changed-only button must exist');
assert.match(content, /Upload Full/, 'full button must exist');
assert.match(content, /Lịch sử/, 'history button must exist');
assert.match(content, /monitor\.waitForSnapshot\(file, startedAt, UPLOAD_TIMEOUT_MS\)/, 'baseline flow must wait for network confirmation');
assert.match(content, /canAdvanceBaselineFromRecord/, 'history retry must guard against baseline rollback');

const attachConfirmStart = content.indexOf('async function attachAndConfirm');
const markConfirmedStart = content.indexOf('async function markRecordConfirmed');
assert.ok(attachConfirmStart >= 0 && markConfirmedStart >= 0, 'confirmation functions must exist');
assert.ok(
  content.indexOf('saveBaseline(', markConfirmedStart) > markConfirmedStart,
  'baseline save belongs to confirmed-record path'
);

assert.match(network, /process_upload_stream/, 'network monitor must watch process upload stream');
assert.match(network, /uploaded\$\//, 'network monitor must watch uploaded finalize path');
assert.match(network, /explicitStatus === 'success'/, 'legacy finalize must require explicit success');
assert.match(network, /stream\.success/, 'process stream must require a success SSE event');
assert.doesNotMatch(
  network,
  /kind:\s*'confirmed'[^\n]{0,180}createPath/,
  'POST /files create response must never be confirmation evidence'
);

assert.match(network, /codexproLocalSourceUploadDiagnosticsV1/, 'network diagnostics must persist across reload');
assert.match(network, /network-request/, 'diagnostics must record upload requests');
assert.match(network, /network-response/, 'diagnostics must record upload responses');
assert.match(network, /snapshot-timeout/, 'diagnostics must preserve timeout context');
assert.match(network, /fetchHookActive/, 'diagnostics must report hook health');
assert.match(network, /\[redacted\]/, 'diagnostics must redact sensitive fields');
assert.match(diagnosticsUi, /Sao chép JSON/, 'diagnostic UI must support copying logs');
assert.match(diagnosticsUi, /Tải JSON/, 'diagnostic UI must support downloading logs');
assert.match(diagnosticsUi, /Xóa log/, 'diagnostic UI must support clearing logs');
assert.match(diagnosticsUi, /Log/, 'diagnostic Log button must exist');

console.log('LOCAL_SOURCE_READER_SMOKE=PASS');
