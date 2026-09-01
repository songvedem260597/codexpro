import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { taskUnfinalizedIncident, taskUnfinalizedIncidents } from "../electron/task-unfinalized-diagnostic.mjs";
import { appendDiagnosticLog, readDiagnosticLogs } from "../electron/diagnostic-log.mjs";

const now = Date.parse("2026-09-01T08:00:00.000Z");
const job = {
  job_id: "cpt_aaaaaaaaaaaaaaaaaaaaaaaa",
  worker_id: "chrome-one",
  status: "running",
  title: "Sửa trạng thái chat rảnh",
  kind: "code",
  root: "C:\\repo",
  started_at: "2026-09-01T07:00:00.000Z",
  updated_at: "2026-09-01T07:01:00.000Z",
  required_obligations: ["global_rules"],
  completed_obligations: ["global_rules"],
  missing_obligations: [],
  events: [{ at: "2026-09-01T07:01:00.000Z", type: "bootstrapped" }]
};

const idle = taskUnfinalizedIncident(job, {
  now,
  profiles: [{ profile_id: "chrome-one", connected: true, activity: "idle", current_task_id: job.job_id, current_task_title: job.title, conversation_tabs: [] }]
});
assert.equal(idle, null, "a connected worker that still owns the task must not be treated as unfinalized merely because browser generation is idle during tool work");

const prefixedOwner = taskUnfinalizedIncident({ ...job, worker_id: "browser:chrome-one" }, {
  now,
  profiles: [{ profile_id: "chrome-one", connected: true, activity: "idle", current_task_id: job.job_id, current_task_title: job.title, conversation_tabs: [] }]
});
assert.equal(prefixedOwner, null, "legacy browser:<profile> job ids must resolve to the same live browser profile owner");

const orphaned = taskUnfinalizedIncident(job, {
  now,
  profiles: [{ profile_id: "chrome-one", connected: true, activity: "idle", current_task_id: "", current_task_title: "", conversation_tabs: [] }]
});
assert.equal(orphaned?.category, "task-unfinalized");
assert.equal(orphaned?.details?.classification, "task_unfinalized");
assert.equal(orphaned?.details?.suspected_cause, "browser_task_pointer_missing_without_finalize");
assert.equal(orphaned?.details?.incident_fingerprint, `task-unfinalized:${job.job_id}`);
assert.equal(orphaned?.details?.last_event?.type, "bootstrapped");
assert.ok(orphaned?.details?.stale_ms > 0);

assert.equal(taskUnfinalizedIncident(job, {
  now,
  profiles: [{ profile_id: "chrome-one", connected: true, activity: "working", current_task_id: job.job_id, conversation_tabs: [{ busy: true }] }]
}), null, "a genuinely live task must not be logged as unfinalized");

const superseded = taskUnfinalizedIncidents([job], {
  now,
  profiles: [{ profile_id: "chrome-one", connected: true, activity: "idle", current_task_id: "cpt_bbbbbbbbbbbbbbbbbbbbbbbb", conversation_tabs: [] }]
});
assert.equal(superseded[0]?.details?.suspected_cause, "browser_task_superseded_without_finalize");
assert.equal(taskUnfinalizedIncidents([{ ...job, status: "completed" }], { now }).length, 0);

const managerMain = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
const renderer = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../../src/server.ts", import.meta.url), "utf8");
assert.match(managerMain, /taskUnfinalizedIncidents\(workerJobs[\s\S]*?TASK_UNFINALIZED_REPEAT_MS/, "runtime status must persist throttled unfinalized-task incidents");
assert.match(renderer, /responseTaskId[\s\S]*?getProfileResponse\([\s\S]*?taskId: responseTaskId/, "the renderer must correlate final response reads with the exact task id");
assert.match(server, /args\.action === "get_chat_response"[\s\S]*?finalizeWorkerJob\([\s\S]*?outcome: terminalOutcome/, "terminal Chrome responses must finalize the durable worker job");
assert.match(server, /args\.action === "stop_chat_generation"[\s\S]*?"cancelled"/, "stopped Chrome tasks must finalize as cancelled");

const diagnosticRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-task-unfinalized-"));
try {
  for (let index = 0; index < 2; index += 1) {
    await appendDiagnosticLog(diagnosticRoot, {
      level: "error",
      source: "manager",
      category: "task-unfinalized",
      action: "task-unfinalized-detected",
      message: orphaned.message,
      details: orphaned.details
    });
  }
  const persisted = await readDiagnosticLogs(diagnosticRoot, { category: "task-unfinalized", hours: 24 });
  assert.equal(persisted.entries.length, 2);
  assert.ok(persisted.entries.every((entry) => entry.details?.occurrence_count === 2), "repeated unfinalized-task incidents must expose their occurrence count");
} finally {
  await fsp.rm(diagnosticRoot, { recursive: true, force: true });
}

console.log("✓ Unfinalized task diagnostic smoke test passed");
