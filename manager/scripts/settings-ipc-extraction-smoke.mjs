import assert from "node:assert/strict";
import fs from "node:fs";

import { registerSettingsIpcHandlers } from "../electron/ipc/settings-ipc.mjs";

const mainSource = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
const settingsIpcSource = fs.readFileSync(new URL("../electron/ipc/settings-ipc.mjs", import.meta.url), "utf8");

const expectedChannels = [
  "codexpro:get-manager-settings",
  "codexpro:save-manager-settings",
  "codexpro:create-worker-image-pack",
  "codexpro:select-worker-image-pack",
  "codexpro:delete-worker-image-pack",
  "codexpro:choose-worker-image",
  "codexpro:reset-worker-image",
  "codexpro:choose-app-background",
  "codexpro:reset-app-background",
  "codexpro:reset-manager-settings"
];

assert.match(mainSource, /import \{ registerSettingsIpcHandlers \} from "\.\/ipc\/settings-ipc\.mjs";/, "main must import the extracted settings IPC registrar");
assert.equal((mainSource.match(/registerSettingsIpcHandlers\(/g) || []).length, 1, "main must register settings IPC exactly once");
const mainRegistration = mainSource.match(/registerSettingsIpcHandlers\(\{([\s\S]*?)\}\);/)?.[1] || "";
for (const dependencyName of ["diagnosticIpcHandle", "managerSettingsPayload", "saveManagerSettingsPatch", "createWorkerImagePack", "selectWorkerImagePack", "deleteWorkerImagePack", "chooseWorkerImage", "resetWorkerImage", "chooseAppBackground", "resetAppBackground", "resetManagerSettings"]) {
  assert.match(mainRegistration, new RegExp(`\\b${dependencyName}\\b`), `main must wire ${dependencyName} into settings IPC`);
}
assert.equal((settingsIpcSource.match(/diagnosticIpcHandle\("codexpro:/g) || []).length, expectedChannels.length, "settings IPC module must register exactly the expected channel count");
for (const channel of expectedChannels) {
  assert.ok(settingsIpcSource.includes(`"${channel}"`), `settings IPC module must own ${channel}`);
  assert.ok(!mainSource.includes(`diagnosticIpcHandle("${channel}"`), `main must not own ${channel} after extraction`);
}

const registrations = [];
const calls = [];
const dependency = (name) => (...args) => {
  calls.push({ name, args });
  return { name, args };
};

registerSettingsIpcHandlers({
  diagnosticIpcHandle: (channel, options, handler) => registrations.push({ channel, options, handler }),
  managerSettingsPayload: dependency("managerSettingsPayload"),
  saveManagerSettingsPatch: dependency("saveManagerSettingsPatch"),
  createWorkerImagePack: dependency("createWorkerImagePack"),
  selectWorkerImagePack: dependency("selectWorkerImagePack"),
  deleteWorkerImagePack: dependency("deleteWorkerImagePack"),
  chooseWorkerImage: dependency("chooseWorkerImage"),
  resetWorkerImage: dependency("resetWorkerImage"),
  chooseAppBackground: dependency("chooseAppBackground"),
  resetAppBackground: dependency("resetAppBackground"),
  resetManagerSettings: dependency("resetManagerSettings")
});

assert.deepEqual(registrations.map((entry) => entry.channel), expectedChannels, "settings IPC channel order must remain stable");
assert.ok(registrations.every((entry) => entry.options?.category === "settings"), "every extracted settings handler must keep settings diagnostic category");

const byChannel = new Map(registrations.map((entry) => [entry.channel, entry]));
const invoke = (channel, payload) => byChannel.get(channel).handler({ sender: "smoke" }, payload);

assert.deepEqual(invoke("codexpro:get-manager-settings"), { name: "managerSettingsPayload", args: [] });
const patch = { fontSize: 16, taskNotifications: false };
assert.deepEqual(invoke("codexpro:save-manager-settings", patch), { name: "saveManagerSettingsPatch", args: [patch] });
assert.deepEqual(byChannel.get("codexpro:save-manager-settings").options.details(patch), { changed_keys: ["fontSize", "taskNotifications"] });
assert.deepEqual(invoke("codexpro:create-worker-image-pack", "Smoke pack"), { name: "createWorkerImagePack", args: ["Smoke pack"] });
assert.deepEqual(invoke("codexpro:select-worker-image-pack", "pack-1"), { name: "selectWorkerImagePack", args: ["pack-1"] });
assert.deepEqual(invoke("codexpro:delete-worker-image-pack", "pack-2"), { name: "deleteWorkerImagePack", args: ["pack-2"] });
const workerImagePayload = { packId: "pack-3", state: "working" };
assert.deepEqual(invoke("codexpro:choose-worker-image", workerImagePayload), { name: "chooseWorkerImage", args: ["pack-3", "working"] });
assert.deepEqual(invoke("codexpro:reset-worker-image", workerImagePayload), { name: "resetWorkerImage", args: ["pack-3", "working"] });
assert.deepEqual(byChannel.get("codexpro:choose-worker-image").options.details(workerImagePayload), { state: "working" });
assert.deepEqual(invoke("codexpro:choose-app-background"), { name: "chooseAppBackground", args: [] });
assert.deepEqual(invoke("codexpro:reset-app-background"), { name: "resetAppBackground", args: [] });
assert.deepEqual(invoke("codexpro:reset-manager-settings"), { name: "resetManagerSettings", args: [] });
assert.equal(calls.length, expectedChannels.length, "each settings handler must forward exactly one service call");
assert.equal(byChannel.get("codexpro:save-manager-settings").options.logSuccess, true);
assert.equal(byChannel.get("codexpro:reset-manager-settings").options.logSuccess, true);
assert.throws(() => registerSettingsIpcHandlers({}), /requires diagnosticIpcHandle/, "registrar must fail fast when diagnostic wrapper is missing");

console.log("settings-ipc-extraction-smoke: ok");
