import assert from "node:assert/strict";
import fs from "node:fs";

const worker = fs.readFileSync(new URL("../chrome-extension/service-worker.js", import.meta.url), "utf8");
assert.match(worker, /const MAX_CHATGPT_TABS = 2;/, "Chrome worker must cap ChatGPT tabs at two");
assert.match(worker, /CHAT_TAB_LIMIT_REACHED/, "worker must fail closed when both tabs are protected");
assert.match(worker, /const TAB_AUDIT_STORAGE_KEY = 'codexproTabAuditV1';/, "tab lifecycle audit must persist in extension storage");
assert.match(worker, /tab_audit:await tabAuditSnapshot\(80\)/, "list_tabs must expose recent tab lifecycle diagnostics");
assert.match(worker, /chrome\.tabs\.onCreated\.addListener[\s\S]*?open_observed/, "tab audit must observe ChatGPT tab opens even outside CodexPro helpers");
assert.match(worker, /chrome\.tabs\.onRemoved\.addListener[\s\S]*?close_observed/, "tab audit must observe ChatGPT tab closes even outside CodexPro helpers");
assert.match(worker, /load_observed/, "tab audit must retain repeated ChatGPT load events for reload-loop diagnosis");
assert.match(worker, /recover_chat_tab[\s\S]*?createChatGptTab\(\{url:'https:\/\/chatgpt\.com\/',active:true\},'recover_chat_tab_new'\)/, "fresh-chat recovery must use the capped tab creator");
assert.match(worker, /newChat[\s\S]*?createChatGptTab\(\{url:'https:\/\/chatgpt\.com\/',active:false\},'send_chat_request_new'\)/, "new chat requests must use the capped tab creator");
assert.match(worker, /tab=await createChatGptTab\(\{url:'https:\/\/chatgpt\.com\/c\/'\+conversationId,active:false\},'send_chat_request_existing'\)/, "conversation opens for send must use the capped tab creator");
assert.match(worker, /get_chat_response[\s\S]*?if\(!tab\)\{[\s\S]*?readUnopenedChatResponse\(tabs,conversation,args,commandExpiresAt\)/, "response reads for unopened recent conversations must stay tabless instead of consuming a capped ChatGPT tab slot");
assert.match(worker, /if\(action==='open_tab'\)\{const tab=await createChatGptTab/, "browser open_tab must use the capped tab creator");
assert.match(worker, /const tab=reusable[\s\S]*?: await createChatGptTab\(\{url,active:true\},'openChatGpt'\)/, "ChatGPT route opens must use the capped tab creator");
assert.match(worker, /checkConnectorInstalled[\s\S]*?const tab=await createChatGptTab\(/, "connector checks must use the capped tab creator");
assert.match(worker, /replaceUnresponsiveChatTab[\s\S]*?serializeChatGptTabCreation[\s\S]*?current\.length>=MAX_CHATGPT_TABS[\s\S]*?auditedRemoveTab\(replacedTabId,'replaceUnresponsiveChatTab','remove_old_tab'\)[\s\S]*?auditedCreateTab\(createArgs,'chat_tab_create'\)/, "renderer replacement must remove the dead tab before creating a replacement when already at the cap");

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
assert.match(worker, /async function stopFlightRecorderForTab\(tabId\)[\s\S]*?flightRecorderStartPromisesByTab\.get\(tabId\)[\s\S]*?await starting/, "stopping a flight recorder must wait for an in-flight serialized startup before releasing its debugger ref");
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

function makeHarness(initialTabs) {
  let tabs = initialTabs.map(tab => ({ ...tab }));
  let nextId = 100;
  let maxObserved = tabs.length;
  let creates = 0;
  const chrome = {
    tabs: {
      async query() { return tabs.map(tab => ({ ...tab })); },
      async create(args) {
        creates += 1;
        const tab = { id: nextId++, url: args.url, active: Boolean(args.active) };
        tabs.push(tab);
        maxObserved = Math.max(maxObserved, tabs.length);
        return { ...tab };
      }
    }
  };
  const tabList = async () => tabs.map(tab => ({ ...tab }));
  const recentConversationList = async () => [];
  const cleanupChatGptTabs = async (_summaries, _recent, options = {}) => {
    const target = Math.max(0, Number(options.maxTabs) || 0);
    const closed = [];
    while (tabs.length > target) {
      const index = tabs.findIndex(tab => !tab.protected);
      if (index < 0) break;
      closed.push(tabs[index].id);
      tabs.splice(index, 1);
    }
    return { closed_count: closed.length, closed };
  };
  const isChatGptTabUrl = value => {
    try { return new URL(String(value || "")).origin === "https://chatgpt.com"; } catch { return false; }
  };
  const auditedCreateTab = async args => await chrome.tabs.create(args);
  const factory = Function(
    "chrome",
    "MAX_CHATGPT_TABS",
    "isChatGptTabUrl",
    "tabList",
    "recentConversationList",
    "cleanupChatGptTabs",
    "auditedCreateTab",
    `let chatTabCreationTail = Promise.resolve(); ${helperSource}; return { createChatGptTab };`
  );
  const { createChatGptTab } = factory(chrome, 2, isChatGptTabUrl, tabList, recentConversationList, cleanupChatGptTabs, auditedCreateTab);
  return {
    createChatGptTab,
    state: () => ({ count: tabs.length, maxObserved, creates, tabs: tabs.map(tab => ({ ...tab })) })
  };
}

{
  const harness = makeHarness([
    { id: 1, url: "https://chatgpt.com/c/a1111111" }
  ]);
  await harness.createChatGptTab({ url: "https://chatgpt.com/", active: false });
  assert.equal(harness.state().count, 2);
  assert.equal(harness.state().maxObserved, 2, "opening the second tab must never transiently exceed the cap");
}

{
  const harness = makeHarness([
    { id: 1, url: "https://chatgpt.com/c/a1111111", protected: true },
    { id: 2, url: "https://chatgpt.com/c/b2222222" }
  ]);
  await harness.createChatGptTab({ url: "https://chatgpt.com/c/c3333333", active: false });
  assert.equal(harness.state().count, 2);
  assert.equal(harness.state().maxObserved, 2, "cleanup must happen before opening a replacement slot");
}

{
  const harness = makeHarness([
    { id: 1, url: "https://chatgpt.com/c/a1111111", protected: true },
    { id: 2, url: "https://chatgpt.com/c/b2222222", protected: true }
  ]);
  await assert.rejects(
    harness.createChatGptTab({ url: "https://chatgpt.com/", active: false }),
    /CHAT_TAB_LIMIT_REACHED/
  );
  assert.equal(harness.state().count, 2);
  assert.equal(harness.state().creates, 0, "no third tab may be created when both existing tabs are protected");
}

{
  const harness = makeHarness([
    { id: 1, url: "https://chatgpt.com/c/a1111111" },
    { id: 2, url: "https://chatgpt.com/c/b2222222" }
  ]);
  await Promise.all([
    harness.createChatGptTab({ url: "https://chatgpt.com/c/c3333333", active: false }),
    harness.createChatGptTab({ url: "https://chatgpt.com/c/d4444444", active: false })
  ]);
  assert.equal(harness.state().count, 2);
  assert.equal(harness.state().maxObserved, 2, "concurrent requests must be serialized so the worker never reaches three ChatGPT tabs");
}

console.log("✓ ChatGPT two-tab cap smoke test passed");
