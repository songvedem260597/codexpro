(() => {
  function isChatGenerationRequest(details) {
    if (details.tabId < 0 || details.method !== 'POST') return false;
    try {
      const url = new URL(details.url);
      const path = url.pathname.replace(/\/+$/, '');
      if (url.hostname !== 'chatgpt.com' && !url.hostname.endsWith('.chatgpt.com')) return false;
      return /\/(?:backend-api|backend-anon)\/(?:f\/)?(?:conversation|steer_turn)$/.test(path)
        || /\/backend-api\/(?:f\/)?(?:codex\/)?responses$/.test(path);
    } catch {
      return false;
    }
  }

  function safeChatRequestEndpoint(value) {
    try {
      const url = new URL(String(value || ''));
      if (url.hostname !== 'chatgpt.com' && !url.hostname.endsWith('.chatgpt.com')) return '';
      return url.pathname.replace(/\/+$/, '') || '/';
    } catch {
      return '';
    }
  }
  function isChatSubmitLifecycleEvidence(item) {
    const endpoint = String(item?.endpoint || '');
    return Boolean(item?.matched_generation)
      || /\/(?:backend-api|backend-anon)\/(?:sentinel\/|(?:f\/)?(?:conversation|steer_turn)|(?:f\/)?(?:codex\/)?responses)/.test(endpoint);
  }

  function isChatSubmissionAckEvidence(item) {
    const endpoint = String(item?.endpoint || '').replace(/\/+$/, '');
    return Boolean(item?.matched_generation)
      || /\/(?:backend-api|backend-anon)\/(?:f\/)?(?:conversation|steer_turn)$/.test(endpoint)
      || /\/backend-api\/(?:f\/)?(?:codex\/)?responses$/.test(endpoint);
  }

  function isAttachmentUploadEndpoint(endpoint) {
    return /\/backend-api\/files(?:\/|$)/.test(String(endpoint || ''));
  }

  function isRecoverableAttachmentUploadAbort(item) {
    return String(item?.endpoint || '') === '/backend-api/files/library/reuse'
      && Number(item?.status_code || 0) === 0
      && /failed$/i.test(String(item?.phase || ''))
      && /(?:net::)?ERR_ABORTED/i.test(String(item?.error || ''));
  }

  function isCompletedAttachmentUpload(item, endpoint) {
    return String(item?.endpoint || '') === endpoint
      && /completed$/i.test(String(item?.phase || ''))
      && Number(item?.status_code) > 0
      && Number(item?.status_code) < 400;
  }

  function shouldUseTrustedClickFallback(attemptState, evidence = []) {
    return Boolean(attemptState?.draft_owned
      && attemptState?.draft_present
      && !evidence.some(isChatSubmissionAckEvidence));
  }

  function decideChatSendPostClick({ attemptState = {}, evidence = [], retryClickCount = 0 } = {}) {
    const generation = (Array.isArray(evidence) ? evidence : []).find(isChatSubmissionAckEvidence);
    if (generation) {
      return { action: 'submitted', acknowledged: true, ack_source: 'generation', generation_endpoint: String(generation.endpoint || ''), retry_allowed: false };
    }
    if (attemptState.generating_after_click === true && attemptState.generating_before_click !== true) {
      return { action: 'submitted', acknowledged: true, ack_source: 'dom-generating', generation_endpoint: '', retry_allowed: false };
    }
    if (attemptState.matching_user_message_after_click === true && attemptState.composer_matches_payload_after_click !== true) {
      return { action: 'submitted', acknowledged: true, ack_source: 'dom-user-message', generation_endpoint: '', retry_allowed: false };
    }
    const retryAllowed = Number(retryClickCount) < 1
      && attemptState.composer_present_after_click === true
      && attemptState.composer_matches_payload_after_click === true
      && attemptState.draft_owned === true
      && attemptState.send_button_ready === true
      && attemptState.send_button_hit_test === true;
    return retryAllowed
      ? { action: 'retry', acknowledged: false, ack_source: '', generation_endpoint: '', retry_allowed: true }
      : { action: 'uncertain', acknowledged: false, ack_source: '', generation_endpoint: '', retry_allowed: false };
  }

  globalThis.CodexProNetworkPolicy = Object.freeze({
    isChatGenerationRequest,
    safeChatRequestEndpoint,
    isChatSubmitLifecycleEvidence,
    isChatSubmissionAckEvidence,
    isAttachmentUploadEndpoint,
    isRecoverableAttachmentUploadAbort,
    isCompletedAttachmentUpload,
    shouldUseTrustedClickFallback,
    decideChatSendPostClick
  });
})();
