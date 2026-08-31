export const DOM_FINAL_STABILITY_MS = 2500;

export function confirmChatResponseFinality(previousCandidate, {
  ready = false,
  source = "",
  signature = "",
  nowMs = Date.now(),
  stabilityMs = DOM_FINAL_STABILITY_MS
} = {}) {
  if (!ready) return { confirmed: false, candidate: null, reason: "not_ready" };
  if (String(source || "") !== "chatgpt_dom") return { confirmed: true, candidate: null, reason: "authoritative_source" };
  if (!signature) return { confirmed: false, candidate: null, reason: "missing_signature" };

  const now = Number(nowMs) || Date.now();
  const minimumStableMs = Math.max(0, Number(stabilityMs) || DOM_FINAL_STABILITY_MS);
  if (!previousCandidate || previousCandidate.signature !== signature) {
    return {
      confirmed: false,
      candidate: { signature, firstSeenAt: now, lastSeenAt: now },
      reason: "candidate_started"
    };
  }

  const firstSeenAt = Number(previousCandidate.firstSeenAt) || now;
  const candidate = { signature, firstSeenAt, lastSeenAt: now };
  return {
    confirmed: now - firstSeenAt >= minimumStableMs,
    candidate,
    reason: now - firstSeenAt >= minimumStableMs ? "candidate_stable" : "candidate_waiting"
  };
}
