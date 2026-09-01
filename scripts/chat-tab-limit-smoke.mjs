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
assert.match(worker, /codexpro_unreachable[\s\S]*?healthReplacement[\s\S]*?chrome\.tabs\.create/, "a dead sole macOS ChatGPT tab must be replaced after it is closed");
assert.match(worker, /recover_chat_tab[\s\S]*?createChatGptTab\(\{url:'https:\/\/chatgpt\.com\/',active:true\}\)/, "fresh-chat recovery must use the capped tab creator");
assert.match(worker, /newChat[\s\S]*?createChatGptTab\(\{url:'https:\/\/chatgpt\.com\/',active:false\}\)/, "new chat requests must use the capped tab creator");
assert.match(worker, /replaceUnresponsiveChatTab[\s\S]*?const tabLimit=await chatGptTabLimit\(\)[\s\S]*?current\.length>=tabLimit[\s\S]*?chrome\.tabs\.remove\(replacedTabId\)[\s\S]*?chrome\.tabs\.create\(createArgs\)/, "hung-tab recovery must close the old tab before opening a replacement at the macOS cap");

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
  const factory = Function(
    "chrome",
    "MAX_CHATGPT_TABS",
    "MAC_MAX_CHATGPT_TABS",
    "isChatGptTabUrl",
    "tabList",
    "recentConversationList",
    "cleanupChatGptTabs",
    "chatGptTabLimit",
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
    chatGptTabLimit
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
  assert.equal(harness.state().maxObserved, 1, "macOS replacement must close the old idle tab before creating a new one");
  assert.deepEqual(harness.state().closed, [1], "the previous macOS ChatGPT tab must be closed");
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
