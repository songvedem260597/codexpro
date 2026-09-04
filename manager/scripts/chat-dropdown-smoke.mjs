import assert from "node:assert/strict";
import fs from "node:fs";

const main = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
const dropdown = fs.readFileSync(new URL("../src/features/chat/chat-dropdown.jsx", import.meta.url), "utf8");

assert.match(main, /import \{ ChatDropdown, NEW_CHAT_TARGET \} from "\.\/features\/chat\/chat-dropdown\.jsx";/, "main.jsx must consume the extracted chat dropdown module");
assert.doesNotMatch(main, /function ChatDropdown\(/, "ChatDropdown implementation must stay out of main.jsx");
assert.doesNotMatch(main, /const NEW_CHAT_TARGET = "__codexpro_new_chat__";/, "NEW_CHAT_TARGET must have one shared definition");
assert.doesNotMatch(main, /import \{ AppDropdown \} from "\.\/app-dropdown\.jsx";/, "main.jsx should no longer import AppDropdown only for ChatDropdown");
assert.match(dropdown, /export const NEW_CHAT_TARGET = "__codexpro_new_chat__";/, "chat dropdown module must export the shared new-chat target sentinel");
assert.match(dropdown, /export function ChatDropdown\(/, "chat dropdown module must export ChatDropdown");
assert.match(dropdown, /import \{ AppDropdown \} from "\.\.\/\.\.\/app-dropdown\.jsx";/, "ChatDropdown must keep using the shared AppDropdown component");
assert.match(dropdown, /value === NEW_CHAT_TARGET[\s\S]*?\[selectedDraft, \.\.\.conversations\]/, "new-chat selection must inject the draft option when it is absent");
assert.match(dropdown, /chat\.draft \? "Chưa tạo trên ChatGPT" : chat\.open \? "Đang mở trong Chrome" : "Chat gần đây"/, "conversation hints must remain unchanged");
assert.match(dropdown, /searchThreshold=\{6\}/, "conversation search threshold must remain six options");
assert.match(dropdown, /option\.chat\.active[\s\S]*?ACTIVE/, "active conversation metadata must remain visible");
assert.equal((main.match(/<ChatDropdown\b/g) || []).length, 1, "chat popup must keep exactly one conversation selector");
assert.ok((main.match(/NEW_CHAT_TARGET/g) || []).length >= 10, "chat orchestration must keep using the shared new-chat sentinel");

console.log("chat-dropdown-smoke: ok");
