const ROLLOVER_CONTEXT_MAX_CHARS = 9000;

export function repoTaskEvidenceSummary(proof) {
  if (!proof) return "";
  const title = String(proof.task_title || "").trim() || "Task chưa có tên";
  if (proof.task_kind !== "code") return `${title} · GENERAL · không tải Rules/CodexGraph`;
  const rulesHash = String(proof.global_rules_sha256 || "").slice(0, 8);
  const coverage = proof.codexgraph?.coverage || {};
  const symbols = Number(coverage.symbolCount) || 0;
  const relationships = Number(coverage.relationshipCount) || 0;
  return `${title} · CODE · Rules ${rulesHash || "thiếu hash"} ✓ · CodexGraph ${symbols} symbols / ${relationships} edges ✓`;
}

export function conversationIdFromTab(tab) {
  return String(tab?.url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
}

function normalizedTaskTitleTokens(value) {
  const ignored = new Set(["task", "chat", "codexpro", "dong", "bo", "cap", "nhat", "sua", "them", "fix"]);
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("vi-VN")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !ignored.has(token));
}

export function taskConversationIdForProfile(profile) {
  const persisted = String(profile?.current_task_conversation_id || "").trim();
  if (/^[A-Za-z0-9-]{8,160}$/.test(persisted)) return persisted;
  const tabs = Array.isArray(profile?.conversation_tabs) ? profile.conversation_tabs : [];
  const liveTab = tabs.find((tab) =>
    Boolean(conversationIdFromTab(tab))
    && (tab?.busy || tab?.settling || String(tab?.network_state || "") === "generating" || tab?.network_stream_in_progress)
  );
  if (liveTab) return conversationIdFromTab(liveTab);
  const taskTokens = normalizedTaskTitleTokens(profile?.current_task_title);
  if (taskTokens.length < 2) return "";
  const taskTokenSet = new Set(taskTokens);
  const candidates = [
    ...tabs.map((tab) => ({ id: conversationIdFromTab(tab), title: tab?.title || "" })),
    ...(Array.isArray(profile?.recent_conversations) ? profile.recent_conversations : []).map((chat) => ({ id: String(chat?.id || ""), title: chat?.title || "" }))
  ]
    .filter((item) => /^[A-Za-z0-9-]{8,160}$/.test(item.id))
    .map((item) => ({ ...item, overlap: normalizedTaskTitleTokens(item.title).filter((token) => taskTokenSet.has(token)).length }))
    .sort((left, right) => right.overlap - left.overlap);
  return candidates[0]?.overlap >= 2 ? candidates[0].id : "";
}

export function profileRequestChats(profile, preferredId = "") {
  const recent = Array.isArray(profile?.recent_conversations) ? profile.recent_conversations : [];
  const tabs = (profile?.conversation_tabs || []).map((tab) => {
    const id = conversationIdFromTab(tab);
    return id ? { id, title: tab.title, url: tab.url, open: true, active: tab.active, busy: tab.busy, settling: tab.settling, network_state: tab.network_state, long_task_watchdog_hung: Boolean(tab.long_task_watchdog_hung), long_task_watchdog_attempt_key: String(tab.long_task_watchdog_attempt_key || "") } : null;
  }).filter(Boolean);
  const tabById = new Map(tabs.map((chat) => [chat.id, chat]));
  const conversations = [...recent.map((chat) => ({ ...chat, ...(tabById.get(String(chat.id)) || {}) })), ...tabs]
    .filter((chat, index, all) => chat.id && all.findIndex((candidate) => String(candidate.id) === String(chat.id)) === index);
  const preferred = conversations.find((chat) => String(chat.id) === String(preferredId));
  return preferred ? [preferred, ...conversations.filter((chat) => chat !== preferred)].slice(0, 3) : conversations.slice(0, 3);
}

