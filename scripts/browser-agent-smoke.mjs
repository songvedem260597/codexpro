import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canAcceptNextChatMessage, isRetryableChatTurnBusyError, shouldShowChatBusy, shouldShowChatSettling } from "../manager/src/chat-status.js";
import { isNetworkStreamCurrentGeneration, materializeTranscriptMessages, mergeNetworkStreamTranscript, replaceCanonicalTranscript } from "../manager/src/chat-transcript.js";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

assert.equal(shouldShowChatSettling({ networkState: "completed", tabSettling: false, responseCurrent: true, responseIncomplete: true }), false, "completed network state must clear stale DOM settling");
assert.equal(shouldShowChatSettling({ networkState: "failed", tabSettling: true, responseCurrent: true, responseIncomplete: true }), true, "fresh tab settling must override a terminal network request");
assert.equal(shouldShowChatSettling({ networkState: "generating", tabSettling: true, responseCurrent: true, responseIncomplete: true }), true, "active generation may remain settling");
assert.equal(shouldShowChatBusy({ networkState: "completed", tabBusy: false, responseCurrent: true, responseBusy: true }), false, "completed network state must clear stale DOM busy state");
assert.equal(shouldShowChatBusy({ networkState: "completed", tabBusy: false, responseCurrent: true, responseBusy: true, streamBusy: true }), true, "a live tool stream must remain busy after the initial generation request completes");
assert.equal(shouldShowChatBusy({ networkState: "failed", tabBusy: true, responseCurrent: true, responseBusy: true }), true, "fresh tab busy state must override a terminal network request");
assert.equal(shouldShowChatBusy({ networkState: "generating", tabBusy: false, responseCurrent: true, responseBusy: false }), true, "generating network state must remain busy");
assert.equal(canAcceptNextChatMessage({ networkState: "completed", tabBusy: false, tabSettling: true, responseCurrent: true, responseBusy: false, responseIncomplete: false }), false, "a visibly settling turn must reject the next message so ChatGPT cannot steer the old turn");
assert.equal(canAcceptNextChatMessage({ networkState: "completed", tabBusy: false, tabSettling: false, responseCurrent: true, responseBusy: false, responseIncomplete: false }), true, "a fully completed and settled turn may accept the next message");
assert.equal(isRetryableChatTurnBusyError(new Error("Đoạn chat vẫn đang hoàn tất lượt trước.")), true, "a fresh worker busy guard must be retried after the turn settles");
assert.equal(isRetryableChatTurnBusyError(new Error("Đoạn chat này đang xử lý yêu cầu khác.")), true, "a network busy race must be retried after the turn settles");
assert.equal(isRetryableChatTurnBusyError(new Error("Profile này đang gửi một yêu cầu khác. Hãy chờ network ACK trước khi gửi tiếp.")), true, "a profile-level send race must be retried without showing a false verification error");
assert.equal(isRetryableChatTurnBusyError(new Error("SEND_UNCERTAIN")), false, "an uncertain submission must never be retried as a harmless busy race");

const cachedTranscript = materializeTranscriptMessages({
  conversationId: "conversation-1",
  text: "Phản hồi cũ vẫn phải còn",
  messages: []
}, "conversation-1");
assert.equal(cachedTranscript.length, 1, "a cached response must become a transcript message before optimistic send");
assert.equal(cachedTranscript[0].role, "assistant");
const newerCachedTranscript = materializeTranscriptMessages({
  conversationId: "conversation-1",
  text: "Phản hồi mới chưa vào canonical",
  messages: cachedTranscript
}, "conversation-1");
assert.equal(newerCachedTranscript.length, 2, "a newer cached response must not be hidden just because an older assistant message exists");

