import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codexpro-send-trace-'));
const port = 19000 + (process.pid % 1000);
process.env.CODEXPRO_HOME = tempHome;
process.env.CODEXPRO_BROWSER_EXTENSION_BRIDGE_PORT = String(port);
process.env.CODEXPRO_SEND_TRACE_TEST_TIMEOUT_MS = '120';

const bridge = await import('../src/browserExtensionBridge.ts');
const { createBridgeSendTraceLogger, SEND_TRACE_LIMITS } = await import('../src/sendTraceLog.ts');
bridge.ensureBrowserExtensionBridge();

const base = `http://127.0.0.1:${port}`;
const headers = {
  'content-type': 'application/json',
  'x-codexpro-extension': 'profile-bridge-v1',
  'origin': 'chrome-extension://gndipignbnipohooclcbhjliikamjlpl'
};
const profile = { id: 'trace-test-profile', enabled: true, label: 'Trace Test', version: 'test' };
const taskId = 'cpt_0123456789abcdef01234567';
const conversationId = '12345678-abcd-1234-abcd-1234567890ab';

async function post(endpoint: string, body: any) {
  const response = await fetch(`${base}${endpoint}`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(response.ok, true, `${endpoint} should return OK, got ${response.status}`);
  return await response.json().catch(() => ({}));
}
async function poll() {
  return await post('/poll', { profile, active: true, tabs: [], recent_conversations: [] });
}
async function sleep(ms: number) { await new Promise((resolve) => setTimeout(resolve, ms)); }
async function traceLines() {
  await sleep(30);
  const file = path.join(tempHome, 'send-trace-bridge.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
function eventsFor(lines: any[], traceId: string) {
  return lines.filter((item) => item?.details?.send_trace_id === traceId);
}

await post('/register', { profile, tab_inventory: [] });

// Success: queued/dispatched must exist before the command result resolves.
{
  const traceId = 'send_trace_success';
  const ipcId = 'ipc_trace_success';
  const promise = bridge.runBrowserExtensionCommand('trace_success', { send_trace_id: traceId, ipc_call_id: ipcId, task_id: taskId, conversation_id: conversationId }, profile.id);
  const message = await poll();
  assert.ok(message.command?.id, 'success command must be delivered');
  await sleep(35);
  const beforeResult = eventsFor(await traceLines(), traceId);
  assert.ok(beforeResult.some((item) => item.event === 'bridge_queued'), 'bridge_queued must be persisted before result');
  assert.ok(beforeResult.some((item) => item.event === 'bridge_dispatched'), 'bridge_dispatched must be persisted before result');
  await post('/trace', { event: 'extension_received', event_at: new Date().toISOString(), send_trace_id: traceId, ipc_call_id: ipcId, command_id: message.command.id, profile_id: profile.id, conversation_id: conversationId, task_id: taskId, source_component: 'extension', source_run_id: 'ext-test-success', source_sequence: 1, source_elapsed_ms: 1 });
  await post('/result', { profile, command_id: message.command.id, result: { ok: true, submission_state: 'submitted', network_acknowledged: true, attempt_id: 'attempt-success' } });
  const result = await promise;
  assert.equal(result.command_id, message.command.id, 'success result must preserve command_id');
  assert.equal(result.send_trace_id, traceId, 'success result must preserve trace id');
  const lines = eventsFor(await traceLines(), traceId);
  assert.ok(lines.some((item) => item.event === 'extension_received'), 'extension_received must retain trace');
  assert.ok(lines.some((item) => item.event === 'result_received' && item.details.handled === true), 'success result_received must be handled');
}

// Error: command/trace ids remain attached to the rejection.
{
  const traceId = 'send_trace_error';
  const ipcId = 'ipc_trace_error';
  const promise = bridge.runBrowserExtensionCommand('trace_error', { send_trace_id: traceId, ipc_call_id: ipcId, task_id: taskId, conversation_id: conversationId }, profile.id).then((value) => ({ value, error: null }), (error) => ({ value: null, error }));
  const message = await poll();
  await post('/result', { profile, command_id: message.command.id, error: { name: 'TraceError', message: 'synthetic error', code: 'TRACE_SYNTHETIC', stage: 'execute', details: { attempt_id: 'attempt-error' } } });
  const { error } = await promise;
  assert.ok(error, 'error command must reject');
  assert.equal(error?.details?.command_id, message.command.id, 'error result must preserve command_id');
  assert.equal(error?.details?.send_trace_id, traceId, 'error result must preserve send_trace_id');
  const lines = eventsFor(await traceLines(), traceId);
  assert.ok(lines.some((item) => item.event === 'result_received' && item.details.result_kind === 'error'), 'error result_received must be traced');
}

// Timeout + late result: promise stays rejected; late result is evidence only.
{
  const traceId = 'send_trace_timeout';
  const ipcId = 'ipc_trace_timeout';
  const promise = bridge.runBrowserExtensionCommand('send_chat_request', { send_trace_id: traceId, ipc_call_id: ipcId, task_id: taskId, conversation_id: conversationId }, profile.id).then((value) => ({ value, error: null }), (error) => ({ value: null, error }));
  const message = await poll();
  const { error: timeoutError } = await promise;
  assert.ok(timeoutError, 'timeout command must reject');
  assert.equal(timeoutError.code, 'BRIDGE_TIMEOUT');
  assert.equal(timeoutError?.details?.command_id, message.command.id, 'timeout must preserve command_id');
  assert.equal(timeoutError?.details?.submission_state, 'uncertain', 'dispatched send timeout must be uncertain');
  await post('/result', { profile, command_id: message.command.id, result: { ok: true, submission_state: 'submitted', network_acknowledged: true, attempt_id: 'attempt-late' } });
  const lines = eventsFor(await traceLines(), traceId);
  assert.ok(lines.some((item) => item.event === 'bridge_timeout' && item.details.command_id === message.command.id), 'bridge_timeout must retain correlation');
  assert.ok(lines.some((item) => item.event === 'late_result' && item.details.command_id === message.command.id && item.details.handled === false), 'late_result must be logged as ignored/unhandled');
  assert.equal(lines.filter((item) => item.event === 'result_received').length, 0, 'late result must not be treated as normal result_received');
}

// Logger stays bounded and non-blocking when flooded.
{
  const logger = createBridgeSendTraceLogger('bridge-bound-test');
  const started = performance.now();
  for (let index = 0; index < SEND_TRACE_LIMITS.max_queue_records * 3; index += 1) {
    logger.emit('noise_stage', { send_trace_id: `bounded-${index}`, note: 'x'.repeat(200) });
  }
  const elapsed = performance.now() - started;
  const stats = logger.stats();
  assert.ok(stats.queued_records <= SEND_TRACE_LIMITS.max_queue_records, 'logger queue records must remain bounded');
  assert.ok(stats.queued_bytes <= SEND_TRACE_LIMITS.max_queue_bytes, 'logger queue bytes must remain bounded');
  assert.ok(stats.dropped_events > 0, 'logger must count dropped_events when the bounded queue overflows');
  assert.ok(elapsed < 2500, `logger emit path should not block on disk (${elapsed.toFixed(1)}ms)`);
}

// Source-level regression guards for extension/manager-only semantics that cannot be executed without Chrome/Electron.
{
  const extension = fs.readFileSync('chrome-extension/service-worker.js', 'utf8');
  const manager = fs.readFileSync('manager/electron/main.mjs', 'utf8');
  const renderer = fs.readFileSync('manager/src/hooks/use-chat-send-actions.js', 'utf8');
  for (const event of ['extension_received','tab_selected','prepare_started','draft_verified','submit_dispatched','network_ack','prepare_error','submit_error','network_ack_timeout']) {
    assert.ok(extension.includes(`'${event}'`) || extension.includes(`\"${event}\"`), `extension must contain ${event}`);
  }
  const networkFn = extension.indexOf('const resultForNetwork=async');
  const ackInNetwork = extension.indexOf("postTrace(command,'network_ack'", networkFn);
  const cleanupInNetwork = extension.indexOf('pendingConversationByTab.delete(tab.id)', networkFn);
  assert.ok(networkFn >= 0 && ackInNetwork > networkFn && ackInNetwork < cleanupInNetwork, 'network ACK must be logged before post-ACK cleanup');
  assert.ok(extension.includes("error.stage='post_ack'") && extension.includes('network_acknowledged:true'), 'post-ACK error must retain ACK evidence');
  assert.ok(manager.includes('if (submissionState === "failed") return { level: "error"'), 'submission_state=failed must log as error');
  assert.ok(manager.includes('Trạng thái gửi ChatGPT chưa xác định'), 'uncertain must use uncertain semantics');
  assert.equal(manager.includes('ChatGPT đã nhận yêu cầu gửi'), false, 'handler resolve alone must not claim ChatGPT received');
  const startIndex = renderer.indexOf('renderer_send_started');
  const inputGuardIndex = renderer.indexOf('if (!text && !attachments.length)', startIndex);
  assert.ok(startIndex >= 0 && inputGuardIndex > startIndex, 'renderer start event must be emitted before send handler can return');
  for (const event of ['ipc_accepted','task_gate_completed','task_gate_rejected','send_finished']) assert.ok(manager.includes(`\"${event}\"`), `manager must contain ${event}`);
}

const finalLines = await traceLines();
assert.ok(finalLines.some((item) => item.event === 'runtime_identity' && item.details.artifact_sha256), 'bridge runtime identity must hash the running artifact once');
assert.ok(finalLines.every((item) => 'event_at' in item && 'received_at' in item && 'written_at' in item), 'persisted events must distinguish event/receive/write timestamps');
assert.ok(finalLines.every((item) => Number.isFinite(item.writer_sequence) && Number.isFinite(item.writer_elapsed_ms)), 'persisted events must carry process-local sequence and monotonic elapsed');

console.log('send-trace regression PASS');
console.log(JSON.stringify({ tempHome, events: finalLines.length, limits: SEND_TRACE_LIMITS }, null, 2));
process.exit(0);
