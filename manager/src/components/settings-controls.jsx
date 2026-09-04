import React from "react";
import { AppDropdown } from "../app-dropdown.jsx";

export function SettingsDropdown({ value, options, disabled, onChange, ariaLabel = "Chọn font chữ", selectedHint = "" }) {
  return (
    <AppDropdown
      className="is-settings"
      value={value}
      options={options.map((option) => ({ ...option, style: option.css ? { fontFamily: option.css } : undefined }))}
      disabled={disabled}
      onChange={onChange}
      ariaLabel={ariaLabel}
      searchPlaceholder={`Tìm ${ariaLabel.toLocaleLowerCase("vi-VN")}…`}
      renderValue={(selected) => <span className="app-dropdown-value-copy"><strong>{selected?.label || "Chọn giá trị"}</strong><small>{selectedHint || selected?.hint || (selected?.value === "system" ? "Theo giao diện Windows" : "Áp dụng cho toàn bộ CodexPro")}</small></span>}
    />
  );
}

export function SettingsToggle({ checked, disabled = false, onChange, title, hint }) {
  return (
    <button
      type="button"
      className={`settings-toggle ${checked ? "is-on" : ""}`}
      aria-pressed={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="settings-toggle-track" aria-hidden="true"><i /></span>
      <span className="settings-toggle-copy"><strong>{title}</strong><small>{hint}</small></span>
    </button>
  );
}