const optimisticTranscript = [...cachedTranscript, { id: "optimistic-user-1", role: "user", text: "Yêu cầu mới", pending: true }];
const firstStreamTranscript = mergeNetworkStreamTranscript(optimisticTranscript, {
  conversationId: "conversation-1",
  text: "Đang xử lý"
});
const updatedStreamTranscript = mergeNetworkStreamTranscript(firstStreamTranscript, {
  conversationId: "conversation-1",
  text: "Đã xử lý gần xong"
});
assert.equal(updatedStreamTranscript.filter((message) => message.id === "network-stream-assistant:conversation-1").length, 1, "network events must update one live response instead of flooding the transcript");
assert.equal(updatedStreamTranscript.at(-1).text, "Đã xử lý gần xong");
assert.ok(updatedStreamTranscript.some((message) => message.text === "Phản hồi cũ vẫn phải còn"), "network streaming must preserve the previous response");
assert.ok(updatedStreamTranscript.some((message) => message.text === "Yêu cầu mới"), "network streaming must preserve the optimistic user message");
assert.deepEqual(replaceCanonicalTranscript(updatedStreamTranscript, []), updatedStreamTranscript, "an empty transient canonical read must not erase the visible transcript");
const laggingCanonicalTranscript = replaceCanonicalTranscript(updatedStreamTranscript, [{ id: "canonical-1", role: "assistant", text: "Canonical" }]);
assert.deepEqual(laggingCanonicalTranscript.map((message) => message.text), ["Canonical", "Yêu cầu mới"], "a populated but lagging canonical read must preserve a just-submitted optimistic user message");
const materializedCanonicalTranscript = replaceCanonicalTranscript(updatedStreamTranscript, [
  { id: "canonical-user-1", role: "user", text: "  Yêu cầu\u00a0mới  " },
  { id: "canonical-assistant-1", role: "assistant", text: "Đã nhận" }
]);
assert.deepEqual(materializedCanonicalTranscript.map((message) => message.id), ["canonical-user-1", "canonical-assistant-1"], "canonical materialization must replace the matching optimistic message without duplication");
const previousCompleteTranscript = [
  { id: "previous-user-1", role: "user", text: "Yêu cầu cũ" },
  { id: "previous-assistant-1", role: "assistant", text: "Phản hồi cũ phải còn" },
  { id: "optimistic-user-2", role: "user", text: "Yêu cầu đang xử lý" },
  { id: "network-stream-assistant:conversation-1", role: "assistant", text: "Đang gọi tool" }
];
const partialCanonicalTranscript = replaceCanonicalTranscript(previousCompleteTranscript, [
  { id: "canonical-user-1", role: "user", text: "Yêu cầu cũ" },
  { id: "canonical-assistant-1", role: "assistant", text: "Phản hồi cũ phải còn" },
  { id: "canonical-user-2", role: "user", text: "Yêu cầu đang xử lý" }
]);
assert.deepEqual(partialCanonicalTranscript, previousCompleteTranscript, "a canonical snapshot ending at the latest user must not erase prior or streaming assistant responses while ChatGPT is still working");
const fourExchanges = [1, 2, 3, 4].flatMap((turn) => [
  { id: `user-${turn}`, role: "user", text: `User ${turn}` },
  { id: `assistant-${turn}`, role: "assistant", text: `Assistant ${turn}` }
]);
const recentThreeExchanges = replaceCanonicalTranscript([], fourExchanges);
assert.deepEqual(recentThreeExchanges.map((message) => message.id), ["user-2", "assistant-2", "user-3", "assistant-3", "user-4", "assistant-4"], "Manager transcript must keep only the three most recent user/assistant exchanges");
const consecutiveUserFollowups = replaceCanonicalTranscript([], [
  { id: "user-1", role: "user", text: "Yêu cầu trước" },
  { id: "assistant-1", role: "assistant", text: "Phản hồi trước phải còn" },
  { id: "user-2", role: "user", text: "Sửa thêm phần A" },
  { id: "user-3", role: "user", text: "Sửa thêm phần B" },
  { id: "user-4", role: "user", text: "Sửa thêm phần C" }
]);
assert.deepEqual(consecutiveUserFollowups.map((message) => message.id), ["user-1", "assistant-1", "user-2", "user-3", "user-4"], "consecutive user follow-ups before one assistant response must count as one open exchange and must not evict prior responses");
const fragmentedAssistantTurns = replaceCanonicalTranscript([], [
  { id: "fragment-user-1", role: "user", text: "Turn one" },
  { id: "fragment-assistant-1a", role: "assistant", text: "Tool progress" },
  { id: "fragment-assistant-1b", role: "assistant", text: "Final one" },
  { id: "fragment-user-2", role: "user", text: "Turn two" },
  { id: "fragment-assistant-2a", role: "assistant", text: "Draft two" },
  { id: "fragment-assistant-2b", role: "assistant", text: "Final two" }
]);
assert.deepEqual(fragmentedAssistantTurns.map((message) => message.id), ["fragment-user-1", "fragment-assistant-1b", "fragment-user-2", "fragment-assistant-2b"], "each exchange must keep only the latest visible assistant response instead of rendering internal assistant fragments");
assert.equal(isNetworkStreamCurrentGeneration({ networkStartedAt: "2026-08-29T14:00:10.000Z", streamUpdatedAt: "2026-08-29T14:00:09.999Z" }), false, "a stream from the previous generation must never be appended after a new optimistic user message");
assert.equal(isNetworkStreamCurrentGeneration({ networkStartedAt: "2026-08-29T14:00:10.000Z", streamUpdatedAt: "2026-08-29T14:00:10.001Z" }), true, "a stream updated by the current generation may be rendered live");
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
assert.match(worker, /network_stream_activity_text:networkStreamActivityText/, "worker responses must expose live CodexPro tool activity separately from assistant text");
assert.match(worker, /network_stream_in_progress:networkStreamInProgress/, "worker responses must expose whether the tool stream is still open");
assert.match(worker, /streamBusy\?\(streamActivity\|\|'CodexPro đang sử dụng tool'\)/, "profile status must prefer live tool activity over stale DOM activity");
assert.match(worker, /probeCanonicalCompletion/, "tracker timeout must verify canonical response before reporting failure");
assert.match(worker, /function probeChatActivityPage/, "profile status must supplement network state with a lightweight DOM activity probe");
assert.match(worker, /testId==='stop-button'/, "DOM activity probe must recognize ChatGPT's stop control");
assert.match(worker, /settling:!networkBusy&&domActivity\.busy/, "completed network requests must remain settling while ChatGPT is visibly active");
assert.match(worker, /activity_text:streamBusy\?/, "active ChatGPT work must expose one concise network-or-DOM activity line");
assert.match(worker, /scheduleDomActivityRefresh/, "DOM settling must refresh until ChatGPT becomes idle");
assert.match(worker, /conversation\|steer_turn/, "ChatGPT steer_turn must be tracked as a generation request");
assert.match(worker, /const staleActivity=Boolean\(injected\.result\.busy\)/, "canonical completion must recover a tab whose DOM is still stuck busy");
assert.match(worker, /await chatDomActivityState\(tab\.id,conversationId,\{fresh:true\}\)\)\.busy/, "worker send must force a fresh DOM activity probe before submitting");
assert.match(worker, /num_turns=6/, "canonical transcript reads must request only the three most recent user/assistant exchanges");
assert.doesNotMatch(worker, /num_turns=40/, "canonical transcript reads must not fetch the old 20-exchange window");
assert.match(worker, /Array\.isArray\(payload\?\.messages\)/, "canonical transcript reads must parse the bounded messages payload directly");
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

