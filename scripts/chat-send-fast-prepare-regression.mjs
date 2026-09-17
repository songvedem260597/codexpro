import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const FAST_CONTENT = fs.readFileSync(new URL("../chrome-extension/chat-send-fast-content.js", import.meta.url), "utf8");
const CONVERSATION_ID = "6aa6c3ac-11a0-83ec-ac95-6ef7ea109e42";
const OTHER_CONVERSATION_ID = "6aa70cf7-1b48-83ec-b8b1-ff7d92df7b92";
const MESSAGE = "REAL_SEND_READINESS_REGRESSION";

function createFastPrepareHarness({ composerVisible = false, draft = "", attachmentCount = 0 } = {}) {
  let listener = null;
  let visibleNow = Boolean(composerVisible);
  let currentPath = `/c/${CONVERSATION_ID}`;
  let currentAttachmentCount = Number(attachmentCount) || 0;

  const attachmentButton = {
    dataset: {},
    textContent: "attachment",
    getBoundingClientRect() { return { width: 24, height: 24 }; },
    getAttribute() { return "Remove file"; }
  };
  const root = {
    dataset: {},
    querySelectorAll() { return Array.from({ length: currentAttachmentCount }, () => attachmentButton); }
  };
  const composer = {
    id: "prompt-textarea",
    dataset: {},
    isContentEditable: true,
    innerText: String(draft),
    textContent: String(draft),
    parentElement: root,
    focus() {},
    closest(selector) { return selector === "form" ? root : null; },
    querySelector() { return null; },
    dispatchEvent() {},
    getBoundingClientRect() { return { width: 640, height: 48 }; }
  };
  const selection = { removeAllRanges() {}, addRange() {} };
  const location = {
    origin: "https://chatgpt.com",
    get pathname() { return currentPath; },
    get href() { return `https://chatgpt.com${currentPath}`; }
  };
  const document = {
    title: "Historical conversation",
    querySelector(selector) {
      if (!visibleNow) return null;
      return selector === "#prompt-textarea" ? composer : null;
    },
    querySelectorAll(selector) {
      if (selector === "button,a,[role=\"button\"]") return [];
      if (selector === "[data-message-author-role=\"user\"]") return [];
      return [];
    },
    createRange() { return { selectNodeContents() {}, collapse() {} }; },
    createTextNode(value) { return { textContent: String(value) }; },
    execCommand(command, _showUi, value) {
      if (command === "insertText") {
        composer.textContent = String(value || "");
        composer.innerText = composer.textContent;
        return true;
      }
      if (command === "delete") {
        composer.textContent = "";
        composer.innerText = "";
        return true;
      }
      return false;
    }
  };
  const chrome = {
    runtime: {
      id: "codexpro-regression-extension",
      onMessage: { addListener(fn) { listener = fn; } }
    }
  };
  class InputEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }
  class Event { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }
  class HTMLTextAreaElement {}
  class HTMLInputElement {}
  const context = vm.createContext({
    chrome,
    document,
    location,
    window: { getSelection: () => selection },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    InputEvent,
    Event,
    HTMLTextAreaElement,
    HTMLInputElement,
    setTimeout,
    clearTimeout,
    Date,
    Promise,
    console
  });
  context.globalThis = context;
  vm.runInContext(FAST_CONTENT, context, { filename: "chat-send-fast-content.js" });
  assert.equal(typeof listener, "function", "fast prepare content script must register its message listener");

  const prepare = (deadlineAt, overrides = {}) => new Promise((resolve, reject) => {
    let settled = false;
    const sendResponse = (value) => { settled = true; resolve(value); };
    const asyncResponse = listener({
      type: "codexpro:prepare-chat-text-v1",
      payload: {
        text: MESSAGE,
        attempt_id: "attempt-readiness-regression",
        deadline_at: deadlineAt,
        stale_attachment_ownership: null,
        expected_conversation_id: CONVERSATION_ID,
        ...overrides
      }
    }, { id: chrome.runtime.id }, sendResponse);
    if (asyncResponse !== true && !settled) reject(new Error("fast prepare listener did not retain the response channel"));
  });

  return {
    setComposerVisible(value) { visibleNow = Boolean(value); },
    setPath(value) { currentPath = String(value); },
    setAttachmentCount(value) { currentAttachmentCount = Number(value) || 0; },
    prepare,
    composer,
    root
  };
}

function assertPrepareFailure(result, label) {
  assert.equal(result?.ok, false, `${label} must fail prepare`);
  assert.notEqual(result?.requires_trusted_submit, true, `${label} must never authorize trusted submit`);
}

