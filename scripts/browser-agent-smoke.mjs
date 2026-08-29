import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const [browserOps, worker, server, httpSource, bridge, managerMain, managerPreload, managerUi, manifestText] = await Promise.all([
  readFile(join(root, "src", "browserOps.ts"), "utf8"),
  readFile(join(root, "chrome-extension", "service-worker.js"), "utf8"),
  readFile(join(root, "src", "server.ts"), "utf8"),
  readFile(join(root, "src", "http.ts"), "utf8"),
  readFile(join(root, "src", "browserExtensionBridge.ts"), "utf8"),
  readFile(join(root, "manager", "electron", "main.mjs"), "utf8"),
  readFile(join(root, "manager", "electron", "preload.cjs"), "utf8"),
  readFile(join(root, "manager", "src", "main.jsx"), "utf8"),
  readFile(join(root, "chrome-extension", "manifest.json"), "utf8")
]);

for (const action of ["trusted_click", "hover", "scroll", "wait_for", "inspect_element", "evaluate", "batch"]) {
  assert.match(browserOps, new RegExp(`\\| \\"${action}\\"`), `dedicated browser action ${action} must be exposed`);
  assert.match(server, new RegExp(`\\"${action}\\"`), `browser_control schema must expose ${action}`);
}

assert.match(browserOps, /const CDP_SESSION_IDLE_MS = 30_000/);
assert.match(browserOps, /const persistentClients = new Map/);
assert.match(browserOps, /existing\?\.client\.isOpen\(\)/);
assert.match(browserOps, /action === "batch"/);
assert.match(browserOps, /Browser wait_for timed out/);
assert.match(browserOps, /Input\.dispatchMouseEvent/);
assert.match(browserOps, /private readonly listeners = new Map/);
assert.match(browserOps, /typeof message\.method === "string"/);
assert.match(browserOps, /Network\.requestWillBeSent/);
assert.match(browserOps, /Runtime\.consoleAPICalled/);
assert.match(browserOps, /withCdpTrace/);
assert.match(browserOps, /sanitizedTraceUrl/);
assert.match(browserOps, /url\.searchParams\.set\(key, "<redacted>"\)/, "CDP trace must redact query values");
assert.match(browserOps, /const targetMutationTails = new Map/);
assert.match(browserOps, /serializeTargetMutation/);
assert.match(browserOps, /semanticSnapshotExpression/);
assert.match(browserOps, /__codexproSemanticRegistry/);
assert.match(browserOps, /MutationObserver/);
const dedicatedBatch = browserOps.slice(browserOps.indexOf('if (action === "batch")'), browserOps.indexOf('if (action === "snapshot")'));
assert.match(dedicatedBatch, /executeResolved/);
assert.doesNotMatch(dedicatedBatch, /runBrowserControl/, "dedicated batch must not resolve the target/client again per step");

assert.match(worker, /const DEBUGGER_SESSION_IDLE_MS = 30000/);
assert.match(worker, /const debuggerSessionsByTab = new Map\(\)/);
assert.match(worker, /async function acquireDebuggerTab/);
assert.match(worker, /function releaseDebuggerTab/);
assert.match(worker, /persistent_debugger:true/);
assert.match(worker, /if\(action==='batch'\)/);
assert.match(worker, /if\(action==='wait_for'\)/);
assert.match(worker, /if\(action==='inspect_element'\)/);
assert.match(worker, /if\(action==='evaluate'\)/);
assert.match(worker, /WORKER_BUSY:/, "extension reload must refuse while a worker is generating");
assert.match(worker, /browserElementActionPage/);
assert.match(worker, /__codexproSemanticRegistry/);
assert.match(worker, /subscribeDebuggerEvents/);
assert.match(worker, /withExtensionCdpTrace/);
assert.match(worker, /url\.searchParams\.set\(key,'<redacted>'\)/, "extension trace must redact query values");
assert.match(worker, /serializeBrowserTabMutation/);
assert.match(worker, /Page\.captureScreenshot/);
assert.doesNotMatch(worker, /chrome\.tabs\.captureVisibleTab/, "extension screenshots must not activate/capture the foreground tab");
const extensionBatch = worker.slice(worker.indexOf("if(action==='batch')"), worker.indexOf("if(action==='snapshot')"));
assert.match(extensionBatch, /executeOnTab/);
assert.doesNotMatch(extensionBatch, /await execute\(/, "extension batch must not resolve the tab again per step");
assert.doesNotMatch(worker, /if\(action==='press'\)\{\s*const target=\{tabId:tab\.id\};await chrome\.debugger\.attach/, "press must not attach/detach a fresh debugger session per action");

assert.match(server, /steps: z\.array\(z\.object/);
assert.match(server, /timeout_ms: z\.number\(\)\.int\(\)\.min\(100\)\.max\(60000\)/);
assert.match(server, /steps: Array\.isArray\(args\.steps\)/);
for (const locator of ["ref", "role", "name", "placeholder", "label", "test_id", "nth"]) assert.match(server, new RegExp(`${locator}:`));
assert.match(server, /trace_ms/);
assert.match(server, /delta:/);

assert.match(bridge, /subscribeBrowserExtensionProfiles/);
assert.match(httpSource, /app\.get\("\/browser-events"/);
assert.match(httpSource, /text\/event-stream/);
assert.match(managerMain, /startBrowserProfileEventStream/);
assert.match(managerMain, /codexpro:browser-profiles/);
assert.match(managerPreload, /onBrowserProfiles/);
assert.match(managerUi, /REALTIME_WATCHDOG_MS = 30000/);
assert.match(managerUi, /api\.onBrowserProfiles/);
assert.doesNotMatch(managerUi, /REALTIME_POLL_MS = 1000/, "Manager must not poll status every second");

const manifest = JSON.parse(manifestText);
assert.equal(manifest.version, "0.5.48");
assert.ok(manifest.permissions.includes("debugger"));

console.log("✓ Browser agent persistent-session/batch/wait smoke test passed");
