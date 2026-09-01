export const DOM_FINAL_STABILITY_MS = 2500;

export function hasStrongerNetworkStreamEvidence(audit, {
  networkStartedAt = "",
  streamUpdatedAt = ""
} = {}) {
  const dom = audit?.chatgpt_dom;
  const stream = audit?.network_stream;
  if (!dom?.available || !stream?.available) return false;
  const domAssistant = dom.assistant_after_latest_user || dom.latest_assistant;
  const streamAssistant = stream.assistant_after_latest_user || stream.latest_assistant;
  const domLength = Math.max(0, Number(domAssistant?.length) || 0);
  const streamLength = Math.max(0, Number(streamAssistant?.length) || 0);
  if (!streamLength || streamLength <= domLength) return false;

  const generationStartedMs = Date.parse(String(networkStartedAt || ""));
  if (Number.isFinite(generationStartedMs)) {
    const streamUpdatedMs = Date.parse(String(streamUpdatedAt || ""));
    if (!Number.isFinite(streamUpdatedMs) || streamUpdatedMs < generationStartedMs) return false;
  }

  return streamLength >= Math.max(domLength + 24, Math.ceil(domLength * 1.5)) && domLength < 160;
}

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
