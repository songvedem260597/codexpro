import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { availableExtensionVersion } from "../electron/extension-release.mjs";
import { extensionReady, profileSafeForWorkerUpdate } from "../src/features/profiles/profile-runtime-utils.js";

let manifest = '{"version":"0.5.124"}';
const read = async () => manifest;
assert.equal(await availableExtensionVersion("/repo", "0.5.123", read), "0.5.124");
assert.equal(extensionReady("0.5.123", "0.5.124"), false);
assert.equal(extensionReady("0.5.124", "0.5.124"), true);
assert.equal(extensionReady("0.5.125", "0.5.124"), true);
manifest = '{"version":"0.5.125"}';
assert.equal(await availableExtensionVersion("/repo", "0.5.123", read), "0.5.125", "detect replacement without restart");
for (const invalid of ['invalid', '{}', '{"version":"latest"}']) {
  manifest = invalid;
  assert.equal(await availableExtensionVersion("/repo", "0.5.123", read), "0.5.123");
}
assert.equal(await availableExtensionVersion("/repo", "0.5.123", async () => { throw Error("missing"); }), "0.5.123");
assert.equal(await availableExtensionVersion("/repo", "0.5.123", () => new Promise(() => {})), "0.5.123", "manifest read is bounded");
assert.equal(profileSafeForWorkerUpdate({activity:"working"}), false);
assert.equal(profileSafeForWorkerUpdate({activity:"idle",busy_request_count:1}), false);
assert.equal(profileSafeForWorkerUpdate({activity:"idle",conversation_tabs:[{busy:true}]}), false);
assert.equal(profileSafeForWorkerUpdate({activity:"idle",conversation_tabs:[]}), true);
const main = await readFile(new URL("../electron/main.mjs", import.meta.url), "utf8");
const reload = main.slice(main.indexOf("async function reloadChromeProfiles()"), main.indexOf("const profileSendOperations"));
assert.match(reload, /availableExtensionVersion\(status.config.root/);
assert.equal((reload.match(/workerExtensionCurrent\(profile, targetVersion\)/g)||[]).length, 2, "selection and confirmation must share the exact version and runtime build identity target");
assert.doesNotMatch(reload, /version: WORKER_EXTENSION_VERSION/);
assert.match(main, /browserProfiles,\s+workerExtensionVersion,/);
const ui = await readFile(new URL("../src/main.jsx", import.meta.url), "utf8");
assert.match(ui, /status\?\.workerExtensionVersion \|\| WORKER_EXTENSION_VERSION/);
assert.match(ui, /extensionReady\(profile, workerExtensionVersion\)/);
assert.match(ui, /disabled=\{Boolean\(busy\) \|\| profileSummary.reload === 0\}/);
const card = await readFile(new URL("../src/features/profiles/browser-profiles-section.jsx", import.meta.url), "utf8");
assert.match(card, /Có extension \{workerExtensionVersion\} mới/);
console.log("extension-release-smoke: PASS (manifest update, badge/button target, busy guards, reload confirmation, fallback/deadline)");