const openProfileChat = managerMain.slice(managerMain.indexOf("async function openProfileChat"), managerMain.indexOf("async function reloadChromeProfiles"));
assert.match(openProfileChat, /action: "activate_tab"[\s\S]*?}, 32000\)/, "Manager must wait longer than the 25-second extension bridge command timeout");
assert.match(openProfileChat, /catch \(error\) \{\s*activationError = error;\s*\}[\s\S]*?focusChromeWindow\(title\)/, "a delayed activate acknowledgement must still verify whether Chrome actually opened");
assert.match(openProfileChat, /activation_acknowledgement_delayed: Boolean\(activationError\)/, "open-profile diagnostics must expose delayed activation acknowledgements");

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
assert.match(managerUi, /const scrollOpenChatToBottom = useCallback\([\s\S]*?modal\.scrollTop = modal\.scrollHeight/, "opening Chat must drive the outer modal scrollbar to the real bottom");
assert.match(managerUi, /function openChat\(profile\)[\s\S]*?responseScrollPositions\.current\.delete\(profile\.profile_id\)[\s\S]*?scrollOpenChatToBottom\(profile\.profile_id\)[\s\S]*?loadResponse\(profile, conversationId, true, true\)\.finally/, "opening Chat must reset manual scroll state and finish both modal/transcript at the bottom after loading");
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
assert.match(managerUi, /networkState === "generating" \|\| tab\.settling/, "Manager must keep polling tool activity after the initial generation request completes");
assert.match(managerUi, /network_stream_activity_text/, "Manager must render live network tool activity without exposing raw tool payloads");

const manifest = JSON.parse(manifestText);
assert.equal(manifest.version, "0.5.60");
assert.ok(manifest.permissions.includes("debugger"));

console.log("✓ Browser agent persistent-session/batch/wait smoke test passed");
