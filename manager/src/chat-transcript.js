const TRANSCRIPT_LIMIT = 20;

function usableMessages(response, conversationId) {
  if (!response || response.conversationId !== conversationId || !Array.isArray(response.messages)) return [];
  return response.messages.filter((message) => String(message?.text || "").trim());
}

export function materializeTranscriptMessages(response, conversationId) {
  const messages = usableMessages(response, conversationId);
  const fallbackText = String(response?.text || "").trim();
  const fallbackAlreadyPresent = messages.some((message) => message?.role === "assistant" && String(message?.text || "").trim() === fallbackText);
  if (!fallbackText || fallbackAlreadyPresent) return messages.slice(-TRANSCRIPT_LIMIT);
  return [
    ...messages,
    {
      id: `cached-assistant:${conversationId}`,
      role: "assistant",
      text: fallbackText,
      truncated: Boolean(response?.truncated)
    }
  ].slice(-TRANSCRIPT_LIMIT);
}

export function mergeNetworkStreamTranscript(previousMessages, { conversationId, text, truncated = false }) {
  const streamText = String(text || "").trim();
  const messages = Array.isArray(previousMessages) ? [...previousMessages] : [];
  if (!streamText) return messages.slice(-TRANSCRIPT_LIMIT);

  const streamId = `network-stream-assistant:${conversationId}`;
  const streamMessage = { id: streamId, role: "assistant", text: streamText, truncated: Boolean(truncated) };
  const existingIndex = messages.findIndex((message) => message?.id === streamId);
  if (existingIndex >= 0) messages[existingIndex] = { ...messages[existingIndex], ...streamMessage };
  else messages.push(streamMessage);
  return messages.slice(-TRANSCRIPT_LIMIT);
}

export function replaceCanonicalTranscript(previousMessages, incomingMessages) {
  const incoming = Array.isArray(incomingMessages) ? incomingMessages : [];
  if (incoming.length) return incoming.slice(-TRANSCRIPT_LIMIT);
  return Array.isArray(previousMessages) ? previousMessages.slice(-TRANSCRIPT_LIMIT) : [];
}
