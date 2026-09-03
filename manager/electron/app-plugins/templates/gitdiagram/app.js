const state = { projects: [], result: null, requestId: "", meta: null, viewKey: "overview" };
const elements = {
  project: document.querySelector("#project"),
  analyze: document.querySelector("#analyze"),
  copy: document.querySelector("#copy"),
  status: document.querySelector("#status"),
  summary: document.querySelector("#summary"),
  components: document.querySelector("#components"),
  modules: document.querySelector("#modules"),
  connections: document.querySelector("#connections"),
  symbols: document.querySelector("#symbols"),
  relations: document.querySelector("#relations"),
  viewbar: document.querySelector("#viewbar"),
  back: document.querySelector("#back"),
  viewTitle: document.querySelector("#view-title"),
  viewHint: document.querySelector("#view-hint"),
  diagram: document.querySelector("#diagram"),
  warnings: document.querySelector("#warnings"),
  commit: document.querySelector("#commit")
};

function requestId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function setStatus(text, tone = "") {
  elements.status.textContent = text;
  elements.status.className = `status ${tone ? `is-${tone}` : ""}`.trim();
}

function renderProjects() {
  const current = elements.project.value;
  const options = state.projects.map((project) => {
    const option = document.createElement("option");
    option.value = project.root;
    option.textContent = project.repoFullName ? `${project.name} · ${project.repoFullName}` : project.name || project.root;
    option.title = project.root;
    return option;
  });
  elements.project.replaceChildren(...options);
  if (state.projects.some((project) => project.root === current)) elements.project.value = current;
  elements.analyze.disabled = !state.projects.length;
  if (!state.projects.length) setStatus("Chưa có workspace đã lưu trong CodexPro.", "error");
}

function layoutNodes(result) {
  const nodes = Array.isArray(result?.nodes) ? result.nodes : [];
  const layerMap = new Map();
  for (const node of nodes) {
    const layer = Math.max(0, Number(node.layer) || 0);
    const list = layerMap.get(layer) || [];
    list.push(node);
    layerMap.set(layer, list);
  }
  const layers = [...layerMap.entries()].sort((a, b) => a[0] - b[0]);
  const widest = Math.max(1, ...layers.map(([, list]) => list.length));
  const viewportWidth = Math.max(760, elements.diagram?.parentElement?.clientWidth || 0);
  const width = Math.max(viewportWidth, widest * 240 + 120);
  const layerGap = 126;
  const top = 44;
  const positions = new Map();
  for (const [layer, list] of layers) {
    const rowWidth = list.length * 190 + Math.max(0, list.length - 1) * 50;
    const startX = (width - rowWidth) / 2;
    list.forEach((node, index) => positions.set(node.id, {
      x: startX + index * 240,
      y: top + layer * layerGap,
      width: 190,
      height: 72
    }));
  }
  const minHeight = state.viewKey === "overview" ? 560 : 380;
  const height = Math.max(minHeight, top + (layers.at(-1)?.[0] || 0) * layerGap + 150);
  return { positions, width, height };
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
  return element;
}

