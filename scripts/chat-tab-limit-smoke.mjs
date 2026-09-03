import assert from "node:assert/strict";
import fs from "node:fs";

const worker = fs.readFileSync(new URL("../chrome-extension/service-worker.js", import.meta.url), "utf8");

assert.match(worker, /const MAX_CHATGPT_TABS = 3;/, "Windows/non-mac worker cap must remain three tabs");
assert.match(worker, /const MAC_MAX_CHATGPT_TABS = 1;/, "macOS worker must cap ChatGPT to one tab per Chrome profile");
assert.match(worker, /chrome\.runtime\.getPlatformInfo\(\)/, "tab cap must be selected from the real Chrome platform");
assert.match(worker, /CHAT_TAB_LIMIT_REACHED/, "worker must fail closed when the existing tab is protected");
assert.match(worker, /chrome\.tabs\.onCreated[\s\S]*?enforceSingleChatTabSoon/, "new ChatGPT tabs must trigger macOS single-tab enforcement");
assert.match(worker, /chrome\.tabs\.onUpdated[\s\S]*?enforceSingleChatTabSoon/, "navigating a tab to ChatGPT must trigger macOS single-tab enforcement");
assert.match(worker, /function chatNavigationSupersedesNetworkState[\s\S]*?trackedConversationId!==conversationIdFromUrl\(nextUrl\)/, "navigation to another conversation or the ChatGPT root must supersede stale network state");
assert.match(worker, /async function resetSupersededChatActivity[\s\S]*?chatNetworkStateByTab\.delete\(tabId\)[\s\S]*?persistChatNetworkState/, "superseded network state must be cleared and persisted");
assert.match(worker, /plan\.reasons\[tabId\]==='codexpro_unreachable'[\s\S]*?chrome\.tabs\.create[\s\S]*?removeTabWithReason\(tabId/, "health cleanup must create the last macOS tab's replacement before closing it");
assert.match(worker, /recover_chat_tab[\s\S]*?createChatGptTab\(\{url:'https:\/\/chatgpt\.com\/',active:true\}\)/, "fresh-chat recovery must use the capped tab creator");
assert.match(worker, /newChat[\s\S]*?createChatGptTab\(\{url:'https:\/\/chatgpt\.com\/',active:false\}\)/, "new chat requests must use the capped tab creator");
const replacementSource = worker.slice(
  worker.indexOf("async function replaceUnresponsiveChatTab"),
  worker.indexOf("async function waitForConversationUrl")
);
assert.match(replacementSource, /preserveOnlyMacTab=tabLimit===MAC_MAX_CHATGPT_TABS/, "macOS recovery must recognize its sole existing ChatGPT tab");
assert.ok(
  replacementSource.indexOf("chrome.tabs.create(createArgs)") < replacementSource.indexOf("removeTabWithReason(replacedTabId,'renderer_replacement_completed')"),
  "macOS recovery must finish creating the replacement before closing the sole old tab"
);

const limitSource = worker.slice(
  worker.indexOf("async function chatGptTabLimit"),
  worker.indexOf("function planChatTabCleanup")
);
assert.ok(limitSource.includes("async function chatGptTabLimit"), "platform tab-limit helper source must be present");

function makeLimitHarness(os) {
  const chrome = { runtime: { async getPlatformInfo() { return { os }; } } };
  const factory = Function(
    "chrome",
    "MAX_CHATGPT_TABS",
    "MAC_MAX_CHATGPT_TABS",
    `let chatTabLimitCache = null; ${limitSource}; return { chatGptTabLimit };`
  );
  return factory(chrome, 3, 1).chatGptTabLimit;
}

assert.equal(await makeLimitHarness("mac")(), 1, "macOS must resolve to exactly one ChatGPT tab");
assert.equal(await makeLimitHarness("win")(), 3, "Windows must retain the three-tab cap");
assert.equal(await makeLimitHarness("linux")(), 3, "non-mac platforms must retain the normal cap");

const debuggerGuardSource = worker.match(/function debuggerSessionBlocksChatTabCleanup\(tabId\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(debuggerGuardSource, "tab cleanup must distinguish the persistent flight-recorder debugger ref from transient debugger work");
{
  const debuggerSessionsByTab = new Map([
    [1, { refs: 1 }],
    [2, { refs: 2 }],
    [3, { refs: 1 }]
  ]);
  const flightRecorderTrackersByTab = new Map([[1, {}], [2, {}]]);
  const debuggerSessionBlocksChatTabCleanup = Function(
    "debuggerSessionsByTab",
    "flightRecorderTrackersByTab",
    `${debuggerGuardSource}; return debuggerSessionBlocksChatTabCleanup;`
  )(debuggerSessionsByTab, flightRecorderTrackersByTab);
  assert.equal(debuggerSessionBlocksChatTabCleanup(1), false, "a flight recorder by itself must not pin an idle ChatGPT tab forever");
  assert.equal(debuggerSessionBlocksChatTabCleanup(2), true, "an extra transient debugger ref must still protect the tab from cleanup");
  assert.equal(debuggerSessionBlocksChatTabCleanup(3), true, "a standalone debugger operation without a flight recorder must protect the tab");
  assert.equal(debuggerSessionBlocksChatTabCleanup(4), false, "a tab with no debugger session must remain eligible for cleanup");
}

const pendingGuardSource = worker.match(/function pendingConversationBlocksChatTabCleanup\(tabId\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(pendingGuardSource, "tab cleanup must expire stale pending-conversation guards");
{
  const now = Date.now();
  const pendingConversationByTab = new Map([
    [21, { at: now }],
    [22, { at: now - 60_001 }]
  ]);
  const pendingConversationBlocksChatTabCleanup = Function(
    "pendingConversationByTab",
    "PENDING_CONVERSATION_TTL_MS",
    `${pendingGuardSource}; return pendingConversationBlocksChatTabCleanup;`
  )(pendingConversationByTab, 60_000);
  assert.equal(pendingConversationBlocksChatTabCleanup(21), true, "a fresh pending submission must still protect its tab");
  assert.equal(pendingConversationBlocksChatTabCleanup(22), false, "a stale pending submission must stop pinning an otherwise idle tab");
  assert.equal(pendingConversationByTab.has(22), false, "stale pending state must be cleared when cleanup evaluates the tab");
}

const recorderStartSource = worker.slice(
  worker.indexOf("async function ensureFlightRecorderForTab"),
  worker.indexOf("async function ensureFlightRecordersForTabs")
);
assert.ok(recorderStartSource.includes("flightRecorderStartPromisesByTab"), "flight recorder startup must serialize concurrent starts per tab");
{
  const flightRecorderTrackersByTab = new Map();
  const flightRecorderStartPromisesByTab = new Map();
  let acquireCount = 0;
  const acquireDebuggerTab = async (tabId) => {
    acquireCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { tabId };
  };
  const chrome = { debugger: { async sendCommand() {} } };
  const ensureFlightRecorderForTab = Function(
    "flightRecorderTrackersByTab",
    "flightRecorderStartPromisesByTab",
    "isChatGptTabUrl",
    "stopFlightRecorderForTab",
    "acquireDebuggerTab",
    "subscribeDebuggerEvents",
    "noteFlightRecorderEvent",
    "chrome",
    "releaseDebuggerTab",
    `${recorderStartSource}; return ensureFlightRecorderForTab;`
  )(
    flightRecorderTrackersByTab,
    flightRecorderStartPromisesByTab,
    () => true,
    async () => false,
    acquireDebuggerTab,
    () => () => {},
    () => {},
    chrome,
    () => {}
  );
  const results = await Promise.all([1, 2, 3].map(() => ensureFlightRecorderForTab(11, "https://chatgpt.com/c/test1234")));
  assert.equal(acquireCount, 1, "concurrent flight-recorder startup must acquire exactly one debugger ref for a tab");
  assert.ok(results.every((result) => result === results[0]), "concurrent recorder callers must share one tracker instance");
  assert.equal(flightRecorderStartPromisesByTab.size, 0, "flight recorder startup serialization must release its start promise after initialization");
}

const helperSource = worker.slice(
  worker.indexOf("async function serializeChatGptTabCreation"),
  worker.indexOf("function isChatGenerationRequest")
);
assert.ok(helperSource.includes("async function createChatGptTab"), "capped tab creator source must be present");

function makeHarness(initialTabs, { limit = 3 } = {}) {
  let tabs = initialTabs.map(tab => ({ ...tab }));
  let nextId = 100;
  let maxObserved = tabs.length;
  let creates = 0;
  const closed = [];
  const chrome = {
    tabs: {
      async query() { return tabs.map(tab => ({ ...tab })); },
      async update(id, args) {
        const tab = tabs.find(candidate => candidate.id === id);
        if (!tab) throw new Error("missing tab");
        Object.assign(tab, args);
        return { ...tab };
      },
      async create(args) {
        creates += 1;
        const tab = { id: nextId++, url: args.url, active: Boolean(args.active) };
        tabs.push(tab);
        maxObserved = Math.max(maxObserved, tabs.length);
        return { ...tab };
      }
    }
  };
  const tabList = async () => tabs.map(tab => ({ ...tab, busy: Boolean(tab.protected) }));
  const recentConversationList = async () => [];
  const cleanupChatGptTabs = async (_summaries, _recent, options = {}) => {
    const requested = Number(options.maxTabs);
    const target = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : limit;
    const allowActiveIdle = options.allowActiveIdle === true;
    while (tabs.length > target) {
      const index = tabs.findIndex(tab => !tab.protected && (!tab.active || allowActiveIdle));
      if (index < 0) break;
      closed.push(tabs[index].id);
      tabs.splice(index, 1);
    }
    return { closed_count: closed.length, closed: [...closed] };
  };
  const isChatGptTabUrl = value => {
    try { return new URL(String(value || "")).origin === "https://chatgpt.com"; } catch { return false; }
  };
  const chatGptTabLimit = async () => limit;
  const conversationIdFromUrl = value => {
    try { return new URL(String(value || "")).pathname.match(/^\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || ""; } catch { return ""; }
  };
  const factory = Function(
    "chrome",
    "MAX_CHATGPT_TABS",
    "MAC_MAX_CHATGPT_TABS",
    "isChatGptTabUrl",
    "tabList",
    "recentConversationList",
    "cleanupChatGptTabs",
    "chatGptTabLimit",
    "conversationIdFromUrl",
    "chatRequestState",
    "chatDomActivityState",
    "debuggerSessionsByTab",
    "pendingConversationByTab",
    "chatAttachmentOwnershipByTab",
    "browserMutationTailsByTab",
    "recordProfileLifecycleEvent",
    `let chatTabCreationTail = Promise.resolve(); ${helperSource}; return { createChatGptTab };`
  );
  const { createChatGptTab } = factory(
    chrome,
    3,
    1,
    isChatGptTabUrl,
    tabList,
    recentConversationList,
    cleanupChatGptTabs,
    chatGptTabLimit,
    conversationIdFromUrl,
    async () => ({ busy: false }),
    async () => ({ busy: false }),
    new Map(),
    new Map(),
    new Map(),
    new Map(),
    () => {}
  );
  return {
    createChatGptTab,
    state: () => ({ count: tabs.length, maxObserved, creates, closed: [...closed], tabs: tabs.map(tab => ({ ...tab })) })
  };
}

{
  const harness = makeHarness([
    { id: 1, url: "https://chatgpt.com/c/a1111111" },
    { id: 2, url: "https://chatgpt.com/c/b2222222" }
  ], { limit: 3 });
  await harness.createChatGptTab({ url: "https://chatgpt.com/", active: false });
  assert.equal(harness.state().count, 3);
  assert.equal(harness.state().maxObserved, 3, "Windows opening the third tab must not exceed its cap");
}

{
  const harness = makeHarness([
    { id: 1, url: "https://chatgpt.com/c/a1111111", active: true }
  ], { limit: 1 });
  await harness.createChatGptTab({ url: "https://chatgpt.com/", active: true });
  assert.equal(harness.state().count, 1);
  assert.equal(harness.state().maxObserved, 1, "macOS must reuse its sole idle tab without closing the profile window");
  assert.equal(harness.state().creates, 0, "macOS one-tab navigation must not create a replacement tab");
  assert.deepEqual(harness.state().closed, [], "the sole macOS ChatGPT tab must remain open");
}

{
  const harness = makeHarness([
    { id: 1, url: "https://chatgpt.com/c/a1111111", active: true, protected: true }
  ], { limit: 1 });
  await assert.rejects(
    harness.createChatGptTab({ url: "https://chatgpt.com/", active: true }),
    /CHAT_TAB_LIMIT_REACHED/
  );
  assert.equal(harness.state().count, 1);
  assert.equal(harness.state().creates, 0, "macOS must never create a second ChatGPT tab while the current tab is protected/busy");
}

{
  const harness = makeHarness([
    { id: 1, url: "https://chatgpt.com/c/a1111111" }
  ], { limit: 1 });
  await Promise.all([
    harness.createChatGptTab({ url: "https://chatgpt.com/c/b2222222", active: false }),
    harness.createChatGptTab({ url: "https://chatgpt.com/c/c3333333", active: false })
  ]);
  assert.equal(harness.state().count, 1);
  assert.equal(harness.state().maxObserved, 1, "concurrent macOS requests must be serialized and never reach two ChatGPT tabs");
}

console.log("✓ macOS one-tab / Windows three-tab ChatGPT cap smoke test passed");
