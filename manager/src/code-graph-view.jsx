import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ControlsContainer,
  FullScreenControl,
  SigmaContainer,
  ZoomControl,
  useLoadGraph,
  useRegisterEvents,
  useSetSettings,
  useSigma
} from "@react-sigma/core";
import { LayoutForceAtlas2Control } from "@react-sigma/layout-forceatlas2";
import { MultiDirectedGraph } from "graphology";
import "@react-sigma/core/lib/style.css";
import "./code-graph.css";

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const NODE_COLORS = {
  module: "#73d7a3",
  class: "#8db4ff",
  interface: "#9dc7ff",
  function: "#c59cff",
  method: "#cda9ff",
  variable: "#f0bd72",
  property: "#edcb8e",
  enum: "#ff9c9c",
  type: "#7ed6d6",
  channel: "#67e6d0",
  event: "#f58fc5",
  route: "#ffad73",
  context: "#73e0c2",
  store: "#ffd166",
  ref: "#7bdff2",
  default: "#9aa7ba"
};
const EDGE_COLORS = {
  calls: "#7edca6",
  references: "#6d8fb4",
  reads: "#d8b36d",
  writes: "#ef8f79",
  ipc: "#5ddfc8",
  emits: "#e483bb",
  listens: "#cf8fd0",
  routes: "#e9a266",
  imports: "#5d738f",
  contains: "#39485e",
  extends: "#7b9eea",
  implements: "#82b4dc",
  tests: "#a7ce72",
  provides: "#70e1c1",
  consumes: "#4fc3a1",
  passes: "#caa5ff",
  stores: "#f2c76e",
  default: "#516071"
};

const RELATION_GROUPS = {
  all: null,
  flow: new Set(["calls", "references", "reads", "writes", "ipc", "emits", "listens", "routes", "tests", "provides", "consumes", "passes", "stores"]),
  structure: new Set(["contains", "imports", "extends", "implements"])
};

function compactPath(value = "") {
  return String(value).replace(/\\/g, "/");
}

function areaForPath(value = "") {
  const normalized = compactPath(value);
  if (!normalized) return "other";
  if (normalized.startsWith("@virtual/")) return "@virtual";
  const [first] = normalized.split("/");
  return first || ".";
}

function sizeForSymbol(symbol) {
  if (symbol?.virtual) return 5.2;
  switch (symbol?.kind) {
    case "module": return 5;
    case "class": return 4.8;
    case "interface": return 4.3;
    case "function": return 3.2;
    case "method": return 2.9;
    case "enum": return 3.7;
    case "type": return 3.2;
    case "channel":
    case "event":
    case "route": return 5.2;
    case "variable":
    case "property": return 2.2;
    default: return 2.4;
  }
}

