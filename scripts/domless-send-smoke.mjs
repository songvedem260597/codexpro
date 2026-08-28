import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const worker = await readFile(join(root, "chrome-extension", "service-worker.js"), "utf8");

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

const sendStart = worker.indexOf("if(action==='send_chat_request'){");
const sendEnd = worker.indexOf("if(action==='rename_chat'){", sendStart);
assert.ok(sendStart >= 0 && sendEnd > sendStart, "send_chat_request command block must exist");
const sendBlock = worker.slice(sendStart, sendEnd);
const timeoutCatch = sendBlock.indexOf("}catch(error){");
const networkRecovery = sendBlock.indexOf("waitForNetworkGeneration(tab.id,submitStartedAt-100,5000)", timeoutCatch);
const acknowledgedReturn = sendBlock.indexOf("if(networkAck)return await resultForNetwork", networkRecovery);
const cleanup = sendBlock.indexOf("await cleanupAttempt()", timeoutCatch);
const enterPrimary = sendBlock.indexOf("trustedSubmitChatComposerTab(tab.id,attemptId,text)");
const earlyAck = sendBlock.indexOf("waitForNetworkGeneration(tab.id,submitStartedAt-100,6000)", enterPrimary);
const clickFallback = sendBlock.indexOf("trustedActivateChatSendButtonTab(tab.id,attemptId)", earlyAck);

assert.ok(timeoutCatch >= 0, "DOM send timeout must be handled");
assert.ok(networkRecovery > timeoutCatch, "DOM timeout must check the network tracker");
assert.ok(acknowledgedReturn > networkRecovery, "a tracked generation must count as submitted");
assert.ok(cleanup > acknowledgedReturn, "draft cleanup must only happen after network recovery fails");
assert.ok(enterPrimary >= 0, "trusted Enter must exist in the primary send path");
assert.ok(earlyAck > enterPrimary, "primary Enter must wait for generation ACK before fallback");
assert.ok(clickFallback > earlyAck, "trusted Send click must only occur after the Enter ACK window");
assert.match(sendBlock, /submitted_by:'trusted-enter'/);
assert.match(sendBlock, /submitted_by:'trusted-click-fallback'/);
assert.doesNotMatch(sendBlock, /chrome\.tabs\.update\(tab\.id,\{active:true\}\)/, "background send must not activate the target tab");
assert.doesNotMatch(sendBlock, /restorePreviouslyActiveTab/, "background send must not need to restore tabs because it never activates them");
assert.match(sendBlock, /SEND_UNCERTAIN:/);
assert.match(sendBlock, /shouldUseTrustedClickFallback\(attemptState\?\.result,earlyEvidence\)/, "fallback must require an owned draft and no submit lifecycle evidence");
assert.match(sendBlock, /trustedSubmitError\.startsWith\('TRUSTED_ENTER_PRE_DISPATCH:'\)/, "a pre-dispatch focus failure must be recognized as definitely unsent");
assert.match(sendBlock, /trusted-enter-pre-dispatch','trusted-click-fallback'/, "a definitely-unsent focus failure may use one trusted-click fallback");
assert.match(worker, /expectedText&&normalized\(composerText\)===normalized\(expectedText\)/, "trusted click fallback must recover a React-replaced composer only for an exact owned payload");
assert.match(sendBlock, /cleanup_skipped:!definitelyUnsent/, "ambiguous attempts must not delete a possibly submitted draft");
assert.match(sendBlock, /await chrome\.tabs\.remove\(hungTabId\)/, "a hard renderer hang must close the exact unresponsive tab");
assert.match(sendBlock, /chrome\.tabs\.create\(\{windowId:recoveryWindowId,url:recoveryUrl,active:recoveryActive\}\)/, "hard-hang recovery must reopen the exact conversation URL in the same window");
assert.match(sendBlock, /await chrome\.tabs\.reload\(tab\.id\)/, "a soft pre-submit expiry must reload the exact conversation tab once");
assert.match(sendBlock, /path_attempted:\['prepare',preparationRecovery\.renderer_replaced\?'replace-tab':'reload','prepare'\]/, "pre-submit recovery must expose its bounded recovery path");
assert.match(sendBlock, /submission_state:'failed'.*PREPARE_FAILED:/s, "a second pre-submit failure is definitely unsent, not SEND_UNCERTAIN");
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
assert.match(sendBlock, /waitForAttachmentUploadNetwork\(tab\.id,submitStartedAt-100\)/, "attachment sends must wait for upload network completion before submit");
assert.match(sendBlock, /trustedSubmitChatSendButtonTab\(tab\.id,attemptId\)/, "attachment sends must use one trusted Send click after upload ACK");
assert.match(sendBlock, /submitted_by:'trusted-click-attachment'/, "attachment sends must report their dedicated submit path");
assert.match(worker, /async function trustedSubmitChatSendButtonTab\(tabId,attemptId\)/, "attachment trusted click must install the CDP network tracker before dispatch");
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
assert.match(enterSource, /const \[refocused\]/, "trusted Enter must re-focus the composer after bringing a background page forward");
assert.doesNotMatch(enterSource, /dispatchMouseEvent|composer-submit-button|send-button/, "trusted Enter must not depend on mouse or Send DOM");

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
const responseSource = extractFunction("readChatResponsePage");
assert.match(responseSource, /thinkingPlaceholder/, "DOM fallback must classify the Thinking placeholder as incomplete");
assert.match(responseSource, /generation_in_progress/, "DOM fallback must expose active generation rather than treating it as a completed answer");

console.log("✓ ChatGPT trusted-Enter primary send smoke test passed");
