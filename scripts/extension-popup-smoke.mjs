import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const [popupHtml, popupJs, worker, bridge, manifestText] = await Promise.all([
  fs.readFile(new URL("../chrome-extension/popup.html", import.meta.url), "utf8"),
  fs.readFile(new URL("../chrome-extension/popup.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../chrome-extension/service-worker.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../src/browserExtensionBridge.ts", import.meta.url), "utf8"),
  fs.readFile(new URL("../chrome-extension/manifest.json", import.meta.url), "utf8")
]);

const manifest = JSON.parse(manifestText);

assert.match(popupHtml, /class="brand-icon"[\s\S]*?<svg/, "popup must render a branded icon");
assert.match(popupHtml, /id="activeState"[\s\S]*?Profile đang ACTIVE/, "active profile must render as status rather than a redundant button");
assert.match(popupHtml, /id="workerToggle"[\s\S]*?role="switch"/, "popup must expose an accessible worker toggle");
assert.match(popupHtml, /id="disabledState"[\s\S]*?không xuất hiện trong danh sách Worker/, "disabled state must explain that the profile is hidden from Manager");
assert.match(popupJs, /button\.hidden=isActive[\s\S]*?activeState\.hidden=!isActive/, "activate action must disappear after activation");
assert.match(popupJs, /installButton\.hidden=true/, "ready connector must hide the redundant reinstall action");
assert.doesNotMatch(popupHtml + popupJs, /CÀI LẠI \/ KIỂM TRA LẠI/, "popup must not retain the redundant reinstall label");
assert.match(popupJs, /workerEnabled[\s\S]*?BRIDGE}\/register[\s\S]*?enabled:false/, "disable must immediately publish a hidden profile state");
assert.match(worker, /if\(!profile\.enabled\)[\s\S]*?setTimeout\(resolve,2000\)[\s\S]*?continue/, "disabled extension must stop polling the Bridge");
assert.match(worker, /if\(!profile\.enabled\)return;[\s\S]*?BRIDGE}\/register/, "disabled extension must suppress realtime heartbeat pushes");
assert.match(bridge, /enabled: boolean[\s\S]*?profile\.enabled = source\.enabled !== false[\s\S]*?profile\.enabled && now - profile\.lastSeen <= PROFILE_TTL_MS/, "Bridge must exclude disabled profiles from connected workers");
assert.deepEqual(manifest.icons, {
  16: "icons/icon16.png",
  32: "icons/icon32.png",
  48: "icons/icon48.png",
  128: "icons/icon128.png"
}, "extension package must provide a complete branded icon set");
assert.deepEqual(manifest.action.default_icon, manifest.icons, "toolbar action must use the branded extension icons");
await Promise.all(Object.values(manifest.icons).map(async (iconPath) => {
  const icon = await fs.readFile(new URL(`../chrome-extension/${iconPath}`, import.meta.url));
  assert.equal(icon.subarray(1, 4).toString("ascii"), "PNG", `${iconPath} must be a real PNG asset`);
}));

const elements = Object.fromEntries([
  "label", "email", "version", "activate", "activateLabel", "activeState", "workerToggle",
  "workerDetails", "disabledState", "install", "installLabel", "installStatus", "installTitle",
  "installStatusText", "installIcon", "status", "statusText"
].map((id) => {
  const attributes = new Map();
  const listeners = new Map();
  return [id, {
    id,
    textContent: "",
    hidden: false,
    disabled: false,
    dataset: {},
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    addEventListener(name, listener) { listeners.set(name, listener); },
    listeners
  }];
}));
const storageWrites = [];
const registerPayloads = [];
const storedProfile = {
  profileId: "profile-popup-smoke",
  active: false,
  connectorInstall: { ok: true, message: "CodexPro READY" },
  workerEnabled: true,
  workerEnabledUpdatedAt: 1
};
const popupContext = vm.createContext({
  console,
  URLSearchParams,
  location: { search: "", pathname: "/popup.html" },
  history: { replaceState() {} },
  crypto: { randomUUID: () => "generated-profile" },
  setTimeout,
  clearTimeout,
  document: {
    body: { textContent: "" },
    querySelector(selector) { return elements[selector.slice(1)]; }
  },
  chrome: {
    storage: {
      local: {
        async get(keys) {
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(requested.filter((key) => key in storedProfile).map((key) => [key, storedProfile[key]]));
        },
        async set(value) {
          Object.assign(storedProfile, value);
          storageWrites.push(value);
        }
      }
    },
    identity: { async getProfileUserInfo() { return { email: "" }; } },
    runtime: {
      getManifest() { return { version: manifest.version }; },
      reload() {},
      async sendMessage() { return { ok: true }; }
    },
    tabs: { async getCurrent() { return null; } }
  },
  async fetch(_url, options) {
    registerPayloads.push(JSON.parse(options.body));
    return { ok: true, status: 200, async json() { return { active_profile_id: "" }; } };
  }
});
vm.runInContext(popupJs, popupContext, { filename: "chrome-extension/popup.js" });
await new Promise((resolve) => setImmediate(resolve));
const toggleHandler = elements.workerToggle.listeners.get("click");
assert.equal(typeof toggleHandler, "function", "worker toggle must register an interactive click handler");
await toggleHandler();
assert.equal(storedProfile.workerEnabled, false, "turning off the switch must persist the disabled worker state");
assert.equal(elements.workerDetails.hidden, true, "turning off the switch must hide live worker controls");
assert.equal(elements.disabledState.hidden, false, "turning off the switch must reveal the disabled explanation");
assert.equal(registerPayloads.at(-1).profile.enabled, false, "turning off the switch must immediately unregister the visible worker");
assert.ok(storageWrites.some((value) => value.workerEnabled === false && value.active === false), "disabled worker state must also clear active routing");

console.log("✓ Extension popup UI and worker enable toggle smoke test passed");
