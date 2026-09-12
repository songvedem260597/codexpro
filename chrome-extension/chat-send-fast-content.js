(() => {
  if (globalThis.__codexproChatSendFastContentV1Installed) return;
  globalThis.__codexproChatSendFastContentV1Installed = true;

  const normalize = (value) => String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^@\s*(?=CodexPro\b)/i, '')
    .trim();
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const composerText = (element) => element?.isContentEditable
    ? String(element.innerText || element.textContent || '')
    : String(element?.value || '');
  const findComposer = () => [
    '#prompt-textarea',
    '[contenteditable="true"][data-lexical-editor="true"]',
    'textarea[data-id="root"]',
    'textarea[placeholder]'
  ].map((selector) => document.querySelector(selector)).find(visible);
  const rootFor = (composer) => composer?.closest('form')
    || composer?.closest('[data-type="unified-composer"]')
    || composer?.parentElement;
  const attachmentButtons = (root) => Array.from((root || document).querySelectorAll(
    'button[aria-label*="Remove file" i],button[aria-label*="Remove attachment" i],button[aria-label*="Xóa tệp" i],button[aria-label*="Xóa file" i]'
  )).filter(visible);
  const targetMatches = (expectedConversationId) => expectedConversationId === null
    || (expectedConversationId ? location.pathname === `/c/${expectedConversationId}` : location.pathname === '/');
  const clearOwnedText = (composer) => {
    composer.focus({ preventScroll: true });
    let nativeInputDispatched = false;
    if (composer.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      selection.removeAllRanges();
      selection.addRange(range);
      nativeInputDispatched = document.execCommand('delete', false);
      if (!nativeInputDispatched) composer.textContent = '';
    } else {
      const proto = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(composer, ''); else composer.value = '';
    }
    if (!nativeInputDispatched) composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
  };

  async function prepareChatTextRequestPage(payload = {}) {
    const prepareStartedAt = Date.now();
    const prepareSteps = {};
    const text = String(payload.text || '');
    const attemptId = String(payload.attempt_id || '');
    const deadlineAt = Number(payload.deadline_at) || 0;
    const expectedConversationId = payload.expected_conversation_id === null
      ? null
      : String(payload.expected_conversation_id || '');
    const expired = () => Boolean(deadlineAt && Date.now() > deadlineAt);
    if (!attemptId || expired()) return { ok: false, error: 'Lần chuẩn bị text đã hết hạn trước khi chạy.', expired: true, cleanup_skipped: true };
    if (location.origin !== 'https://chatgpt.com' || !targetMatches(expectedConversationId)) {
      return { ok: false, error: 'CONVERSATION_CHANGED: Tab không còn ở đúng conversation.', target_changed: true, cleanup_skipped: true };
    }
    if (payload.stale_attachment_ownership) return { ok: false, fallback_required: true, error: 'Cần đường prepare đầy đủ để dọn attachment cũ.' };

    const limitPattern = /(?:you(?:'|’)?ve reached the maximum length for this conversation|maximum length for this conversation|đ(?:ã|a) (?:đạt|chạm|tới).*?(?:độ dài|do dai).*?(?:tối đa|toi da).*?(?:cuộc trò chuyện|đoạn chat))/i;
    const startNewChatPattern = /(?:start new chat|bắt đầu (?:một )?(?:cuộc trò chuyện|đoạn chat) mới)/i;
    for (const control of document.querySelectorAll('button,a,[role="button"]')) {
      const label = String(control.textContent || control.getAttribute?.('aria-label') || '').trim();
      if (!startNewChatPattern.test(label) || !visible(control)) continue;
      let node = control;
      for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
        const message = String(node.textContent || '').replace(/\u200b/g, '').trim();
        if (message.length <= 1400 && limitPattern.test(message)) {
          return { ok: false, error: `CONVERSATION_LIMIT_REACHED: ${message}`, conversation_limit_reached: true, conversation_limit_message: message, cleanup_skipped: true };
        }
      }
    }
    prepareSteps.limit_scan_ms = Date.now() - prepareStartedAt;

    let composer = findComposer();
    if (!composer) return { ok: false, error: 'Không tìm thấy ô nhập đang hiển thị trong đoạn chat.' };
    let root = rootFor(composer);
    const staleAttemptId = String(composer.dataset.codexproDraftAttempt || root?.dataset?.codexproAttachmentAttempt || '');
    if (staleAttemptId && staleAttemptId !== attemptId) {
      const current = normalize(composerText(composer));
      const marked = normalize(composer.dataset.codexproDraftText || '');
      if (attachmentButtons(root).length || current && (!marked || current !== marked)) {
        return { ok: false, fallback_required: true, error: 'Cần đường prepare đầy đủ để kiểm tra draft/attachment cũ.' };
      }
      if (current) clearOwnedText(composer);
      delete composer.dataset.codexproDraftAttempt;
      delete composer.dataset.codexproDraftText;
      composer = findComposer();
      root = rootFor(composer);
    }
    if (!composer || expired() || !targetMatches(expectedConversationId)) {
      return { ok: false, error: 'Lần chuẩn bị hết hạn hoặc composer đã đổi.', expired: expired(), cleanup_skipped: true };
    }
    const draft = normalize(composerText(composer));
    const ownedDraft = Boolean(draft && composer.dataset.codexproDraftAttempt === attemptId && draft === normalize(text));
    if (draft && !ownedDraft) return { ok: false, error: 'Ô ChatGPT đang có một bản nháp khác. CodexPro không ghi đè bản nháp của người dùng.' };
    if (attachmentButtons(root).length) return { ok: false, error: 'Ô chat đang có file chưa gửi; CodexPro không ghi đè file/bản nháp có sẵn.' };
    prepareSteps.composer_guard_ms = Date.now() - prepareStartedAt - prepareSteps.limit_scan_ms;

    const inputStartedAt = Date.now();
    if (text && !ownedDraft) {
      composer.focus({ preventScroll: true });
      composer.dataset.codexproDraftAttempt = attemptId;
      composer.dataset.codexproDraftText = text;
      let nativeInputDispatched = false;
      if (composer.isContentEditable) {
        const selection = window.getSelection();
        const range = document.createRange();
        if (composer.querySelector('[data-inline-selection-pill]')) {
          const paragraph = composer.querySelector('p:last-child') || composer;
          range.selectNodeContents(paragraph);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
          nativeInputDispatched = document.execCommand('insertText', false, ` ${text}`);
          if (!nativeInputDispatched) paragraph.append(document.createTextNode(` ${text}`));
        } else {
          range.selectNodeContents(composer);
          selection.removeAllRanges();
          selection.addRange(range);
          nativeInputDispatched = document.execCommand('insertText', false, text);
          if (!nativeInputDispatched) composer.textContent = text;
        }
      } else {
        const proto = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(composer, text); else composer.value = text;
      }
      if (!nativeInputDispatched) composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
    prepareSteps.input_ms = Date.now() - inputStartedAt;

    const verifyStartedAt = Date.now();
    const verifyDeadline = Math.min(deadlineAt || Date.now() + 1000, Date.now() + 1000);
    while (!expired() && Date.now() < verifyDeadline) {
      const current = findComposer();
      if (normalize(composerText(current)) === normalize(text)) { composer = current; break; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!composer || normalize(composerText(composer)) !== normalize(text)) {
      return { ok: false, error: 'ChatGPT chưa nhận đúng nội dung vào composer; chưa gửi để tránh báo thành công giả.', expired: expired() };
    }
    prepareSteps.verify_ms = Date.now() - verifyStartedAt;
    composer.dataset.codexproDraftAttempt = attemptId;
    composer.dataset.codexproDraftText = text;
    composer.dataset.codexproSubmitAttempt = attemptId;
    const matchingUserMessageCountBefore = Array.from(document.querySelectorAll('[data-message-author-role="user"]'))
      .filter((node) => normalize(node.textContent || '') === normalize(text)).length;
    prepareSteps.baseline_ms = Date.now() - verifyStartedAt - prepareSteps.verify_ms;
    return {
      ok: true,
      title: document.title,
      url: location.href,
      length: text.length,
      attachment_count: 0,
      attachment_names: [],
      attachment_labels: [],
      existing_attachment_count: 0,
      attachment_prepare_path: '',
      attachment_reused: false,
      stale_owned_cleanup: null,
      prepared: true,
      composer_prepared: true,
      requires_trusted_submit: true,
      matching_user_message_count_before: matchingUserMessageCountBefore,
      internal_submit_found: false,
      internal_submit_reason: 'Composer payload đã được xác minh; dùng visible Send button với trusted CDP click.',
      submitted: false,
      submitted_by: 'prepared',
      attempt_id: attemptId,
      prepare_transport: 'content-message',
      prepare_step_ms: { ...prepareSteps, total_ms: Date.now() - prepareStartedAt }
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender?.id !== chrome.runtime.id || message?.type !== 'codexpro:prepare-chat-text-v1') return undefined;
    Promise.resolve(prepareChatTextRequestPage(message.payload))
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  });
})();
