import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const [worker, bridge, managerMain] = await Promise.all([
  readFile(join(root, "chrome-extension", "service-worker.js"), "utf8"),
  readFile(join(root, "src", "browserExtensionBridge.ts"), "utf8"),
  readFile(join(root, "manager", "electron", "main.mjs"), "utf8")
]);

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = worker.indexOf(marker);
  assert.notEqual(start, -1, `${name} must remain defined in the profile bridge worker`);
  const bodyStart = worker.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  let regex = false;
  let characterClass = false;
  for (let index = bodyStart; index < worker.length; index += 1) {
    const character = worker[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (regex) {
      if (character === "\\") escaped = true;
      else if (character === "[" && !characterClass) characterClass = true;
      else if (character === "]" && characterClass) characterClass = false;
      else if (character === "/" && !characterClass) regex = false;
      continue;
    }
    if (["'", "\"", "`"].includes(character)) {
      quote = character;
      continue;
    }
    if (character === "/" && worker[index - 1] !== "*") {
      const previous = worker.slice(0, index).trimEnd().at(-1) ?? "";
      if (["(", "=", ":", "!", "&", "|", ","].includes(previous)) {
        regex = true;
        continue;
      }
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return worker.slice(start, index + 1);
    }
  }
  assert.fail(`Could not find the end of ${name}`);
}

const generationSource = extractFunction("isChatGenerationRequest");
const isChatGenerationRequest = Function(`${generationSource}; return isChatGenerationRequest;`)();

assert.equal(isChatGenerationRequest({
  tabId: 9,
  method: "POST",
  url: "https://chatgpt.com/backend-api/f/conversation"
}), true);
assert.equal(isChatGenerationRequest({
  tabId: 9,
  method: "POST",
  url: "https://chatgpt.com/backend-api/codex/responses"
}), true);
assert.equal(isChatGenerationRequest({
  tabId: 9,
  method: "POST",
  url: "https://chatgpt.com/backend-api/f/responses"
}), true);
assert.equal(isChatGenerationRequest({
  tabId: 9,
  method: "POST",
  url: "https://chatgpt.com/backend-api/f/conversation/prepare"
}), false, "prepare is not generation ACK");
assert.equal(isChatGenerationRequest({
  tabId: 9,
  method: "POST",
  url: "https://chatgpt.com/realtime/wm"
}), false, "realtime setup/transport is not sufficient generation ACK evidence");
assert.equal(isChatGenerationRequest({
  tabId: 9,
  method: "GET",
  url: "https://chatgpt.com/backend-api/conversation"
}), false);
assert.equal(isChatGenerationRequest({
  tabId: 9,
  method: "POST",
  url: "https://example.com/backend-api/conversation"
}), false);

const replaceTabSource = extractFunction("replaceUnresponsiveChatTab");
const recoveryCalls = [];
const recoveryNetworkState = new Map([[41, { state: "completed", conversation_id: "12345678-abcd" }]]);
const recoveryPostLog = new Map([[41, [{ state: "completed" }]]]);
const recoveryPostVersion = new Map([[41, 3]]);
const replaceUnresponsiveChatTab = Function(
  "chrome", "waitForTab", "ensureChatNetworkStreamCapture", "ensureChatNetworkStateLoaded", "chatNetworkStateByTab", "chatNetworkPostLogByTab", "chatNetworkPostVersionByTab", "pendingConversationByTab", "persistChatNetworkState", "scheduleRealtimeProfilePush", "recentConversationCache",
  `${replaceTabSource.replace(/^function/, "async function")}; return replaceUnresponsiveChatTab;`
)(
  { tabs: {
    create: async (args) => { recoveryCalls.push(["create", args]); return { id: 42, windowId: 7, active: true, url: args.url }; },
    get: async (id) => { recoveryCalls.push(["get", id]); return { id, windowId: 7, active: true, url: "https://chatgpt.com/c/12345678-abcd" }; },
    remove: async (id) => { recoveryCalls.push(["remove", id]); }
  } },
  async (id) => { recoveryCalls.push(["wait", id]); },
  async (id) => { recoveryCalls.push(["capture", id]); },
  async () => { recoveryCalls.push(["state"]); },
  recoveryNetworkState,
  recoveryPostLog,
  recoveryPostVersion,
  new Map([[41, { conversation_id: "12345678-abcd" }]]),
  async () => { recoveryCalls.push(["persist"]); },
  () => { recoveryCalls.push(["push"]); },
  { at: 1, items: [] }
);
const recoveryResult = await replaceUnresponsiveChatTab({ id: 41, windowId: 7, active: true, url: "https://chatgpt.com/c/12345678-abcd" }, "https://chatgpt.com/c/12345678-abcd", 5000);
assert.equal(recoveryResult.replaced_tab_id, 41);
assert.equal(recoveryResult.recovery_tab_id, 42);
assert.ok(recoveryCalls.findIndex(([name]) => name === "wait") < recoveryCalls.findIndex(([name]) => name === "remove"), "the replacement must finish loading before the stuck tab is closed");
assert.deepEqual(recoveryNetworkState.get(42), recoveryNetworkState.get(41), "completed network evidence must follow the replacement tab");

