import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../chrome-extension/service-worker.js", import.meta.url), "utf8");
const managerMain = readFileSync(new URL("../manager/electron/main.mjs", import.meta.url), "utf8");
const managerUi = readFileSync(new URL("../manager/src/main.jsx", import.meta.url), "utf8");

const recoveryStart = worker.indexOf("if(action==='recover_chat_tab'){");
const recoveryEnd = worker.indexOf("if(action==='send_chat_request'){", recoveryStart);
assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart, "recover_chat_tab command block must exist");
const recoveryBlock = worker.slice(recoveryStart, recoveryEnd);

assert.match(recoveryBlock, /const newChat=Boolean\(args\.new_chat\)/, "stuck-tab recovery must accept an explicit fresh-chat mode");
assert.match(recoveryBlock, /releaseChatDebuggerForRecovery\(tab\.id\)/, "fresh-chat recovery must release the old tab's CDP tracker and debugger session");
assert.match(recoveryBlock, /https:\/\/chatgpt\.com\//, "fresh-chat recovery must target a clean ChatGPT chat instead of the broken conversation URL");
assert.match(recoveryBlock, /conversation_id:newChat\?'':conversationId/, "fresh-chat recovery must not keep the abandoned conversation selected");
assert.match(recoveryBlock, /new_chat:newChat/, "the extension result must tell Manager that a fresh chat was created");

assert.match(managerMain, /function isMissingChromeTabError[\s\S]*?No tab with id/i, "Manager must recognize a stale Chrome tab id");
assert.match(managerMain, /async function openProfileChat[\s\S]*?const openFreshChat[\s\S]*?action: "open_tab"[\s\S]*?url: "https:\/\/chatgpt\.com\/"/, "Mở Chrome must define a fresh-chat fallback for a stale target");
assert.match(managerMain, /async function openProfileChat[\s\S]*?isMissingChromeTabError\(error\)[\s\S]*?await openFreshChat\(\)/, "Mở Chrome must use the fresh-chat fallback when its cached target id no longer exists");
assert.match(managerMain, /async function recoverProfileChatTab[\s\S]*?new_chat: newChat/, "Manager must forward fresh-chat recovery through MCP");
assert.match(managerUi, /async function recoverProfileTab[\s\S]*?newChat: true[\s\S]*?NEW_CHAT_TARGET/, "the UI must select the fresh-chat composer after recovering a hung profile");

console.log("✓ Stuck ChatGPT tab recovery smoke test passed");
