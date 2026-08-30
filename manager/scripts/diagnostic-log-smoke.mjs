import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendDiagnosticLog,
  clearDiagnosticLogs,
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

  await pruneDiagnosticLogs(root);
  const all = await readDiagnosticLogs(root, { hours: 24, limit: 20 });
  assert.equal(all.summary.total, 3);
  assert.equal(all.summary.error, 1);
  assert.equal(all.summary.warn, 1);
  assert.equal(all.summary.info, 1);
  assert.ok(!all.entries.some((entry) => entry.action === "expired"));

  const serialized = JSON.stringify(all);
  assert.ok(!serialized.includes("fixture-auth-value"));
  assert.ok(!serialized.includes("fixture-sensitive-alpha"));
  assert.ok(!serialized.includes("fixture-sensitive-beta"));
  assert.ok(serialized.includes("[REDACTED]"));

  const errors = await readDiagnosticLogs(root, { hours: 24, level: "error" });
  assert.equal(errors.entries.length, 1);
  assert.equal(errors.entries[0].action, "send-request");

  const searched = await readDiagnosticLogs(root, { hours: 24, query: "list_profiles" });
  assert.equal(searched.entries.length, 1);
  assert.equal(searched.entries[0].source, "mcp");

  await clearDiagnosticLogs(root);
  const cleared = await readDiagnosticLogs(root, { hours: 24 });
  assert.equal(cleared.summary.total, 0);

  console.log("✓ diagnostic log retention/redaction/filter smoke test passed");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
