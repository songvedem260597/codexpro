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
assert.match(modal, /<ChatDropdown[\s\S]*selectRequestConversation\(profile, id\)/, "chat modal must keep an explicit conversation selector");
assert.doesNotMatch(modal, /value=\{draft\}/, "chat modal must not own controlled draft input state");

assert.match(source, /requestTargetsRef\.current = \{ \.\.\.requestTargetsRef\.current, \[profileId\]: nextTarget \}/, "conversation selection must synchronously pin the target ref");
assert.match(source, /function openChat\(profile\)[\s\S]*?activeTabReady[\s\S]*?open_active_idle_tab_overrode_pinned[\s\S]*?requestTargetsRef\.current/, "opening an idle Chrome tab must override a stale pinned busy conversation");
assert.match(source, /selection_reason:[\s\S]*composer_lock_reason:[\s\S]*tab_candidates:/, "target diagnostics must explain selection and composer locks");
assert.match(source, /action: "open-chat-target-selection"[\s\S]*?draft_length:[\s\S]*?tab_candidates:/, "opening the composer must log target selection and retained draft evidence");
assert.match(modal, /profileRequestChats\(profile, pinnedTarget\)/, "refresh must keep the pinned conversation in the selector");
assert.match(source, /const relevant = selectedTarget[\s\S]*\? selectedTarget === conversationId\s*:\s*currentResponse\?\.conversationId === conversationId/, "an explicit target must be the only auto-loaded conversation for that profile");
assert.match(source, /const fetchKey = responseCacheKey\(profile\.profile_id, conversationId\)[\s\S]*responseFetches\.current\.has\(fetchKey\)[\s\S]*responseFetches\.current\.delete\(fetchKey\)/, "response fetch locks must be scoped by profile and conversation instead of profile only");
assert.match(source, /hydrateCachedResponse[\s\S]*selectedTargetNow[\s\S]*selectedTargetNow !== conversationId[\s\S]*cachedResponseIsFresh/, "stale cache hydration must stop when the user switches conversations");
assert.match(source, /const responseTargetStillCurrent = \(\) =>[\s\S]*currentTarget === conversationId[\s\S]*if \(!responseTargetStillCurrent\(\)\) return null/, "late response reads must be discarded after the selected conversation changes");
assert.match(source, /responseProfileId !== profile\.profile_id \|\| responseConversationId !== conversationId[\s\S]*RESPONSE_OWNERSHIP_MISMATCH/, "renderer must reject responses whose profile or conversation ownership does not match the request");

console.log("chat-composer-isolation-smoke: ok");
