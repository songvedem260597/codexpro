import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const composerStart = source.indexOf("function ChatRequestComposer(");
const appStart = source.indexOf("function App()", composerStart);
assert.ok(composerStart >= 0 && appStart > composerStart, "ChatRequestComposer must stay isolated above App");

const composer = source.slice(composerStart, appStart);
assert.match(composer, /const \[draft, setDraft\] = useState\(/, "composer draft must be local state");
assert.match(composer, /onDraftSnapshot\(normalized\)/, "composer must snapshot draft without lifting render state");
assert.match(composer, /onDraftActivityChange\(Boolean\(normalized\.trim\(\)\)\)/, "typing must mark the composer active so background transcript pinning cannot move the reader viewport");
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
assert.match(source, /hydrateCachedResponse[\s\S]*const cacheFresh = cachedResponseIsFresh[\s\S]*selectedTargetNow[\s\S]*selectedTargetNow !== conversationId/, "stale cache hydration must stop when the user switches conversations");
assert.match(source, /const responseTargetStillCurrent = \(\) =>[\s\S]*currentTarget === conversationId[\s\S]*if \(!responseTargetStillCurrent\(\)\) return null/, "late response reads must be discarded after the selected conversation changes");
assert.match(source, /responseProfileId !== profile\.profile_id \|\| responseConversationId !== conversationId[\s\S]*RESPONSE_OWNERSHIP_MISMATCH/, "renderer must reject responses whose profile or conversation ownership does not match the request");

assert.match(source, /const cacheFresh = cachedResponseIsFresh[\s\S]*transcriptLoading: !cacheFresh/, "stale cached transcripts must remain visibly loading until refreshed");
assert.match(source, /const activeTurn = sameConversation[\s\S]*transcriptLoading: !activeTurn/, "opening an idle existing chat must show transcript loading even when stale messages are already cached");
assert.match(source, /transcriptLoading: Boolean\(previous\.transcriptLoading && needsDomFallback\)/, "a network-only read must preserve transcript loading while a DOM fallback is still required");
assert.match(source, /responseCurrent && response\?\.transcriptLoading \? <div className="response-empty is-transcript-loading">[\s\S]*Đang tải tin nhắn<\/span>/, "transcript loading must hide stale cached messages behind an explicit loading state without duplicating animated dots in the text");
assert.match(source, /!responseCurrent \|\| response\?\.loading && !hasResponseContent \? <div className="response-empty is-transcript-loading">/, "initial response loading must use the same aligned loading state");
assert.match(styles, /\.latest-response \{[^}]*padding:\s*15px 14px 18px/, "tool activity transcript must retain its 14px container inset");
assert.match(styles, /\.tool-activity-live \{[^}]*padding-left:\s*31px/, "CodexPro tool activity must retain its 31px inner inset");
assert.match(styles, /\.response-empty\.is-transcript-loading \{\s*padding-left:\s*45px;\s*\}/, "loading text must align exactly with tool activity at 14px + 31px from the response edge");
assert.match(styles, /\.chat-response-notices \{[^}]*position:\s*absolute/, "response notices must overlay the fixed chat frame instead of shrinking the transcript viewport");
assert.match(modal, /const hasResponseNotice = showRolloverNotice \|\| showRepoTaskNotice \|\| showNetworkNotice/, "chat response notices must share one non-layout overlay host");
assert.match(modal, /className="chat-response-notices"/, "chat response notices must render through the overlay host");
assert.match(source, /const responseComposerActive = useRef\(new Map\(\)\)/, "composer activity must use a dedicated lock instead of overwriting manual scroll ownership");
assert.match(source, /responseScrollLocked\.current\.get\(profileId\) \|\| responseComposerActive\.current\.get\(profileId\)/, "auto-positioning must pause while the user is drafting");
assert.match(source, /type: "chat-frame-geometry"/, "chat frame diagnostics must persist geometry changes");
assert.match(source, /const geometry = \{[\s\S]*panel:[\s\S]*transcript:[\s\S]*composer:[\s\S]*textarea:/, "chat frame diagnostics must include frame, transcript, composer, and textarea geometry");
assert.match(modal, /data-layout-transcript-loading=\{responseCurrent && response\?\.transcriptLoading \? "1" : "0"\}/, "chat modal must expose transcript loading for runtime UI verification");

console.log("chat-composer-isolation-smoke: ok");
