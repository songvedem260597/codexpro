import assert from "node:assert/strict";
import fs from "node:fs";

import { registerDiagnosticLogIpcHandlers } from "../electron/ipc/diagnostic-log-ipc.mjs";
import { registerUtilityIpcHandlers } from "../electron/ipc/utility-ipc.mjs";

const mainSource = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
const preloadSource = fs.readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");
const utilitySource = fs.readFileSync(new URL("../electron/ipc/utility-ipc.mjs", import.meta.url), "utf8");
const diagnosticLogSource = fs.readFileSync(new URL("../electron/ipc/diagnostic-log-ipc.mjs", import.meta.url), "utf8");

const utilityChannels = ["codexpro:copy", "codexpro:notify"];
const diagnosticLogChannels = [
  "codexpro:get-diagnostic-logs",
  "codexpro:clear-diagnostic-logs",
  "codexpro:prune-diagnostic-logs"
];
const expectedChannels = [...utilityChannels, ...diagnosticLogChannels];

assert.match(mainSource, /import \{ registerUtilityIpcHandlers \} from "\.\/ipc\/utility-ipc\.mjs";/, "main must import the utility IPC registrar");
assert.match(mainSource, /import \{ registerDiagnosticLogIpcHandlers \} from "\.\/ipc\/diagnostic-log-ipc\.mjs";/, "main must import the diagnostic-log IPC registrar");
assert.equal((mainSource.match(/registerUtilityIpcHandlers\(/g) || []).length, 1, "main must register utility IPC exactly once");
assert.equal((mainSource.match(/registerDiagnosticLogIpcHandlers\(/g) || []).length, 1, "main must register diagnostic-log IPC exactly once");
assert.equal((mainSource.match(/ipcMain\.handle\(/g) || []).length, 0, "raw ipcMain.handle registrations must stay out of main after extraction");
assert.equal((utilitySource.match(/ipcMain\.handle\("codexpro:/g) || []).length, utilityChannels.length, "utility registrar must own exactly two raw IPC channels");
assert.equal((diagnosticLogSource.match(/ipcMain\.handle\("codexpro:/g) || []).length, diagnosticLogChannels.length, "diagnostic-log registrar must own exactly three raw IPC channels");
assert.doesNotMatch(utilitySource, /diagnosticIpcHandle/, "utility handlers must remain raw IPC without new diagnostic wrapping");
assert.doesNotMatch(diagnosticLogSource, /diagnosticIpcHandle/, "diagnostic-log handlers must remain raw IPC without new diagnostic wrapping");

for (const channel of expectedChannels) {
  assert.ok(utilitySource.includes(`"${channel}"`) || diagnosticLogSource.includes(`"${channel}"`), `${channel} must have one extracted owner`);
  assert.ok(!mainSource.includes(`ipcMain.handle("${channel}"`), `${channel} must no longer be registered directly in main`);
}
for (const channel of utilityChannels) assert.equal(utilitySource.split(`"${channel}"`).length - 1, 1, `${channel} must be registered exactly once`);
for (const channel of diagnosticLogChannels) assert.equal(diagnosticLogSource.split(`"${channel}"`).length - 1, 1, `${channel} must be registered exactly once`);

assert.match(preloadSource, /copyText: \(text\) => invoke\("codexpro:copy", text\)/, "copy preload access must stay unchanged");
assert.match(preloadSource, /showNotification: \(payload\) => invoke\("codexpro:notify", payload\)/, "notification preload access must stay unchanged");
assert.match(preloadSource, /getDiagnosticLogs: \(options\) => invoke\("codexpro:get-diagnostic-logs", options\)/, "diagnostic read preload access must stay unchanged");
assert.match(preloadSource, /clearDiagnosticLogs: \(\) => invoke\("codexpro:clear-diagnostic-logs"\)/, "diagnostic clear preload access must stay unchanged");
assert.match(preloadSource, /pruneDiagnosticLogs: \(\) => invoke\("codexpro:prune-diagnostic-logs"\)/, "diagnostic prune preload access must stay unchanged");

function captureHandlers() {
  const handlers = new Map();
  return {
    handlers,
    ipcMain: {
      handle(channel, handler) {
        assert.equal(handlers.has(channel), false, `duplicate IPC registration for ${channel}`);
        handlers.set(channel, handler);
      }
    }
  };
}

const utilityCapture = captureHandlers();
const clipboardWrites = [];
const notificationPayloads = [];
registerUtilityIpcHandlers({
  ipcMain: utilityCapture.ipcMain,
  clipboard: { writeText: (text) => clipboardWrites.push(text) },
  showNotification: (payload) => {
    notificationPayloads.push(payload);
    return "notification-result";
  }
});
assert.deepEqual([...utilityCapture.handlers.keys()], utilityChannels, "utility IPC channel order/set must remain stable");
assert.equal(utilityCapture.handlers.get("codexpro:copy")({}, "copy me"), true, "copy must keep returning true");
assert.equal(utilityCapture.handlers.get("codexpro:copy")({}, null), true, "copy must keep accepting falsy input");
assert.deepEqual(clipboardWrites, ["copy me", ""], "copy must preserve String(text || '') normalization before clipboard write");
const notificationPayload = { title: "Smoke", body: "Body", silent: true };
assert.equal(utilityCapture.handlers.get("codexpro:notify")({}, notificationPayload), "notification-result", "notify must return the notification service result unchanged");
assert.equal(notificationPayloads[0], notificationPayload, "notify must forward the original payload object unchanged");

const utilityFailureCapture = captureHandlers();
registerUtilityIpcHandlers({
  ipcMain: utilityFailureCapture.ipcMain,
  clipboard: { writeText: () => { throw new Error("copy failure"); } },
  showNotification: () => { throw new Error("notification failure"); }
});
assert.throws(() => utilityFailureCapture.handlers.get("codexpro:copy")({}, "x"), /copy failure/, "copy errors must propagate");
assert.throws(() => utilityFailureCapture.handlers.get("codexpro:notify")({}, {}), /notification failure/, "notification errors must propagate");

const diagnosticCapture = captureHandlers();
const diagnosticCalls = [];
const home = "C:/smoke-home";
registerDiagnosticLogIpcHandlers({
  ipcMain: diagnosticCapture.ipcMain,
  codexProHome: home,
  readDiagnosticLogs: async (...args) => { diagnosticCalls.push(["read", ...args]); return { kind: "read" }; },
  clearDiagnosticLogs: async (...args) => { diagnosticCalls.push(["clear", ...args]); return { kind: "clear" }; },
  pruneDiagnosticLogs: async (...args) => { diagnosticCalls.push(["prune", ...args]); return { kind: "prune" }; }
});
assert.deepEqual([...diagnosticCapture.handlers.keys()], diagnosticLogChannels, "diagnostic-log IPC channel order/set must remain stable");
const readOptions = { hours: 6, limit: 25 };
assert.deepEqual(await diagnosticCapture.handlers.get("codexpro:get-diagnostic-logs")({}, readOptions), { kind: "read" });
assert.deepEqual(await diagnosticCapture.handlers.get("codexpro:get-diagnostic-logs")({}, null), { kind: "read" });
assert.deepEqual(await diagnosticCapture.handlers.get("codexpro:clear-diagnostic-logs")({}), { kind: "clear" });
assert.deepEqual(await diagnosticCapture.handlers.get("codexpro:prune-diagnostic-logs")({}), { kind: "prune" });
assert.deepEqual(diagnosticCalls, [
  ["read", home, readOptions],
  ["read", home, {}],
  ["clear", home],
  ["prune", home]
], "diagnostic-log handlers must preserve home/options forwarding and options fallback");

const diagnosticFailureCapture = captureHandlers();
registerDiagnosticLogIpcHandlers({
  ipcMain: diagnosticFailureCapture.ipcMain,
  codexProHome: home,
  readDiagnosticLogs: async () => { throw new Error("read failure"); },
  clearDiagnosticLogs: async () => { throw new Error("clear failure"); },
  pruneDiagnosticLogs: async () => { throw new Error("prune failure"); }
});
await assert.rejects(() => diagnosticFailureCapture.handlers.get("codexpro:get-diagnostic-logs")({}, {}), /read failure/, "diagnostic read errors must propagate");
await assert.rejects(() => diagnosticFailureCapture.handlers.get("codexpro:clear-diagnostic-logs")({}), /clear failure/, "diagnostic clear errors must propagate");
await assert.rejects(() => diagnosticFailureCapture.handlers.get("codexpro:prune-diagnostic-logs")({}), /prune failure/, "diagnostic prune errors must propagate");

assert.throws(() => registerUtilityIpcHandlers({}), /requires ipcMain\.handle/, "utility registrar must fail fast without ipcMain.handle");
assert.throws(() => registerDiagnosticLogIpcHandlers({}), /requires ipcMain\.handle/, "diagnostic-log registrar must fail fast without ipcMain.handle");

console.log("utility-ipc-extraction-smoke: ok");
