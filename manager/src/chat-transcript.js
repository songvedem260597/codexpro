const TRANSCRIPT_EXCHANGE_LIMIT = 3;
const TRANSCRIPT_MESSAGE_HARD_LIMIT = 12;

function usableMessages(response, conversationId) {
  if (!response || response.conversationId !== conversationId || !Array.isArray(response.messages)) return [];
  return response.messages.filter((message) => String(message?.text || "").trim());
}

export function trimRecentTranscriptMessages(messages) {
  const usable = Array.isArray(messages) ? messages.filter((message) => String(message?.text || "").trim()) : [];
  if (!usable.length) return [];
  const exchanges = [];
  let current = null;
  const orphanAssistants = [];
  const normalized = (value) => String(value || "").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  for (const message of usable) {
    if (message?.role === "user") {
      if (current?.users?.length && current?.assistant) exchanges.push(current);
      if (!current || current.assistant) current = { users: [], assistant: null };
      const text = normalized(message?.text);
      const lastUserText = normalized(current.users.at(-1)?.text);
      if (!lastUserText || lastUserText !== text) current.users.push(message);
      else current.users[current.users.length - 1] = message;
      continue;
    }
    if (message?.role === "assistant") {
      if (current?.users?.length) current.assistant = message;
      else orphanAssistants.push(message);
    }
  }
  if (current?.users?.length) exchanges.push(current);
  if (!exchanges.length) return orphanAssistants.slice(-TRANSCRIPT_EXCHANGE_LIMIT);
  const selectedExchanges = exchanges.slice(-TRANSCRIPT_EXCHANGE_LIMIT);
  const orphanCapacity = Math.max(0, TRANSCRIPT_EXCHANGE_LIMIT - selectedExchanges.length);
  const orphanPrefix = orphanCapacity ? orphanAssistants.slice(-orphanCapacity) : [];
  return [...orphanPrefix, ...selectedExchanges.flatMap((exchange) => exchange.assistant ? [...exchange.users, exchange.assistant] : exchange.users)].slice(-TRANSCRIPT_MESSAGE_HARD_LIMIT);
}

export function materializeTranscriptMessages(response, conversationId) {
  const messages = usableMessages(response, conversationId);
  const fallbackText = String(response?.text || "").trim();
  const fallbackAlreadyPresent = messages.some((message) => message?.role === "assistant" && String(message?.text || "").trim() === fallbackText);
  if (!fallbackText || fallbackAlreadyPresent) return trimRecentTranscriptMessages(messages);
  return trimRecentTranscriptMessages([
    ...messages,
    {
      id: `cached-assistant:${conversationId}`,
      role: "assistant",
      text: fallbackText,
      truncated: Boolean(response?.truncated)
    }
  ]);
}

export function mergeNetworkStreamTranscript(previousMessages, { conversationId, text, truncated = false }) {
  const streamText = String(text || "").trim();
  const messages = Array.isArray(previousMessages) ? [...previousMessages] : [];
  if (!streamText) return trimRecentTranscriptMessages(messages);

  const streamId = `network-stream-assistant:${conversationId}`;
  const streamMessage = { id: streamId, role: "assistant", text: streamText, truncated: Boolean(truncated) };
  const existingIndex = messages.findIndex((message) => message?.id === streamId);
  if (existingIndex >= 0) messages[existingIndex] = { ...messages[existingIndex], ...streamMessage };
  else messages.push(streamMessage);
  return trimRecentTranscriptMessages(messages);
}

export function replaceCanonicalTranscript(previousMessages, incomingMessages) {
  const incoming = Array.isArray(incomingMessages) ? incomingMessages : [];
  if (incoming.length) {
    const comparableText = (value) => String(value || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const canonicalUserTexts = new Set(incoming
      .filter((message) => message?.role === "user")
      .map((message) => comparableText(message?.text))
      .filter(Boolean));
    const previous = Array.isArray(previousMessages) ? previousMessages : [];
    const latestCanonicalUserIndex = incoming.findLastIndex((message) => message?.role === "user");
    const canonicalHasAssistantAfterLatestUser = latestCanonicalUserIndex < 0
      || incoming.slice(latestCanonicalUserIndex + 1).some((message) => message?.role === "assistant");
    if (previous.length && !canonicalHasAssistantAfterLatestUser) {
      const previousKeys = new Set(previous.map((message) => `${message?.role || ""}\u0000${comparableText(message?.text)}`));
      const trailingCanonicalMessages = [];
      let commonIndex = -1;
      for (let index = incoming.length - 1; index >= 0; index -= 1) {
        const message = incoming[index];
        if (previousKeys.has(`${message?.role || ""}\u0000${comparableText(message?.text)}`)) {
          commonIndex = index;
          break;
        }
      }
      if (commonIndex >= 0) {
        for (const message of incoming.slice(commonIndex + 1)) {
          const key = `${message?.role || ""}\u0000${comparableText(message?.text)}`;
          if (!previousKeys.has(key)) trailingCanonicalMessages.push(message);
        }
      }
      return trimRecentTranscriptMessages([...previous, ...trailingCanonicalMessages]);
    }
    const unmaterializedOptimisticUsers = (Array.isArray(previousMessages) ? previousMessages : [])
      .filter((message) => message?.role === "user" && /^(?:optimistic|rollover)-user-/.test(String(message?.id || "")))
      .filter((message) => {
        const text = comparableText(message?.text);
        return text && !canonicalUserTexts.has(text);
      });
    return trimRecentTranscriptMessages([...incoming, ...unmaterializedOptimisticUsers]);
  }
  return trimRecentTranscriptMessages(previousMessages);
}

export function isNetworkStreamCurrentGeneration({ networkStartedAt, streamUpdatedAt }) {
  const generationStartedMs = Date.parse(String(networkStartedAt || ""));
  if (!Number.isFinite(generationStartedMs)) return true;
  const streamUpdatedMs = Date.parse(String(streamUpdatedAt || ""));
  return Number.isFinite(streamUpdatedMs) && streamUpdatedMs >= generationStartedMs;
}
