(() => {
  const GLOBAL_KEY = "__codexproNetworkStreamCaptureV1";
  const current = globalThis[GLOBAL_KEY];
  if (current?.version === 3 && typeof current.read === "function") return;

  const originalFetch = (current?.originalFetch || globalThis.fetch)?.bind(globalThis);
  if (typeof originalFetch !== "function") return;

  const records = [];
  const MAX_RECORDS = 12;
  const MAX_TEXT = 80000;
  let nextRecordId = 1;

  const bounded = (value, limit = MAX_TEXT) => String(value || "").replace(/\u200b/g, "").slice(0, limit);
  const endpointOf = (value) => {
    try { return new URL(String(value || ""), location.href).pathname; } catch { return ""; }
  };
  const isGenerationEndpoint = (url, method) => {
    if (String(method || "GET").toUpperCase() !== "POST") return false;
    const endpoint = endpointOf(url);
    return /\/(?:backend-api|backend-anon)\/(?:f\/)?(?:conversation|(?:codex\/)?responses)(?:\/|$)/.test(endpoint);
  };
  const requestConversationId = (body) => {
    if (typeof body !== "string" || !body.trim()) return "";
    try { return conversationIdFrom(JSON.parse(body)); } catch { return ""; }
  };
  const pageConversationId = () => {
    try { return new URL(location.href).pathname.match(/^\/c\/([A-Za-z0-9-]{8,180})/)?.[1] || ""; } catch { return ""; }
  };
  const requestDetails = (input, init) => ({
    url: typeof input === "string" || input instanceof URL ? String(input) : String(input?.url || ""),
    method: String(init?.method || input?.method || "GET").toUpperCase(),
    conversationId: requestConversationId(init?.body) || pageConversationId()
  });
  const messageText = (message) => {
    const content = message?.content || message?.message?.content;
    const parts = Array.isArray(content?.parts) ? content.parts : Array.isArray(content) ? content : [];
    const values = parts.flatMap((part) => {
      if (typeof part === "string") return [part];
      if (typeof part?.text === "string") return [part.text];
      if (typeof part?.content === "string") return [part.content];
      if (typeof part?.output_text === "string") return [part.output_text];
      return [];
    });
    if (values.length) return bounded(values.join("\n"));
    if (typeof content?.text === "string") return bounded(content.text);
    if (typeof content?.content === "string") return bounded(content.content);
    if (typeof message?.text === "string") return bounded(message.text);
    return "";
  };
  const conversationIdFrom = (payload) => bounded(
    payload?.conversation_id || payload?.conversationId || payload?.conversation?.id || payload?.response?.conversation_id || "",
    180
  );
  const assistantRole = (message) => String(message?.author?.role || message?.role || message?.message?.author?.role || "").toLowerCase() === "assistant";
  const toolActivityFromText = (text) => {
    const source = String(text || "").trim().replace(/\\\"/g, '"');
    if (!source.includes("/CodexPro/") || !source.includes("args")) return "";
    return "Codex Pro đang sử dụng công cụ";
  };
  const visibleAssistant = (message) => {
    const candidate = message?.message || message;
    const metadata = candidate?.metadata || {};
    if (!assistantRole(candidate) || metadata.is_visually_hidden_from_conversation === true) return false;
    const contentType = String(candidate?.content?.content_type || "").toLowerCase();
    if (contentType === "reasoning_recap" && metadata.reasoning_recap_type === "hide_all") return false;
    return true;
  };
  const messageId = (message, record) => bounded(message?.id || message?.message?.id || record.activeMessageId || `stream-${record.id}`, 220);

  function createRecord(url, conversationId = "") {
    const record = {
      id: nextRecordId++,
      conversationId: bounded(conversationId, 180),
      endpoint: endpointOf(url),
      startedAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: 0,
      eventCount: 0,
      error: "",
      activeMessageId: "",
      patchPath: "",
      messages: []
    };
    records.push(record);
    while (records.length > MAX_RECORDS) records.shift();
    return record;
  }

  function ensureAssistant(record, message) {
    const id = messageId(message, record);
    record.activeMessageId = id;
    let existing = record.messages.find((item) => item.id === id);
    if (!existing) {
      existing = { id, role: "assistant", text: "", status: "in_progress", end_turn: false, updated_at: new Date().toISOString() };
      record.messages.push(existing);
      record.messages = record.messages.slice(-20);
    }
    return existing;
  }

  function upsertAssistant(record, message, textOverride = "") {
    if (!message || (!visibleAssistant(message) && !textOverride)) return;
    const existing = ensureAssistant(record, message);
    const text = bounded(textOverride || messageText(message)).trim();
    if (!text) return;
    const next = {
      id: existing.id,
      role: "assistant",
      text,
      status: bounded(message?.status || message?.message?.status || "", 80),
      end_turn: message?.end_turn === true || message?.message?.end_turn === true,
      updated_at: new Date().toISOString()
    };
    Object.assign(existing, next);
    record.messages = record.messages.slice(-20);
    record.updatedAt = Date.now();
  }

  function appendDelta(record, delta, payload) {
    const value = bounded(delta).replace(/\u0000/g, "");
    if (!value) return;
    const id = bounded(payload?.message_id || payload?.item_id || payload?.output_id || record.activeMessageId || `stream-${record.id}`, 220);
    record.activeMessageId = id;
    let existing = record.messages.find((item) => item.id === id);
    if (!existing) {
      existing = { id, role: "assistant", text: "", status: "in_progress", end_turn: false, updated_at: new Date().toISOString() };
      record.messages.push(existing);
    }
    existing.text = bounded(existing.text + value);
    existing.updated_at = new Date().toISOString();
    record.messages = record.messages.slice(-20);
    record.updatedAt = Date.now();
  }

  function inspectPayload(record, payload, depth = 0, seen = new Set()) {
    if (!payload || depth > 5 || typeof payload !== "object" || seen.has(payload)) return;
    seen.add(payload);
    const conversationId = conversationIdFrom(payload);
    if (conversationId) record.conversationId = conversationId;

    if (visibleAssistant(payload)) upsertAssistant(record, payload);
    if (payload.message && visibleAssistant(payload.message)) upsertAssistant(record, payload.message);
    if (payload.item && visibleAssistant(payload.item)) upsertAssistant(record, payload.item);

    if (payload.p === "/message/content/parts/0" && payload.o === "append" && typeof payload.v === "string") {
      record.patchPath = payload.p;
      appendDelta(record, payload.v, payload);
    } else if (!payload.p && typeof payload.v === "string" && record.patchPath === "/message/content/parts/0") {
      appendDelta(record, payload.v, payload);
    }

    const type = String(payload.type || payload.event || "").toLowerCase();
    const delta = typeof payload.delta === "string"
      ? payload.delta
      : typeof payload.delta?.text === "string"
        ? payload.delta.text
        : typeof payload.text_delta === "string"
          ? payload.text_delta
          : "";
    if (delta && /(output_text|text|content|message|assistant).*(delta|chunk)|(delta).*(output_text|text|content|message|assistant)/.test(type) && !/(argument|tool|json)/.test(type)) {
      appendDelta(record, delta, payload);
    }

    const fullText = typeof payload.output_text === "string"
      ? payload.output_text
      : /(?:output_text|message|content).*(?:done|completed)/.test(type) && typeof payload.text === "string"
        ? payload.text
        : "";
    if (fullText) upsertAssistant(record, { id: payload.message_id || payload.item_id || record.activeMessageId, role: "assistant", status: "in_progress" }, fullText);

    for (const key of ["v", "data", "response", "output", "item", "message", "input_message", "delta"]) {
      const value = payload[key];
      if (Array.isArray(value)) value.slice(0, 40).forEach((item) => inspectPayload(record, item, depth + 1, seen));
      else inspectPayload(record, value, depth + 1, seen);
    }
  }

  function parseEvent(record, raw) {
    const value = String(raw || "").trim();
    if (!value || value === "[DONE]") return;
    try {
      const payload = JSON.parse(value);
      record.eventCount += 1;
      inspectPayload(record, payload);
    } catch {
      // Ignore keepalives and non-JSON protocol frames.
    }
  }

  async function consumeResponse(record, response) {
    try {
      const clone = response.clone();
      if (!clone.body) return;
      const reader = clone.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || "";
        for (const event of events) {
          const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          if (data) parseEvent(record, data);
          else event.split(/\r?\n/).forEach((line) => parseEvent(record, line));
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        const data = buffer.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        if (data) parseEvent(record, data);
        else buffer.split(/\r?\n/).forEach((line) => parseEvent(record, line));
      }
      record.completedAt = Date.now();
      record.updatedAt = Date.now();
    } catch (error) {
      record.error = bounded(error?.message || error, 500);
      record.completedAt = Date.now();
      record.updatedAt = Date.now();
    }
  }

  const capturedFetch = async function (...args) {
    const details = requestDetails(args[0], args[1]);
    const response = await originalFetch(...args);
    if (isGenerationEndpoint(details.url, details.method)) {
      const record = createRecord(details.url, details.conversationId);
      void consumeResponse(record, response);
    }
    return response;
  };

  const api = {
    version: 3,
    installedAt: Date.now(),
    originalFetch,
    records,
    read(conversationId = "") {
      const requested = bounded(conversationId, 180);
      const recent = records.filter((record) => Date.now() - record.startedAt < 30 * 60 * 1000);
      const record = requested
        ? [...recent].reverse().find((item) => item.conversationId === requested)
        : recent.at(-1);
      if (!record) return { available: false, capture_installed: true, conversation_id: requested };
      const rawMessages = record.messages.filter((message) => message.text);
      const latestActivity = [...rawMessages].reverse().map((message) => toolActivityFromText(message.text)).find(Boolean) || "";
      const messages = rawMessages.filter((message) => !toolActivityFromText(message.text)).map((message) => ({ ...message }));
      const latest = [...messages].reverse().find((message) => message.role === "assistant");
      return {
        available: Boolean(messages.length || latestActivity),
        capture_installed: true,
        conversation_id: record.conversationId || requested,
        endpoint: record.endpoint,
        text: latest?.text || "",
        text_length: String(latest?.text || "").length,
        messages,
        activity_text: latestActivity,
        in_progress: !record.completedAt,
        event_count: record.eventCount,
        started_at: new Date(record.startedAt).toISOString(),
        updated_at: new Date(record.updatedAt).toISOString(),
        completed: Boolean(record.completedAt),
        error: record.error
      };
    }
  };

  globalThis[GLOBAL_KEY] = api;
  globalThis.fetch = capturedFetch;
})();
