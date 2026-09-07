import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const content = readFileSync(join(here, 'content.js'), 'utf8');
const network = readFileSync(join(here, 'upload-network.js'), 'utf8');
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));

assert.deepEqual(
  manifest.content_scripts?.[0]?.js,
  ['upload-network.js', 'content.js'],
  'network hook must load before upload UI logic'
);
assert.equal(manifest.content_scripts?.[0]?.world, 'MAIN', 'network hook must run in ChatGPT MAIN world');
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

console.log('LOCAL_SOURCE_READER_SMOKE=PASS');