async function runHistoricalReopenReadinessRace() {
  const harness = createFastPrepareHarness();
  const startedAt = Date.now();
  const deadlineAt = startedAt + 4_000;
  // Real incident shape: correct historical URL is open, but composer appears only
  // after the old 900 ms retry window and before the legitimate prepare deadline.
  const revealTimer = setTimeout(() => harness.setComposerVisible(true), 1_250);
  try {
    let result = await harness.prepare(deadlineAt);
    if (!result?.ok && /Không tìm thấy ô nhập đang hiển thị/i.test(String(result?.error || ""))) {
      await new Promise((resolve) => setTimeout(resolve, 900));
      result = await harness.prepare(deadlineAt);
    }
    return { result, elapsedMs: Date.now() - startedAt };
  } finally {
    clearTimeout(revealTimer);
  }
}

const immediateHarness = createFastPrepareHarness({ composerVisible: true });
const immediateStartedAt = Date.now();
const immediate = await immediateHarness.prepare(immediateStartedAt + 2_000);
assert.equal(immediate?.ok, true, "already-visible composer must prepare immediately");
assert.ok(Date.now() - immediateStartedAt < 500, "already-visible composer must not incur readiness sleep");
assert.equal(immediate?.requires_trusted_submit, true);

const delayed = await runHistoricalReopenReadinessRace();
assert.equal(
  delayed.result?.ok,
  true,
  `historical reopen must wait for composer readiness within the bounded deadline; got ${JSON.stringify(delayed.result)}`
);
assert.ok(delayed.elapsedMs >= 1_150, `composer should become ready late, not immediately (elapsed=${delayed.elapsedMs}ms)`);
assert.ok(delayed.elapsedMs < 4_000, `composer readiness must remain bounded by the operation deadline (elapsed=${delayed.elapsedMs}ms)`);
assert.equal(delayed.result?.prepared, true);
assert.equal(delayed.result?.composer_prepared, true);
assert.equal(delayed.result?.requires_trusted_submit, true);
assert.ok(Number(delayed.result?.prepare_step_ms?.composer_wait_ms) >= 1_100, "traceable prepare timing must include readiness wait");

const changedHarness = createFastPrepareHarness();
const changedTimer = setTimeout(() => changedHarness.setPath(`/c/${OTHER_CONVERSATION_ID}`), 150);
const changedStartedAt = Date.now();
const changed = await changedHarness.prepare(changedStartedAt + 2_000);
clearTimeout(changedTimer);
assertPrepareFailure(changed, "conversation-change while waiting");
assert.equal(changed?.target_changed, true, "conversation change must abort readiness wait");
assert.match(String(changed?.error || ""), /CONVERSATION_CHANGED/);
assert.ok(Date.now() - changedStartedAt < 1_000, "conversation change must abort promptly instead of waiting for deadline");

const expiryHarness = createFastPrepareHarness();
const expiryStartedAt = Date.now();
const expired = await expiryHarness.prepare(expiryStartedAt + 250);
assertPrepareFailure(expired, "operation expiry while waiting");
assert.equal(expired?.expired, true, "operation deadline must terminate readiness wait");
assert.ok(Date.now() - expiryStartedAt < 1_000, "expired operation must not wait for the 5s readiness cap");

const neverHarness = createFastPrepareHarness();
const neverStartedAt = Date.now();
const never = await neverHarness.prepare(neverStartedAt + 7_000);
assertPrepareFailure(never, "composer never appears");
assert.match(String(never?.error || ""), /Không tìm thấy ô nhập/);
assert.ok(Number(never?.composer_wait_ms) >= 4_800, "missing composer must wait for the bounded readiness condition, not fail instantly");
assert.ok(Date.now() - neverStartedAt < 6_000, "missing composer wait must remain bounded by the 5s readiness cap");

const draftHarness = createFastPrepareHarness({ composerVisible: true, draft: "USER DRAFT MUST SURVIVE" });
const draft = await draftHarness.prepare(Date.now() + 2_000);
assertPrepareFailure(draft, "existing user draft");
assert.match(String(draft?.error || ""), /bản nháp khác/);
assert.equal(draftHarness.composer.textContent, "USER DRAFT MUST SURVIVE", "existing draft must not be overwritten or cleared");

const staleAttachmentHarness = createFastPrepareHarness();
const staleAttachment = await staleAttachmentHarness.prepare(Date.now() + 2_000, {
  stale_attachment_ownership: { attempt_id: "older-attempt" }
});
assertPrepareFailure(staleAttachment, "stale attachment ownership");
assert.equal(staleAttachment?.fallback_required, true, "stale attachment ownership must stay on full-prepare fallback path");

const attachmentHarness = createFastPrepareHarness({ composerVisible: true, attachmentCount: 1 });
const attachment = await attachmentHarness.prepare(Date.now() + 2_000);
assertPrepareFailure(attachment, "existing attachment");
assert.match(String(attachment?.error || ""), /file chưa gửi/);

console.log(`chat-send-fast-prepare regression PASS; delayed readiness=${delayed.elapsedMs} ms`);
