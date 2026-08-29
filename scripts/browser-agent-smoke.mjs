import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canAcceptNextChatMessage, isRetryableChatTurnBusyError, shouldShowChatBusy, shouldShowChatSettling } from "../manager/src/chat-status.js";
import { isNetworkStreamCurrentGeneration, materializeTranscriptMessages, mergeNetworkStreamTranscript, replaceCanonicalTranscript, transcriptAwaitingAssistant } from "../manager/src/chat-transcript.js";

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
assert.equal(transcriptAwaitingAssistant(partialCanonicalTranscript), false, "an existing live stream assistant counts as the response for the latest user");
const missingLatestResponse = [
  { id: "cached-user", role: "user", text: "Yêu cầu cũ" },
  { id: "cached-assistant", role: "assistant", text: "Phản hồi cũ" },
  { id: "optimistic-user-latest", role: "user", text: "Yêu cầu mới đang thiếu response" }
];
assert.equal(transcriptAwaitingAssistant(missingLatestResponse), true, "a cache ending at the newest user must be treated as incomplete even when network tracking is idle");
const recoveredLatestResponse = replaceCanonicalTranscript(missingLatestResponse, [
  { id: "canonical-user-old", role: "user", text: "Yêu cầu cũ" },
  { id: "canonical-assistant-old", role: "assistant", text: "Phản hồi cũ" },
  { id: "canonical-user-latest", role: "user", text: "Yêu cầu mới đang thiếu response" },
  { id: "canonical-assistant-latest", role: "assistant", text: "Response mới phải được nối vào" }
]);
assert.equal(recoveredLatestResponse.at(-1).text, "Response mới phải được nối vào", "canonical recovery must append the missing latest response after the newest user");
assert.equal(transcriptAwaitingAssistant(recoveredLatestResponse), false, "canonical recovery must close the previously incomplete latest exchange");
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
const [browserOps, worker, server, httpSource, bridge, managerMain, managerPreload, managerUi, managerStyles, managerChatScroll, manifestText] = await Promise.all([
  readFile(join(root, "src", "browserOps.ts"), "utf8"),
  readFile(join(root, "chrome-extension", "service-worker.js"), "utf8"),
  readFile(join(root, "src", "server.ts"), "utf8"),
  readFile(join(root, "src", "http.ts"), "utf8"),
  readFile(join(root, "src", "browserExtensionBridge.ts"), "utf8"),
  readFile(join(root, "manager", "electron", "main.mjs"), "utf8"),
  readFile(join(root, "manager", "electron", "preload.cjs"), "utf8"),
  readFile(join(root, "manager", "src", "main.jsx"), "utf8"),
  readFile(join(root, "manager", "src", "styles.css"), "utf8"),
  readFile(join(root, "manager", "src", "chat-scroll.js"), "utf8"),
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
assert.match(browserOps, /Timed out connecting to the Chrome tab[\s\S]*?socket\.close\(\)/, "a timed-out CDP connection must close its half-open socket");
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
assert.match(worker, /const shouldProbeDom=Boolean\(conversationId&&\(tab\.active\|\|networkState\.busy\|\|cachedDomActivity\?\.busy/, "idle background ChatGPT tabs must not receive unconditional DOM probes");
assert.match(worker, /for\(const tabId of chatDomActivityByTab\.keys\(\)\)if\(!liveTabIds\.has\(tabId\)\)chatDomActivityByTab\.delete\(tabId\)/, "closed tabs must be pruned from the DOM activity cache");
assert.match(worker, /testId==='stop-button'/, "DOM activity probe must recognize ChatGPT's stop control");
assert.match(worker, /settling:!networkBusy&&domActivity\.busy/, "completed network requests must remain settling while ChatGPT is visibly active");
assert.match(worker, /activity_text:streamBusy\?/, "active ChatGPT work must expose one concise network-or-DOM activity line");
assert.match(worker, /async function confirmConnectorFromLiveToolActivity/, "worker must self-heal stale connector status after observing a real CodexPro tool call");
assert.match(worker, /await confirmConnectorFromLiveToolActivity\(tabs\)[\s\S]*?const profile=await profileInfo\(\)/, "worker must persist live-tool confirmation before reporting the next profile heartbeat");
assert.match(worker, /scheduleDomActivityRefresh/, "DOM settling must refresh until ChatGPT becomes idle");
assert.match(worker, /async function recentConversationList[\s\S]*?promiseWithTimeout\([\s\S]*?fetchRecentConversationsPage[\s\S]*?DOM_ACTION_TIMEOUT_MS/, "a hung active renderer must not block the extension poll loop and heartbeat");
assert.match(worker, /if\(action==='recover_chat_tab'\)[\s\S]*?WORKER_BUSY:[\s\S]*?replaceUnresponsiveChatTab/, "manual tab recovery must refuse active generations and replace only an idle renderer");
assert.match(worker, /async function replaceUnresponsiveChatTab[\s\S]*?chrome\.tabs\.create[\s\S]*?waitForTab[\s\S]*?chrome\.tabs\.remove\(replacedTabId\)/, "renderer recovery must load a replacement before closing the exact stuck tab");
assert.match(worker, /dom_replaced=true[\s\S]*?recovery_tab_id/, "stale-response reload recovery must escalate to replacing a renderer that stays unresponsive");
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
assert.match(managerMain, /async function recoverProfileChatTab[\s\S]*?action: "recover_chat_tab"[\s\S]*?60000/, "Manager must expose the bounded replace-tab recovery command");

assert.match(server, /steps: z\.array\(z\.object/);
assert.match(server, /timeout_ms: z\.number\(\)\.int\(\)\.min\(100\)\.max\(60000\)/);
assert.match(server, /steps: Array\.isArray\(args\.steps\)/);
for (const locator of ["ref", "role", "name", "placeholder", "label", "test_id", "nth"]) assert.match(server, new RegExp(`${locator}:`));
assert.match(server, /trace_ms/);
assert.match(server, /delta:/);

assert.match(bridge, /subscribeBrowserExtensionProfiles/);
assert.match(bridge, /const observedCodexProToolActivity = conversationSummaries\.some/, "bridge must treat live CodexPro tool activity as stronger evidence than a stale connector false-negative");
assert.match(bridge, /const connectorInstalled = profile\.connectorInstalled \|\| observedCodexProToolActivity/, "profile summaries must not show CodexPro missing while it is actively being used");
assert.match(bridge, /function pruneExpiredProfiles/);
assert.match(bridge, /profileWorkspaceRoots\.delete\(id\)[\s\S]*?profileWorkspaceBindings\.delete\(id\)/, "expired extension profiles must release workspace maps");
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
assert.match(managerPreload, /recoverProfileChat/);
assert.match(managerPreload, /invokeResult/);
assert.match(managerUi, /SendDebugEvidence/);
assert.match(managerUi, /network_evidence/);
assert.match(managerUi, /REALTIME_WATCHDOG_MS = 30000/);
assert.match(managerUi, /PROJECT_REFRESH_MS = 5 \* 60 \* 1000/, "project discovery must not run every status watchdog tick");
assert.match(managerMain, /app\.requestSingleInstanceLock\(\)/, "normal Manager launches must hold a single-instance lock");
assert.match(managerMain, /REPO_SCAN_CACHE_MS = 10 \* 60 \* 1000/, "repo discovery must use a durable cache");
assert.match(managerMain, /GIT_SUMMARY_CACHE_MS = 2 \* 60 \* 1000/, "project Git summaries must be cached independently");
assert.match(managerUi, /api\.onBrowserProfiles/);
assert.doesNotMatch(managerUi, /REALTIME_POLL_MS = 1000/, "Manager must not poll status every second");
assert.match(managerUi, /responseScrollLocked/, "manual transcript scrolling must lock auto-scroll");
assert.match(managerUi, /rendererUnresponsive[\s\S]*?recoverProfileTab\(profile\)[\s\S]*?Khôi phục tab/, "an unresponsive ChatGPT renderer must expose a one-click replacement in the profile card");
assert.match(managerUi, /responseScrollLocked\.current\.get\(chatProfileId\)/, "stream updates must respect the manual scroll lock");
assert.match(managerUi, /responseScrollLocked\.current\.delete\(profile\.profile_id\)/, "sending a new message must resume auto-scroll");
assert.match(managerUi, /const scrollOpenChatToBottom = useCallback\([\s\S]*?modal\.scrollTop = modal\.scrollHeight/, "opening Chat must drive the outer modal scrollbar to the real bottom");
assert.match(managerUi, /function openChat\(profile\)[\s\S]*?responseScrollPositions\.current\.delete\(profile\.profile_id\)[\s\S]*?scrollOpenChatToBottom\(profile\.profile_id\)[\s\S]*?hydrateCachedResponse\(profile, conversationId\)\.finally/, "opening Chat must hydrate the cached transcript before finishing both modal/transcript at the bottom");
assert.match(managerUi, /openChatAwaitingAssistant[\s\S]*?pollLatestResponse[\s\S]*?canonicalOnly/, "Manager must poll canonical data without DOM while the newest user is still missing an assistant response");
assert.match(managerUi, /tab\.connection_interrupted[\s\S]*?connectionRecoveryReads[\s\S]*?loadResponse\(profile, conversationId, true, true, true\)/, "Manager must automatically recover the exact chat when ChatGPT reports an interrupted connection");
assert.match(worker, /connection_interrupted:Boolean\(domActivity\.connection_interrupted\)/, "profile status must expose interrupted ChatGPT renderers to Manager");
assert.match(worker, /connectionInterrupted\?'connection_interrupted':staleActivity[\s\S]*?chrome\.tabs\.reload\(tab\.id\)/, "an interrupted ChatGPT response must reload the exact conversation tab first");
assert.match(worker, /!rendererRefreshed\|\|domResult\.connection_interrupted[\s\S]*?replaceUnresponsiveChatTab\(tab,`https:\/\/chatgpt\.com\/c\/\$\{conversationId\}`\)/, "a chat that remains interrupted after reload must be replaced at the same conversation URL");
assert.match(bridge, /connection_interrupted:\s*tab\.connection_interrupted\s*===\s*true/, "the extension bridge must preserve interrupted-response state for Manager recovery");
assert.match(worker, /args\.read_dom===false&&args\.canonical_only!==true[\s\S]*?args\.canonical_only===true[\s\S]*?canonical_available:true/, "worker must expose authenticated canonical response reads without querying transcript DOM");
assert.match(managerMain, /read_dom: payload\?\.canonicalOnly === true \|\| payload\?\.readDom !== false,[\s\S]*?canonical_only: payload\?\.canonicalOnly === true/, "Manager canonical recovery must remain compatible with a server process that has not restarted yet");
assert.match(managerUi, /cachedResponseIsFresh\([\s\S]*?network_last_completed_at/, "Chat reopening must compare the persisted response against the latest network completion before re-reading transcript content");
assert.match(managerPreload, /getChatResponseCache[\s\S]*?saveChatResponseCache/, "Manager preload must expose persistent chat-response cache access");
assert.match(managerPreload, /logChatLayout[\s\S]*?codexpro:log-chat-layout/, "Manager preload must expose fire-and-forget chat layout tracing");
assert.match(managerMain, /manager-chat-layout\.jsonl[\s\S]*?appendManagerChatLayoutLog[\s\S]*?codexpro:log-chat-layout/, "Manager must persist bounded chat layout traces");
assert.match(managerMain, /manager-chat-cache\.json[\s\S]*?MAX_CHAT_CACHE_ENTRIES = 30/, "Manager must persist a bounded local response cache instead of rebuilding every transcript on open");
assert.match(managerUi, /!tab\.busy && !tab\.settling && currentResponse\?\.repoTaskId/, "CodexPro verification must wait until the ChatGPT turn has visibly settled");
assert.match(managerUi, /ChatGPT vẫn đang xử lý hoặc hoàn tất lượt trước/, "send must reject attempts that would steer the active turn");
assert.match(managerUi, /setRequestSendEvidence\(\(current\) => \(\{ \.\.\.current, \[profile\.profile_id\]: null \}\)\)/, "opening Chrome must clear stale send evidence");
assert.match(managerUi, /isRetryableChatTurnBusyError\(err\)/, "CodexPro verification must distinguish a harmless busy race from an uncertain send");
assert.match(managerUi, /repoTaskVerificationReads\.current\.set\(verificationKey, Date\.now\(\) \+ REPO_TASK_VERIFICATION_RETRY_MS\)/, "a blocked verification retry must be released after a cooldown");
assert.match(managerUi, /repoTaskStatus: "waiting", loading: false/, "a rejected verification retry must return to waiting instead of remaining stuck on retrying");
assert.match(managerStyles, /\.chat-response-head strong \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/, "long response headlines must remain one line and end with an ellipsis");
assert.match(managerUi, /className="chat-response-send-state"[\s\S]*?Đang gửi tin nhắn[\s\S]*?className="typing-dots"/, "the send indicator must render inline inside the response header");
assert.match(managerStyles, /\.chat-response-send-state \{[^}]*inline-flex;[^}]*white-space: nowrap;/, "the inline send indicator must stay compact on the response status row");
assert.match(managerStyles, /\.chat-modal \{[^}]*height: 94vh;[^}]*overflow-anchor: none;[^}]*scrollbar-gutter: stable;/, "chat modal geometry must stay fixed while send state, attachments, and evidence change");
assert.match(managerStyles, /\.latest-response \{[^}]*overflow-anchor: none;[^}]*scrollbar-gutter: stable;[^}]*scroll-behavior: auto;/, "realtime transcript updates must not repeatedly animate or re-anchor the chat viewport");
assert.match(managerUi, /const openChatScrollKey = useMemo\([\s\S]*?lastMessage[\s\S]*?visibleText[\s\S]*?contentKey[\s\S]*?turnKey/, "chat auto-scroll must follow visible transcript content and the explicit turn lifecycle");
assert.match(managerUi, /useLayoutEffect\(\(\) => \{[\s\S]*?openChatScrollKey[\s\S]*?scrollResponseToBottom\(chatProfileId\)/, "chat auto-scroll must settle before paint to avoid a visible second jump");
const sendRequestSource = managerUi.slice(managerUi.indexOf("async function sendRequest(profile)"), managerUi.indexOf("async function rolloverFullConversation"));
assert.doesNotMatch(sendRequestSource, /requestAnimationFrame\(\(\) => scrollResponseToBottom/, "sendRequest must not schedule a duplicate transcript scroll");
assert.match(managerUi, /responseTurnActive[\s\S]*?is-response-runway/, "an active send must reserve a half-height response runway before stream content arrives");
assert.ok(managerUi.indexOf("const selectedSettling =") < managerUi.indexOf("const responseTurnActive ="), "response cage activity must be derived only after busy/settling state is initialized");
assert.match(managerUi, /logChatLayout[\s\S]*?MutationObserver[\s\S]*?ResizeObserver/, "Manager chat must trace intermittent DOM and height changes behind layout jumps");
assert.match(managerStyles, /\.chat-transcript-message\.is-response-cage \{[^}]*min-height: 108px;[^}]*padding-bottom: 24px;/, "the reserved response cage must keep enough vertical space to prevent transcript jumps");
assert.match(managerStyles, /\.chat-transcript-message\.is-response-runway \{[^}]*--chat-response-runway-height/, "the newest turn must keep a half-height runway below the sent message");
assert.match(managerStyles, /\.chat-transcript-message \{[^}]*flex: 0 0 auto;/, "response runway must never shrink older messages and overlap their content");
assert.match(managerUi, /installResponseAutoPin[\s\S]*?chatResponseRef[\s\S]*?scrollResponseToBottom/, "Manager must keep the transcript pinned after async DOM and layout changes");
assert.match(managerChatScroll, /handleResponseWheel[\s\S]*?deltaY < 0[\s\S]*?recordResponseScroll[\s\S]*?responseDistanceFromBottom/, "only explicit upward user input may pause auto-scroll; layout-driven scroll events must not lock it");
assert.doesNotMatch(managerStyles, /\.message-send-indicator\s*\{/, "the old standalone send status panel must be removed");
assert.match(managerUi, /className="toast-icon"[\s\S]*?<svg viewBox="0 0 24 24"/, "success toasts must use the custom vector status icon");
assert.match(managerStyles, /\.toast-message \{[^}]*font-family: var\(--app-font-family,[^}]*font-weight: var\(--weight-semibold\)/, "toast typography must match the Manager interface");
assert.doesNotMatch(managerUi, /RESPONSE_AUTO_SCROLL_RESUME_MS/, "manual transcript scrolling must not auto-resume on a timer");
assert.match(managerUi, /networkState === "generating" \|\| tab\.settling/, "Manager must keep polling tool activity after the initial generation request completes");
assert.match(managerUi, /network_stream_activity_text/, "Manager must render live network tool activity without exposing raw tool payloads");

const manifest = JSON.parse(manifestText);
assert.equal(manifest.version, "0.5.63");
assert.match(managerMain, new RegExp(`const WORKER_EXTENSION_VERSION = "${manifest.version.replace(/\\./g, "\\\\.")}";`), "Manager backend worker target must match the packaged extension version");
assert.match(managerMain, /confirmationDeadline[\s\S]*?versionAtLeast\(profile\.extension_version\)/, "worker update must wait for a heartbeat confirming the new extension version");
assert.doesNotMatch(managerUi, /window\.confirm\(/, "worker update must use the CodexPro confirmation dialog instead of the native Windows prompt");
assert.match(managerUi, /className="worker-update-dialog"[\s\S]*?Cập nhật CodexPro Worker[\s\S]*?Cập nhật worker/, "Manager must render the custom worker update confirmation dialog");
assert.match(managerUi, /Đã update thành công.*result\.version/, "Manager must only announce update success after the backend confirms the target version");
assert.ok(manifest.permissions.includes("debugger"));

console.log("✓ Browser agent persistent-session/batch/wait smoke test passed");
