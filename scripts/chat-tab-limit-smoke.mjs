import assert from "node:assert/strict";
import fs from "node:fs";

const worker = fs.readFileSync(new URL("../chrome-extension/service-worker.js", import.meta.url), "utf8");
assert.match(worker, /const MAX_CHATGPT_TABS = 3;/, "Chrome worker must cap ChatGPT tabs at three");
assert.match(worker, /CHAT_TAB_LIMIT_REACHED/, "worker must fail closed when all three tabs are protected");
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
  const { createChatGptTab } = factory(chrome, 3, isChatGptTabUrl, tabList, recentConversationList, cleanupChatGptTabs, auditedCreateTab);
  return {
    createChatGptTab,
    state: () => ({ count: tabs.length, maxObserved, creates, tabs: tabs.map(tab => ({ ...tab })) })
  };
}

{
  const harness = makeHarness([
    { id: 1, url: "https://chatgpt.com/c/a1111111" },
    { id: 2, url: "https://chatgpt.com/c/b2222222" }
  ]);
  await harness.createChatGptTab({ url: "https://chatgpt.com/", active: false });
  assert.equal(harness.state().count, 3);
  assert.equal(harness.state().maxObserved, 3, "opening the third tab must never transiently exceed the cap");
}

{
  const harness = makeHarness([
    { id: 1, url: "https://chatgpt.com/c/a1111111", protected: true },
    { id: 2, url: "https://chatgpt.com/c/b2222222" },
    { id: 3, url: "https://chatgpt.com/c/c3333333", protected: true }
  ]);
  await harness.createChatGptTab({ url: "https://chatgpt.com/c/d4444444", active: false });
  assert.equal(harness.state().count, 3);
  assert.equal(harness.state().maxObserved, 3, "cleanup must happen before opening a replacement slot");
}

{
  const harness = makeHarness([
    { id: 1, url: "https://chatgpt.com/c/a1111111", protected: true },
    { id: 2, url: "https://chatgpt.com/c/b2222222", protected: true },
    { id: 3, url: "https://chatgpt.com/c/c3333333", protected: true }
  ]);
  await assert.rejects(
    harness.createChatGptTab({ url: "https://chatgpt.com/", active: false }),
    /CHAT_TAB_LIMIT_REACHED/
  );
  assert.equal(harness.state().count, 3);
  assert.equal(harness.state().creates, 0, "no fourth tab may be created when all three existing tabs are protected");
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
  assert.equal(harness.state().count, 3);
  assert.equal(harness.state().maxObserved, 3, "concurrent requests must be serialized so the worker never reaches four ChatGPT tabs");
}

console.log("✓ ChatGPT three-tab cap smoke test passed");
