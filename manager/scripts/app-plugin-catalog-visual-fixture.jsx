import React from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { AppPluginCenter } from "../src/app-plugin-center.jsx";

const catalog = [
  {
    id: "taste-skill",
    name: "Taste Skill",
    description: "Bộ skill thiết kế frontend, redesign và image-to-code cho GPT/Codex.",
    installed: true,
    skill_count: 13,
    source_commit: "ccbc15639c97"
  },
  {
    id: "gitdiagram",
    name: "GitDiagram",
    description: "Rút repo local thành sơ đồ kiến trúc tổng quát, dễ đọc, dựa trên CodexGraph và ý tưởng architecture-first của GitDiagram.",
    installed: true,
    source_commit: "cb4e4cf58c14"
  }
];

const api = {
  listAppPlugins: async () => [],
  listAppPluginCatalog: async () => catalog
};

function Fixture() {
  return (
    <div style={{ width: "100%", minHeight: "100vh", padding: 16, background: "#090d12", boxSizing: "border-box" }}>
      <AppPluginCenter api={api} status={{ workers: [], browserProfiles: [] }} projects={[]} notify={() => undefined} onError={(error) => console.error(error)} onRefresh={() => undefined} />
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Fixture />);

setTimeout(() => {
  const cards = [...document.querySelectorAll(".app-plugin-catalog-card")];
  const layout = document.querySelector(".app-plugin-layout");
  const center = document.querySelector(".app-plugin-center");
  window.__appPluginCatalogVisualResult = {
    ok: cards.length === 2 && Boolean(layout) && Boolean(center),
    cardHeights: cards.map((card) => Math.round(card.getBoundingClientRect().height)),
    cardWidths: cards.map((card) => Math.round(card.getBoundingClientRect().width)),
    cardTop: cards.map((card) => Math.round(card.getBoundingClientRect().top)),
    layoutTop: Math.round(layout?.getBoundingClientRect().top || 0),
    layoutHeight: Math.round(layout?.getBoundingClientRect().height || 0),
    centerHeight: Math.round(center?.getBoundingClientRect().height || 0),
    bodyScrollWidth: document.body.scrollWidth,
    bodyClientWidth: document.body.clientWidth,
    text: center?.innerText || ""
  };
}, 250);
