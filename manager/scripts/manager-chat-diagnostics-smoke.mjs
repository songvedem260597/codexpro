import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createManagerChatDiagnostics } from "../electron/manager-chat-diagnostics.mjs";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-manager-chat-diagnostics-"));
const events = [];
let tick = 0;
const now = () => new Date(Date.UTC(2026, 8, 5, 1, tick++, 0)).toISOString();
const diagnostic = (...args) => events.push(args);

try {
  const chatDiagnostics = createManagerChatDiagnostics({
    home: tempHome,
    diagnostic,
    now,
    layoutMaxBytes: 1,
    auditMaxBytes: 1,
    layoutEntryMaxBytes: 1024,
    auditEntryMaxBytes: 1024
  });

  chatDiagnostics.appendManagerChatLayoutLog({ profileId: "profile-a", width: 800 });
  await chatDiagnostics.flush();
  chatDiagnostics.appendManagerChatLayoutLog({ profileId: "profile-a", width: 900 });
  await chatDiagnostics.flush();

  const layoutCurrent = path.join(tempHome, "manager-chat-layout.jsonl");
  const layoutPrevious = path.join(tempHome, "manager-chat-layout.previous.jsonl");
  assert.equal(JSON.parse(fs.readFileSync(layoutPrevious, "utf8").trim()).width, 800);
  assert.equal(JSON.parse(fs.readFileSync(layoutCurrent, "utf8").trim()).width, 900);

  chatDiagnostics.appendManagerChatResponseAuditLog({ comparison: "match", profileId: "profile-a" });
  await chatDiagnostics.flush();
  chatDiagnostics.appendManagerChatResponseAuditLog({ comparison: "manager_state_mismatch", profileId: "profile-a" });
  await chatDiagnostics.flush();

  const auditCurrent = path.join(tempHome, "manager-chat-response-audit.jsonl");
  const auditPrevious = path.join(tempHome, "manager-chat-response-audit.previous.jsonl");
  assert.equal(JSON.parse(fs.readFileSync(auditPrevious, "utf8").trim()).comparison, "match");
  assert.equal(JSON.parse(fs.readFileSync(auditCurrent, "utf8").trim()).comparison, "manager_state_mismatch");

  chatDiagnostics.recordChatResponseAuditDiagnostic({
    comparison: "manager_state_mismatch",
    profileId: "profile-a",
    conversationId: "conv-0001",
    requestId: "req-1",
    sources: {
      chatgptDom: {
        available: true,
        messageCount: 4,
        latestAssistant: { fingerprint: "expected", length: 42 }
      }
    },
    managerState: { messageCount: 3, latestAssistant: { fingerprint: "actual", length: 40 } },
    managerUi: { messageCount: 3 }
  });
  assert.equal(events.length, 1);
  assert.equal(events[0][0], "error");
  assert.equal(events[0][2], "chat-audit");
  assert.equal(events[0][4].expected_assistant.fingerprint, "expected");

  chatDiagnostics.recordChatResponseAuditDiagnostic({
    comparison: "manager_state_mismatch",
    profileId: "profile-a",
    conversationId: "conv-0001"
  });
  assert.equal(events.length, 1, "duplicate comparison must not emit another diagnostic");

  chatDiagnostics.recordChatResponseAuditDiagnostic({
    comparison: "match",
    profileId: "profile-a",
    conversationId: "conv-0001",
    requestId: "req-1"
  });
  assert.equal(events.length, 2);
  assert.equal(events[1][0], "info");
  assert.equal(events[1][4].action, "chat-response-audit-recovered");

  chatDiagnostics.recordChatResponseAuditDiagnostic({
    comparison: "source_unavailable",
    profileId: "profile-b",
    conversationId: "conv-0002",
    networkState: "generating"
  });
  assert.equal(events.length, 2, "non-terminal source gaps must not emit a diagnostic");

  chatDiagnostics.recordChatResponseAuditDiagnostic({
    comparison: "source_unavailable",
    profileId: "profile-b",
    conversationId: "conv-0002",
    networkState: "completed"
  });
  assert.equal(events.length, 2, "the existing dedupe behavior must suppress an unchanged comparison even after the network becomes terminal");

  chatDiagnostics.recordChatResponseAuditDiagnostic({
    comparison: "source_unavailable",
    profileId: "profile-c",
    conversationId: "conv-0003",
    networkState: "completed"
  });
  assert.equal(events.length, 3);
  assert.equal(events[2][0], "warn");

  const mainSource = fs.readFileSync(path.resolve("electron/main.mjs"), "utf8");
  assert.ok(mainSource.includes('from "./manager-chat-diagnostics.mjs"'));
  assert.ok(!mainSource.includes("function appendManagerChatLayoutLog("));
  assert.ok(!mainSource.includes("responseAuditDiagnosticState"));

  console.log("manager-chat-diagnostics-smoke: ok");
} finally {
  fs.rmSync(tempHome, { recursive: true, force: true });
}
