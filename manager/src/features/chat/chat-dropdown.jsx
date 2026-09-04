import React from "react";
import { AppDropdown } from "../../app-dropdown.jsx";

export const NEW_CHAT_TARGET = "__codexpro_new_chat__";

export function ChatDropdown({ value, conversations, disabled, onChange }) {
  const selectedDraft = { id: NEW_CHAT_TARGET, title: "Chat mới", open: false, draft: true };
  const available = value === NEW_CHAT_TARGET && !conversations.some((chat) => chat.id === value) ? [selectedDraft, ...conversations] : conversations;
  const options = available.map((chat, index) => ({ value: chat.id, label: chat.title || "Đoạn chat chưa có tiêu đề", hint: chat.draft ? "Chưa tạo trên ChatGPT" : chat.open ? "Đang mở trong Chrome" : "Chat gần đây", searchText: `${chat.title || ""} ${chat.id || ""}`, chat, position: index + 1 }));
  return (
    <AppDropdown
      className="is-chat"
      value={value}
      options={options}
      disabled={disabled}
      onChange={onChange}
      ariaLabel="Chọn đoạn chat dự án"
      placeholder="Chưa tải được các đoạn chat gần đây"
      searchPlaceholder="Tìm tiêu đề hoặc ID đoạn chat…"
      searchThreshold={6}
      renderValue={(selected) => <span className="app-dropdown-value-copy"><strong>{selected?.label || "Chưa tải được các đoạn chat gần đây"}</strong>{selected && <small>{selected.hint}</small>}</span>}
      renderOption={(option) => <><span className="app-dropdown-index">{option.position}</span><span className="app-dropdown-option-copy"><strong>{option.label}</strong><small>{option.hint}</small></span>{option.chat.active && <span className="app-dropdown-meta is-active">ACTIVE</span>}</>}
    />
  );
}