function buildGraph(graphData) {
  const graph = new MultiDirectedGraph({ allowSelfLoops: true });
  const symbols = (Array.isArray(graphData?.nodes) ? graphData.nodes : Array.isArray(graphData?.symbols) ? graphData.symbols : [])
    .filter((symbol) => symbol && (symbol.id !== undefined || symbol.key !== undefined));
  const grouped = new Map();

  for (const symbol of symbols) {
    const area = areaForPath(symbol.path);
    const bucket = grouped.get(area) || [];
    bucket.push(symbol);
    grouped.set(area, bucket);
  }

  const areaEntries = [...grouped.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const areaCount = Math.max(1, areaEntries.length);
  const orbit = Math.max(35, areaCount * 5.5);

  areaEntries.forEach(([area, entries], areaIndex) => {
    const centerAngle = (Math.PI * 2 * areaIndex) / areaCount - Math.PI / 2;
    const centerX = Math.cos(centerAngle) * orbit;
    const centerY = Math.sin(centerAngle) * orbit;
    const localRadius = Math.max(8, Math.sqrt(entries.length) * 0.75);

    entries.forEach((symbol, index) => {
      const nodeKey = String(symbol.id ?? symbol.key);
      const angle = index * GOLDEN_ANGLE;
      const distance = Math.sqrt((index + 0.5) / Math.max(1, entries.length)) * localRadius;
      graph.addNode(nodeKey, {
        x: centerX + Math.cos(angle) * distance,
        y: centerY + Math.sin(angle) * distance,
        size: sizeForSymbol(symbol),
        color: NODE_COLORS[symbol.kind] || NODE_COLORS.default,
        label: symbol.name || nodeKey,
        kind: symbol.kind || "symbol",
        path: compactPath(symbol.path),
        area,
        line: symbol.line,
        source: symbol.source,
        confidence: symbol.confidence,
        virtual: Boolean(symbol.virtual),
        exported: Boolean(symbol.exported),
        raw: symbol
      });
    });
  });

  const relationships = Array.isArray(graphData?.edges) ? graphData.edges : Array.isArray(graphData?.relationships) ? graphData.relationships : [];
  relationships.forEach((relationship, index) => {
    const sourceValue = relationship?.source ?? relationship?.fromSymbolId ?? (relationship?.from ? `module:${compactPath(relationship.from)}` : undefined);
    const targetValue = relationship?.target ?? relationship?.toSymbolId ?? (relationship?.to ? `module:${compactPath(relationship.to)}` : undefined);
    if (sourceValue === undefined || targetValue === undefined) return;
    const source = String(sourceValue);
    const target = String(targetValue);
    if (!graph.hasNode(source) || !graph.hasNode(target)) return;
    graph.addEdgeWithKey(`edge:${index}`, source, target, {
      kind: relationship.kind || "relationship",
      label: relationship.kind || "relationship",
      size: relationship.kind === "ipc" || relationship.kind === "routes" ? 1.15 : 0.55,
      color: EDGE_COLORS[relationship.kind] || EDGE_COLORS.default,
      raw: relationship
    });
  });

  return graph;
}

function GraphLoader({ graph }) {
  const loadGraph = useLoadGraph();
  useEffect(() => {
    loadGraph(graph, true);
  }, [graph, loadGraph]);
  return null;
}

function compactHoverLabel(value, maxLength = 68) {
  const label = String(value || "").trim();
  if (label.length <= maxLength) return label;
  return `${label.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function drawCodexGraphNodeHover(context, data, settings) {
  const label = compactHoverLabel(data.label);
  const fontSize = Number(settings.labelSize || 12);
  const fontFamily = settings.labelFont || "Segoe UI";
  const fontWeight = settings.labelWeight || "500";
  const nodeRadius = Math.max(4, Number(data.size || 2) + 3);

  context.save();
  context.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  context.textBaseline = "middle";
  context.lineWidth = 1;
  context.shadowColor = "#000b";
  context.shadowBlur = 10;

  context.beginPath();
  context.arc(data.x, data.y, nodeRadius, 0, Math.PI * 2);
  context.fillStyle = "#101821f2";
  context.fill();
  context.strokeStyle = "#6a7b90";
  context.stroke();

  if (label) {
    const paddingX = 8;
    const height = Math.max(24, fontSize + 10);
    const width = Math.ceil(context.measureText(label).width + paddingX * 2);
    const x = data.x + nodeRadius + 5;
    const y = data.y - height / 2;
    const radius = 6;

    context.beginPath();
    context.roundRect(x, y, width, height, radius);
    context.fillStyle = "#101821f2";
    context.fill();
    context.strokeStyle = "#465568";
    context.stroke();

    context.shadowBlur = 0;
    context.fillStyle = "#eef4fb";
    context.fillText(label, x + paddingX, data.y);
  }

  context.restore();
}

function GraphInteraction({ query, area, relationGroup, selectedNode, onSelectNode }) {
  const sigma = useSigma();
  const registerEvents = useRegisterEvents();
  const setSettings = useSetSettings();

  useEffect(() => {
    registerEvents({
      clickNode: ({ node }) => onSelectNode(node),
      clickStage: () => onSelectNode("")
    });
  }, [onSelectNode, registerEvents]);

  useEffect(() => {
    const graph = sigma.getGraph();
    const needle = query.trim().toLowerCase();
    const selectedExists = selectedNode && graph.hasNode(selectedNode);
    const neighborhood = selectedExists ? new Set([selectedNode, ...graph.neighbors(selectedNode)]) : null;
    const allowedRelations = RELATION_GROUPS[relationGroup] || null;

    const nodeVisible = (node) => {
      const attrs = graph.getNodeAttributes(node);
      if (area !== "all" && attrs.area !== area) return false;
      if (!needle) return true;
      return `${attrs.label || ""} ${attrs.path || ""} ${attrs.kind || ""}`.toLowerCase().includes(needle);
    };

    setSettings({
      nodeReducer: (node, data) => {
        const reduced = { ...data };
        if (!nodeVisible(node)) {
          reduced.hidden = true;
          return reduced;
        }
        if (selectedExists) {
          if (node === selectedNode) {
            reduced.size = Math.max(8, Number(data.size || 2) * 2.2);
            reduced.highlighted = true;
            reduced.zIndex = 4;
          } else if (neighborhood?.has(node)) {
            reduced.size = Math.max(4.5, Number(data.size || 2) * 1.35);
            reduced.zIndex = 3;
          } else {
            reduced.color = "#35404d";
            reduced.label = "";
            reduced.zIndex = 0;
          }
        } else if (needle) {
          reduced.size = Math.max(6, Number(data.size || 2) * 1.7);
          reduced.highlighted = true;
          reduced.zIndex = 3;
        }
        return reduced;
      },
      edgeReducer: (edge, data) => {
        const reduced = { ...data };
        const [source, target] = graph.extremities(edge);
        if (!nodeVisible(source) || !nodeVisible(target) || (allowedRelations && !allowedRelations.has(data.kind))) {
          reduced.hidden = true;
          return reduced;
        }
        if (selectedExists && source !== selectedNode && target !== selectedNode) {
          reduced.color = "#29323d";
          reduced.size = 0.25;
        } else if (selectedExists) {
          reduced.size = Math.max(1.4, Number(data.size || 0.5) * 1.8);
          reduced.zIndex = 2;
        }
        return reduced;
      }
    });
    sigma.refresh();
  }, [area, query, relationGroup, selectedNode, setSettings, sigma]);

  return null;
}

function GraphDropdown({ label, value, options, onChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const selected = options.find((option) => option.value === value) || options[0];

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className={`codexgraph-filter${open ? " is-open" : ""}`} ref={rootRef}>
      <span className="codexgraph-filter-label">{label}</span>
      <button
        type="button"
        className="codexgraph-filter-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={`codexgraph-filter-dot is-${selected?.tone || "default"}`} aria-hidden="true" />
        <span className="codexgraph-filter-value">{selected?.label || value}</span>
        <span className="codexgraph-filter-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="codexgraph-filter-menu" role="listbox" aria-label={label}>
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={active}
                className={`codexgraph-filter-option${active ? " is-active" : ""}`}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span className={`codexgraph-filter-dot is-${option.tone || "default"}`} aria-hidden="true" />
                <span className="codexgraph-filter-option-copy">
                  <strong>{option.label}</strong>
                  {option.hint && <small>{option.hint}</small>}
                </span>
                <span className="codexgraph-filter-check" aria-hidden="true">✓</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DetailPanel({ graphData, selectedNode }) {
  const symbols = Array.isArray(graphData?.nodes) ? graphData.nodes : Array.isArray(graphData?.symbols) ? graphData.symbols : [];
  const relationships = Array.isArray(graphData?.edges) ? graphData.edges : Array.isArray(graphData?.relationships) ? graphData.relationships : [];
  const keyFor = (symbol) => String(symbol?.id ?? symbol?.key ?? "");
  const selected = selectedNode ? symbols.find((symbol) => keyFor(symbol) === selectedNode) : null;
  const symbolById = useMemo(() => new Map(symbols.map((symbol) => [keyFor(symbol), symbol]).filter(([key]) => key)), [symbols]);
  const related = useMemo(() => {
    if (!selectedNode) return [];
    return relationships
      .map((edge) => ({ ...edge, sourceKey: String(edge?.source ?? edge?.fromSymbolId ?? ""), targetKey: String(edge?.target ?? edge?.toSymbolId ?? "") }))
      .filter((edge) => edge.sourceKey === selectedNode || edge.targetKey === selectedNode)
      .slice(0, 18)
      .map((edge) => {
        const outgoing = edge.sourceKey === selectedNode;
        const otherId = outgoing ? edge.targetKey : edge.sourceKey;
        const other = symbolById.get(otherId);
        return {
          kind: edge.kind || "relationship",
          direction: outgoing ? "→" : "←",
          label: other?.name || edge.to || edge.from || otherId || "unknown",
          path: other?.path || ""
        };
      });
  }, [relationships, selectedNode, symbolById]);

  if (!selected) {
    return (
      <aside className="codexgraph-detail is-empty">
        <div className="codexgraph-detail-icon" aria-hidden="true">◎</div>
        <strong>Chọn một node</strong>
        <span>Click node trên map để xem symbol, file và các liên kết CodexGraph trực tiếp.</span>
      </aside>
    );
  }

  return (
    <aside className="codexgraph-detail">
      <div className="codexgraph-detail-head">
        <span className={`codexgraph-kind is-${String(selected.kind || "symbol").replace(/[^a-z0-9_-]/gi, "-")}`}>{selected.kind || "symbol"}</span>
        {selected.virtual && <span className="codexgraph-virtual">virtual</span>}
      </div>
      <h3>{selected.name || keyFor(selected)}</h3>
      <code className="codexgraph-path">{compactPath(selected.path)}{selected.line ? `:${selected.line}` : ""}</code>
      <div className="codexgraph-meta">
        <div><small>Confidence</small><strong>{selected.confidence || "—"}</strong></div>
        <div><small>Source</small><strong>{selected.source || "—"}</strong></div>
      </div>
      <div className="codexgraph-related-head"><span>Liên kết gần</span><strong>{related.length}</strong></div>
      <div className="codexgraph-related-list">
        {related.length ? related.map((item, index) => (
          <div key={`${item.kind}:${item.label}:${index}`} className="codexgraph-related-row">
            <span className="codexgraph-related-kind">{item.kind}</span>
            <span className="codexgraph-related-direction">{item.direction}</span>
            <span className="codexgraph-related-copy"><strong>{item.label}</strong>{item.path && <small>{compactPath(item.path)}</small>}</span>
          </div>
        )) : <div className="codexgraph-related-empty">Không có edge trực tiếp trong payload hiện tại.</div>}
      </div>
    </aside>
  );
}

export function CodeGraphView({ graphData }) {
  const [query, setQuery] = useState("");
  const [area, setArea] = useState("all");
  const [relationGroup, setRelationGroup] = useState("all");
  const [selectedNode, setSelectedNode] = useState("");
  const graph = useMemo(() => buildGraph(graphData), [graphData]);
  const coverage = graphData?.coverage || {};
  const areas = useMemo(() => {
    const values = new Set(graph.nodes().map((node) => graph.getNodeAttribute(node, "area")).filter(Boolean));
    return [...values].sort((a, b) => a.localeCompare(b));
  }, [graph]);
  const areaOptions = useMemo(() => [
    { value: "all", label: "Tất cả khu vực", hint: `${graph.order.toLocaleString()} nodes`, tone: "all" },
    ...areas.map((value) => ({ value, label: value, hint: "Lọc theo thư mục gốc", tone: "area" }))
  ], [areas, graph.order]);
  const relationOptions = useMemo(() => [
    { value: "all", label: "Tất cả quan hệ", hint: "Hiển thị mọi edge", tone: "all" },
    { value: "flow", label: "Luồng gọi / state / IPC", hint: "Calls, reads, writes, events…", tone: "flow" },
    { value: "structure", label: "Cấu trúc / import", hint: "Contains, imports, extends…", tone: "structure" }
  ], []);

  const visibleSymbols = Array.isArray(graphData?.nodes) ? graphData.nodes.length : Array.isArray(graphData?.symbols) ? graphData.symbols.length : 0;
  const visibleRelationships = Array.isArray(graphData?.edges) ? graphData.edges.length : Array.isArray(graphData?.relationships) ? graphData.relationships.length : 0;
  const warning = Array.isArray(graphData?.warnings) ? graphData.warnings[0] : "";

  if (!visibleSymbols) {
    return (
      <section className="codexgraph-empty">
        <strong>CodexGraph chưa trả symbol graph</strong>
        <span>Hãy kiểm tra CODEXPRO_ANALYSIS và chạy lại “Kiểm tra qua MCP”.</span>
      </section>
    );
  }

  return (
    <section className="codexgraph-shell">
      <div className="codexgraph-summary">
        <div className="codexgraph-summary-copy">
          <p className="eyebrow">CODEXGRAPH LIVE MAP</p>
          <h3>Neural code map</h3>
          <p>Map này render trực tiếp từ <code>nodes</code> và <code>edges</code> compact của CodexGraph.</p>
        </div>
        <div className="codexgraph-metrics">
          <div><strong>{Number(coverage.symbolCount || visibleSymbols).toLocaleString()}</strong><span>symbols</span></div>
          <div><strong>{Number(coverage.relationshipCount || visibleRelationships).toLocaleString()}</strong><span>relations</span></div>
          <div><strong>{graph.order.toLocaleString()}</strong><span>nodes render</span></div>
          <div><strong>{graph.size.toLocaleString()}</strong><span>edges render</span></div>
        </div>
      </div>

      <div className="codexgraph-toolbar">
        <label className="codexgraph-search">
          <span aria-hidden="true">⌕</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm function, class, file..." />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="Xóa tìm kiếm">×</button>}
        </label>
        <GraphDropdown
          label="Khu vực"
          value={area}
          options={areaOptions}
          onChange={(nextArea) => {
            setArea(nextArea);
            setSelectedNode("");
          }}
        />
        <GraphDropdown
          label="Edge"
          value={relationGroup}
          options={relationOptions}
          onChange={setRelationGroup}
        />
        <div className="codexgraph-live"><i />CodexGraph active</div>
      </div>

      <div className="codexgraph-stage-grid">
        <div className="codexgraph-stage">
          <SigmaContainer
            graph={MultiDirectedGraph}
            className="codexgraph-sigma"
            settings={{
              allowInvalidContainer: true,
              defaultNodeColor: NODE_COLORS.default,
              defaultEdgeColor: EDGE_COLORS.default,
              labelColor: { color: "#dce6f1" },
              labelFont: "Segoe UI",
              labelSize: 12,
              labelWeight: "500",
              defaultDrawNodeHover: drawCodexGraphNodeHover,
              labelDensity: 0.16,
              labelGridCellSize: 120,
              labelRenderedSizeThreshold: 8,
              edgeColor: "default",
              renderEdgeLabels: false,
              enableEdgeEvents: false,
              zIndex: true,
              hideEdgesOnMove: true,
              hideLabelsOnMove: true
            }}
          >
            <GraphLoader graph={graph} />
            <GraphInteraction
              query={query}
              area={area}
              relationGroup={relationGroup}
              selectedNode={selectedNode}
              onSelectNode={setSelectedNode}
            />
            <ControlsContainer position="bottom-right">
              <ZoomControl />
              <FullScreenControl />
              <LayoutForceAtlas2Control settings={{ settings: { slowDown: 10, gravity: 0.8, scalingRatio: 2 } }} />
            </ControlsContainer>
          </SigmaContainer>
          <div className="codexgraph-hint">Wheel để zoom · kéo nền để pan · click node để soi quan hệ · nút mạng ở góc phải chạy ForceAtlas2 worker</div>
        </div>
        <DetailPanel graphData={graphData} selectedNode={selectedNode} />
      </div>

      {(graphData?.output_limited || warning) && (
        <div className="codexgraph-warning">
          <strong>{graphData?.output_limited ? "Payload đang bị giới hạn." : "CodexGraph warning"}</strong>
          {warning && <span>{warning}</span>}
        </div>
      )}
    </section>
  );
}
