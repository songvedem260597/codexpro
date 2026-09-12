import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const content = readFileSync(join(here, 'content.js'), 'utf8');
const taskUpload = readFileSync(join(here, 'task-upload.js'), 'utf8');
const network = readFileSync(join(here, 'upload-network.js'), 'utf8');
const diagnosticsUi = readFileSync(join(here, 'diagnostics-ui.js'), 'utf8');
const zipUpload = readFileSync(join(here, 'zip-upload.js'), 'utf8');
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
  ['zip-upload.js', 'content.js', 'task-upload.js', 'diagnostics-ui.js'],
  'ZIP transformer must load before source/task upload UI and diagnostics UI'
);
assert.equal(manifest.content_scripts?.[1]?.world, 'MAIN', 'upload UI must run in ChatGPT MAIN world');

assert.match(content, /codexproLocalSourceReaderBaselinesV2/, 'confirmed baseline must use V2 storage');
assert.match(content, /codexproLocalSourceReaderV2/, 'snapshot history must use IndexedDB');
assert.match(content, /Upload thay đổi/, 'changed-only button must exist');
assert.match(content, /Upload Full/, 'full button must exist');
assert.match(content, /Lịch sử/, 'history button must exist');
assert.match(content, /monitor\.waitForSnapshot\(file, startedAt, UPLOAD_TIMEOUT_MS\)/, 'baseline flow must wait for network confirmation');
assert.match(content, /canAdvanceBaselineFromRecord/, 'history retry must guard against baseline rollback');

assert.match(taskUpload, /Upload Task/, 'task upload button must exist');
assert.match(taskUpload, /rootHandle\?\.name[^\n]+task-tracking/, 'task upload must require the task-tracking root');
assert.match(taskUpload, /new Set\(\['json', 'md', 'txt'\]\)/, 'task upload must only accept task text formats');
assert.match(taskUpload, /state \|\| ''\)\.toUpperCase\(\) === 'COMPLETED'/, 'completed task filter must inspect state');
assert.match(taskUpload, /parsed\.finalized === true/, 'completed task filter must require finalized=true');
assert.match(taskUpload, /MAX_TASK_FILES = 100/, 'task upload must cap file count');
assert.match(taskUpload, /MAX_TASK_FILE_BYTES = 1024 \* 1024/, 'task upload must cap each file size');
assert.match(taskUpload, /MAX_TASK_TOTAL_BYTES = 10 \* 1024 \* 1024/, 'task upload must cap total size');
assert.match(taskUpload, /monitor\.waitForSnapshot\(file, startedAt, UPLOAD_TIMEOUT_MS\)/, 'task upload must wait for network confirmation');
assert.match(taskUpload, /codexpro-unfinished-tasks-/, 'task upload must use a task-only attachment name');
assert.doesNotMatch(taskUpload, /saveBaseline\s*\(/, 'task upload must never advance source baseline');
assert.doesNotMatch(taskUpload, /markRecordConfirmed\s*\(/, 'task upload must not reuse source-baseline confirmation state');
assert.doesNotMatch(taskUpload, /putHistory\s*\(/, 'task upload must not write source snapshot history');
assert.doesNotMatch(taskUpload, /requestSubmit\s*\(|\.submit\s*\(/, 'task upload must not auto-send the composer');

assert.match(zipUpload, /application\/zip/, 'snapshot transformer must emit ZIP files');
assert.match(zipUpload, /_codexpro\/manifest\.txt/, 'ZIP must include a snapshot manifest');
assert.match(zipUpload, /0x04034b50/, 'ZIP must contain local file headers');
assert.match(zipUpload, /0x02014b50/, 'ZIP must contain central directory headers');
assert.match(zipUpload, /0x06054b50/, 'ZIP must contain end-of-central-directory record');
assert.match(zipUpload, /-local-source-\(\?:full\|delta\)-r/, 'ZIP conversion must target generated local source snapshots only');
assert.doesNotMatch(zipUpload, /codexpro-unfinished-tasks/, 'task attachment must never be rewritten as a source ZIP snapshot');

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
assert.match(network, /stream\.success/, 'process stream must require a success event');
assert.match(network, /trimmed\.startsWith\('data:'\)/, 'process stream parser must accept both SSE data lines and plain NDJSON lines');
assert.match(network, /event === 'file\.processing\.completed'/, 'ChatGPT file.processing.completed must count as upload success');
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