export function applyConversationTitleOverrides(status, overrides) {
  if (!status || !overrides || !Object.keys(overrides).length) return status;
  return {
    ...status,
    browserProfiles: (status.browserProfiles || []).map((profile) => {
      const recentConversations = (profile.recent_conversations || []).map((chat) => {
        const title = overrides[`${profile.profile_id}:${chat.id}`];
        return title ? { ...chat, title } : chat;
      });
      const conversationTabs = (profile.conversation_tabs || []).map((tab) => {
        const conversationId = conversationIdFromTab(tab);
        const title = overrides[`${profile.profile_id}:${conversationId}`];
        return title ? { ...tab, title } : tab;
      });
      const activeTab = conversationTabs.find((tab) => tab.active) || conversationTabs[0];
      return {
        ...profile,
        recent_conversations: recentConversations,
        conversation_tabs: conversationTabs,
        active_chat_title: activeTab?.title || profile.active_chat_title
      };
    })
  };
}

export function visibleUserMessageText(value) {
  const text = String(value || "").trim();
  const marker = "Yêu cầu của người dùng:";
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex >= 0) return text.slice(markerIndex + marker.length).trim();
  if (text.includes("Yêu cầu của người dùng nằm trong file đính kèm.")) return "Yêu cầu nằm trong file đính kèm.";
  return text;
}

export function buildConversationRolloverPrompt(result) {
  const recoveryContinuation = String(result?.continuation_reason || "") === "recovery";
  const prefix = [
    recoveryContinuation
      ? "Tab ChatGPT trước bị treo hoặc không thể khôi phục an toàn nên CodexPro đã tự tạo cuộc chat tiếp nối này."
      : "Đoạn chat trước vừa đạt giới hạn độ dài nên CodexPro đã tự tạo cuộc chat mới này.",
    "Hãy tiếp tục đúng dự án/công việc đang làm từ bối cảnh gần nhất bên dưới. Không bắt đầu lại từ đầu và không yêu cầu người dùng lặp lại thông tin đã có nếu có thể suy ra từ bối cảnh.",
    result?.projectRoot ? `Repo tiếp tục (đã khóa trong CodexPro): ${String(result.projectRoot).trim()}` : "",
    result?.title ? `Tên chat trước: ${String(result.title).trim()}` : "",
    result?.recovery_reason ? `Lý do chuyển chat: ${String(result.recovery_reason).trim()}` : "",
    "",
    "Bối cảnh gần nhất từ chat trước:"
  ].filter((line) => line !== "").join("\n");
  const messages = Array.isArray(result?.messages) ? result.messages.filter((message) => String(message?.text || "").trim()) : [];
  const chunks = [];
  let remaining = ROLLOVER_CONTEXT_MAX_CHARS;
  for (let index = messages.length - 1; index >= 0 && remaining > 200; index -= 1) {
    const message = messages[index];
    const role = message?.role === "user" ? "Bạn" : "ChatGPT";
    const messageText = message?.role === "user" ? visibleUserMessageText(message.text) : String(message.text || "").trim();
    const fullChunk = `${role}:\n${messageText}`;
    if (fullChunk.length <= remaining) {
      chunks.unshift(fullChunk);
      remaining -= fullChunk.length + 2;
      continue;
    }
    const tailLength = Math.max(0, remaining - role.length - 6);
    if (tailLength > 180) chunks.unshift(`${role}:\n…${fullChunk.slice(-tailLength)}`);
    break;
  }
  const context = chunks.length ? chunks.join("\n\n") : "(Không đọc được transcript gần nhất; hãy tiếp tục dựa trên yêu cầu tiếp theo của người dùng.)";
  return `${prefix}\n\n${context}\n\nTiếp tục từ đúng việc còn dang dở. Nếu cần chờ người dùng đưa yêu cầu tiếp theo thì chỉ báo ngắn gọn rằng chat mới đã sẵn sàng để tiếp tục dự án.`.slice(0, 11800);
}
