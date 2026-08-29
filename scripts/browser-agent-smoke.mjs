import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canAcceptNextChatMessage, isRetryableChatTurnBusyError, shouldShowChatBusy, shouldShowChatSettling } from "../manager/src/chat-status.js";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

assert.equal(shouldShowChatSettling({ networkState: "completed", tabSettling: false, responseCurrent: true, responseIncomplete: true }), false, "completed network state must clear stale DOM settling");
assert.equal(shouldShowChatSettling({ networkState: "failed", tabSettling: true, responseCurrent: true, responseIncomplete: true }), true, "fresh tab settling must override a terminal network request");
assert.equal(shouldShowChatSettling({ networkState: "generating", tabSettling: true, responseCurrent: true, responseIncomplete: true }), true, "active generation may remain settling");
assert.equal(shouldShowChatBusy({ networkState: "completed", tabBusy: false, responseCurrent: true, responseBusy: true }), false, "completed network state must clear stale DOM busy state");
assert.equal(shouldShowChatBusy({ networkState: "failed", tabBusy: true, responseCurrent: true, responseBusy: true }), true, "fresh tab busy state must override a terminal network request");
assert.equal(shouldShowChatBusy({ networkState: "generating", tabBusy: false, responseCurrent: true, responseBusy: false }), true, "generating network state must remain busy");
assert.equal(canAcceptNextChatMessage({ networkState: "completed", tabBusy: false, tabSettling: true, responseCurrent: true, responseBusy: false, responseIncomplete: false }), false, "a visibly settling turn must reject the next message so ChatGPT cannot steer the old turn");
assert.equal(canAcceptNextChatMessage({ networkState: "completed", tabBusy: false, tabSettling: false, responseCurrent: true, responseBusy: false, responseIncomplete: false }), true, "a fully completed and settled turn may accept the next message");
assert.equal(isRetryableChatTurnBusyError(new Error("Đoạn chat vẫn đang hoàn tất lượt trước.")), true, "a fresh worker busy guard must be retried after the turn settles");
assert.equal(isRetryableChatTurnBusyError(new Error("Đoạn chat này đang xử lý yêu cầu khác.")), true, "a network busy race must be retried after the turn settles");
assert.equal(isRetryableChatTurnBusyError(new Error("SEND_UNCERTAIN")), false, "an uncertain submission must never be retried as a harmless busy race");
const [browserOps, worker, server, httpSource, bridge, managerMain, managerPreload, managerUi, managerStyles, manifestText] = await Promise.all([
  readFile(join(root, "src", "browserOps.ts"), "utf8"),
  readFile(join(root, "chrome-extension", "service-worker.js"), "utf8"),
  readFile(join(root, "src", "server.ts"), "utf8"),
  readFile(join(root, "src", "http.ts"), "utf8"),
  readFile(join(root, "src", "browserExtensionBridge.ts"), "utf8"),
  readFile(join(root, "manager", "electron", "main.mjs"), "utf8"),
  readFile(join(root, "manager", "electron", "preload.cjs"), "utf8"),
  readFile(join(root, "manager", "src", "main.jsx"), "utf8"),
  readFile(join(root, "manager", "src", "styles.css"), "utf8"),
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
assert.match(worker, /function probeChatActivityPage/, "profile status must supplement network state with a lightweight DOM activity probe");
assert.match(worker, /testId==='stop-button'/, "DOM activity probe must recognize ChatGPT's stop control");
assert.match(worker, /settling:!networkBusy&&domActivity\.busy/, "completed network requests must remain settling while ChatGPT is visibly active");
assert.match(worker, /activity_text:domActivity\.busy\?domActivity\.activity_text:''/, "active ChatGPT work must expose one concise activity line");
assert.match(worker, /scheduleDomActivityRefresh/, "DOM settling must refresh until ChatGPT becomes idle");
assert.match(worker, /conversation\|steer_turn/, "ChatGPT steer_turn must be tracked as a generation request");
assert.match(worker, /const staleActivity=Boolean\(injected\.result\.busy\)/, "canonical completion must recover a tab whose DOM is still stuck busy");
assert.match(worker, /await chatDomActivityState\(tab\.id,conversationId,\{fresh:true\}\)\)\.busy/, "worker send must force a fresh DOM activity probe before submitting");
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
assert.match(managerMain, /selectedConversationTab\?\.busy \|\| selectedNetworkState === "generating"/, "Manager backend must reject active network generations");
assert.doesNotMatch(managerMain, /selectedConversationTab\?\.busy \|\| selectedConversationTab\?\.settling/, "Manager backend must leave cached DOM settling decisions to the worker's fresh probe");
assert.match(managerMain, /codexpro:browser-profiles/);
assert.match(managerPreload, /onBrowserProfiles/);
assert.match(managerPreload, /invokeResult/);
assert.match(managerUi, /SendDebugEvidence/);
assert.match(managerUi, /network_evidence/);
assert.match(managerUi, /REALTIME_WATCHDOG_MS = 30000/);
assert.match(managerUi, /api\.onBrowserProfiles/);
assert.doesNotMatch(managerUi, /REALTIME_POLL_MS = 1000/, "Manager must not poll status every second");
assert.match(managerUi, /responseScrollLocked/, "manual transcript scrolling must lock auto-scroll");
assert.match(managerUi, /responseScrollLocked\.current\.get\(chatProfileId\)/, "stream updates must respect the manual scroll lock");
assert.match(managerUi, /responseScrollLocked\.current\.delete\(profile\.profile_id\)/, "sending a new message must resume auto-scroll");
assert.match(managerUi, /!tab\.busy && !tab\.settling && currentResponse\?\.repoTaskId/, "CodexPro verification must wait until the ChatGPT turn has visibly settled");
assert.match(managerUi, /ChatGPT vẫn đang xử lý hoặc hoàn tất lượt trước/, "send must reject attempts that would steer the active turn");
assert.match(managerUi, /setRequestSendEvidence\(\(current\) => \(\{ \.\.\.current, \[profile\.profile_id\]: null \}\)\)/, "opening Chrome must clear stale send evidence");
assert.match(managerUi, /isRetryableChatTurnBusyError\(err\)/, "CodexPro verification must distinguish a harmless busy race from an uncertain send");
assert.match(managerUi, /repoTaskVerificationReads\.current\.set\(verificationKey, Date\.now\(\) \+ REPO_TASK_VERIFICATION_RETRY_MS\)/, "a blocked verification retry must be released after a cooldown");
assert.match(managerUi, /repoTaskStatus: "waiting", loading: false/, "a rejected verification retry must return to waiting instead of remaining stuck on retrying");
assert.match(managerStyles, /\.chat-response-head strong \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/, "long response headlines must remain one line and end with an ellipsis");
assert.match(managerUi, /className="toast-icon"[\s\S]*?<svg viewBox="0 0 24 24"/, "success toasts must use the custom vector status icon");
assert.match(managerStyles, /\.toast-message \{[^}]*font-family: var\(--app-font-family,[^}]*font-weight: var\(--weight-semibold\)/, "toast typography must match the Manager interface");
assert.doesNotMatch(managerUi, /RESPONSE_AUTO_SCROLL_RESUME_MS/, "manual transcript scrolling must not auto-resume on a timer");

const manifest = JSON.parse(manifestText);
assert.equal(manifest.version, "0.5.53");
assert.ok(manifest.permissions.includes("debugger"));

console.log("✓ Browser agent persistent-session/batch/wait smoke test passed");
