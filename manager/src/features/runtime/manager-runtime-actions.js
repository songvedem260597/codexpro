import { applyConversationTitleOverrides } from "../chat/chat-conversation-utils.js";
import { mergeRuntimeStatus } from "../../ui-performance.js";

export function createManagerRuntimeActions({
  api,
  status,
  conversationTitleOverridesRef,
  setStatus,
  setBusy,
  setError,
  notify
}) {
  async function copyLink() {
    if (!status?.mcpLink) return;
    await api.copyText(status.mcpLink);
    notify("Đã copy link MCP");
  }

  async function rotateLink() {
    setBusy("rotate");
    setError("");
    try {
      const result = await api.rotateLink();
      if (!result.cancelled) {
        setStatus((current) => applyConversationTitleOverrides(mergeRuntimeStatus(current, result), conversationTitleOverridesRef.current));
        await api.copyText(result.mcpLink);
        notify("Đã tạo và copy link mới");
      }
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy("");
    }
  }

  async function control(action) {
    setBusy(action);
    setError("");
    try {
      const nextStatus = await api.controlServer(action);
      setStatus((current) => applyConversationTitleOverrides(mergeRuntimeStatus(current, nextStatus), conversationTitleOverridesRef.current));
      notify(action === "restart" ? "CodexPro đã restart" : "CodexPro đã khởi động");
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy("");
    }
  }

  return { copyLink, rotateLink, control };
}
