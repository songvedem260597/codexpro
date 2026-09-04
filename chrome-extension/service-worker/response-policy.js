(() => {
  function canonicalResponseSupersedesDom(canonical, domResult) {
    if (!canonical?.ok) return false;
    const hasAssistantAfterLatestUser = (messages) => {
      const usable = Array.isArray(messages) ? messages : [];
      const latestUserIndex = usable.findLastIndex((message) => message?.role === 'user');
      return latestUserIndex >= 0 && usable.slice(latestUserIndex + 1).some((message) => message?.role === 'assistant' && String(message?.text || '').trim());
    };
    const canonicalHasResponse = Boolean(canonical.response_ready || hasAssistantAfterLatestUser(canonical.messages));
    const domHasResponse = hasAssistantAfterLatestUser(domResult?.messages);
    if (domHasResponse && !canonicalHasResponse) return false;
    const canonicalText = String(canonical.text || '').trim();
    const domText = String(domResult?.text || '').trim();
    if (domHasResponse && canonicalHasResponse && domText.length > canonicalText.length) return false;
    return canonicalHasResponse || canonicalText.length > domText.length;
  }

  function shouldReloadChatRecovery(options) {
    const {
      connectionInterrupted = false,
      messageDeliveryTimedOut = false,
      staleContent = false,
      networkBusy = false,
      canonicalReady = false,
      rendererTimedOut = false
    } = options || {};
    if (rendererTimedOut) return true;
    if (networkBusy) return false;
    if (messageDeliveryTimedOut || connectionInterrupted) return true;
    if (staleContent && canonicalReady) return true;
    return false;
  }

  function mergeChatRecoveryResponse(checkpoint, incoming) {
    const before = checkpoint && typeof checkpoint === 'object' ? checkpoint : {};
    const after = incoming && typeof incoming === 'object' ? incoming : {};
    const normalized = (value) => String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const progressiveText = (previousValue, incomingValue) => {
      const previous = String(previousValue || '').trim();
      const next = String(incomingValue || '').trim();
      if (!previous) return next;
      if (!next) return previous;
      const previousComparable = normalized(previous);
      const nextComparable = normalized(next);
      if (previousComparable === nextComparable) return next.length >= previous.length ? next : previous;
      if (nextComparable.includes(previousComparable)) return next;
      if (previousComparable.includes(nextComparable)) return previous;
      const maximumOverlap = Math.min(previous.length, next.length);
      const minimumOverlap = Math.min(12, maximumOverlap);
      for (let size = maximumOverlap; size >= minimumOverlap; size -= 1) {
        if (previous.slice(-size) === next.slice(0, size)) return previous + next.slice(size);
      }
      return next.length > previous.length ? next : previous;
    };
    const previousMessages = Array.isArray(before.messages) ? before.messages.filter((message) => String(message?.text || '').trim()) : [];
    const incomingMessages = Array.isArray(after.messages) ? after.messages.filter((message) => String(message?.text || '').trim()) : [];
    let messages = incomingMessages.length ? [...incomingMessages] : [...previousMessages];
    if (incomingMessages.length && previousMessages.length) {
      messages = messages.map((message, index) => {
        if (message?.role !== 'assistant') return message;
        const userIndex = messages.slice(0, index).findLastIndex((candidate) => candidate?.role === 'user');
        const userText = normalized(messages[userIndex]?.text);
        let previousUserIndex = -1;
        for (let cursor = previousMessages.length - 1; cursor >= 0; cursor -= 1) {
          if (previousMessages[cursor]?.role === 'user' && normalized(previousMessages[cursor]?.text) === userText) {
            previousUserIndex = cursor;
            break;
          }
        }
        if (previousUserIndex < 0) return message;
        const nextUserIndex = previousMessages.findIndex((candidate, cursor) => cursor > previousUserIndex && candidate?.role === 'user');
        const turnEnd = nextUserIndex < 0 ? previousMessages.length : nextUserIndex;
        const previousAssistant = previousMessages.slice(previousUserIndex + 1, turnEnd).findLast((candidate) => candidate?.role === 'assistant');
        if (!previousAssistant) return message;
        return {
          ...message,
          id: previousAssistant.id || message.id,
          text: progressiveText(previousAssistant.text, message.text),
          truncated: Boolean(previousAssistant.truncated && message.truncated)
        };
      });
      const incomingLatestUserIndex = messages.findLastIndex((message) => message?.role === 'user');
      const incomingHasAssistant = incomingLatestUserIndex < 0 || messages.slice(incomingLatestUserIndex + 1).some((message) => message?.role === 'assistant');
      const previousLatestUserIndex = previousMessages.findLastIndex((message) => message?.role === 'user');
      const sameLatestUser = incomingLatestUserIndex >= 0
        && previousLatestUserIndex >= 0
        && normalized(messages[incomingLatestUserIndex]?.text) === normalized(previousMessages[previousLatestUserIndex]?.text);
      if (sameLatestUser && !incomingHasAssistant && previousMessages.slice(previousLatestUserIndex + 1).some((message) => message?.role === 'assistant')) {
        messages = [...previousMessages];
      }
    }
    messages = messages.slice(-12);
    const latestAssistant = [...messages].reverse().find((message) => message?.role === 'assistant');
    const text = progressiveText(before.text, latestAssistant?.text || after.text);
    const checkpointApplied = text !== String(after.text || '').trim()
      || messages.length !== incomingMessages.length
      || messages.some((message, index) => message?.text !== incomingMessages[index]?.text);
    return {
      ...before,
      ...after,
      text,
      text_length: text.length,
      messages,
      message_count: messages.filter((message) => message?.role === 'assistant').length,
      total_message_count: messages.length,
      response_checkpoint_applied: checkpointApplied
    };
  }

  function responseAuditTextSummary(value) {
    const text = String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return { fingerprint: `${text.length}:${(hash >>> 0).toString(16).padStart(8, '0')}`, length: text.length, preview: text.slice(-180) };
  }

  function responseAuditSnapshot(source, payload, available) {
    const messages = (Array.isArray(payload?.messages) ? payload.messages : []).filter((message) => ['user', 'assistant'].includes(message?.role) && String(message?.text || '').trim());
    const latestUserIndex = messages.findLastIndex((message) => message.role === 'user');
    const assistantAfterLatestUser = latestUserIndex >= 0 ? messages.slice(latestUserIndex + 1).findLast((message) => message.role === 'assistant') : messages.findLast((message) => message.role === 'assistant');
    return {
      source,
      available: Boolean(available),
      response_ready: payload?.response_ready === true,
      busy: payload?.busy === true,
      message_count: messages.length,
      latest_user: responseAuditTextSummary(messages.findLast((message) => message.role === 'user')?.text),
      latest_assistant: responseAuditTextSummary(messages.findLast((message) => message.role === 'assistant')?.text),
      assistant_after_latest_user: responseAuditTextSummary(assistantAfterLatestUser?.text),
      error: String(payload?.error || '').slice(0, 500),
      updated_at: String(payload?.updated_at || '')
    };
  }

  function withResponseAudit(result, { dom = null, canonical = null, networkStream = null } = {}) {
    return {
      ...result,
      response_audit: {
        schema_version: 1,
        selected_source: String(result?.response_source || ''),
        chatgpt_dom: responseAuditSnapshot('chatgpt_dom', dom, Boolean(dom?.ok)),
        canonical_api: responseAuditSnapshot('canonical_api', canonical, Boolean(canonical?.ok)),
        network_stream: responseAuditSnapshot('network_stream', networkStream, Boolean(networkStream?.available))
      }
    };
  }

  globalThis.CodexProResponsePolicy = Object.freeze({
    canonicalResponseSupersedesDom,
    shouldReloadChatRecovery,
    mergeChatRecoveryResponse,
    responseAuditTextSummary,
    responseAuditSnapshot,
    withResponseAudit
  });
})();