const sendStart = worker.indexOf("if(action==='send_chat_request'){");
const sendEnd = worker.indexOf("if(action==='rename_chat'){", sendStart);
assert.ok(sendStart >= 0 && sendEnd > sendStart, "send_chat_request command block must exist");
const sendBlock = worker.slice(sendStart, sendEnd);
const timeoutCatch = sendBlock.indexOf("}catch(error){");
const networkRecovery = sendBlock.indexOf("networkAck=await waitForNetworkGeneration(tab.id,submitStartedAt-100", timeoutCatch);
const acknowledgedReturn = sendBlock.indexOf("if(networkAck)return await resultForNetwork", networkRecovery);
const cleanup = sendBlock.indexOf("await cleanupAttempt()", timeoutCatch);
const enterPrimary = sendBlock.indexOf("trustedSubmitChatComposerTab(tab.id,attemptId,text)");
const earlyAckBlock = sendBlock.indexOf("let earlyAck=null", enterPrimary);
const earlyAck = sendBlock.indexOf("waitForNetworkGeneration(tab.id,submitStartedAt-100", earlyAckBlock);
const clickFallback = sendBlock.indexOf("trustedActivateChatSendButtonTab(tab.id,attemptId)", earlyAck);

assert.ok(timeoutCatch >= 0, "DOM send timeout must be handled");
assert.ok(networkRecovery > timeoutCatch, "DOM timeout must check the network tracker");
assert.ok(acknowledgedReturn > networkRecovery, "a tracked generation must count as submitted");
assert.ok(cleanup > acknowledgedReturn, "draft cleanup must only happen after network recovery fails");
assert.ok(enterPrimary >= 0, "trusted Enter must exist in the primary send path");
assert.ok(earlyAckBlock > enterPrimary, "primary Enter must establish its bounded ACK window");
assert.ok(earlyAck > enterPrimary, "primary Enter must wait for generation ACK before fallback");
assert.ok(clickFallback > earlyAck, "trusted Send click must only occur after the Enter ACK window");
assert.match(sendBlock, /submitted_by:'trusted-enter'/);
assert.match(sendBlock, /submitted_by:'trusted-click-fallback'/);
assert.doesNotMatch(sendBlock, /chrome\.tabs\.update\(tab\.id,\{active:true\}\)/, "background send must not activate the target tab");
assert.doesNotMatch(sendBlock, /restorePreviouslyActiveTab/, "background send must not need to restore tabs because it never activates them");
assert.match(sendBlock, /SEND_UNCERTAIN:/);
assert.match(sendBlock, /shouldUseTrustedClickFallback\(attemptState\?\.result,earlyEvidence\)/, "fallback must require an owned draft and no submit lifecycle evidence");
assert.match(sendBlock, /trustedSubmitError\.startsWith\(attachmentSubmit\?'ATTACHMENT_DOM_CLICK_PRE_DISPATCH:':'TRUSTED_ENTER_PRE_DISPATCH:'\)/, "each submit mechanism must recognize its definitely-unsent pre-dispatch failure");
assert.match(sendBlock, /definitelyNotDispatched&&!attachmentSubmit&&remainingCommandMs\(\)>1500/, "an expired pre-dispatch attempt must not start a late click fallback");
assert.match(sendBlock, /trusted-enter-pre-dispatch','trusted-click-fallback'/, "a definitely-unsent focus failure may use one trusted-click fallback");
assert.match(worker, /expectedText&&normalized\(composerText\)===normalized\(expectedText\)/, "trusted click fallback must recover a React-replaced composer only for an exact owned payload");
assert.match(sendBlock, /cleanup_skipped:!definitelyUnsent/, "ambiguous attempts must not delete a possibly submitted draft");
assert.match(sendBlock, /await chrome\.tabs\.remove\(hungTabId\)/, "a hard renderer hang must close the exact unresponsive tab");
assert.match(sendBlock, /chrome\.tabs\.create\(\{windowId:recoveryWindowId,url:recoveryUrl,active:recoveryActive\}\)/, "hard-hang recovery must reopen the exact conversation URL in the same window");
assert.match(sendBlock, /await chrome\.tabs\.reload\(tab\.id\)/, "a soft pre-submit expiry must reload the exact conversation tab once");
assert.match(sendBlock, /path_attempted:\['prepare',preparationRecovery\.renderer_replaced\?'replace-tab':'reload','prepare'\]/, "pre-submit recovery must expose its bounded recovery path");
assert.match(sendBlock, /submission_state:'failed'.*PREPARE_FAILED:/s, "a second pre-submit failure is definitely unsent, not SEND_UNCERTAIN");
assert.match(worker, /const ATTACHMENT_PREPARE_TIMEOUT_MS = 60000;/, "attachment preparation must allow ChatGPT enough time to render and stabilize uploaded files");
assert.match(sendBlock, /const prepareTimeoutMs=attachments\.length\?ATTACHMENT_PREPARE_TIMEOUT_MS:DOM_PREPARE_TIMEOUT_MS;/, "attachment sends must use the dedicated preparation deadline");
assert.match(sendBlock, /submitted_by:'prepare-timeout'.*send_uncertain:false.*ATTACHMENT_PREPARE_TIMEOUT/s, "a timeout before trusted input dispatch is definitely unsent and safe to retry");
assert.match(worker, /normalized\(composerText\(current\)\)===normalized\(expectedText\)/, "trusted Enter must recover a React-replaced composer only when its draft exactly matches the owned payload");
assert.match(worker, /ok:true,focused:document\.activeElement===composer/, "the first ownership check must not require a background tab to already own keyboard focus");
assert.match(worker, /refocused\?\.result\?\.focused!==true/, "trusted Enter must require focus after bringing the page to the foreground");
assert.match(worker, /focusAttempt<15.*setTimeout\(resolve,50\)/s, "foreground focus verification must tolerate a bounded Chrome/React focus race");
assert.match(worker, /TRUSTED_ENTER_PRE_DISPATCH:/, "trusted Enter must distinguish a definitely-unsent pre-dispatch failure");
assert.match(worker, /TRUSTED_ENTER_DISPATCH_UNCERTAIN:/, "trusted Enter must preserve ambiguity after key dispatch starts");
assert.match(worker, /let refocusedResult=null/, "trusted Enter metadata must retain the refocus result outside the dispatch block");
assert.match(worker, /const heartbeat=setInterval\(\(\)=>\{void fetch\(`\$\{BRIDGE\}\/register`/, "long extension commands must keep their profile heartbeat alive");
assert.match(worker, /network_generation_endpoint/, "generation ACK must expose the matched endpoint");
assert.match(worker, /network_recent_posts/, "safe POST path diagnostics must be exposed without request bodies");
assert.match(worker, /CDP_NETWORK_TRACKER_MAX_MS/, "CDP tracking must have a bounded maximum lifetime");
assert.match(worker, /const CDP_NETWORK_START_TIMEOUT_MS = 15000;/, "the pre-armed CDP tracker must remain alive through the bounded Enter-to-click fallback window");
const networkWaitSource = extractFunction("waitForNetworkGeneration");
assert.match(networkWaitSource, /chatNetworkWaitersByTab/, "generation ACK waits must subscribe to network state changes");
assert.doesNotMatch(networkWaitSource, /setTimeout\(resolve,50\)/, "generation ACK waits must not spin every 50 ms");
assert.match(sendBlock, /waitForAttachmentUploadNetwork\(tab\.id,submitStartedAt-100,/, "attachment sends must wait for upload network completion before submit");
assert.doesNotMatch(sendBlock, /attachmentSubmit\?trustedSubmitChatSendButtonTab/, "attachment primary submit must not depend on a background mouse click");
assert.match(sendBlock, /submitted_by:'dom-click-attachment'/, "attachment sends must honestly report their page-context submit path");
assert.match(sendBlock, /attachmentSubmit\?submitChatAttachmentButtonTab\(tab\.id,attemptId,text\):trustedSubmitChatComposerTab/, "attachment sends must use a scoped background page click after upload ACK while text keeps trusted Enter");
assert.match(worker, /async function submitChatAttachmentButtonTab\(tabId,attemptId,expectedText=''/, "attachment submit must install the network tracker before invoking the scoped page click");
assert.match(worker, /func:clickPreparedChatSendButtonPage,args:\[attemptId\]/, "attachment submit must click only the Send button marked for the exact attempt");
assert.match(sendBlock, /ATTACHMENT_UPLOAD_FAILED:/, "a failed upload must stop before submit and clean only the owned draft");
assert.match(worker, /const tracker=cdpNetworkTrackersByTab\.get\(tabId\);if\(tracker\)void tracker\.cleanup\(\)/, "closing a tab must detach its CDP tracker");
assert.doesNotMatch(worker, /body_text:String\(request\.body_text/, "diagnostics must not export captured message bodies");
assert.match(worker, /replace\(\/\^@\\s\*\(\?=CodexPro\\b\)\/i,''\)/, "manager mentions must compare semantically after ChatGPT renders them");
assert.match(worker, /const verifyDeadline=Math\.min\(/, "composer verification must not consume the entire send deadline");
const prepareSource = extractFunction("sendChatRequestPage");
assert.doesNotMatch(prepareSource, /composer-submit-button|send-button|aria-label\*="Send"|sendRect|send_point/, "primary preparation must not find or measure the Send button");
assert.match(prepareSource, /requires_trusted_submit:true/, "prepared composer must request the trusted Enter path");
assert.match(prepareSource, /internal_submit_found:false/, "runtime result must report that no stable internal submit action was found");
assert.match(prepareSource, /new DataTransfer\(\)/, "attachment preparation must keep the existing DOM upload path");
assert.match(prepareSource, /new ClipboardEvent\('paste'/, "attachment preparation must fall back to ChatGPT's paste upload handler when a file input change produces no preview");
assert.match(prepareSource, /attachmentPreparePath='paste-fallback'/, "attachment diagnostics must expose the paste upload fallback");
assert.match(prepareSource, /staleAttachmentsOwned&&staleDraftOwned/, "a retry may clean only stale attachments and draft text proven to belong to CodexPro");
assert.match(prepareSource, /existingAttachments\.length&&!reusableExistingAttachments/, "attachments not owned or exactly matched to the incoming files must remain protected");
assert.match(prepareSource, /attachment_prepare_path:ownedExistingAttachments\?'existing-attempt'/, "an internal prepare retry must reuse its already uploaded attachment instead of rejecting itself");
assert.match(prepareSource, /!draft&&existingAttachments\.length===expectedAttachmentNames\.length/, "an orphaned React preview may be reused only when the composer is empty and file counts match");
assert.match(prepareSource, /expectedAttachmentNames\.every\(name=>existingAttachmentLabels\.some\(label=>label\.includes\(name\)\)\)/, "an orphaned React preview may be reused only when every incoming filename matches");
assert.match(sendBlock, /attachments\.length&&!injected\.result\.attachment_reused/, "reused attachment previews must not wait for a second upload request that will never occur");
assert.match(prepareSource, /codexproDraftText/, "attachment ownership must retain the exact draft text for safe stale-attempt recovery");
assert.match(worker, /CHAT_ATTACHMENT_OWNERSHIP_KEY/, "attachment ownership must survive React rerenders and extension worker restarts outside the DOM");
assert.match(prepareSource, /persistedOwnershipMatches/, "stale CodexPro attachments must only be removed when persisted ownership matches every visible file and the composer has no user draft");
assert.match(sendBlock, /rememberChatAttachmentOwnership/, "the worker must persist attachment ownership before attempting submit");
assert.match(sendBlock, /clearChatAttachmentOwnership\(tab\.id,attemptId\)/, "network ACK must clear persisted attachment ownership");
assert.match(prepareSource, /const currentComposer=findComposer\(\)/, "composer verification must survive ChatGPT replacing the React node");

const clickSource = extractFunction("prepareTrustedClickFallbackPage");
assert.match(clickSource, /composer-submit-button|send-button/, "Send selectors may remain only in the fallback locator");
assert.match(clickSource, /codexproSendAttempt/, "fallback click must be scoped to the exact send attempt");

const enterSource = extractFunction("trustedSubmitChatComposerTab");
assert.match(enterSource, /focusChatComposerForSubmitPage/, "trusted Enter must focus the prepared composer without locating Send");
assert.match(enterSource, /Input\.dispatchKeyEvent/, "trusted Enter must use CDP keyboard input");
assert.doesNotMatch(enterSource, /Page\.bringToFront/, "trusted Enter must not bring the Chrome profile to the foreground");
assert.match(enterSource, /Emulation\.setFocusEmulationEnabled/, "trusted Enter must emulate focus without depending on the OS foreground window");
assert.match(enterSource, /background_submit:true/, "trusted Enter must report background submission metadata");
assert.match(enterSource, /cdp_tracker_armed:true/, "trusted Enter must return after dispatch while leaving the CDP tracker armed");
assert.doesNotMatch(enterSource, /await tracker\.started/, "trusted Enter must not hide the dispatch result behind a second network wait");
assert.match(enterSource, /const \[refocused\]/, "trusted Enter must re-focus the composer after bringing a background page forward");
assert.doesNotMatch(enterSource, /dispatchMouseEvent|composer-submit-button|send-button/, "trusted Enter must not depend on mouse or Send DOM");
const trustedKeySource = extractFunction("trustedKeyTab");
assert.match(trustedKeySource, /Emulation\.setFocusEmulationEnabled/, "generic trusted keys must work in a background tab without raising its Chrome window");

const evidenceSource = extractFunction("isChatSubmitLifecycleEvidence");
const isChatSubmitLifecycleEvidence = Function(`${evidenceSource}; return isChatSubmitLifecycleEvidence;`)();
const fallbackSource = extractFunction("shouldUseTrustedClickFallback");
const shouldUseTrustedClickFallback = Function(`${evidenceSource}; ${fallbackSource}; return shouldUseTrustedClickFallback;`)();
assert.equal(shouldUseTrustedClickFallback({ draft_owned: true, draft_present: true }, []), true, "unchanged owned draft with no network activity can use click fallback");
assert.equal(shouldUseTrustedClickFallback({ draft_owned: true, draft_present: true }, [{ endpoint: "/backend-api/sentinel/chat-requirements", matched_generation: false }]), false, "Sentinel activity blocks a duplicate fallback");
assert.equal(shouldUseTrustedClickFallback({ draft_owned: true, draft_present: true }, [{ endpoint: "/backend-api/f/conversation", matched_generation: true }]), false, "generation ACK blocks duplicate fallback");
assert.equal(shouldUseTrustedClickFallback({ draft_owned: false, draft_present: true }, []), false, "a React-replaced/unowned composer cannot be clicked as fallback");
assert.equal(shouldUseTrustedClickFallback({ draft_owned: true, draft_present: false }, []), false, "a consumed draft cannot be retried");

assert.match(sendBlock, /const newChat=Boolean\(args\.new_chat\)/, "new chat path must remain supported");
assert.match(sendBlock, /conversationId/, "existing conversation path must remain supported");
assert.match(worker, /readCanonicalConversationPage/, "canonical conversation reading must remain available");
assert.match(bridge, /expires_at_ms: number/, "bridge commands must carry an explicit expiry");
assert.match(bridge, /profile\.queued = profile\.queued\.filter\(\(queued\) => queued\.id !== command\.id\)/, "timed-out commands must be removed from the extension queue");
assert.match(bridge, /command\.expires_at_ms<=Date\.now\(\)\|\|!state\.pending\.has\(command\.id\)/, "poll must discard expired or orphaned commands before delivery");
assert.match(managerMain, /const profileSendOperations = new Map\(\)/, "Manager must reject concurrent sends for the same profile");
assert.match(managerMain, /Profile này đang gửi một yêu cầu khác/, "concurrent profile sends must fail explicitly instead of queueing a duplicate");
const responseSource = extractFunction("readChatResponsePage");
assert.match(responseSource, /thinkingPlaceholder/, "DOM fallback must classify the Thinking placeholder as incomplete");
assert.match(responseSource, /generation_in_progress/, "DOM fallback must expose active generation rather than treating it as a completed answer");
assert.match(responseSource, /connection interrupted\\\.\\s\*waiting for the complete answer/i, "DOM fallback must detect ChatGPT's interrupted connection placeholder");
assert.match(responseSource, /incomplete_reason:messageDeliveryTimedOut\?'message_delivery_timeout':connectionInterrupted\?'connection_interrupted'/, "recoverable ChatGPT errors must remain incomplete until the exact chat is recovered");

console.log("✓ ChatGPT trusted-Enter primary send smoke test passed");
