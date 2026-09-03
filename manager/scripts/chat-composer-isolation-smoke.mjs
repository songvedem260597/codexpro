import assert from "node:assert/strict";
import fs from "node:fs";
import { availableConversationIdsForProfile, conversationBelongsToProfile, isConversationUnavailableError } from "../src/conversation-target.js";

const source = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const electronMain = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
const composerStart = source.indexOf("function ChatRequestComposer(");
const appStart = source.indexOf("function App()", composerStart);
assert.ok(composerStart >= 0 && appStart > composerStart, "ChatRequestComposer must stay isolated above App");

const composer = source.slice(composerStart, appStart);
assert.match(composer, /const \[draft, setDraft\] = useState\(/, "composer draft must be local state");
assert.match(composer, /const draftRef = useRef\(String\(initialDraft \|\| ""\)\)/, "composer must track the live draft independently while a previous send waits for ACK");
assert.match(composer, /const submittedDraft = draft[\s\S]*?onSend\(submittedDraft\)[\s\S]*?draftRef\.current === submittedDraft/, "a completed send may clear only the exact draft it submitted, never text typed for the next follow-up");
assert.match(composer, /onDraftSnapshot\(normalized\)/, "composer must snapshot draft without lifting render state");
assert.match(composer, /onDraftActivityChange\(Boolean\(normalized\.trim\(\)\)\)/, "typing must mark the composer active so background transcript pinning cannot move the reader viewport");
assert.match(composer, /\[profileId, draftResetVersion\]/, "composer must reset local draft when switching profiles");
assert.doesNotMatch(composer, /setRequestDrafts/, "composer must not update App state on each keystroke");

const freshProfileWithStaleTask = {
  current_task_conversation_id: "6a970b60-bd88-83ec-b382-79276c663acc",
  recent_conversations: [],
  conversation_tabs: [{ url: "https://chatgpt.com/", active: true }]
};
assert.equal(conversationBelongsToProfile(freshProfileWithStaleTask, freshProfileWithStaleTask.current_task_conversation_id), false, "a fresh Chrome profile must reject a task conversation persisted by an older profile incarnation");
assert.deepEqual([...availableConversationIdsForProfile(freshProfileWithStaleTask)], [], "a ChatGPT home tab must not invent an available conversation");
assert.equal(conversationBelongsToProfile({ recent_conversations: [{ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }] }, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), true, "a recent conversation remains selectable");
assert.equal(conversationBelongsToProfile({ conversation_tabs: [{ url: "https://chatgpt.com/c/11111111-2222-3333-4444-555555555555" }] }, "11111111-2222-3333-4444-555555555555"), true, "an open conversation tab remains selectable");
assert.equal(isConversationUnavailableError(new Error("Chrome extension action failed: Đoạn chat không còn thuộc 3 chat gần nhất của profile này.")), true, "the stale-selection recovery must recognize the wrapped worker error");

assert.match(source, /const requestDraftsRef = useRef\(\{\}\)/, "App must keep draft snapshots in a ref");
assert.doesNotMatch(source, /setRequestDrafts/, "legacy App draft setter must not return");
assert.match(source, /async function sendRequest\(profile, draftOverride = null\)/, "sendRequest must accept the composer draft directly");

const modalStart = source.indexOf("function renderChatModal()");
const modalEnd = source.indexOf("const selectedFont =", modalStart);
const modal = source.slice(modalStart, modalEnd);
assert.match(modal, /<ChatRequestComposer/, "chat modal must render the isolated composer");
assert.match(modal, /const canSendBase = !sending && profile\.connected[\s\S]*?!selectedRecoveringNetworkAbort[\s\S]*?!rolloverCreating/, "manual follow-up send eligibility must depend on the send lock and transport safety, not on the assistant being idle");
assert.match(modal, /disabled=\{!profile\.connected \|\| rolloverCreating\}/, "the follow-up textarea must stay editable while a send is awaiting ACK and while ChatGPT is generating");
assert.match(composer, /selectedBusy \|\| selectedSettling \? "Gửi thêm"/, "busy and settling chats must present an enabled follow-up action instead of an idle-only blocker");
assert.match(source, /allowBusyFollowup: !newChat/, "Manager manual sends must explicitly opt into serialized follow-up steering for existing chats");
assert.match(electronMain, /const allowBusyFollowup = Boolean\(!newChat && payload\?\.allowBusyFollowup === true\)/, "Electron must require an explicit manual follow-up opt-in");
assert.match(electronMain, /selectedNetworkState === "generating"\) && !allowBusyFollowup/, "Electron must keep automated sends blocked while allowing explicit manual steering");
assert.match(electronMain, /allow_busy_followup: allowBusyFollowup/, "Electron must forward the busy-follow-up capability to the browser bridge");
assert.match(modal, /managerSettings\.showChatConversationSelector !== false[\s\S]*?<ChatDropdown[\s\S]*selectRequestConversation\(profile, id\)/, "chat modal conversation selector must be controlled by the Manager setting");
assert.match(source, /showChatConversationSelector:\s*true/, "conversation selector must remain enabled by default for existing users");
assert.match(source, /title="Hiện mục Đoạn chat"[\s\S]*saveManagerSetting\(\{ showChatConversationSelector: value \}/, "Settings must expose an explicit conversation-selector toggle");
assert.match(electronMain, /showChatConversationSelector:\s*true/, "Electron settings must default the selector to visible");
assert.match(electronMain, /showChatConversationSelector:\s*parsed\?\.showChatConversationSelector !== false/, "Electron settings must persist a saved hidden selector state");
assert.match(electronMain, /hasOwnProperty\.call\(patch, "showChatConversationSelector"\)[\s\S]*next\.showChatConversationSelector = patch\.showChatConversationSelector !== false/, "Electron settings save path must accept the selector toggle");
assert.doesNotMatch(modal, /value=\{draft\}/, "chat modal must not own controlled draft input state");

assert.match(source, /requestTargetsRef\.current = \{ \.\.\.requestTargetsRef\.current, \[profileId\]: nextTarget \}/, "conversation selection must synchronously pin the target ref");
assert.match(source, /function taskConversationIdForProfile\(profile\)[\s\S]*?current_task_conversation_id[\s\S]*?conversationBelongsToProfile\(profile, persisted\)[\s\S]*?network_stream_in_progress[\s\S]*?overlap >= 2/, "task chat resolution must use a persisted binding only while the conversation still belongs to the live profile, then a live task tab, then conservative title affinity");
assert.match(source, /function openChat\(profile\)[\s\S]*?taskConversationIdForProfile\(profile\)[\s\S]*?taskConversationId \|\| \(activeTabReady[\s\S]*?open_task_bound_conversation[\s\S]*?open_task_inferred_conversation/, "opening a worker chat must prefer the task conversation over an unrelated active idle Chrome tab");
assert.match(source, /pinnedConversationCandidate === NEW_CHAT_TARGET \|\| availableConversationIds\.has\(pinnedConversationCandidate\)[\s\S]*?open_new_chat_after_stale_selection/, "opening a fresh profile must discard a stale pinned target and use the new-chat composer");
assert.match(source, /isConversationUnavailableError\(err\)[\s\S]*?recover_stale_conversation_as_new_chat[\s\S]*?recover-stale-conversation-selection/, "a conversation removed during response loading must recover to the new-chat composer without surfacing the worker guard as a fatal UI error");
assert.match(source, /selection_reason:[\s\S]*composer_lock_reason:[\s\S]*tab_candidates:/, "target diagnostics must explain selection and composer locks");
assert.match(source, /action: "open-chat-target-selection"[\s\S]*?task_id:[\s\S]*?task_title:[\s\S]*?task_bound_conversation_id:[\s\S]*?task_resolved_conversation_id:[\s\S]*?stale_task_conversation_id:[\s\S]*?stale_pinned_conversation_id:[\s\S]*?available_conversation_ids:[\s\S]*?task_tab_differs_from_chrome_active:[\s\S]*?active_conversation_id:[\s\S]*?active_title:[\s\S]*?draft_length:[\s\S]*?tab_candidates:/, "opening the composer must log enough task-vs-active-tab and stale-selection evidence to diagnose wrong chat loads");
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
