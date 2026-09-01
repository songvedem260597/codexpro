import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHeadlessWorkerManager } from "../manager/electron/headless-workers.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-headless-worker-"));
const chromeRoot = path.join(root, "chrome-user-data");
const profileRoot = path.join(chromeRoot, "Profile 1");
const codexProHome = path.join(root, "codexpro-home");
const previousChromeRoot = process.env.CODEXPRO_CHROME_USER_DATA_DIR;
const previousChromePath = process.env.CODEXPRO_CHROME_PATH;

try {
  fs.mkdirSync(path.join(profileRoot, "Network"), { recursive: true });
  fs.mkdirSync(path.join(profileRoot, "Cache"), { recursive: true });
  fs.mkdirSync(path.join(profileRoot, "Local Extension Settings", "gndipignbnipohooclcbhjliikamjlpl"), { recursive: true });
  fs.writeFileSync(path.join(chromeRoot, "Local State"), JSON.stringify({
    profile: { info_cache: { "Profile 1": { name: "ChatGPT Worker", user_name: "worker@example.com" } } }
  }));
  fs.writeFileSync(path.join(profileRoot, "Preferences"), JSON.stringify({
    profile: { name: "ChatGPT Worker" },
    extensions: { settings: { gndipignbnipohooclcbhjliikamjlpl: { state: 1 } } }
  }));
  fs.writeFileSync(path.join(profileRoot, "Network", "Cookies"), "session-cookie-snapshot");
  fs.writeFileSync(path.join(profileRoot, "Cache", "skip-me"), "cache");
  fs.writeFileSync(path.join(profileRoot, "Local Extension Settings", "gndipignbnipohooclcbhjliikamjlpl", "000003.log"), "extension-state");

  process.env.CODEXPRO_CHROME_USER_DATA_DIR = chromeRoot;
  process.env.CODEXPRO_CHROME_PATH = process.execPath;

  const manager = createHeadlessWorkerManager({
    codexProHome,
    extensionRoot: path.resolve("chrome-extension")
  });

  const initial = manager.listWorkers();
  assert.equal(initial.supported, true);
  assert.equal(initial.chromePath, process.execPath);
  assert.equal(initial.sourceProfiles.length, 1);
  assert.equal(initial.sourceProfiles[0].profileDirectory, "Profile 1");
  assert.equal(initial.sourceProfiles[0].userName, "worker@example.com");
  assert.equal(initial.sourceProfiles[0].codexProInstalled, true);

  const created = await manager.createWorker({ sourceProfileDirectory: "Profile 1", autoStart: false });
  assert.equal(created.running, false);
  assert.equal(created.label, "ChatGPT Worker");
  assert.equal(created.sourceProfileDirectory, "Profile 1");
  assert.equal(created.sourceHasCodexProExtension, true);
  assert.ok(created.lastSyncedAt);
  assert.equal(fs.readFileSync(path.join(created.userDataDir, "Profile 1", "Network", "Cookies"), "utf8"), "session-cookie-snapshot");
  assert.equal(fs.existsSync(path.join(created.userDataDir, "Profile 1", "Cache", "skip-me")), false);
  assert.equal(fs.readFileSync(path.join(created.userDataDir, "Profile 1", "Local Extension Settings", "gndipignbnipohooclcbhjliikamjlpl", "000003.log"), "utf8"), "extension-state");

  const toggled = await manager.setWorkerAutoStart(created.id, true);
  assert.equal(toggled.autoStart, true);
  const synced = await manager.syncWorker(created.id);
  assert.ok(synced.lastSyncedAt);

  const legacyState = JSON.parse(fs.readFileSync(path.join(codexProHome, "headless-workers.json"), "utf8"));
  legacyState.workers[0].label = "Headless · ChatGPT Worker";
  fs.writeFileSync(path.join(codexProHome, "headless-workers.json"), JSON.stringify(legacyState));
  assert.equal(manager.listWorkers().workers[0].label, "ChatGPT Worker");
  assert.equal(JSON.parse(fs.readFileSync(path.join(codexProHome, "headless-workers.json"), "utf8")).workers[0].label, "ChatGPT Worker");

  const removed = await manager.deleteWorker(created.id);
  assert.equal(removed.removed, true);
  assert.equal(manager.listWorkers().workers.length, 0);
  assert.equal(fs.existsSync(path.join(codexProHome, "headless-workers", created.id)), false);

  console.log("✓ headless worker profile clone smoke test passed");
} finally {
  if (previousChromeRoot === undefined) delete process.env.CODEXPRO_CHROME_USER_DATA_DIR;
  else process.env.CODEXPRO_CHROME_USER_DATA_DIR = previousChromeRoot;
  if (previousChromePath === undefined) delete process.env.CODEXPRO_CHROME_PATH;
  else process.env.CODEXPRO_CHROME_PATH = previousChromePath;
  fs.rmSync(root, { recursive: true, force: true });
}
