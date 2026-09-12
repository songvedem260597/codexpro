import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const [tabPolicySource, networkPolicySource, workerSource, managerSource, manifest, fastPrepareSource] = await Promise.all([
  readFile(join(root, "chrome-extension", "service-worker", "tab-policy.js"), "utf8"),
  readFile(join(root, "chrome-extension", "service-worker", "network-policy.js"), "utf8"),
  readFile(join(root, "chrome-extension", "service-worker.js"), "utf8"),
  readFile(join(root, "manager", "electron", "main.mjs"), "utf8"),
  readFile(join(root, "chrome-extension", "manifest.json"), "utf8").then(JSON.parse),
  readFile(join(root, "chrome-extension", "chat-send-fast-content.js"), "utf8").catch(() => "")
]);
const tabPolicy = Function("globalThis", `${tabPolicySource}; return globalThis.CodexProTabPolicy;`)({});
const networkPolicy = Function("globalThis", `${networkPolicySource}; return globalThis.CodexProNetworkPolicy;`)({});
const { boundConversationTab } = await import("../manager/electron/chat-send-target.mjs");
const { sendDebugEvidence } = await import("../manager/src/features/chat/chat-activity.js");

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const functionStart = source.indexOf(marker);
  assert.notEqual(functionStart, -1, `${name} must remain defined in the worker`);
  const start = source.slice(Math.max(0, functionStart - 6), functionStart) === "async " ? functionStart - 6 : functionStart;
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  let regex = false;
  let characterClass = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (regex) {
      if (character === "\\") escaped = true;
      else if (character === "[" && !characterClass) characterClass = true;
      else if (character === "]" && characterClass) characterClass = false;
      else if (character === "/" && !characterClass) regex = false;
      continue;
    }
    if (["'", '"', "`"].includes(character)) { quote = character; continue; }
    if (character === "/" && source[index - 1] !== "*") {
      const previous = source.slice(0, index).trimEnd().at(-1) ?? "";
      if (["(", "=", ":", "!", "&", "|", ","].includes(previous)) { regex = true; continue; }
    }
    if (character === "{") depth += 1;
    if (character === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`Could not extract ${name}`);
}

assert.equal(typeof tabPolicy.resolveChatSendTab, "function", "tab policy must expose the binding-first send resolver");

const conversationId = "6aa2a5aa-f148-83ec-9746-149940af67e0";
const boundTab = { id: 42, windowId: 7, url: `https://chatgpt.com/c/${conversationId}`, status: "complete" };
const calls = { get: 0, query: 0, recent: 0, create: 0, wait: 0 };
let clock = 1_000;
const direct = await tabPolicy.resolveChatSendTab({
  conversationId,
  requestedId: boundTab.id,
  getTab: async (tabId) => {
    calls.get += 1;
    assert.equal(tabId, boundTab.id);
    clock += 3;
    return boundTab;
  },
  queryTabs: async () => { calls.query += 1; return []; },
  recentConversationList: async () => { calls.recent += 1; return []; },
  createTab: async () => { calls.create += 1; return null; },
  waitForTab: async () => { calls.wait += 1; },
  now: () => clock
});

assert.equal(direct.tab.id, boundTab.id, "a valid direct binding must select the known tab");
assert.equal(direct.binding_hit, true, "a validated target_id must be reported as a binding hit");
assert.equal(direct.binding_validation_ms, 3);
assert.ok(direct.find_tab_ms < 500, `healthy bound-tab resolution must stay below 500 ms (got ${direct.find_tab_ms})`);
assert.deepEqual(calls, { get: 1, query: 0, recent: 0, create: 0, wait: 0 }, "a valid binding must not scan, fetch recents, or create a tab");

const fallbackCalls = { get: 0, query: 0, recent: 0, create: 0, wait: 0 };
const searchedTab = { id: 84, windowId: 9, url: `https://chatgpt.com/c/${conversationId}`, status: "complete" };
const searched = await tabPolicy.resolveChatSendTab({
  conversationId,
  requestedId: 41,
  getTab: async () => { fallbackCalls.get += 1; return { id: 41, url: "https://chatgpt.com/c/a-different-conversation" }; },
  queryTabs: async () => { fallbackCalls.query += 1; return [searchedTab]; },
  recentConversationList: async () => { fallbackCalls.recent += 1; return []; },
  createTab: async () => { fallbackCalls.create += 1; return null; },
  waitForTab: async () => { fallbackCalls.wait += 1; },
  now: () => clock
});