function renderDiagram(result) {
  const nodes = Array.isArray(result?.nodes) ? result.nodes : [];
  const edges = Array.isArray(result?.edges) ? result.edges : [];
  if (!nodes.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "CodexGraph chưa đủ dữ liệu để dựng kiến trúc tổng quát.";
    elements.diagram.replaceChildren(empty);
    return;
  }

  const { positions, width, height } = layoutNodes(result);
  elements.diagram.style.width = `${width}px`;
  elements.diagram.style.height = `${height}px`;
  elements.diagram.style.minHeight = `${height}px`;

  const svg = svgElement("svg", { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none" });
  const defs = svgElement("defs");
  const marker = svgElement("marker", { id: "arrow", viewBox: "0 0 10 10", refX: 8, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
  marker.append(svgElement("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#6f7884" }));
  defs.append(marker);
  svg.append(defs);

  const labels = [];
  for (const edge of edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    const x1 = from.x + from.width / 2;
    const y1 = from.y + from.height;
    const x2 = to.x + to.width / 2;
    const y2 = to.y;
    const midY = Math.max(y1 + 22, (y1 + y2) / 2);
    const path = svgElement("path", {
      d: `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2 - 4}`,
      fill: "none",
      stroke: "#747d88",
      "stroke-width": Math.min(2.2, 1 + Math.log2(Math.max(1, Number(edge.weight) || 1)) * 0.18),
      "marker-end": "url(#arrow)"
    });
    svg.append(path);
    const label = document.createElement("span");
    label.className = "edge-label";
    label.textContent = edge.label || edge.kind || "flow";
    label.style.left = `${(x1 + x2) / 2}px`;
    label.style.top = `${midY}px`;
    labels.push(label);
  }

  const nodeElements = nodes.map((node) => {
    const position = positions.get(node.id);
    const box = document.createElement("div");
    box.className = "flow-node";
    box.style.left = `${position.x}px`;
    box.style.top = `${position.y}px`;
    box.title = node.path || node.key || node.label;
    const detailView = state.viewKey === "overview" ? state.result?.details?.[node.key] : null;
    if (detailView?.nodes?.length) {
      box.classList.add("is-clickable");
      box.tabIndex = 0;
      box.setAttribute("role", "button");
      box.setAttribute("aria-label", `Xem module bên trong ${node.label || node.key}`);
      box.addEventListener("click", () => openDetail(node.key));
      box.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openDetail(node.key);
      });
    }
    const label = document.createElement("strong");
    label.textContent = node.label || node.key || node.id;
    const detail = document.createElement("small");
    detail.textContent = node.path || node.description || "";
    box.append(label, detail);
    return box;
  });

  elements.diagram.replaceChildren(svg, ...labels, ...nodeElements);
}

function activeDiagramResult() {
  if (state.viewKey === "overview") return state.result;
  return state.result?.details?.[state.viewKey] || state.result;
}

function showOverview() {
  if (!state.result) return;
  state.viewKey = "overview";
  elements.viewbar.hidden = false;
  elements.back.hidden = true;
  elements.viewTitle.textContent = "Tổng quan hệ thống";
  elements.viewHint.textContent = "Nhấp một component để xem module bên trong.";
  elements.copy.disabled = !String(state.result?.mermaid || "").trim();
  renderDiagram(state.result);
}

function openDetail(componentKey) {
  const detail = state.result?.details?.[componentKey];
  if (!detail?.nodes?.length) return;
  state.viewKey = componentKey;
  elements.viewbar.hidden = false;
  elements.back.hidden = false;
  elements.viewTitle.textContent = detail.component_label || detail.title || componentKey;
  const stats = detail.stats || {};
  elements.viewHint.textContent = `${stats.modules || detail.nodes.length} module · ${stats.connections || detail.edges?.length || 0} luồng nội bộ`;
  elements.copy.disabled = !String(detail.mermaid || "").trim();
  renderDiagram(detail);
}

function renderResult(result) {
  state.result = result;
  const stats = result?.stats || {};
  elements.components.textContent = Number(stats.components || 0).toLocaleString("vi-VN");
  elements.modules.textContent = Number(stats.detail_modules || 0).toLocaleString("vi-VN");
  elements.connections.textContent = Number(stats.connections || 0).toLocaleString("vi-VN");
  elements.symbols.textContent = Number(stats.source_symbols || 0).toLocaleString("vi-VN");
  elements.relations.textContent = Number(stats.source_relationships || 0).toLocaleString("vi-VN");
  elements.summary.hidden = false;
  const warnings = Array.isArray(result?.warnings) ? result.warnings.filter(Boolean) : [];
  elements.warnings.hidden = !warnings.length;
  elements.warnings.textContent = warnings.join(" · ");
  showOverview();
  setStatus(`Đã rút ${stats.components || 0} component lớn và ${stats.detail_modules || 0} module chi tiết từ CodexGraph.`, "");
}

elements.analyze.addEventListener("click", () => {
  const root = elements.project.value;
  if (!root || !state.projects.some((project) => project.root === root)) return;
  state.requestId = requestId();
  elements.analyze.disabled = true;
  elements.copy.disabled = true;
  setStatus("CodexPro đang đọc CodexGraph và rút kiến trúc tổng quát…", "busy");
  window.parent.postMessage({ type: "codexpro:gitdiagram-analyze", request_id: state.requestId, root }, "*");
});

elements.copy.addEventListener("click", () => {
  const mermaid = String(activeDiagramResult()?.mermaid || "");
  if (!mermaid) return;
  window.parent.postMessage({ type: "codexpro:copy-text", text: mermaid, label: "GitDiagram Mermaid" }, "*");
});

elements.back.addEventListener("click", showOverview);

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  if (event.data?.type === "codexpro:plugin-context") {
    state.projects = Array.isArray(event.data.projects) ? event.data.projects.filter((project) => project?.root) : [];
    renderProjects();
    return;
  }
  if (event.data?.type === "codexpro:gitdiagram-result" && event.data?.request_id === state.requestId) {
    elements.analyze.disabled = !state.projects.length;
    renderResult(event.data.result || {});
    return;
  }
  if (event.data?.type === "codexpro:gitdiagram-error" && event.data?.request_id === state.requestId) {
    elements.analyze.disabled = !state.projects.length;
    setStatus(String(event.data.error || "Không phân tích được repo."), "error");
  }
});

fetch("./meta.json", { cache: "no-store" })
  .then((response) => response.ok ? response.json() : null)
  .then((meta) => {
    state.meta = meta;
    if (meta?.source_commit) elements.commit.textContent = `commit ${String(meta.source_commit).slice(0, 12)}`;
  })
  .catch(() => {});

window.parent.postMessage({ type: "codexpro:plugin-ready", plugin_id: "gitdiagram" }, "*");
