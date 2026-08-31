const TRANSCRIPT_EXCHANGE_LIMIT = 3;
const TRANSCRIPT_MESSAGE_HARD_LIMIT = 12;
const OPTIMISTIC_SUBMISSION_TTL_MS = 10 * 60 * 1000;

function messageHasContent(message) {
  return Boolean(String(message?.text || "").trim() || (Array.isArray(message?.images) && message.images.length));
}

function usableMessages(response, conversationId) {
  if (!response || response.conversationId !== conversationId || !Array.isArray(response.messages)) return [];
  return response.messages.filter(messageHasContent);
}

export function trimRecentTranscriptMessages(messages) {
  const usable = Array.isArray(messages) ? messages.filter(messageHasContent) : [];
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

function optimisticSubmissionState(message) {
  if (!/^(?:optimistic|rollover)-user-/.test(String(message?.id || ""))) return "";
  return String(message?.submissionState || "");
}

function optimisticSubmissionIsCurrent(message, nowMs = Date.now()) {
  const state = optimisticSubmissionState(message);
  if (!state) return Boolean(message?.pending || message?.uncertain);
  if (state === "uncertain") return true;
  if (state !== "pending" && state !== "submitted") return false;
  const createdAtMs = Date.parse(String(message?.createdAt || ""));
  return Number.isFinite(createdAtMs) && nowMs - createdAtMs <= OPTIMISTIC_SUBMISSION_TTL_MS;
}

export function cacheableTranscriptMessages(messages) {
  return trimRecentTranscriptMessages(messages).filter((message) => {
    if (message?.pending || optimisticSubmissionState(message) === "pending") return false;
    if (/^(?:optimistic|rollover)-user-/.test(String(message?.id || "")) && !optimisticSubmissionState(message) && !message?.uncertain) return false;
    return true;
  }).map((message) => {
    const { images: _images, ...cacheMessage } = message || {};
    return cacheMessage;
  }).filter((message) => String(message?.text || "").trim());
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

export function transcriptAwaitingAssistant(messages) {
  const usable = Array.isArray(messages) ? messages.filter(messageHasContent) : [];
  const latestUserIndex = usable.findLastIndex((message) => message?.role === "user");
  return latestUserIndex >= 0 && !usable.slice(latestUserIndex + 1).some((message) => message?.role === "assistant" && message?.provisional !== true && message?.endTurn !== false);
}

export function latestTurnHasProvisionalAssistant(messages) {
  const usable = Array.isArray(messages) ? messages.filter(messageHasContent) : [];
  const latestUserIndex = usable.findLastIndex((message) => message?.role === "user");
  const turnMessages = latestUserIndex >= 0 ? usable.slice(latestUserIndex + 1) : usable;
  const latestAssistant = turnMessages.findLast((message) => message?.role === "assistant");
  return Boolean(latestAssistant && (latestAssistant.provisional === true || latestAssistant.endTurn === false));
}

export function discardProvisionalAssistantAfterLatestUser(messages, { includeUnverified = false } = {}) {
  const usable = Array.isArray(messages) ? messages : [];
  const latestUserIndex = usable.findLastIndex((message) => message?.role === "user");
  if (latestUserIndex < 0) return trimRecentTranscriptMessages(usable);
  return trimRecentTranscriptMessages(usable.filter((message, index) => {
    if (index <= latestUserIndex || message?.role !== "assistant") return true;
    return !(includeUnverified || message?.provisional === true || message?.endTurn === false);
  }));
}

export function completedResponseNeedsDomFallback(response) {
  if (!response) return false;
  const messages = Array.isArray(response?.messages) ? response.messages : [];
  const latestUserIndex = messages.findLastIndex((message) => message?.role === "user");
  const assistant = latestUserIndex >= 0
    ? messages.slice(latestUserIndex + 1).findLast((message) => message?.role === "assistant")
    : messages.findLast((message) => message?.role === "assistant");
  const suspiciousShortFinal = response.response_ready === true
    && response.canonical_available !== true
    && String(assistant?.text || response.text || "").trim().length <= 2;
  if (response.response_ready === true && !suspiciousShortFinal) return false;
  if (response.busy === true || response.network_stream_in_progress === true || response.network_state === "generating") return false;
  return suspiciousShortFinal || response.canonical_available === false || messages.length === 0 || transcriptAwaitingAssistant(messages);
}

export function mergeProgressiveResponseText(previousValue, incomingValue) {
  const previous = String(previousValue || "").trim();
  const incoming = String(incomingValue || "").trim();
  if (!previous) return incoming;
  if (!incoming) return previous;
  const comparable = (value) => String(value || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const previousComparable = comparable(previous);
  const incomingComparable = comparable(incoming);
  if (previousComparable === incomingComparable) return incoming.length >= previous.length ? incoming : previous;
  if (incomingComparable.includes(previousComparable)) return incoming;
  if (previousComparable.includes(incomingComparable)) return previous;
  const maximumOverlap = Math.min(previous.length, incoming.length);
  const minimumOverlap = Math.min(12, maximumOverlap);
  for (let size = maximumOverlap; size >= minimumOverlap; size -= 1) {
    if (previous.slice(-size) === incoming.slice(0, size)) return `${previous}${incoming.slice(size)}`;
  }
  return incoming.length > previous.length ? incoming : previous;
}

function preserveProgressiveAssistantMessages(previousMessages, incomingMessages, comparableText) {
  const previous = Array.isArray(previousMessages) ? previousMessages : [];
  return incomingMessages.map((message, incomingIndex, incoming) => {
    if (message?.role !== "assistant") return message;
    const incomingUserIndex = incoming.slice(0, incomingIndex).findLastIndex((candidate) => candidate?.role === "user");
    const incomingUserText = comparableText(incoming[incomingUserIndex]?.text);
    let previousUserIndex = -1;
    for (let index = previous.length - 1; index >= 0; index -= 1) {
      if (previous[index]?.role === "user" && comparableText(previous[index]?.text) === incomingUserText) {
        previousUserIndex = index;
        break;
      }
    }
    if (previousUserIndex < 0) return message;
    const nextPreviousUserIndex = previous.findIndex((candidate, index) => index > previousUserIndex && candidate?.role === "user");
    const previousTurnEnd = nextPreviousUserIndex < 0 ? previous.length : nextPreviousUserIndex;
    const previousAssistant = previous.slice(previousUserIndex + 1, previousTurnEnd).findLast((candidate) => candidate?.role === "assistant");
    if (!previousAssistant) return message;
    return {
      ...message,
      id: previousAssistant.id || message.id,
      text: previousAssistant.provisional === true && message.provisional !== true
        ? message.text
        : mergeProgressiveResponseText(previousAssistant.text, message.text),
      truncated: Boolean(previousAssistant.truncated && message.truncated)
    };
  });
}

function preserveProgressiveMessageIdentities(previousMessages, incomingMessages, comparableText) {
  const previous = Array.isArray(previousMessages) ? previousMessages : [];
  const incoming = Array.isArray(incomingMessages) ? incomingMessages : [];
  const usersWithStableIds = incoming.map((message, incomingIndex) => {
    if (message?.role !== "user") return message;
    const text = comparableText(message?.text);
    if (!text) return message;
    const occurrenceFromEnd = incoming.slice(incomingIndex + 1)
      .filter((candidate) => candidate?.role === "user" && comparableText(candidate?.text) === text).length;
    const previousMatches = previous.filter((candidate) => candidate?.role === "user" && comparableText(candidate?.text) === text);
    const previousUser = previousMatches.at(-(occurrenceFromEnd + 1));
    return previousUser?.id ? { ...message, id: previousUser.id } : message;
  });
  return preserveProgressiveAssistantMessages(previous, usersWithStableIds, comparableText);
}

export function mergeNetworkStreamTranscript(previousMessages, { conversationId, text, truncated = false }) {
  const streamText = String(text || "").trim();
  const messages = Array.isArray(previousMessages) ? [...previousMessages] : [];
  if (!streamText) return trimRecentTranscriptMessages(messages);

  const streamId = `network-stream-assistant:${conversationId}`;
  const streamMessage = { id: streamId, role: "assistant", text: streamText, truncated: Boolean(truncated), provisional: true, endTurn: false };
  const existingIndex = messages.findIndex((message) => message?.id === streamId);
  if (existingIndex >= 0) messages[existingIndex] = {
    ...messages[existingIndex],
    ...streamMessage,
    text: mergeProgressiveResponseText(messages[existingIndex]?.text, streamText)
  };
  else messages.push(streamMessage);
  return trimRecentTranscriptMessages(messages);
}

export function replaceCanonicalTranscript(previousMessages, incomingMessages, { nowMs = Date.now() } = {}) {
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
    const previous = (Array.isArray(previousMessages) ? previousMessages : []).filter((message) => {
      if (message?.role !== "user" || !/^(?:optimistic|rollover)-user-/.test(String(message?.id || ""))) return true;
      const text = comparableText(message?.text);
      return canonicalUserTexts.has(text) || optimisticSubmissionIsCurrent(message, nowMs);
    });
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
    const unmaterializedOptimisticUsers = previous
      .filter((message) => message?.role === "user" && /^(?:optimistic|rollover)-user-/.test(String(message?.id || "")))
      .filter((message) => {
        const text = comparableText(message?.text);
        return text && !canonicalUserTexts.has(text);
      });
    const progressiveIncoming = preserveProgressiveMessageIdentities(previous, incoming, comparableText);
    return trimRecentTranscriptMessages([...progressiveIncoming, ...unmaterializedOptimisticUsers]);
  }
  return trimRecentTranscriptMessages(previousMessages);
}

export function isNetworkStreamCurrentGeneration({ networkStartedAt, streamUpdatedAt }) {
  const generationStartedMs = Date.parse(String(networkStartedAt || ""));
  if (!Number.isFinite(generationStartedMs)) return true;
  const streamUpdatedMs = Date.parse(String(streamUpdatedAt || ""));
  return Number.isFinite(streamUpdatedMs) && streamUpdatedMs >= generationStartedMs;
}
