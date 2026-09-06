import assert from "node:assert/strict";
import fs from "node:fs";

import { createDiagnosticIpcRegistrar } from "../electron/ipc/diagnostic-ipc.mjs";
import { registerWorkerIpcHandlers } from "../electron/ipc/worker-ipc.mjs";

const mainSource = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
const diagnosticSource = fs.readFileSync(new URL("../electron/ipc/diagnostic-ipc.mjs", import.meta.url), "utf8");
const workerSource = fs.readFileSync(new URL("../electron/ipc/worker-ipc.mjs", import.meta.url), "utf8");

assert.match(mainSource, /import \{ createDiagnosticIpcRegistrar \} from "\.\/ipc\/diagnostic-ipc\.mjs";/, "main must import the extracted diagnostic IPC registrar");
assert.match(mainSource, /import \{ registerWorkerIpcHandlers \} from "\.\/ipc\/worker-ipc\.mjs";/, "main must import the extracted worker IPC registrar");
assert.match(mainSource, /const \{ handle: diagnosticIpcHandle, allowed: diagnosticAllowed \} = createDiagnosticIpcRegistrar\(\{ ipcMain, diagnostic \}\);/, "main must create the diagnostic IPC handler and shared diagnostic throttle from the extracted service");
assert.match(mainSource, /registerWorkerIpcHandlers\(\{[\s\S]*?diagnosticIpcHandle,[\s\S]*?runtimeStatus,[\s\S]*?workerPluginRegistry,[\s\S]*?apiWorkerStore,[\s\S]*?createProviderForApiWorker[\s\S]*?\}\);/, "main must wire worker IPC dependencies explicitly");
assert.doesNotMatch(mainSource, /function diagnosticIpcHandle\(/, "diagnostic IPC implementation must stay out of main.mjs");
assert.doesNotMatch(mainSource, /function diagnosticProjection\(/, "diagnostic projection implementation must stay out of main.mjs");
assert.doesNotMatch(mainSource, /diagnosticIpcHandle\("codexpro:(?:status|workers|worker-send|worker-read|worker-stop|api-worker-configs|list-api-worker-models|save-api-worker|delete-api-worker|test-api-worker)"/, "worker/API-worker IPC registrations must stay out of main.mjs");
assert.match(diagnosticSource, /export function createDiagnosticIpcRegistrar\(/, "diagnostic IPC registrar must be exported from its service module");
assert.match(diagnosticSource, /ipcMain\.handle\(channel, async \(event, \.\.\.args\) =>/, "diagnostic IPC service must own ipcMain.handle wrapping");

const expectedWorkerChannels = [
  "codexpro:status",
  "codexpro:workers",
  "codexpro:worker-send",
  "codexpro:worker-read",
  "codexpro:worker-stop",
  "codexpro:api-worker-configs",
  "codexpro:list-api-worker-models",
  "codexpro:save-api-worker",
  "codexpro:delete-api-worker",
  "codexpro:test-api-worker"
];
for (const channel of expectedWorkerChannels) {
  assert.ok(workerSource.includes(`"${channel}"`), `worker IPC module must own ${channel}`);
}

const rawIpcHandlers = new Map();
const diagnostics = [];
const diagnosticRegistrar = createDiagnosticIpcRegistrar({
  ipcMain: {
    handle(channel, handler) {
      assert.equal(rawIpcHandlers.has(channel), false, `duplicate raw IPC registration for ${channel}`);
      rawIpcHandlers.set(channel, handler);
    }
  },
  diagnostic: (...args) => diagnostics.push(args)
});
assert.equal(typeof diagnosticRegistrar.allowed, "function", "diagnostic registrar must expose the shared throttle used by non-IPC diagnostics");
assert.equal(diagnosticRegistrar.allowed("shared-throttle-smoke", 10_000), true);
assert.equal(diagnosticRegistrar.allowed("shared-throttle-smoke", 10_000), false);

diagnosticRegistrar.handle("codexpro:diagnostic-smoke", {
  category: "smoke",
  action: "diagnostic-smoke",
  logSuccess: true,
  successMessage: "diagnostic smoke ok",
  details: (payload) => ({ payload_id: String(payload?.id || "") }),
  resultDetails: (result) => ({ result_id: String(result?.id || "") })
}, async (_event, payload) => ({ id: payload.id, ok: true }));

const diagnosticResult = await rawIpcHandlers.get("codexpro:diagnostic-smoke")({}, { id: "ipc-1" });
assert.deepEqual(diagnosticResult, { id: "ipc-1", ok: true });
assert.equal(diagnostics.length, 1);
assert.equal(diagnostics[0][0], "info");
assert.equal(diagnostics[0][2], "smoke");
assert.equal(diagnostics[0][3], "diagnostic smoke ok");
assert.equal(diagnostics[0][4].payload_id, "ipc-1");
assert.equal(diagnostics[0][4].result_id, "ipc-1");
assert.equal(diagnostics[0][4].ipc_channel, "codexpro:diagnostic-smoke");
assert.match(String(diagnostics[0][4].ipc_call_id || ""), /^ipc_/);

diagnosticRegistrar.handle("codexpro:diagnostic-envelope-error", {
  category: "smoke",
  action: "diagnostic-envelope-error",
  failureMessage: "envelope failed"
}, async () => ({ ok: false, error: { message: "expected failure" } }));
await rawIpcHandlers.get("codexpro:diagnostic-envelope-error")({});
assert.equal(diagnostics.at(-1)[0], "error");
assert.match(diagnostics.at(-1)[3], /envelope failed: expected failure/);

const registeredWorkerHandlers = new Map();
const workerCalls = [];
const reports = [];
const apiConfigs = [{ id: "api-one", provider: "openai", model: "model-one" }];
const apiWorkerStore = {
  list: () => apiConfigs,
  credential: async (id) => `credential:${id}`,
  save: async (payload) => ({ saved: payload.id }),
  remove: async (id) => ({ removed: id })
};
let discoveryOptions = null;
registerWorkerIpcHandlers({
  diagnosticIpcHandle(channel, options, handler) {
    assert.equal(registeredWorkerHandlers.has(channel), false, `duplicate worker IPC registration for ${channel}`);
    registeredWorkerHandlers.set(channel, { options, handler });
  },
  runtimeStatus: async () => ({ workers: [{ id: "worker-one" }], workerSources: ["runtime"] }),
  materializeApiWorkerRequest: async (payload) => ({ ...payload, workerId: "api:worker-one", materialized: true }),
  recordUserReportedError: (payload, context) => reports.push({ payload, context }),
  workerPluginRegistry: {
    async invoke(action, workerId, payload) {
      workerCalls.push({ action, workerId, payload });
      return { action, workerId };
    }
  },
  apiWorkerStore,
  discoverApiWorkerModels: async (payload, options) => {
    discoveryOptions = options;
    return { models: [`${payload.provider}-model`] };
  },
  createProviderForApiWorker: (config, options = {}) => ({
    config,
    options,
    async probe() {
      return { connected: true, id: config.id };
    }
  })
});

assert.deepEqual([...registeredWorkerHandlers.keys()], expectedWorkerChannels, "worker IPC registration order and channel set must stay stable");
assert.deepEqual(await registeredWorkerHandlers.get("codexpro:status").handler({}), { workers: [{ id: "worker-one" }], workerSources: ["runtime"] });
assert.deepEqual(await registeredWorkerHandlers.get("codexpro:workers").handler({}), { workers: [{ id: "worker-one" }], sources: ["runtime"] });

const sent = await registeredWorkerHandlers.get("codexpro:worker-send").handler({}, { task_id: "task-one" });
assert.deepEqual(sent, { action: "send", workerId: "api:worker-one" });
assert.equal(reports.length, 1);
assert.equal(reports[0].payload.materialized, true);
assert.deepEqual(reports[0].context, { request_channel: "worker_job" });
assert.equal(workerCalls[0].action, "send");
assert.equal(workerCalls[0].workerId, "api:worker-one");

await registeredWorkerHandlers.get("codexpro:worker-read").handler({}, { worker_id: "api:worker-two" });
await registeredWorkerHandlers.get("codexpro:worker-stop").handler({}, { workerId: "api:worker-three" });
assert.deepEqual(workerCalls.slice(1).map(({ action, workerId }) => ({ action, workerId })), [
  { action: "read", workerId: "api:worker-two" },
  { action: "stop", workerId: "api:worker-three" }
]);

assert.deepEqual(await registeredWorkerHandlers.get("codexpro:api-worker-configs").handler({}), apiConfigs);
const discovered = await registeredWorkerHandlers.get("codexpro:list-api-worker-models").handler({}, { id: "api-one", provider: "openai" });
assert.deepEqual(discovered, { models: ["openai-model"] });
assert.equal(await discoveryOptions.getStoredCredential("api-one"), "credential:api-one");
const discoveredProvider = await discoveryOptions.createProvider({ id: "api-one" }, async () => "secret");
assert.equal(discoveredProvider.config.id, "api-one");
assert.equal(typeof discoveredProvider.options.getApiKey, "function");

assert.deepEqual(await registeredWorkerHandlers.get("codexpro:save-api-worker").handler({}, { id: "api-two" }), { saved: "api-two" });
assert.deepEqual(await registeredWorkerHandlers.get("codexpro:delete-api-worker").handler({}, "api-two"), { removed: "api-two" });
assert.deepEqual(await registeredWorkerHandlers.get("codexpro:test-api-worker").handler({}, "api-one"), { connected: true, id: "api-one" });
await assert.rejects(() => registeredWorkerHandlers.get("codexpro:test-api-worker").handler({}, "missing"), /configuration was not found/);

console.log("electron-ipc-extraction-smoke: ok");
