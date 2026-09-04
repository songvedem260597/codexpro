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

  globalThis.CodexProNetworkPolicy = Object.freeze({
    isChatGenerationRequest,
    safeChatRequestEndpoint,
    isChatSubmitLifecycleEvidence,
    isChatSubmissionAckEvidence,
    isAttachmentUploadEndpoint,
    isRecoverableAttachmentUploadAbort,
    isCompletedAttachmentUpload,
    shouldUseTrustedClickFallback
  });
})();
