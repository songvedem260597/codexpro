(() => {
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
    isChatSubmitLifecycleEvidence,
    isChatSubmissionAckEvidence,
    isAttachmentUploadEndpoint,
    isRecoverableAttachmentUploadAbort,
    isCompletedAttachmentUpload,
    shouldUseTrustedClickFallback
  });
})();
