import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
const composerStart = source.indexOf("function ChatRequestComposer(");
const appStart = source.indexOf("function App()", composerStart);
assert.ok(composerStart >= 0 && appStart > composerStart, "ChatRequestComposer must stay isolated above App");

const composer = source.slice(composerStart, appStart);
assert.match(composer, /const \[draft, setDraft\] = useState\(/, "composer draft must be local state");
assert.match(composer, /onDraftSnapshot\(normalized\)/, "composer must snapshot draft without lifting render state");
assert.match(composer, /\[profileId, draftResetVersion\]/, "composer must reset local draft when switching profiles");
assert.doesNotMatch(composer, /setRequestDrafts/, "composer must not update App state on each keystroke");

assert.match(source, /const requestDraftsRef = useRef\(\{\}\)/, "App must keep draft snapshots in a ref");
assert.doesNotMatch(source, /setRequestDrafts/, "legacy App draft setter must not return");
assert.match(source, /async function sendRequest\(profile, draftOverride = null\)/, "sendRequest must accept the composer draft directly");

const modalStart = source.indexOf("function renderChatModal()");
const modalEnd = source.indexOf("const selectedFont =", modalStart);
const modal = source.slice(modalStart, modalEnd);
assert.match(modal, /<ChatRequestComposer/, "chat modal must render the isolated composer");
assert.doesNotMatch(modal, /value=\{draft\}/, "chat modal must not own controlled draft input state");

console.log("chat-composer-isolation-smoke: ok");
