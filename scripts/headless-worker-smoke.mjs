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
const sourceLockCalls = [];
const sourceUnlockCalls = [];
let sourceLockError = null;
let prelockObservedStarting = false;
let prelockTaskGateBlocked = false;

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
    getBrowserProfiles: async () => liveBrowserProfiles,
    setSourceProfileLock: async (profileId, workerId) => {
      sourceLockCalls.push({ profileId, workerId });
      const state = JSON.parse(fs.readFileSync(path.join(codexProHome, "headless-workers.json"), "utf8"));
      const worker = state.workers.find((item) => item.id === workerId);
      prelockObservedStarting = Boolean(worker?.startingAt) && !worker?.pid;
      try {
        await manager.assertProfileTaskExclusive(profileId);
      } catch (error) {
        prelockTaskGateBlocked = /Chrome vẫn dùng bình thường, nhưng ChatGPT và task CodexPro.*bị khóa/.test(String(error?.message || error));
      }
      if (sourceLockError) throw sourceLockError;
      return { ok: true, locked: true, worker_id: workerId };
    },
    clearSourceProfileLock: async (profileId, workerId) => {
      sourceUnlockCalls.push({ profileId, workerId });
      return { ok: true, locked: false, worker_id: workerId };
    }
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
  assert.equal(sourceLockCalls.length, 0, "busy source preflight must reject before any source ChatGPT lock is written");
  sourceLockError = new Error("TEST_PRELOCK_SENTINEL");
  await assert.rejects(
    manager.startWorker(created.id),
    /TEST_PRELOCK_SENTINEL/,
    "idle source must be pre-locked before headless Chrome is spawned"
  );
  assert.equal(sourceLockCalls.length, 1, "headless start must request exactly one source lock before spawn");
  assert.deepEqual(sourceLockCalls[0], { profileId: sourceProfileId, workerId: created.id });
  assert.equal(prelockObservedStarting, true, "headless worker must publish a starting lock before asking the source extension to lock ChatGPT");
  assert.equal(prelockTaskGateBlocked, true, "source task gate must already reject work during the pre-spawn starting window, before a headless pid exists");
  assert.ok(sourceUnlockCalls.some((call) => call.profileId === sourceProfileId && call.workerId === created.id), "failed headless startup must clear its source lock");
  assert.equal(String(JSON.parse(fs.readFileSync(path.join(codexProHome, "headless-workers.json"), "utf8")).workers[0].startingAt || ""), "", "failed startup must clear the persistent starting marker");
  sourceLockError = null;

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
  const managerRenderer = fs.readFileSync(path.resolve("manager/src/main.jsx"), "utf8");
  const serviceWorker = fs.readFileSync(path.resolve("chrome-extension/service-worker.js"), "utf8");
  const manifest = fs.readFileSync(path.resolve("chrome-extension/manifest.json"), "utf8");
  const networkCapture = fs.readFileSync(path.resolve("chrome-extension/network-capture.js"), "utf8");
  const headlessLock = fs.readFileSync(path.resolve("chrome-extension/headless-lock.js"), "utf8");
  const bridgeSource = fs.readFileSync(path.resolve("src/browserExtensionBridge.ts"), "utf8");
  const serverSource = fs.readFileSync(path.resolve("src/server.ts"), "utf8");
  const serverExclusive = serverSource.slice(
    serverSource.indexOf("async function assertBrowserControlHeadlessExclusive"),
    serverSource.indexOf("type GlobalRulesSnapshot")
  );

  const headlessSelectionUi = managerRenderer.slice(
    managerRenderer.indexOf('className="headless-create-row"'),
    managerRenderer.indexOf('className="headless-runtime-meta"')
  );
  assert.doesNotMatch(headlessSelectionUi, /headlessSelectedProfiles\.length\s*>?=\s*3|slice\(0,\s*3\)|\/3 đã chọn|tối đa 3 Chrome profile/, "headless source selection must not impose a fixed three-profile cap");
  assert.match(headlessSelectionUi, /headlessSelectedProfiles\.length[\s\S]*?headlessWorkerForSource\(profile, headlessState\.workers \|\| \[\]\)[\s\S]*?có thể tạo/, "headless source selection count must follow only Chrome profiles that can still create a worker");
  assert.match(managerRenderer, /function headlessWorkerForSource\(profile, workers = \[\]\)[\s\S]*?sourceProfileId[\s\S]*?sourceProfileDirectory/, "Manager must identify an existing headless worker by stable source id or source directory");
  assert.match(managerRenderer, /available = eligible\.filter\(\(profile\) => !headlessWorkerForSource\(profile, next\?\.workers \|\| \[\]\)\)/, "refresh must remove already-cloned Chrome profiles from the create selection");
  assert.match(headlessSelectionUi, /const clonedWorker = headlessWorkerForSource[\s\S]*?disabled=\{Boolean\(headlessBusy\) \|\| Boolean\(clonedWorker\)\}[\s\S]*?Đã có headless/, "already-cloned source profiles must be disabled and visibly explain which headless worker owns them");
  assert.match(managerMain, /headlessWorkers\.enforceExclusiveUse\(browserProfilesRaw\)/, "runtime status must continuously enforce source/headless exclusivity");
  assert.match(managerMain, /headlessWorkers\.enforceExclusiveUse\(payload\.profiles\)/, "realtime browser profile events must immediately enforce source/headless exclusivity");
  assert.ok((managerMain.match(/headlessWorkers\.assertProfileTaskExclusive\(profileId\)/g) || []).length >= 2, "Manager open/send paths must reject a source profile locked by headless");
  assert.doesNotMatch(managerMain, /closeSourceProfile:/, "Manager must not close the source Chrome profile just because headless is active");
  assert.match(managerMain, /setSourceProfileLock:[\s\S]*?action: "set_headless_lock"[\s\S]*?headless_worker_id/, "Manager must pre-lock source ChatGPT with the exact headless worker id before spawn");
  assert.match(managerMain, /clearSourceProfileLock:[\s\S]*?action: "clear_headless_lock"/, "Manager must be able to clear a failed or stopped headless source lock");
  assert.doesNotMatch(serverExclusive, /close_profile|windows\.remove/, "runtime exclusivity must never close an idle source Chrome profile");
  assert.match(serverSource, /startingAt\?: string[\s\S]*?Math\.max\(0, now - startingAtMs\) < 30_000/, "runtime task gating must treat a headless startup marker as exclusive before the Chrome pid is ready");
  assert.match(serverSource, /set_headless_lock[\s\S]*?clear_headless_lock[\s\S]*?headless_worker_id/, "runtime browser control must expose bounded source-lock actions and the owning worker id");
  assert.match(serverSource, /\["close_profile", "set_headless_lock", "clear_headless_lock"\]\.includes\(args\.action\)/, "lock-management actions must bypass the ordinary source-lock rejection while all other browser control remains exclusive");
  assert.match(bridgeSource, /startingAt[\s\S]*?ownsSession[\s\S]*?30_000/, "bridge lock discovery must cover the pre-spawn starting window as well as a live pid");
  assert.match(serviceWorker, /if\(action==='set_headless_lock'\)[\s\S]*?WORKER_BUSY[\s\S]*?headlessExclusiveWorkerId:exclusiveWorkerId/, "source extension must refuse a pre-lock while ChatGPT is busy and persist the exact owning worker id when idle");
  assert.match(serviceWorker, /pendingStartLock[\s\S]*?reason:'headless_starting'/, "source extension must keep the warning fail-closed while the headless process is still starting");
  assert.match(serviceWorker, /url\.searchParams\.set\('profile_id',profileId\)[\s\S]*?result\?\.locked===true[\s\S]*?headlessExclusiveWorkerId:workerId/, "source extension must discover and persist a running headless lock without closing Chrome");
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
