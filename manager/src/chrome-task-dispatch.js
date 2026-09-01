export function classifyChromeTaskDispatch(result = {}) {
  const conversationId = String(result?.conversation_id || "").trim();
  const submissionState = String(result?.submission_state || (result?.network_acknowledged ? "submitted" : "")).trim().toLowerCase();

  if (submissionState === "failed") {
    return {
      accepted: false,
      pending: false,
      conversationId,
      error: String(result?.error || "Chrome worker chưa gửi được task.")
    };
  }

  if (submissionState === "uncertain" || result?.send_uncertain === true) {
    return {
      accepted: false,
      pending: false,
      conversationId,
      error: String(result?.error || "Chrome worker chưa xác nhận task đã được gửi.")
    };
  }

  const accepted = Boolean(
    conversationId
    || result?.submitted === true
    || result?.network_acknowledged === true
    || submissionState === "submitted"
  );
  const pending = accepted && !conversationId && result?.conversation_pending === true;

  return {
    accepted,
    pending,
    conversationId,
    error: accepted ? "" : "Chrome worker chưa xác nhận task đã được gửi."
  };
}
