import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = fs.readFileSync(path.join(root, "chrome-extension", "service-worker.js"), "utf8");
const bridge = fs.readFileSync(path.join(root, "src", "browserExtensionBridge.ts"), "utf8");
const managerUi = fs.readFileSync(path.join(root, "manager", "src", "main.jsx"), "utf8");

assert.match(
  worker,
  /function probeChatActivityPage\(\)[\s\S]*?maximum length for this conversation[\s\S]*?start new chat[\s\S]*?conversation_limit_reached:conversationLimitReached[\s\S]*?conversation_limit_message:conversationLimitMessage/,
  "normal profile polling must detect the terminal full-conversation banner"
);
assert.match(
  worker,
  /conversation_limit_reached:Boolean\(domActivity\.conversation_limit_reached\)[\s\S]*?conversation_limit_message:String\(domActivity\.conversation_limit_message/,
  "profile summaries must propagate terminal conversation-length evidence"
);
assert.match(
  bridge,
  /conversation_limit_reached:\s*tab\.conversation_limit_reached\s*===\s*true[\s\S]*?conversation_limit_message:\s*String\(tab\.conversation_limit_message/,
  "extension bridge must preserve terminal conversation-length evidence"
);
assert.match(
  managerUi,
  /tab\?\.conversation_limit_reached[\s\S]*?recoveryContinuationSnapshot\(profile, conversationId, targetTab\)[\s\S]*?conversation-limit-auto-rollover-start[\s\S]*?rolloverFullConversation\(profile, conversationId,[\s\S]*?continuation_reason: "limit"[\s\S]*?conversation-limit-auto-rollover-done/,
  "Manager must preserve recent context and proactively roll a full selected conversation to a new chat"
);
assert.match(
  worker,
  /newChat[\s\S]*?createChatGptTab\(\{url:'https:\/\/chatgpt\.com\/',active:true\},'send_chat_request_new'\)/,
  "the continuation must create the new ChatGPT tab in the foreground"
);
assert.match(worker, /chrome\.windows\.update\(created\.windowId,\{focused:true\}\)/, "foreground continuation must focus the Chrome window");

console.log("✓ proactive conversation-limit rollover smoke test passed");
