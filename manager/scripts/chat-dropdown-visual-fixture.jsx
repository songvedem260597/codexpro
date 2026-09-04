import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { ChatDropdown, NEW_CHAT_TARGET } from "../src/features/chat/chat-dropdown.jsx";

const conversations = [
  { id: "chat-active", title: "Audit refactor CodexPro", open: true, active: true },
  { id: "chat-recovery", title: "Recovery checkpoint", open: false },
  { id: "chat-worker", title: "API worker cleanup", open: true },
  { id: "chat-gitdiagram", title: "GitDiagram plugin", open: false },
  { id: "chat-settings", title: "Settings controls", open: false },
  { id: "chat-rollover", title: "Conversation rollover", open: false },
  { id: "chat-diagnostics", title: "Diagnostics log", open: false }
];

function Fixture() {
  const [value, setValue] = useState(NEW_CHAT_TARGET);
  return (
    <main style={{ minHeight: "100vh", padding: 40, background: "#090d12", boxSizing: "border-box" }}>
      <section className="settings-panel" style={{ width: 760, maxWidth: "100%", margin: "0 auto" }}>
        <div className="settings-panel-head">
          <div>
            <p className="eyebrow">CHAT DROPDOWN</p>
            <h2>Conversation selector</h2>
            <p className="section-note">Visual smoke for the extracted ChatDropdown component.</p>
          </div>
        </div>
        <div style={{ display: "grid", gap: 18 }}>
          <ChatDropdown value={value} conversations={conversations} onChange={setValue} />
          <ChatDropdown value="chat-active" conversations={conversations} disabled onChange={() => undefined} />
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<Fixture />);

setTimeout(() => {
  const triggers = [...document.querySelectorAll(".app-dropdown-trigger")];
  window.__chatDropdownVisualResult = {
    ok: triggers.length === 2,
    selectedText: triggers[0]?.innerText || "",
    selectedExpanded: triggers[0]?.getAttribute("aria-expanded"),
    disabled: triggers[1]?.disabled === true,
    triggerHeights: triggers.map((item) => Math.round(item.getBoundingClientRect().height)),
    bodyScrollWidth: document.body.scrollWidth,
    bodyClientWidth: document.body.clientWidth
  };
}, 250);
