import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendDiagnosticLog,
  clearDiagnosticLogs,
  flushDiagnosticLogs,
  pruneDiagnosticLogs,
  readDiagnosticLogs
} from "../electron/diagnostic-log.mjs";

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

  await pruneDiagnosticLogs(root);
  const all = await readDiagnosticLogs(root, { hours: 24, limit: 20 });
  assert.equal(all.summary.total, 5);
  assert.equal(all.summary.error, 1);
  assert.equal(all.summary.warn, 2);
  assert.equal(all.summary.info, 2);
  assert.deepEqual(all.available.levels, { info: 2, warn: 2, error: 1 });
  assert.equal(all.available.sources.mcp, 1);
  assert.equal(all.available.sources.renderer, 2);
  assert.equal(all.available.sources["mcp-task"], 2);
  assert.equal(all.available.categories.tool, 1);
  assert.equal(all.available.categories.chat, 1);
  assert.equal(all.available.categories["task-routing"], 2);
  assert.ok(!all.entries.some((entry) => entry.action === "expired"));
  assert.equal(new Set(all.entries.map((entry) => entry.record_id)).size, all.summary.total, "every record needs a unique id for incident correlation");
  assert.ok(all.entries.every((entry) => /^\w[\w-]+$/.test(entry.record_id)), "diagnostic record ids must be searchable");

  const serialized = JSON.stringify(all);
  assert.ok(!serialized.includes("fixture-auth-value"));
  assert.ok(!serialized.includes("fixture-sensitive-alpha"));
  assert.ok(!serialized.includes("fixture-sensitive-beta"));
  assert.ok(!serialized.includes("fixture-task-secret"));
  assert.ok(serialized.includes("[REDACTED]"));

  const errors = await readDiagnosticLogs(root, { hours: 24, level: "error" });
  assert.equal(errors.entries.length, 1);
  assert.equal(errors.entries[0].action, "send-request");
  assert.equal(errors.available.sources.mcp, 1, "filter facets must retain sources outside the selected result set");
  assert.equal(errors.available.levels.info, 2, "filter facets must retain all available levels");

  const searched = await readDiagnosticLogs(root, { hours: 24, query: "list_profiles" });
  assert.equal(searched.entries.length, 1);
  assert.equal(searched.entries[0].source, "mcp");

  const toolCategory = await readDiagnosticLogs(root, { hours: 24, source: "mcp", category: "tool" });
  assert.equal(toolCategory.entries.length, 1);
  assert.equal(toolCategory.entries[0].duration_ms, 42);

  const routedTask = await readDiagnosticLogs(root, { hours: 24, source: "mcp-task", category: "task-routing", query: "profile-session" });
  assert.equal(routedTask.entries.length, 1);
  assert.equal(routedTask.entries[0].action, "repo_task_profile_rerouted");
  assert.equal(routedTask.entries[0].details.task_owner_profile_id, "profile-owner");

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

  console.log("✓ diagnostic log retention/redaction/filter smoke test passed");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
