import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldShowChatBusy, shouldShowChatSettling } from "../manager/src/chat-status.js";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

assert.equal(shouldShowChatSettling({ networkState: "completed", tabSettling: false, responseCurrent: true, responseIncomplete: true }), false, "completed network state must clear stale DOM settling");
assert.equal(shouldShowChatSettling({ networkState: "failed", tabSettling: true, responseCurrent: true, responseIncomplete: true }), false, "failed network state must clear settling");
assert.equal(shouldShowChatSettling({ networkState: "generating", tabSettling: true, responseCurrent: true, responseIncomplete: true }), true, "active generation may remain settling");
assert.equal(shouldShowChatBusy({ networkState: "completed", tabBusy: false, responseCurrent: true, responseBusy: true }), false, "completed network state must clear stale DOM busy state");
assert.equal(shouldShowChatBusy({ networkState: "failed", tabBusy: true, responseCurrent: true, responseBusy: true }), false, "failed network state must clear busy state");
assert.equal(shouldShowChatBusy({ networkState: "generating", tabBusy: false, responseCurrent: true, responseBusy: false }), true, "generating network state must remain busy");
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
assert.match(worker, /reconcileChatNetworkCompletion/, "canonical/stream completion must reconcile stuck network state");
assert.match(worker, /networkStream\.completed/, "stream completion must end a generation without waiting for CDP loadingFinished");
assert.match(worker, /probeCanonicalCompletion/, "tracker timeout must verify canonical response before reporting failure");
assert.match(worker, /browserElementActionPage/);
assert.match(worker, /__codexproSemanticRegistry/);
assert.match(worker, /subscribeDebuggerEvents/);
assert.match(worker, /withExtensionCdpTrace/);
assert.match(worker, /url\.searchParams\.set\(key,'<redacted>'\)/, "extension trace must redact query values");
assert.match(worker, /serializeBrowserTabMutation/);
assert.match(worker, /Page\.captureScreenshot/);
assert.doesNotMatch(worker, /chrome\.tabs\.captureVisibleTab/, "extension screenshots must not activate/capture the foreground tab");
assert.doesNotMatch(worker, /composer_html|connector_debug/, "generic snapshots must not contain ChatGPT-specific diagnostics");
assert.match(worker, /chatNetworkPostWaitersByTab/, "attachment upload waits must subscribe to network events");
const attachmentWait = worker.slice(worker.indexOf("async function waitForAttachmentUploadNetwork"), worker.indexOf("function shouldUseTrustedClickFallback"));
assert.doesNotMatch(attachmentWait, /setTimeout\(resolve,100\)/, "attachment upload waits must not poll every 100 ms");
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
assert.match(bridge, /bridgeErrorEnvelope/);
assert.match(bridge, /code: String\(envelope\.code/);
assert.match(server, /function errorEnvelope/);
assert.match(server, /structuredContent: \{ error: errorEnvelope\(error\) \}/);
assert.match(httpSource, /app\.get\("\/browser-events"/);
assert.match(httpSource, /text\/event-stream/);
assert.match(managerMain, /startBrowserProfileEventStream/);
assert.match(managerMain, /codexpro:browser-profiles/);
assert.match(managerPreload, /onBrowserProfiles/);
assert.match(managerPreload, /invokeResult/);
assert.match(managerUi, /SendDebugEvidence/);
assert.match(managerUi, /network_evidence/);
assert.match(managerUi, /REALTIME_WATCHDOG_MS = 30000/);
assert.match(managerUi, /api\.onBrowserProfiles/);
assert.doesNotMatch(managerUi, /REALTIME_POLL_MS = 1000/, "Manager must not poll status every second");

const manifest = JSON.parse(manifestText);
assert.equal(manifest.version, "0.5.49");
assert.ok(manifest.permissions.includes("debugger"));

console.log("✓ Browser agent persistent-session/batch/wait smoke test passed");
