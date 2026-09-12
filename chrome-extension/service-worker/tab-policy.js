(() => {
  function conversationIdFromUrl(value) {
    try {
      return new URL(String(value || '')).pathname.match(/^\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || '';
    } catch {
      return '';
    }
  }

  function isChatGptTabUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return url.origin === 'https://chatgpt.com';
    } catch {
      return false;
    }
  }

  function safeTabAuditUrl(value) {
    try {
      const url = new URL(String(value || ''));
      if (url.origin !== 'https://chatgpt.com') return '';
      return `${url.origin}${url.pathname}`;
    } catch {
      return '';
    }
  }

  function tabAuditTabRecord(tab, urlOverride = '') {
    const url = safeTabAuditUrl(urlOverride || tab?.url || '');
    return {
      tab_id: Number.isInteger(tab?.id) ? tab.id : 0,
      window_id: Number.isInteger(tab?.windowId) ? tab.windowId : 0,
      url,
      conversation_id: conversationIdFromUrl(url),
      active: Boolean(tab?.active),
      status: String(tab?.status || '')
    };
  }

  async function resolveChatSendTab(options = {}) {
    const conversationId = String(options.conversationId || '').trim();
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const startedAt = now();
    const getTab = options.getTab;
    const queryTabs = options.queryTabs;
    const recentConversationList = options.recentConversationList;
    const createTab = options.createTab;
    const waitForTab = options.waitForTab;
    const isExcluded = typeof options.isExcluded === 'function' ? options.isExcluded : () => false;
    const rememberBinding = typeof options.rememberBinding === 'function' ? options.rememberBinding : () => {};
    let bindingValidationMs = 0;
    const result = (tab, source, bindingHit = false, bindingSource = '') => {
      if (tab?.id) rememberBinding(conversationId, tab.id);
      return {
        tab,
        resolution_source: source,
        binding_hit: bindingHit,
        binding_source: bindingSource,
        binding_validation_ms: bindingValidationMs,
        find_tab_ms: Math.max(0, now() - startedAt)
      };
    };
    const matches = tab => Boolean(tab?.id && !isExcluded(tab) && conversationIdFromUrl(tab.url) === conversationId);
    const bindingIds = [...new Set([Number(options.requestedId), Number(options.boundId)].filter(Number.isInteger))];
    for (const tabId of bindingIds) {
      const validationStartedAt = now();
      let candidate = null;
      try { candidate = await getTab(tabId); } catch {}
      bindingValidationMs += Math.max(0, now() - validationStartedAt);
      if (matches(candidate)) return result(candidate, 'binding', true, tabId === Number(options.requestedId) ? 'target_id' : 'conversation_binding');
    }
    const tabs = await queryTabs();
    const candidates = (Array.isArray(tabs) ? tabs : []).filter(matches);
    const openTab = candidates.find(tab => tab.active) || candidates[0];
    if (openTab) return result(openTab, 'open-tab');
    const recent = await recentConversationList(3);
    if (!recent.some(conversation => String(conversation?.id || '') === conversationId)) {
      throw new Error('Đoạn chat không còn thuộc 3 chat gần nhất của profile này.');
    }
    let created = await createTab(conversationId);
    if (!created?.id) throw new Error('Không thể mở lại tab ChatGPT của đoạn chat này.');
    await waitForTab(created.id);
    created = await getTab(created.id);
    if (!matches(created)) throw new Error('CONVERSATION_TAB_VERIFY_FAILED: Tab mở lại không khớp conversation cần gửi.');
    return result(created, 'recent-history-reopen');
  }

  function planChatTabCleanup(tabs, options = {}) {
    const maxTabs = Math.max(1, Number(options.maxTabs) || 1);
    const healthFailuresToClose = Math.max(1, Number(options.healthFailuresToClose) || 1);
    const recentIds = new Set((Array.isArray(options.recentConversationIds) ? options.recentConversationIds : []).map(String));
    const managed = (Array.isArray(tabs) ? tabs : []).filter(tab => Number.isInteger(tab?.id) && isChatGptTabUrl(tab?.url));
    const protectedTab = tab => Boolean(tab.active || tab.pinned || tab.audible || tab.status === 'loading' || tab.busy || tab.settling || tab.pending);
    const closable = managed.filter(tab => !protectedTab(tab));
    const oldest = (left, right) => Number(left.last_accessed || 0) - Number(right.last_accessed || 0) || Number(left.id) - Number(right.id);
    const planned = [];
    const reasons = {};

    for (const tab of closable.filter(tab => Number(tab.health_failures || 0) >= healthFailuresToClose).sort(oldest)) {
      planned.push(tab.id);
      reasons[tab.id] = 'codexpro_unreachable';
    }

    let remaining = managed.length - planned.length;
    const overflow = Math.max(0, remaining - maxTabs);
    if (overflow) {
      const candidates = closable.filter(tab => !planned.includes(tab.id)).sort((left, right) => {
        const leftConversation = conversationIdFromUrl(left.url);
        const rightConversation = conversationIdFromUrl(right.url);
        const leftPriority = !leftConversation ? 0 : recentIds.has(leftConversation) ? 2 : 1;
        const rightPriority = !rightConversation ? 0 : recentIds.has(rightConversation) ? 2 : 1;
        return leftPriority - rightPriority || oldest(left, right);
      });
      for (const tab of candidates.slice(0, overflow)) {
        planned.push(tab.id);
        reasons[tab.id] = 'tab_limit';
        remaining -= 1;
      }
    }

    return {
      close_ids: planned,
      reasons,
      managed_count: managed.length,
      remaining_count: remaining,
      max_tabs: maxTabs
    };
  }

  globalThis.CodexProTabPolicy = Object.freeze({
    conversationIdFromUrl,
    isChatGptTabUrl,
    safeTabAuditUrl,
    tabAuditTabRecord,
    resolveChatSendTab,
    planChatTabCleanup
  });
})();
