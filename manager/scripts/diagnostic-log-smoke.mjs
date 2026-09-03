import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendDiagnosticLog,
  clearDiagnosticLogs,
  flushDiagnosticLogs,
  pruneDiagnosticLogs,
  readDiagnosticLogs,
  trimToByteLimit
} from "../electron/diagnostic-log.mjs";

const trimFixture = Array.from({ length: 12 }, (_, index) => ({ id: index, payload: "x" }));
assert.deepEqual(trimToByteLimit(trimFixture).map((entry) => entry.id), trimFixture.map((entry) => entry.id), "byte trimming must preserve chronological order");
const trimStartedAt = Date.now();
trimToByteLimit(Array.from({ length: 30_000 }, (_, index) => ({ id: index, payload: "diagnostic" })));
assert.ok(Date.now() - trimStartedAt < 2_500, "byte trimming must remain linear for large diagnostic logs");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-diagnostic-"));

try {
  const file = path.join(root, "manager-diagnostic.jsonl");
  const expired = {
    schema_version: 1,
    timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    level: "error",
    source: "old",
    category: "runtime",
    action: "expired",
    message: "expired"
  };
  await fs.writeFile(file, `${JSON.stringify(expired)}\n`, "utf8");

  await appendDiagnosticLog(root, {
    level: "info",
    source: "mcp",
    category: "tool",
    action: "browser_control:list_profiles",
    message: "tool ok",
    duration_ms: 42
  });
  await appendDiagnosticLog(root, {
    level: "warn",
    source: "renderer",
    category: "status",
    action: "refresh-status",
    message: "Authorization: Bearer fixture-auth-value",
    details: {
      ["to" + "ken"]: "fixture-sensitive-alpha",
      nested: { ["api_" + "key"]: "fixture-sensitive-beta" }
    }
  });
  await appendDiagnosticLog(root, {
    level: "error",
    source: "renderer",
    category: "chat",
    action: "send-request",
    message: "failed"
  });
  await fs.writeFile(path.join(root, "profile-task-events.jsonl"), [
    JSON.stringify({
      at: new Date().toISOString(),
      event: "repo_task_prepared",
      profile_id: "profile-owner",
      task_id: "cpt_eeeeeeeeeeeeeeeeeeeeeeee",
      scope: "workspace"
    }),
    JSON.stringify({
      at: new Date().toISOString(),
      event: "repo_task_profile_rerouted",
      task_id: "cpt_eeeeeeeeeeeeeeeeeeeeeeee",
      session_profile_id: "profile-session",
      task_owner_profile_id: "profile-owner",
      connector_token: "fixture-task-secret"
    })
  ].join("\n") + "\n", "utf8");
  await fs.writeFile(path.join(root, "runtime-lifecycle.jsonl"), `${JSON.stringify({
    schema_version: 1,
    record_id: "runtime-fixture",
    timestamp: new Date().toISOString(),
    level: "error",
    source: "runtime",
    category: "lifecycle",
    action: "child-exit",
    message: "codexpro process exited",
    details: { child_pid: 1234, exit_code: 1, token: "fixture-runtime-secret" }
  })}\n`, "utf8");

  await pruneDiagnosticLogs(root);
  const all = await readDiagnosticLogs(root, { hours: 24, limit: 20 });
  assert.equal(all.scan.tail_bounded, true, "recent unfiltered diagnostics should use bounded tail reads");
  assert.equal(all.scan.max_bytes_per_file, 2 * 1024 * 1024);
  assert.equal(all.summary.total, 6);
  assert.equal(all.summary.error, 2);
  assert.equal(all.summary.warn, 2);
  assert.equal(all.summary.info, 2);
  assert.deepEqual(all.available.levels, { info: 2, warn: 2, error: 2 });
  assert.equal(all.available.sources.mcp, 1);
  assert.equal(all.available.sources.renderer, 2);
  assert.equal(all.available.sources["mcp-task"], 2);
  assert.equal(all.available.sources.runtime, 1);
  assert.equal(all.available.categories.tool, 1);
  assert.equal(all.available.categories.chat, 1);
  assert.equal(all.available.categories["task-routing"], 2);
  assert.equal(all.available.categories.lifecycle, 1);
  assert.ok(!all.entries.some((entry) => entry.action === "expired"));
  assert.equal(new Set(all.entries.map((entry) => entry.record_id)).size, all.summary.total, "every record needs a unique id for incident correlation");
  assert.ok(all.entries.every((entry) => /^\w[\w-]+$/.test(entry.record_id)), "diagnostic record ids must be searchable");

  const serialized = JSON.stringify(all);
  assert.ok(!serialized.includes("fixture-auth-value"));
  assert.ok(!serialized.includes("fixture-sensitive-alpha"));
  assert.ok(!serialized.includes("fixture-sensitive-beta"));
  assert.ok(!serialized.includes("fixture-task-secret"));
  assert.ok(!serialized.includes("fixture-runtime-secret"));
  assert.ok(serialized.includes("[REDACTED]"));

  const errors = await readDiagnosticLogs(root, { hours: 24, level: "error" });
  assert.equal(errors.scan.tail_bounded, false, "filtered diagnostics must retain full-scan semantics");
  assert.equal(errors.entries.length, 2);
  assert.ok(errors.entries.some((entry) => entry.action === "send-request"));
  assert.ok(errors.entries.some((entry) => entry.action === "child-exit"));
  assert.equal(errors.available.sources.mcp, 1, "filter facets must retain sources outside the selected result set");
  assert.equal(errors.available.levels.info, 2, "filter facets must retain all available levels");

  const searched = await readDiagnosticLogs(root, { hours: 24, query: "list_profiles" });
  assert.equal(searched.scan.tail_bounded, false, "diagnostic search must scan the full retention window");
  assert.equal(searched.entries.length, 1);
  assert.equal(searched.entries[0].source, "mcp");

  const toolCategory = await readDiagnosticLogs(root, { hours: 24, source: "mcp", category: "tool" });
  assert.equal(toolCategory.entries.length, 1);
  assert.equal(toolCategory.entries[0].duration_ms, 42);

  const routedTask = await readDiagnosticLogs(root, { hours: 24, source: "mcp-task", category: "task-routing", query: "profile-session" });
  assert.equal(routedTask.entries.length, 1);
  assert.equal(routedTask.entries[0].action, "repo_task_profile_rerouted");
  assert.equal(routedTask.entries[0].details.task_owner_profile_id, "profile-owner");

  for (const [incidentFingerprint, message] of [
    ["same-user-incident", "Người dùng báo lỗi lần đầu"],
    ["same-user-incident", "Người dùng báo lỗi lặp lại"],
    ["different-user-incident", "Người dùng báo lỗi khác"]
  ]) {
    await appendDiagnosticLog(root, {
      level: "error",
      source: "user",
      category: "user-reported-error",
      action: "user-reported-error",
      message,
      details: {
        classification: "user_discovered_error",
        incident_fingerprint: incidentFingerprint,
        report_origin: "chat_request"
      }
    });
  }
  const userReported = await readDiagnosticLogs(root, { hours: 24, source: "user", category: "user-reported-error" });
  assert.equal(userReported.entries.length, 3);
  assert.equal(userReported.summary.user_reported_error, 3, "summary must separate user-discovered errors from automatic system errors");
  const repeatedIncident = userReported.entries.filter((entry) => entry.details?.incident_fingerprint === "same-user-incident");
  assert.equal(repeatedIncident.length, 2);
  assert.ok(repeatedIncident.every((entry) => entry.details?.occurrence_count === 2), "every repeated incident row must expose the total occurrence count in the selected window");
  assert.ok(repeatedIncident.every((entry) => entry.details?.first_seen_at && entry.details?.last_seen_at), "repeated incidents must expose their investigation window");

  const compactionRoot = path.join(root, "compaction");
  await fs.mkdir(compactionRoot, { recursive: true });
  const compactionRecords = [];
  const compactionBaseTime = Date.now() - 60_000;
  for (let index = 0; index < 16_000; index += 1) {
    compactionRecords.push(JSON.stringify({
      schema_version: 1,
      record_id: `compaction-${index}`,
      timestamp: new Date(compactionBaseTime + index).toISOString(),
      level: "info",
      source: "compaction",
      category: "retention",
      action: "seed",
      message: `${index}:${"x".repeat(600)}`
    }));
  }
  await fs.writeFile(path.join(compactionRoot, "manager-diagnostic.jsonl"), `${compactionRecords.join("\n")}\n`, "utf8");
  const seededStat = await fs.stat(path.join(compactionRoot, "manager-diagnostic.jsonl"));
  assert.ok(seededStat.size > 8 * 1024 * 1024, "compaction fixture must exceed the diagnostic cap");
  await pruneDiagnosticLogs(compactionRoot);
  const compactedStat = await fs.stat(path.join(compactionRoot, "manager-diagnostic.jsonl"));
  assert.ok(compactedStat.size <= 6 * 1024 * 1024, "compaction must leave enough headroom to avoid pruning after every append");
  const compactedLatest = await readDiagnosticLogs(compactionRoot, { hours: 24, source: "compaction", limit: 2 });
  assert.equal(compactedLatest.entries[0]?.record_id, "compaction-15999", "compaction must retain the newest record");
  assert.equal(compactedLatest.entries[1]?.record_id, "compaction-15998", "compaction must preserve record order");
  for (let index = 0; index < 100; index += 1) {
    await appendDiagnosticLog(compactionRoot, {
      level: "info",
      source: "compaction",
      category: "retention",
      action: "post-compaction",
      message: `post-compaction-${index}`
    });
  }
  await flushDiagnosticLogs(compactionRoot);
  const appendedStat = await fs.stat(path.join(compactionRoot, "manager-diagnostic.jsonl"));
  assert.ok(appendedStat.size < 8 * 1024 * 1024, "normal appends after compaction must remain below the prune trigger");

  const burstRoot = path.join(root, "burst");
  const burstWrites = [];
  for (let index = 0; index < 22_500; index += 1) {
    burstWrites.push(appendDiagnosticLog(burstRoot, {
      level: "info",
      source: "burst",
      category: "load",
      action: "burst-write",
      message: `burst-${index}`,
      details: { index }
    }));
  }
  await Promise.all(burstWrites);
  await flushDiagnosticLogs(burstRoot);
  const burstLatest = await readDiagnosticLogs(burstRoot, { hours: 24, source: "burst", limit: 5000 });
  assert.ok(burstLatest.entries.some((entry) => entry.message === "burst-22499"), "backpressure must keep the newest diagnostic records");
  const backpressure = await readDiagnosticLogs(burstRoot, { hours: 24, category: "logging", query: "diagnostic-backpressure", limit: 10 });
  assert.equal(backpressure.entries.length, 1, "an overloaded pending queue must leave one diagnostic backpressure marker");
  assert.ok(Number(backpressure.entries[0].details?.dropped_count) > 0, "the backpressure marker must report how many old pending records were dropped");
  const burstStat = await fs.stat(path.join(burstRoot, "manager-diagnostic.jsonl"));
  assert.ok(burstStat.size <= 8 * 1024 * 1024, "diagnostic storage must remain capped at 8 MiB after a large burst");

  await clearDiagnosticLogs(root);
  const cleared = await readDiagnosticLogs(root, { hours: 24 });
  assert.equal(cleared.summary.total, 0);
  await assert.rejects(fs.stat(path.join(root, "profile-task-events.jsonl")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(root, "runtime-lifecycle.jsonl")), { code: "ENOENT" });

  console.log("✓ diagnostic log retention/redaction/filter smoke test passed");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
