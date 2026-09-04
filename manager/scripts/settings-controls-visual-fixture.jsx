import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { SettingsDropdown, SettingsToggle } from "../src/components/settings-controls.jsx";

const options = [
  { value: "system", label: "Segoe UI / mặc định Windows", hint: "Theo giao diện Windows" },
  { value: "manrope", label: "Manrope", hint: "Tiêu đề · giao diện hiện đại", css: 'Manrope, "Segoe UI", sans-serif' },
  { value: "jetbrains", label: "JetBrains Mono", hint: "Code · ID · log kỹ thuật", css: '"JetBrains Mono", monospace' }
];

function Fixture() {
  const [font, setFont] = useState("system");
  const [showChatSelector, setShowChatSelector] = useState(true);
  return (
    <main style={{ minHeight: "100vh", padding: 40, background: "#090d12", boxSizing: "border-box" }}>
      <section className="settings-panel" style={{ width: 680, maxWidth: "100%", margin: "0 auto" }}>
        <div className="settings-panel-head">
          <div>
            <p className="eyebrow">SETTINGS CONTROLS</p>
            <h2>Shared settings controls</h2>
            <p className="section-note">Visual smoke for the extracted dropdown and toggle components.</p>
          </div>
        </div>
        <div style={{ display: "grid", gap: 18 }}>
          <div className="font-setting-row">
            <label>Font nội dung</label>
            <SettingsDropdown value={font} options={options} ariaLabel="Chọn font nội dung" onChange={setFont} />
          </div>
          <SettingsToggle checked={showChatSelector} title="Hiện mục Đoạn chat" hint="Bật hoặc tắt bộ chọn hội thoại trong popup Chat." onChange={setShowChatSelector} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <SettingsDropdown value="system" options={options} ariaLabel="Dropdown bị khóa" disabled onChange={() => undefined} />
            <SettingsToggle checked={false} title="Toggle bị khóa" hint="Kiểm tra disabled state." disabled onChange={() => undefined} />
          </div>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<Fixture />);

setTimeout(() => {
  const panel = document.querySelector(".settings-panel");
  const triggers = [...document.querySelectorAll(".app-dropdown-trigger")];
  const toggles = [...document.querySelectorAll(".settings-toggle")];
  window.__settingsControlsVisualResult = {
    ok: Boolean(panel) && triggers.length === 2 && toggles.length === 2,
    panel: panel ? { width: Math.round(panel.getBoundingClientRect().width), height: Math.round(panel.getBoundingClientRect().height) } : null,
    triggerHeights: triggers.map((item) => Math.round(item.getBoundingClientRect().height)),
    toggleHeights: toggles.map((item) => Math.round(item.getBoundingClientRect().height)),
    activeTogglePressed: toggles[0]?.getAttribute("aria-pressed"),
    disabledDropdown: triggers[1]?.disabled === true,
    disabledToggle: toggles[1]?.disabled === true,
    bodyScrollWidth: document.body.scrollWidth,
    bodyClientWidth: document.body.clientWidth
  };
}, 250);
