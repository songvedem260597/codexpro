import assert from "node:assert/strict";
import fs from "node:fs";

const worker = fs.readFileSync(new URL("../chrome-extension/service-worker.js", import.meta.url), "utf8");
assert.match(worker, /const MAX_CHATGPT_TABS = 3;/, "Chrome worker must cap ChatGPT tabs at three");
assert.match(worker, /CHAT_TAB_LIMIT_REACHED/, "worker must fail closed when all three tabs are protected");
assert.match(worker, /recover_chat_tab[\s\S]*?createChatGptTab\(\{url:'https:\/\/chatgpt\.com\/',active:true\}\)/, "fresh-chat recovery must use the capped tab creator");
assert.match(worker, /newChat[\s\S]*?createChatGptTab\(\{url:'https:\/\/chatgpt\.com\/',active:false\}\)/, "new chat requests must use the capped tab creator");
assert.match(worker, /tab=await createChatGptTab\(\{url:'https:\/\/chatgpt\.com\/c\/'\+conversationId,active:false\}\)/, "conversation opens for send must use the capped tab creator");
assert.match(worker, /tab=await createChatGptTab\(\{url:`https:\/\/chatgpt\.com\/c\/\$\{conversationId\}`,active:false\}\)/, "conversation opens for response reads must use the capped tab creator");
assert.match(worker, /if\(action==='open_tab'\)\{const tab=await createChatGptTab/, "browser open_tab must use the capped tab creator");
assert.match(worker, /const tab=reusable[\s\S]*?: await createChatGptTab\(\{url,active:true\}\)/, "ChatGPT route opens must use the capped tab creator");
assert.match(worker, /checkConnectorInstalled[\s\S]*?const tab=await createChatGptTab\(/, "connector checks must use the capped tab creator");
assert.match(worker, /replaceUnresponsiveChatTab[\s\S]*?serializeChatGptTabCreation[\s\S]*?current\.length>=MAX_CHATGPT_TABS[\s\S]*?chrome\.tabs\.remove\(replacedTabId\)[\s\S]*?chrome\.tabs\.create\(createArgs\)/, "renderer replacement must remove the dead tab before creating a replacement when already at the cap");

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
  const factory = Function(
    "chrome",
    "MAX_CHATGPT_TABS",
    "isChatGptTabUrl",
    "tabList",
    "recentConversationList",
    "cleanupChatGptTabs",
    `let chatTabCreationTail = Promise.resolve(); ${helperSource}; return { createChatGptTab };`
  );
  const { createChatGptTab } = factory(chrome, 3, isChatGptTabUrl, tabList, recentConversationList, cleanupChatGptTabs);
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
