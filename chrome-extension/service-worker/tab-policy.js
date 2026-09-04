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
    planChatTabCleanup
  });
})();
