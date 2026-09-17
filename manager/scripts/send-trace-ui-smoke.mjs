import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSendTraceTimeline } from "../electron/send-trace-log.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const managerRoot = path.resolve(here, "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-send-trace-smoke-"));

function line({ event, at, component, sequence, traceId, details = {} }) {
  return JSON.stringify({
    schema_version: 1,
    event,
    event_at: at,
    received_at: at,
    writer_component: component,
    writer_sequence: sequence,
    details: { send_trace_id: traceId, ...details }
  });
}

try {
  const failedId = "send_failure_fixture";
  const successId = "send_success_fixture";
  await fs.writeFile(path.join(tempRoot, "send-trace-manager.jsonl"), [
    line({ event: "renderer_send_started", at: "2026-09-18T00:00:00.000Z", component: "manager", sequence: 1, traceId: failedId, details: { profile_id: "e7", conversation_id: "historical" } }),
    line({ event: "ipc_accepted", at: "2026-09-18T00:00:00.010Z", component: "manager", sequence: 2, traceId: failedId, details: { ipc_call_id: "ipc-fail", profile_id: "e7", conversation_id: "historical" } }),
    line({ event: "send_finished", at: "2026-09-18T00:00:01.000Z", component: "manager", sequence: 3, traceId: failedId, details: { ipc_call_id: "ipc-fail", attempt_id: "attempt-fail", command_id: "command-fail", submission_state: "failed", terminal_outcome: "failed", network_acknowledged: false } }),
    line({ event: "renderer_send_started", at: "2026-09-18T00:01:00.000Z", component: "manager", sequence: 4, traceId: successId, details: { profile_id: "e7", conversation_id: "historical" } }),
    line({ event: "send_finished", at: "2026-09-18T00:01:01.200Z", component: "manager", sequence: 5, traceId: successId, details: { ipc_call_id: "ipc-success", attempt_id: "attempt-success", command_id: "command-success", submission_state: "submitted", terminal_outcome: "success", network_acknowledged: true } })
  ].join("\n") + "\n", "utf8");
  await fs.writeFile(path.join(tempRoot, "send-trace-bridge.jsonl"), [
    line({ event: "extension_received", at: "2026-09-18T00:00:00.020Z", component: "bridge", sequence: 1, traceId: failedId, details: { ipc_call_id: "ipc-fail", command_id: "command-fail", conversation_id: "historical" } }),
    line({ event: "tab_selected", at: "2026-09-18T00:00:00.050Z", component: "bridge", sequence: 2, traceId: failedId, details: { ipc_call_id: "ipc-fail", command_id: "command-fail", attempt_id: "attempt-fail", conversation_id: "historical", tab_id: 42 } }),
    line({ event: "prepare_error", at: "2026-09-18T00:00:00.300Z", component: "bridge", sequence: 3, traceId: failedId, details: { ipc_call_id: "ipc-fail", command_id: "command-fail", attempt_id: "attempt-fail", conversation_id: "historical", tab_id: 42, error_code: "PREPARE_RECOVERABLE", composer_visible: false, composer_wait_ms: 250, remaining_deadline_ms: 3500 } }),
    line({ event: "prepare_error", at: "2026-09-18T00:01:00.150Z", component: "bridge", sequence: 4, traceId: successId, details: { ipc_call_id: "ipc-success", command_id: "command-success", attempt_id: "attempt-success", conversation_id: "historical", tab_id: 43, error_code: "PREPARE_RECOVERABLE" } }),
    line({ event: "draft_verified", at: "2026-09-18T00:01:00.600Z", component: "bridge", sequence: 5, traceId: successId, details: { ipc_call_id: "ipc-success", command_id: "command-success", attempt_id: "attempt-success", conversation_id: "historical", tab_id: 43 } }),
    line({ event: "network_ack", at: "2026-09-18T00:01:01.000Z", component: "bridge", sequence: 6, traceId: successId, details: { ipc_call_id: "ipc-success", command_id: "command-success", attempt_id: "attempt-success", conversation_id: "historical", tab_id: 43, submission_state: "submitted", ack_source: "generation" } })
  ].join("\n") + "\n", "utf8");

  const failed = await readSendTraceTimeline(tempRoot, { send_trace_id: failedId });
  assert.equal(failed.status, "FAILURE");
  assert.equal(failed.first_failed_stage, "prepare_error");
  assert.equal(failed.last_successful_stage, "tab_selected");
  assert.equal(failed.total_ms, 1000);
  assert.equal(failed.events.find((event) => event.event === "prepare_error")?.relevant?.composer_visible, false);
  assert.equal(failed.events.find((event) => event.event === "prepare_error")?.relevant?.composer_wait_ms, 250);
  assert.equal(failed.events.find((event) => event.event === "tab_selected")?.tab_id, 42);

  const success = await readSendTraceTimeline(tempRoot, { send_trace_id: successId });
  assert.equal(success.status, "SUCCESS", "a recoverable intermediate prepare_error must not override terminal send success");
  assert.equal(success.first_failed_stage, "");
  assert.equal(success.last_successful_stage, "send_finished");
  assert.equal(success.total_ms, 1200);
  assert.equal(success.events.find((event) => event.event === "network_ack")?.relevant?.ack_source, "generation");

  const preload = await fs.readFile(path.join(managerRoot, "electron", "preload.cjs"), "utf8");
  const ipc = await fs.readFile(path.join(managerRoot, "electron", "ipc", "diagnostic-log-ipc.mjs"), "utf8");
  const hook = await fs.readFile(path.join(managerRoot, "src", "hooks", "use-chat-send-actions.js"), "utf8");
  const composer = await fs.readFile(path.join(managerRoot, "src", "features", "chat", "chat-request-composer.jsx"), "utf8");
  assert.match(preload, /getSendTrace:\s*\(options\)\s*=>\s*invoke\("codexpro:get-send-trace"/);
  assert.match(ipc, /codexpro:get-send-trace/);
  assert.match(hook, /getSendTrace\(\{\s*send_trace_id:\s*sendTraceId/);
  assert.match(composer, /Full send trace/);
  assert.match(composer, /Copy trace/);
  assert.match(composer, /first_failed_stage/);
  assert.match(composer, /last_successful_stage/);

  console.log("send-trace-ui-smoke: PASS");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
