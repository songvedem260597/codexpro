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
let liveBrowserProfiles = [];

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
  const sourceProfileId = "11111111-2222-4333-8444-555555555555";
  const extensionState = `extension-state profileId&\"${sourceProfileId}\"`;
  fs.writeFileSync(path.join(profileRoot, "Local Extension Settings", "gndipignbnipohooclcbhjliikamjlpl", "000003.log"), extensionState);

  process.env.CODEXPRO_CHROME_USER_DATA_DIR = chromeRoot;
  process.env.CODEXPRO_CHROME_PATH = process.execPath;

  const manager = createHeadlessWorkerManager({
    codexProHome,
    extensionRoot: path.resolve("chrome-extension"),
    getBrowserProfiles: async () => liveBrowserProfiles
  });

  const initial = manager.listWorkers();
  assert.equal(initial.supported, true);
  assert.equal(initial.chromePath, process.execPath);
  assert.equal(initial.sourceProfiles.length, 1);
  assert.equal(initial.sourceProfiles[0].profileDirectory, "Profile 1");
  assert.equal(initial.sourceProfiles[0].userName, "worker@example.com");
  assert.equal(initial.sourceProfiles[0].codexProInstalled, true);
  assert.equal(initial.sourceProfiles[0].profileId, sourceProfileId, "source profile id must be recovered from extension storage so exclusivity fails closed even without email");

  liveBrowserProfiles = [{
    profile_id: sourceProfileId,
    email: "worker@example.com",
    label: "Chrome profile nguồn",
    headless: false,
    connected: true,
    chatgpt_tab_count: 1,
    tab_count: 4,
    current_task_id: "cpt_aaaaaaaaaaaaaaaaaaaaaaaa",
    current_task_title: "Task đang chạy",
    activity: "idle",
    busy_request_count: 0,
    conversation_tabs: []
  }];
  await assert.rejects(
    manager.createWorker({ sourceProfileDirectory: "Profile 1", autoStart: true }),
    /Phải chờ task hoàn tất rồi mới được bật headless/,
    "first auto-start create must be blocked while the source profile owns a task"
  );
  assert.equal(manager.listWorkers().workers.length, 0, "blocked first auto-start create must not leave an orphan worker");

  const created = await manager.createWorker({ sourceProfileDirectory: "Profile 1", autoStart: false });
  assert.equal(created.running, false);
  assert.equal(created.label, "ChatGPT Worker");
  assert.equal(created.sourceProfileDirectory, "Profile 1");
  assert.equal(created.sourceProfileId, sourceProfileId);
  assert.equal(created.sourceHasCodexProExtension, true);
  assert.ok(created.lastSyncedAt);
  assert.equal(fs.readFileSync(path.join(created.userDataDir, "Profile 1", "Network", "Cookies"), "utf8"), "session-cookie-snapshot");
  assert.equal(fs.existsSync(path.join(created.userDataDir, "Profile 1", "Cache", "skip-me")), false);
  assert.equal(fs.readFileSync(path.join(created.userDataDir, "Profile 1", "Local Extension Settings", "gndipignbnipohooclcbhjliikamjlpl", "000003.log"), "utf8"), extensionState);
  await assert.rejects(
    manager.createWorker({ sourceProfileDirectory: "Profile 1", autoStart: true }),
    /Mỗi profile chỉ được có một headless worker/,
    "duplicate headless workers for the same source profile must be rejected"
  );
  assert.equal(manager.listWorkers().workers.length, 1, "duplicate create must not leave an orphan worker");
  await assert.rejects(
    manager.startWorker(created.id),
    /Phải chờ task hoàn tất rồi mới được bật headless/,
    "headless start must be blocked while the source profile still owns a task"
  );
  assert.equal(manager.listWorkers().workers[0].running, false);

  liveBrowserProfiles[0] = {
    ...liveBrowserProfiles[0],
    current_task_id: "",
    current_task_title: "",
    activity: "idle"
  };

  const simulatedRunningState = JSON.parse(fs.readFileSync(path.join(codexProHome, "headless-workers.json"), "utf8"));
  simulatedRunningState.workers[0].pid = process.pid;
  fs.writeFileSync(path.join(codexProHome, "headless-workers.json"), JSON.stringify(simulatedRunningState));

  await assert.rejects(
    manager.assertProfileTaskExclusive(sourceProfileId),
    /Chrome vẫn dùng bình thường, nhưng ChatGPT và task CodexPro.*bị khóa/,
    "source Chrome must remain usable while task creation and ChatGPT control are rejected immediately"
  );
  const headlessTaskGate = await manager.assertProfileTaskExclusive(created.id);
  assert.equal(headlessTaskGate.ok, true, "the headless worker must remain task-eligible while its idle source Chrome stays open");
  assert.equal(headlessTaskGate.sourceProfileId, sourceProfileId);

  const exclusivity = await manager.enforceExclusiveUse([
    liveBrowserProfiles[0],
    {
      profile_id: created.id,
      label: created.label,
      headless: true,
      connected: true,
      source_profile_id: sourceProfileId,
      tab_count: 1,
      chatgpt_tab_count: 1,
      activity: "idle",
      current_task_id: "",
      busy_request_count: 0,
      conversation_tabs: []
    }
  ]);
  assert.equal(exclusivity.stopped.length, 0, "an idle source Chrome must not stop headless merely because Chrome remains open");
  assert.deepEqual(exclusivity.lockedSources, [{ workerId: created.id, sourceProfileId }], "the open source Chrome must be reported as ChatGPT-locked rather than closed");

  const resetState = JSON.parse(fs.readFileSync(path.join(codexProHome, "headless-workers.json"), "utf8"));
  resetState.workers[0].pid = 0;
  fs.writeFileSync(path.join(codexProHome, "headless-workers.json"), JSON.stringify(resetState));

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

  const managerMain = fs.readFileSync(path.resolve("manager/electron/main.mjs"), "utf8");
  const serviceWorker = fs.readFileSync(path.resolve("chrome-extension/service-worker.js"), "utf8");
  const manifest = fs.readFileSync(path.resolve("chrome-extension/manifest.json"), "utf8");
  const networkCapture = fs.readFileSync(path.resolve("chrome-extension/network-capture.js"), "utf8");
  const headlessLock = fs.readFileSync(path.resolve("chrome-extension/headless-lock.js"), "utf8");
  const serverSource = fs.readFileSync(path.resolve("src/server.ts"), "utf8");
  const serverExclusive = serverSource.slice(
    serverSource.indexOf("async function assertBrowserControlHeadlessExclusive"),
    serverSource.indexOf("type GlobalRulesSnapshot")
  );

  assert.match(managerMain, /headlessWorkers\.enforceExclusiveUse\(browserProfilesRaw\)/, "runtime status must continuously enforce source/headless exclusivity");
  assert.match(managerMain, /headlessWorkers\.enforceExclusiveUse\(payload\.profiles\)/, "realtime browser profile events must immediately enforce source/headless exclusivity");
  assert.ok((managerMain.match(/headlessWorkers\.assertProfileTaskExclusive\(profileId\)/g) || []).length >= 2, "Manager open/send paths must reject a source profile locked by headless");
  assert.doesNotMatch(managerMain, /closeSourceProfile:/, "Manager must not close the source Chrome profile just because headless is active");
  assert.doesNotMatch(serverExclusive, /close_profile|windows\.remove/, "runtime exclusivity must never close an idle source Chrome profile");
  assert.match(serviceWorker, /url\.searchParams\.set\('profile_id',profileId\)[\s\S]*?result\?\.locked===true[\s\S]*?headlessExclusiveWorkerId:workerId/, "source extension must discover and persist a running headless lock without first closing Chrome");
  assert.match(manifest, /"headless-lock\.js"/, "ChatGPT pages must load the source/headless lock bridge at document_start");
  assert.match(headlessLock, /ChatGPT đang tạm khóa trên profile này[\s\S]*?Chrome vẫn dùng bình thường/, "a locked source ChatGPT tab must clearly explain that the rest of Chrome remains usable");
  assert.match(headlessLock, /body\.inert = true/, "the source ChatGPT document must become non-interactive while headless owns the session");
  assert.match(headlessLock, /setInterval\(\(\) => void refresh\(\), 300\)/, "the source ChatGPT lock must refresh quickly enough to warn immediately after headless starts or stops");
  assert.match(headlessLock, /\['click', 'pointerdown', 'submit', 'beforeinput', 'paste', 'drop', 'keydown'\]/, "locked source ChatGPT tabs must block direct user interaction as well as task submission");
  assert.match(networkCapture, /codexproHeadlessLocked[\s\S]*?isGenerationEndpoint[\s\S]*?throw new Error/, "MAIN-world ChatGPT generation fetches must fail closed while the source profile is locked by headless");
  assert.ok(serverSource.includes("if (gateProfileId) await assertBrowserControlHeadlessExclusive(gateProfileId);"), "begin_repo_task must reject source/headless task overlap before a task gate opens");
  assert.match(serverSource, /if \(!\["close_profile", "set_headless_lock", "clear_headless_lock"\]\.includes\(args\.action\)\) await assertBrowserControlHeadlessExclusive\(selectedProfile!\);/, "direct runtime browser_control must enforce headless exclusivity except for explicit lock-management and close actions");

  console.log("✓ headless worker source-Chrome warning/exclusivity smoke test passed");
} finally {
  if (previousChromeRoot === undefined) delete process.env.CODEXPRO_CHROME_USER_DATA_DIR;
  else process.env.CODEXPRO_CHROME_USER_DATA_DIR = previousChromeRoot;
  if (previousChromePath === undefined) delete process.env.CODEXPRO_CHROME_PATH;
  else process.env.CODEXPRO_CHROME_PATH = previousChromePath;
  fs.rmSync(root, { recursive: true, force: true });
}
