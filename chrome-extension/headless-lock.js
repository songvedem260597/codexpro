(() => {
  'use strict';

  const LOCK_ATTR = 'codexproHeadlessLocked';
  const WORKER_ATTR = 'codexproHeadlessWorkerId';
  const OVERLAY_ID = 'codexpro-headless-lock-warning';
  const BODY_LOCK_ATTR = 'data-codexpro-headless-body-locked';

  function locked() {
    return document.documentElement?.dataset?.[LOCK_ATTR] === '1';
  }

  function restoreBody() {
    const body = document.body;
    if (!body || body.getAttribute(BODY_LOCK_ATTR) !== '1') return;
    body.inert = body.dataset.codexproHeadlessPreviousInert === '1';
    const previousAriaHidden = body.dataset.codexproHeadlessPreviousAriaHidden;
    if (previousAriaHidden === '__missing__') body.removeAttribute('aria-hidden');
    else body.setAttribute('aria-hidden', previousAriaHidden || 'false');
    delete body.dataset.codexproHeadlessPreviousInert;
    delete body.dataset.codexproHeadlessPreviousAriaHidden;
    body.removeAttribute(BODY_LOCK_ATTR);
  }

  function lockBody() {
    const body = document.body;
    if (!body) return;
    if (body.getAttribute(BODY_LOCK_ATTR) !== '1') {
      body.dataset.codexproHeadlessPreviousInert = body.inert ? '1' : '0';
      body.dataset.codexproHeadlessPreviousAriaHidden = body.hasAttribute('aria-hidden')
        ? String(body.getAttribute('aria-hidden') || '')
        : '__missing__';
      body.setAttribute(BODY_LOCK_ATTR, '1');
    }
    body.inert = true;
    body.setAttribute('aria-hidden', 'true');
  }

  function removeOverlay() {
    document.getElementById(OVERLAY_ID)?.remove();
    restoreBody();
  }

  function warningOverlay(workerId) {
    let overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = OVERLAY_ID;
      overlay.setAttribute('role', 'alertdialog');
      overlay.setAttribute('aria-live', 'assertive');
      overlay.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:2147483647',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'padding:24px',
        'box-sizing:border-box',
        'background:rgba(9,13,20,.78)',
        'backdrop-filter:blur(10px)',
        '-webkit-backdrop-filter:blur(10px)',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        'color:#f8fafc',
        'pointer-events:auto'
      ].join(';');

      const card = document.createElement('section');
      card.style.cssText = [
        'width:min(560px,100%)',
        'border:1px solid rgba(255,255,255,.14)',
        'border-radius:20px',
        'background:rgba(19,25,35,.97)',
        'box-shadow:0 28px 80px rgba(0,0,0,.42)',
        'padding:28px',
        'box-sizing:border-box'
      ].join(';');

      const badge = document.createElement('div');
      badge.textContent = 'HEADLESS ĐANG CHẠY';
      badge.style.cssText = 'display:inline-flex;align-items:center;padding:6px 10px;border-radius:999px;background:rgba(245,158,11,.14);border:1px solid rgba(245,158,11,.35);color:#fbbf24;font-size:12px;font-weight:700;letter-spacing:.08em';

      const title = document.createElement('h1');
      title.textContent = 'ChatGPT đang tạm khóa trên profile này';
      title.style.cssText = 'margin:18px 0 10px;font-size:24px;line-height:1.25;font-weight:750;color:#fff';

      const message = document.createElement('p');
      message.dataset.codexproHeadlessMessage = '1';
      message.style.cssText = 'margin:0;color:#dbe4ef;font-size:15px;line-height:1.65';

      const note = document.createElement('div');
      note.textContent = 'Chrome vẫn dùng bình thường. Bạn vẫn có thể duyệt web ở các tab khác, nhưng không thể gửi tin nhắn, tạo task hoặc sử dụng ChatGPT bằng profile này cho đến khi dừng headless trong CodexPro Manager.';
      note.style.cssText = 'margin-top:18px;padding:14px 16px;border-radius:14px;background:rgba(255,255,255,.055);color:#b9c6d6;font-size:13px;line-height:1.6';

      card.append(badge, title, message, note);
      overlay.append(card);
      document.documentElement?.append(overlay);
    }
    const message = overlay.querySelector('[data-codexpro-headless-message="1"]');
    if (message) {
      message.textContent = workerId
        ? `Headless worker ${workerId} đang giữ quyền sử dụng ChatGPT của session này.`
        : 'Một headless worker đang giữ quyền sử dụng ChatGPT của session này.';
    }
    lockBody();
  }

  function publish(result) {
    const root = document.documentElement;
    if (!root) return;
    if (result?.locked === true) {
      root.dataset[LOCK_ATTR] = '1';
      const workerId = String(result?.worker_id || '').trim();
      if (workerId) root.dataset[WORKER_ATTR] = workerId;
      else delete root.dataset[WORKER_ATTR];
      warningOverlay(workerId);
      return;
    }
    root.dataset[LOCK_ATTR] = '0';
    delete root.dataset[WORKER_ATTR];
    removeOverlay();
  }

  async function refresh() {
    try {
      const stored = await chrome.storage.local.get('headlessExclusiveWorkerId');
      const persistedWorkerId = String(stored.headlessExclusiveWorkerId || '').trim();
      if (persistedWorkerId) publish({ locked: true, worker_id: persistedWorkerId });
      const result = await chrome.runtime.sendMessage({ type: 'codexpro-headless-lock-status' });
      if (result?.ok === false) {
        if (persistedWorkerId) publish({ locked: true, worker_id: persistedWorkerId });
        return;
      }
      publish(result);
    } catch {
      // A persisted lock is fail-closed. Never clear it because a status probe failed.
    }
  }

  function blockChatInteraction(event) {
    if (!locked()) return;
    if (event.type === 'keydown') {
      const target = event.target;
      const editing = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target?.isContentEditable === true;
      if (!editing && event.key !== 'Enter') return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  for (const type of ['click', 'pointerdown', 'submit', 'beforeinput', 'paste', 'drop', 'keydown']) {
    document.addEventListener(type, blockChatInteraction, true);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.headlessExclusiveWorkerId || changes.profileId || changes.headlessWorkerId)) void refresh();
  });
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh();
  });

  void refresh();
  const timer = setInterval(() => void refresh(), 300);
  addEventListener('pagehide', () => {
    clearInterval(timer);
    removeOverlay();
  }, { once: true });
})();