assert.equal(searched.tab.id, searchedTab.id, "an invalid binding must fall back to matching open tabs");
assert.equal(searched.binding_hit, false);
assert.deepEqual(fallbackCalls, { get: 1, query: 1, recent: 0, create: 0, wait: 0 }, "open-tab recovery must still avoid recents and tab creation");

const managerBinding = boundConversationTab({
  conversation_tabs: [
    { id: 11, url: "https://chatgpt.com/c/some-other-conversation" },
    boundTab
  ]
}, conversationId);
assert.equal(managerBinding?.id, boundTab.id, "Manager must preserve the conversation_id -> tab_id binding used for dispatch");
assert.match(managerSource, /target_id:\s*newChat\s*\|\|\s*!selectedConversationTab\?\.id\s*\?\s*undefined\s*:\s*String\(selectedConversationTab\.id\)/, "Manager must forward the validated target_id using the browser_control string schema");
assert.match(workerSource, /resolveChatSendTab\(\{[\s\S]*?requestedId[\s\S]*?chrome\.tabs\.get[\s\S]*?chrome\.tabs\.query/, "the extension send route must use the tested binding-first resolver");
const pollStart = workerSource.indexOf("async function pollLoop()");
const pollFetch = workerSource.indexOf("`${BRIDGE}/poll`", pollStart);
assert.ok(pollStart >= 0 && pollFetch > pollStart);
assert.doesNotMatch(workerSource.slice(pollStart, pollFetch), /recentConversationList\(/, "command polling must not wait for recentConversationList before receiving a bound-tab send");

assert.equal(typeof networkPolicy.decideChatSendPostClick, "function", "network policy must expose the safe post-click decision function");
const unchangedDraft = {
  composer_present_after_click: true,
  composer_matches_payload_after_click: true,
  draft_owned: true,
  send_button_ready: true,
  send_button_hit_test: true,
  matching_user_message_after_click: false,
  generating_after_click: false
};
const firstMiss = networkPolicy.decideChatSendPostClick({ attemptState: unchangedDraft, evidence: [], retryClickCount: 0 });
assert.equal(firstMiss.action, "retry", "an exact owned draft with no ACK must allow one safe button retry");
const secondMiss = networkPolicy.decideChatSendPostClick({ attemptState: unchangedDraft, evidence: [], retryClickCount: 1 });
assert.equal(secondMiss.action, "uncertain", "the same unchanged draft must never permit a third click");

const sentinelOnly = [{ endpoint: "/backend-api/sentinel/chat-requirements/prepare", matched_generation: false }];
const sentinelDecision = networkPolicy.decideChatSendPostClick({ attemptState: unchangedDraft, evidence: sentinelOnly, retryClickCount: 1 });
assert.notEqual(sentinelDecision.action, "submitted", "Sentinel preparation traffic alone must not acknowledge submission");

const generationDecision = networkPolicy.decideChatSendPostClick({
  attemptState: unchangedDraft,
  evidence: [{ endpoint: "/backend-api/conversation", matched_generation: true }],
  retryClickCount: 0
});
assert.equal(generationDecision.action, "submitted", "a generation POST is a strong submission signal");
assert.equal(generationDecision.ack_source, "generation");

const transcriptDecision = networkPolicy.decideChatSendPostClick({
  attemptState: { ...unchangedDraft, composer_matches_payload_after_click: false, matching_user_message_after_click: true },
  evidence: [],
  retryClickCount: 0
});
assert.equal(transcriptDecision.action, "submitted", "draft departure plus a new exact transcript message is a strong signal");

const generatingDecision = networkPolicy.decideChatSendPostClick({
  attemptState: { ...unchangedDraft, composer_matches_payload_after_click: false, generating_after_click: true },
  evidence: [],
  retryClickCount: 0
});
assert.equal(generatingDecision.action, "submitted", "ChatGPT entering generating state is a strong signal");

const staleGeneratingDecision = networkPolicy.decideChatSendPostClick({
  attemptState: { ...unchangedDraft, generating_after_click: true, generating_before_click: true },
  evidence: [],
  retryClickCount: 0
});
assert.equal(staleGeneratingDecision.action, "retry", "a Stop control that was already visible before the click must not acknowledge submission");

const clearedDecision = networkPolicy.decideChatSendPostClick({
  attemptState: { ...unchangedDraft, composer_present_after_click: false, composer_matches_payload_after_click: false, draft_owned: false, send_button_ready: false, send_button_hit_test: false },
  evidence: [],
  retryClickCount: 0
});
assert.equal(clearedDecision.action, "uncertain", "a cleared/disappeared composer without positive ACK must stay uncertain");
assert.equal(clearedDecision.retry_allowed, false, "a cleared/disappeared composer must never be retried");

const trustedClickSource = extractFunction(workerSource, "trustedActivateChatSendButtonTab");
assert.match(trustedClickSource, /if\(isVisible&&enabled&&pointerEvents&&!hitTest\)\{el\.scrollIntoView\([\s\S]{0,420}document\.elementFromPoint/, "trusted Send may scroll only after the first center hit-test fails, then it must re-run elementFromPoint");
assert.doesNotMatch(trustedClickSource, /el\.scrollIntoView\([^)]*\);\s*const rect=/, "trusted Send must not force a transcript scroll before its first hit-test");
const mouseEvents = [];
let runtimeEvaluations = 0;
const clickChrome = {
  debugger: {
    async sendCommand(_target, method, params) {
      if (method === "Runtime.evaluate") {
        runtimeEvaluations += 1;
        return runtimeEvaluations === 1
          ? { result: { value: { ok: true, x: 120, y: 80, selector: "#composer-submit-button", hit_test: true, generating_before_click: true } } }
          : { result: { value: { clicked: true, is_trusted: true } } };
      }
      if (method === "Input.dispatchMouseEvent") mouseEvents.push(params.type);
      if (method === "Input.dispatchKeyEvent") assert.fail("Send-button primary path must not dispatch Enter");
      return {};
    }
  }
};
const withClickDebugger = async (tabId, operation) => await operation({ tabId });
const trustedClick = Function("chrome", "withDebuggerTab", `${trustedClickSource}; return trustedActivateChatSendButtonTab;`)(clickChrome, withClickDebugger);
const clickResult = await trustedClick(42, "attempt-button-primary", "hello");
assert.equal(clickResult.send_button_actually_clicked, true, "CDP success is not enough; the trusted page click observer must confirm the Send button received the click");
assert.equal(clickResult.send_button_hit_test, true);
assert.equal(clickResult.send_button_selector, "#composer-submit-button");
assert.equal(clickResult.generating_before_click, true, "the exact pre-dispatch page evaluation must carry the Stop-control baseline into post-click verification");
assert.ok(clickResult.click_dispatch_started_at > 0, "trusted click must timestamp the ACK cutoff immediately before CDP mouse dispatch");
assert.deepEqual(mouseEvents, ["mouseMoved", "mousePressed", "mouseReleased"], "button-primary submission must issue one trusted mouse click");

let blockedMouseEvents = 0;
const blockedChrome = {
  debugger: {
    async sendCommand(_target, method) {
      if (method === "Runtime.evaluate") return { result: { value: { ok: false, error: "Send button center is covered", hit_test: false } } };
      if (method === "Input.dispatchMouseEvent") blockedMouseEvents += 1;
      return {};
    }
  }
};
const blockedClick = Function("chrome", "withDebuggerTab", `${trustedClickSource}; return trustedActivateChatSendButtonTab;`)(blockedChrome, withClickDebugger);
await assert.rejects(() => blockedClick(42, "attempt-covered", "hello"), /covered|hit.?test/i);
assert.equal(blockedMouseEvents, 0, "a failed elementFromPoint hit-test must stop before any mouse dispatch");

const inspectAttemptSource = extractFunction(workerSource, "inspectChatSendAttemptPage");
let sendButtonLabel = "Send prompt";
let sendButtonTestId = "send-button";
const sendButton = {
  disabled: false,
  dataset: {},
  getAttribute(name) { return name === "aria-disabled" ? "false" : name === "aria-label" ? sendButtonLabel : name === "data-testid" ? sendButtonTestId : ""; },
  hasAttribute() { return false; },
  getBoundingClientRect() { return { left: 100, top: 60, width: 40, height: 30 }; },
  contains(node) { return node === this; },
  scrollIntoView() {}
};
const composerRoot = {
  querySelector(selector) { return /send-button|composer-submit-button|aria-label/.test(selector) ? sendButton : null; }
};
const composer = {
  isContentEditable: true,
  innerText: "hello",
  textContent: "hello",
  dataset: { codexproDraftAttempt: "attempt-inspect" },
  getBoundingClientRect() { return { left: 20, top: 20, width: 400, height: 100 }; },
  closest() { return composerRoot; },
  parentElement: composerRoot
};
const userMessage = { innerText: "hello", textContent: "hello", getBoundingClientRect() { return { left: 20, top: 200, width: 300, height: 40 }; } };
const stopButton = { innerText: "Stop generating", textContent: "Stop generating", getAttribute(name) { return name === "aria-label" ? "Stop generating" : ""; }, getBoundingClientRect() { return { left: 450, top: 60, width: 30, height: 30 }; } };
const inspectDocument = {
  querySelector(selector) {
    if (selector === "#modal-subscription-failure") return null;
    if (selector.includes("prompt-textarea") || selector.includes("contenteditable") || selector.includes("textarea")) return composer;
    return null;
  },
  querySelectorAll(selector) {
    if (selector.includes("data-message-author-role=\"user\"")) return [userMessage];
    if (selector === "button,[role=\"button\"]") return [stopButton];
    return [];
  },
  elementFromPoint() { return sendButton; }
};
const inspectAttempt = Function("document", "getComputedStyle", `${inspectAttemptSource}; return inspectChatSendAttemptPage;`)(inspectDocument, () => ({ display: "block", visibility: "visible", opacity: "1", pointerEvents: "auto" }));
const inspected = inspectAttempt("attempt-inspect", "hello", 0);
assert.equal(inspected.composer_present_after_click, true);
assert.equal(inspected.composer_matches_payload_after_click, true);
assert.equal(inspected.matching_user_message_after_click, true, "post-click inspection must find a new exact user transcript message");
assert.equal(inspected.generating_after_click, true, "post-click inspection must recognize the visible Stop control");
assert.equal(inspected.send_button_ready, true);
assert.equal(inspected.send_button_hit_test, true);

const staleStopInspected = inspectAttempt("attempt-inspect", "hello", 1, true);
assert.equal(staleStopInspected.generating_before_click, true);
assert.equal(staleStopInspected.generating_after_click, false, "a pre-existing Stop control must not become a post-click transition signal");

sendButtonLabel = "Stop generating";
sendButtonTestId = "stop-button";
const stopAsSubmitInspected = inspectAttempt("attempt-inspect", "hello", 1, true);
assert.equal(stopAsSubmitInspected.send_button_ready, false, "a Stop control reusing the composer submit id must never be accepted as Send");
sendButtonLabel = "Send prompt";
sendButtonTestId = "send-button";

composer.innerText = "user edited this draft";
composer.textContent = composer.innerText;
const edited = inspectAttempt("attempt-inspect", "hello", 0);
assert.equal(edited.composer_matches_payload_after_click, false, "an attempt marker must not override an edited payload mismatch");
assert.equal(networkPolicy.decideChatSendPostClick({ attemptState: edited, evidence: [], retryClickCount: 0 }).retry_allowed, false, "an edited draft must never be retried");

const activationSource = extractFunction(workerSource, "activateChatTabForTrustedSend");
const activationOriginSource = extractFunction(workerSource, "captureChatTabActivationOrigin");
const activationCalls = [];
let activationClock = 5_000;
const activationChrome = {
  tabs: {
    async get(tabId) { activationCalls.push(["get", tabId]); activationClock += 2; return { id: tabId, windowId: 7, active: false }; },
    async query(query) { activationCalls.push(["query", query]); activationClock += 2; return [{ id: 41, windowId: 7, active: true }]; },
    async update(tabId, update) { activationCalls.push(["tab-update", tabId, update]); activationClock += 2; return { id: tabId, windowId: 7, active: true }; }
  },
  windows: {
    async getLastFocused() { activationCalls.push(["window-last-focused"]); activationClock += 2; return { id: 3, focused: true }; },
    async get(windowId) { activationCalls.push(["window-get", windowId]); activationClock += 2; return { id: windowId, focused: false }; },
    async update(windowId, update) { activationCalls.push(["window-update", windowId, update]); activationClock += 2; return { id: windowId, focused: true }; }
  }
};
const activateChatTab = Function("chrome", "Date", `${activationOriginSource}; ${activationSource}; return activateChatTabForTrustedSend;`)(activationChrome, { now: () => activationClock });
const activation = await activateChatTab(42);
assert.equal(activation.target_temporarily_activated, true);
assert.equal(activation.previous_active_tab_id, 41);
assert.equal(activation.previous_focused_window_id, 3);
assert.ok(activation.tab_activation_ms >= 0);
assert.ok(activationCalls.some(([kind, tabId, update]) => kind === "tab-update" && tabId === 42 && update.active === true), "trusted click must activate its target tab");
assert.ok(activationCalls.some(([kind, windowId, update]) => kind === "window-update" && windowId === 7 && update.focused === true), "trusted click must focus its target window");

const restoreSource = extractFunction(workerSource, "restoreChatTabAfterTrustedSend");
const restoreCalls = [];
const restoreChrome = {
  tabs: { async update(tabId, update) { restoreCalls.push(["tab", tabId, update]); } },
  windows: { async update(windowId, update) { restoreCalls.push(["window", windowId, update]); } }
};
const restoreChatTab = Function("chrome", `${restoreSource}; return restoreChatTabAfterTrustedSend;`)(restoreChrome);
const restored = await restoreChatTab(activation);
assert.equal(restored.restored, true);
assert.ok(restoreCalls.some(([kind, id, update]) => kind === "window" && id === 3 && update.focused === true), "temporary cross-window activation must restore the formerly focused Chrome window");

const prepareTabSource = extractFunction(workerSource, "prepareChatRequestTab");
const prepareCommands = [];
let attachmentInjectionCount = 0;
let fastPrepareFallback = false;
const prepareChrome = {
  tabs: {
    async sendMessage() {
      return fastPrepareFallback
        ? { ok: false, fallback_required: true }
        : { ok: true, prepared: true, route: "content-message" };
    }
  },
  debugger: {
    async sendCommand(_target, method, params) {
      prepareCommands.push({ method, params });
      return { result: { value: { ok: true, prepared: true, route: "cdp" } } };
    }
  },
  scripting: {
    async executeScript(options) {
      if (options.files) return [{ result: { ok: true, installed: true } }];
      attachmentInjectionCount += 1;
      return [{ result: { ok: true, prepared: true, route: "scripting" } }];
    }
  }
};
const prepareWithDebugger = async (tabId, operation) => await operation({ tabId });
async function fakePreparePage() { return { ok: true }; }
const prepareChatRequestTab = Function("chrome", "withDebuggerTab", "sendChatRequestPage", `${prepareTabSource}; return prepareChatRequestTab;`)(prepareChrome, prepareWithDebugger, fakePreparePage);
const textPrepared = await prepareChatRequestTab(42, "hello", [], "attempt-fast", Date.now() + 5_000, null, conversationId);
assert.equal(textPrepared[0].result.route, "content-message");
assert.equal(prepareCommands.length, 0, "healthy text-only preparation must use the preloaded content bridge without compiling a page function");
assert.equal(attachmentInjectionCount, 0);
fastPrepareFallback = true;
const recoveredTextPrepare = await prepareChatRequestTab(42, "hello", [], "attempt-recovery", Date.now() + 5_000, { attempt_id: "stale" }, conversationId);
assert.equal(recoveredTextPrepare[0].result.route, "cdp");
assert.equal(prepareCommands.length, 1, "stale ownership recovery may use the complete CDP prepare path");
assert.equal(prepareCommands[0].method, "Runtime.evaluate");
assert.equal(prepareCommands[0].params.awaitPromise, true);
assert.equal(prepareCommands[0].params.returnByValue, true);
const attachmentPrepared = await prepareChatRequestTab(42, "hello", [{ name: "proof.txt", data_base64: "eA==" }], "attempt-file", Date.now() + 5_000, null, conversationId);
assert.equal(attachmentPrepared[0].result.route, "scripting");
assert.equal(attachmentInjectionCount, 1, "attachment preparation must retain executeScript instead of serializing base64 through CDP");

const sendBlockStart = workerSource.indexOf("if(action==='send_chat_request')");
const sendBlockEnd = workerSource.indexOf("if(action==='rename_chat')", sendBlockStart);
assert.ok(sendBlockStart >= 0 && sendBlockEnd > sendBlockStart);
const sendBlock = workerSource.slice(sendBlockStart, sendBlockEnd);
const preparePageSource = extractFunction(workerSource, "sendChatRequestPage");
assert.ok(sendBlock.indexOf("activateChatTabForTrustedSend(tab.id)") < sendBlock.indexOf("prepareChatRequestTab(tab.id"), "the target tab/window must be activated before editor preparation so ChatGPT cannot reconcile a hidden draft away");
assert.match(sendBlock, /finally\{await restoreActivatedTab\(\);\}/, "temporary tab/window activation must be restored on every post-activation exit");
assert.match(sendBlock, /ensureChatRendererReadyForSend[\s\S]{0,500}catch\(error\)\{await restoreChatTabAfterTrustedSend\(tabActivationOrigin\);throw error;\}/, "renderer preflight failure must restore the previously active tab/window");
assert.match(sendBlock, /prepareChatRequestTab\(tab\.id,text,attachments,attemptId,deadlineAt,staleAttachmentOwnership,targetConversationId\)/, "send must use the low-latency text prepare router");
assert.match(sendBlock, /submit_path:'trusted-send-button'/, "visible Send must be the primary text submission path");
assert.match(sendBlock, /trustedSubmitChatSendButtonTab\(tab\.id,attemptId,text,\(startedAt\)=>\{generationAckStartedAfterMs=Number\(startedAt\)\|\|0;\}\)/, "the primary submit must retain the exact dispatch cutoff even if post-click confirmation hangs");
assert.doesNotMatch(sendBlock, /trustedSubmitChatComposerTab\(tab\.id,attemptId,text\)/, "trusted Enter must not remain the preferred text submission method");
assert.match(sendBlock, /retry_click_count/, "the send result must expose the exactly-once retry count");
assert.match(sendBlock, /trustedSubmitError[\s\S]*?waitForNetworkGeneration[\s\S]*?resultForNetwork/, "a post-dispatch click confirmation failure must still honor a strong generation ACK before returning uncertain");
assert.match(sendBlock, /generationAckStartedAfterMs=Number\(trustedSubmit\.click_dispatch_started_at\)/, "generation ACK filtering must begin at the exact CDP click dispatch cutoff");
assert.match(trustedClickSource, /onDispatchStarted\(clickDispatchStartedAt\)/, "trusted click must publish its exact pre-dispatch timestamp before any mouse command can hang");
assert.doesNotMatch(sendBlock, /observeChatSendAfterClick\([\s\S]{0,240}Boolean\(domActivity\.busy\)/, "post-click Stop transition checks must not use the earlier cached DOM activity probe");
assert.doesNotMatch(sendBlock, /waitForNetworkGeneration\([\s\S]*?NETWORK_START_TIMEOUT_MS/, "normal post-click verification must not include the old 30-second ACK wait");
assert.doesNotMatch(sendBlock, /resultForSubmitLifecycle/, "sentinel/prepare lifecycle must not retain an acknowledgement path, even as dead code");
assert.doesNotMatch(preparePageSource, /if\(!visible\(control\)\)continue;[\s\S]{0,240}const label=/, "normal composer preparation must not force geometry/layout reads for every page control");
assert.match(preparePageSource, /const label=[^;]*textContent[^;]*;[\s\S]{0,160}!startNewChatPattern\.test\(label\)\|\|!visible\(control\)/, "conversation-limit detection must filter cheap text before any visibility/layout check");
assert.match(preparePageSource, /matchingUserMessageCountBefore=[^;]*textContent[^;]*;/, "prepare must count exact transcript baselines with textContent so a long conversation does not force layout for every user message");
assert.doesNotMatch(preparePageSource, /matchingUserMessageCountBefore=[^;]*(?:visible\(node\)|node\.innerText)/, "prepare must not use visibility or innerText while counting the transcript baseline");
assert.match(inspectAttemptSource, /matchingUserMessageCount=[^;]*textContent[^;]*;/, "post-click verification must use the same layout-free transcript count as prepare");
assert.doesNotMatch(inspectAttemptSource, /matchingUserMessageCount=[^;]*(?:visible\(node\)|node\.innerText)/, "post-click verification must not force layout for every transcript message");
assert.match(preparePageSource, /composer\.dataset\.codexproDraftAttempt=attemptId;[\s\S]{0,180}composer\.dataset\.codexproSubmitAttempt=attemptId;/, "attachment-only sends must own the composer before the trusted Send-button check");
assert.match(workerSource, /previous\?\.conversation_id&&previous\.conversation_id!==summary\.conversation_id[\s\S]{0,120}forgetConversationTabBindingByTab\(tabId\)[\s\S]{0,180}rememberConversationTabBinding\(summary\.conversation_id,tabId\)/, "same-tab conversation navigation must remove obsolete bindings before remembering the new one");
assert.ok(manifest.content_scripts?.some((entry) => entry.matches?.includes("https://chatgpt.com/*") && entry.js?.includes("chat-send-fast-content.js")), "ChatGPT tabs must preload the low-latency text prepare bridge");
assert.match(fastPrepareSource, /chrome\.runtime\.onMessage\.addListener/, "the low-latency prepare bridge must receive extension-only prepare requests");
assert.match(prepareTabSource, /chrome\.tabs\.sendMessage/, "text-only preparation must use the preloaded content bridge");
assert.match(prepareTabSource, /files:\['chat-send-fast-content\.js'\]/, "already-open tabs must get one small-file injection fallback after an extension reload");
assert.match(managerSource, /sendProbe\.actualComposerMatchesPayload = Boolean/, "real Manager smoke must inspect the ChatGPT composer payload");
assert.match(managerSource, /request_payload_sha256/, "Manager must carry an exact sent-payload fingerprint into its real smoke proof");
assert.match(managerSource, /actualPayloadSha256[\s\S]{0,500}=== expectedPayloadSha256/, "real Manager smoke must count exact ChatGPT user payloads rather than substring matches");
assert.match(managerSource, /return \{ \.\.\.result, request_payload_sha256: createHash\("sha256"\)\.update\(taskText, "utf8"\)\.digest\("hex"\)/, "the Manager send result must produce the exact wrapped payload hash consumed by its live proof");
assert.match(managerSource, /backend-api\|backend-anon[\s\S]{0,120}conversation\|steer_turn[\s\S]{0,180}codex\\\/\)\?responses/, "real Manager smoke must accept every strong generation endpoint supported by the worker");
assert.match(managerSource, /sendProbe\.actualDuplicateCount = Math\.max/, "real Manager smoke must count exact duplicate user messages");
assert.match(managerSource, /sendProbe\.ok = Boolean\([\s\S]{0,500}sendProbe\.pipeline\?\.send_button_actually_clicked === true[\s\S]{0,240}sendProbe\.pipeline\?\.networkAck === true/, "real Manager smoke acceptance must require trusted click confirmation and generation ACK");
assert.match(managerSource, /const smokeResultOk = process\.env\.CODEXPRO_MANAGER_SMOKE_SEND === "1" \? sendProbe\?\.ok === true : true;[\s\S]{0,300}const smokeResult = \{ ok: smokeResultOk/, "a failed real send proof must fail the overall Manager smoke result");

let fastPrepareListener = null;
let fastComposerScrollCount = 0;
let fastComposerFocusOptions = null;
let fastComposerSyntheticEventCount = 0;
const fastComposerRoot = { dataset: {}, querySelectorAll: () => [] };
const fastComposer = {
  isContentEditable: true,
  innerText: "",
  textContent: "",
  dataset: {},
  parentElement: fastComposerRoot,
  closest: () => fastComposerRoot,
  querySelector: () => null,
  getBoundingClientRect: () => ({ width: 420, height: 90 }),
  scrollIntoView() { fastComposerScrollCount += 1; },
  focus(options) { fastComposerFocusOptions = options; },
  dispatchEvent() { fastComposerSyntheticEventCount += 1; }
};
const fastDocument = {
  title: "ChatGPT",
  querySelector(selector) { return /prompt-textarea|contenteditable|textarea/.test(selector) ? fastComposer : null; },
  querySelectorAll(selector) { return selector.includes('data-message-author-role="user"') ? [] : []; },
  createRange: () => ({ selectNodeContents() {}, collapse() {} }),
  execCommand(command, _ui, value) {
    if (command === "insertText") { fastComposer.innerText = value; fastComposer.textContent = value; return true; }
    return false;
  }
};
const fastWindow = { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) };
const fastChrome = { runtime: { id: "extension-id", onMessage: { addListener(listener) { fastPrepareListener = listener; } } } };
Function("globalThis", "chrome", "document", "location", "getComputedStyle", "window", "InputEvent", "Event", "HTMLTextAreaElement", "HTMLInputElement", fastPrepareSource)(
  {}, fastChrome, fastDocument,
  { origin: "https://chatgpt.com", pathname: `/c/${conversationId}`, href: `https://chatgpt.com/c/${conversationId}` },
  () => ({ display: "block", visibility: "visible" }), fastWindow,
  class InputEvent {}, class Event {}, class HTMLTextAreaElement {}, class HTMLInputElement {}
);
assert.equal(typeof fastPrepareListener, "function");
const fastPrepared = await new Promise((resolve) => {
  const keepAlive = fastPrepareListener({ type: "codexpro:prepare-chat-text-v1", payload: { text: "fast hello", attempt_id: "attempt-fast-content", deadline_at: Date.now() + 1_000, stale_attachment_ownership: null, expected_conversation_id: conversationId } }, { id: "extension-id" }, resolve);
  assert.equal(keepAlive, true);
});
assert.equal(fastPrepared.ok, true);
assert.equal(fastPrepared.prepare_transport, "content-message");
assert.equal(fastComposer.dataset.codexproDraftAttempt, "attempt-fast-content");
assert.equal(fastComposer.innerText, "fast hello");
assert.equal(fastComposerScrollCount, 0, "healthy text preparation must not synchronously scroll a long ChatGPT transcript");
assert.equal(fastComposerFocusOptions?.preventScroll, true, "healthy text preparation must focus without forcing transcript layout/scroll");
assert.equal(fastComposerSyntheticEventCount, 0, "execCommand already emits the contenteditable input event; the fast path must not make ChatGPT reconcile the same edit again");
assert.match(managerSource, /action:\s*"evaluate"[\s\S]{0,500}#prompt-textarea/, "real Manager smoke must inspect the exact ChatGPT composer through a supported browser action");

const telemetry = sendDebugEvidence({
  find_tab_ms: 12,
  binding_hit: true,
  binding_validation_ms: 3,
  tab_activation_ms: 8,
  prepare_ms: 44,
  send_button_selector: "#composer-submit-button",
  send_button_hit_test: true,
  trusted_click_ms: 9,
  send_button_actually_clicked: true,
  composer_present_after_click: true,
  composer_matches_payload_after_click: false,
  matching_user_message_after_click: true,
  generation_ack_ms: 121,
  generation_endpoint: "/backend-api/f/conversation",
  retry_click_count: 0
});
assert.deepEqual({
  find_tab_ms: telemetry.find_tab_ms,
  binding_hit: telemetry.binding_hit,
  binding_validation_ms: telemetry.binding_validation_ms,
  tab_activation_ms: telemetry.tab_activation_ms,
  prepare_ms: telemetry.prepare_ms,
  send_button_selector: telemetry.send_button_selector,
  send_button_hit_test: telemetry.send_button_hit_test,
  trusted_click_ms: telemetry.trusted_click_ms,
  send_button_actually_clicked: telemetry.send_button_actually_clicked,
  composer_present_after_click: telemetry.composer_present_after_click,
  composer_matches_payload_after_click: telemetry.composer_matches_payload_after_click,
  matching_user_message_after_click: telemetry.matching_user_message_after_click,
  generation_ack_ms: telemetry.generation_ack_ms,
  generation_endpoint: telemetry.generation_endpoint,
  retry_click_count: telemetry.retry_click_count
}, {
  find_tab_ms: 12,
  binding_hit: true,
  binding_validation_ms: 3,
  tab_activation_ms: 8,
  prepare_ms: 44,
  send_button_selector: "#composer-submit-button",
  send_button_hit_test: true,
  trusted_click_ms: 9,
  send_button_actually_clicked: true,
  composer_present_after_click: true,
  composer_matches_payload_after_click: false,
  matching_user_message_after_click: true,
  generation_ack_ms: 121,
  generation_endpoint: "/backend-api/f/conversation",
  retry_click_count: 0
}, "Manager send evidence must retain every requested pipeline telemetry field separately");

console.log("chat send pipeline smoke PASS");
