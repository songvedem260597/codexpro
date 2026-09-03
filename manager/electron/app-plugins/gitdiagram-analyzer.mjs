const FLOW_PRIORITY = new Map([
  ["ipc", 0],
  ["routes", 1],
  ["provides", 2],
  ["consumes", 3],
  ["passes", 4],
  ["calls", 5],
  ["writes", 6],
  ["reads", 7],
  ["emits", 8],
  ["listens", 9],
  ["stores", 10],
  ["references", 11],
  ["imports", 20],
  ["extends", 21],
  ["implements", 22],
  ["contains", 30]
]);

const ROOT_SPLIT_SEGMENTS = new Set(["src", "app", "lib", "packages", "apps", "services", "manager"]);
const NOISE_SEGMENTS = new Set(["test", "tests", "__tests__", "spec", "specs", "fixtures", "examples", "docs", "coverage", "dist", "build", "node_modules"]);
const LABEL_WORDS = new Map([
  ["api", "API"],
  ["apis", "API"],
  ["ui", "UI"],
  ["web", "Web"],
  ["frontend", "Frontend"],
  ["backend", "Backend"],
  ["client", "Client"],
  ["server", "Server"],
  ["electron", "Electron Runtime"],
  ["analysis", "Analysis Engine"],
  ["graph", "Graph Engine"],
  ["worker", "Worker"],
  ["workers", "Workers"],
  ["worker-core", "Worker Core"],
  ["chrome-extension", "Chrome Extension"],
  ["extension", "Extension"],
  ["mcp", "MCP"],
  ["db", "Database"],
  ["database", "Database"],
  ["storage", "Storage"],
  ["auth", "Authentication"],
  ["routes", "Routes"],
  ["components", "Components"],
  ["core", "Core"],
  ["runtime", "Runtime"],
  ["plugins", "Plugins"],
  ["app-plugins", "App Plugins"]
]);

function normalizedPath(value = "") {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function isNoisePath(value = "") {
  const lower = normalizedPath(value).toLowerCase();
  if (!lower || lower.startsWith("@virtual/")) return true;
  const segments = lower.split("/");
  if (segments.some((segment) => NOISE_SEGMENTS.has(segment))) return true;
  return /(?:^|\/)[^/]*(?:\.test|\.spec)\.[^/]+$/.test(lower);
}

function componentKeyForPath(value = "") {
  const path = normalizedPath(value);
  if (!path || isNoisePath(path)) return "";
  const segments = path.split("/").filter(Boolean);
  if (!segments.length) return "";
  if (segments.length === 1) return "root";
  const first = segments[0].toLowerCase();
  if (ROOT_SPLIT_SEGMENTS.has(first) && segments[1]) return `${segments[0]}/${segments[1]}`;
  return segments[0];
}

function titleCaseToken(token) {
  const known = LABEL_WORDS.get(String(token || "").toLowerCase());
  if (known) return known;
  return String(token || "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.length <= 3 && part === part.toUpperCase() ? part : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function labelForComponent(key) {
  if (key === "root") return "Application Core";
  const segments = String(key || "").split("/").filter(Boolean);
  if (segments.length === 2 && segments[0].toLowerCase() === "src") return titleCaseToken(segments[1]);
  if (segments.length === 2 && segments[0].toLowerCase() === "app") return titleCaseToken(segments[1]);
  if (segments.length === 2 && segments[0].toLowerCase() === "lib") return titleCaseToken(segments[1]);
  if (segments.length === 2 && segments[0].toLowerCase() === "manager" && segments[1].toLowerCase() === "src") return "Manager UI";
  if (segments.length === 2 && segments[0].toLowerCase() === "manager" && segments[1].toLowerCase() === "electron") return "Manager Runtime";
  return segments.map(titleCaseToken).join(" · ");
}

function edgeLabel(kind) {
  switch (String(kind || "")) {
    case "ipc": return "IPC";
    case "routes": return "route";
    case "provides": return "provides";
    case "consumes": return "uses";
    case "passes": return "passes";
    case "calls": return "calls";
    case "writes": return "writes";
    case "reads": return "reads";
    case "emits": return "event";
    case "listens": return "listens";
    case "stores": return "stores";
    case "imports": return "imports";
    case "references": return "uses";
    default: return String(kind || "flow");
  }
}

function escapeMermaid(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "'").replace(/[\r\n]+/g, " ").replace(/\|/g, "/");
}

function computeLayers(nodes, edges) {
  if (!nodes.length) return new Map();
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!incoming.has(edge.to) || !outgoing.has(edge.from)) continue;
    incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1);
    outgoing.get(edge.from).push(edge.to);
  }
  const hinted = nodes.find((node) => /ui|front|client|web|manager ui/i.test(node.label));
  const root = hinted || [...nodes].sort((a, b) => {
    const outgoingDelta = (outgoing.get(b.id)?.length || 0) - (outgoing.get(a.id)?.length || 0);
    if (outgoingDelta) return outgoingDelta;
    const incomingDelta = (incoming.get(a.id) || 0) - (incoming.get(b.id) || 0);
    if (incomingDelta) return incomingDelta;
    return b.score - a.score;
  })[0];
  const layers = new Map([[root.id, 0]]);
  const queue = [root.id];
  while (queue.length) {
    const current = queue.shift();
    const nextLayer = Math.min(5, (layers.get(current) || 0) + 1);
    for (const target of outgoing.get(current) || []) {
      if (layers.has(target)) continue;
      layers.set(target, nextLayer);
      queue.push(target);
    }
  }
  let fallback = Math.min(5, Math.max(0, ...layers.values()) + 1);
  for (const node of nodes) {
    if (layers.has(node.id)) continue;
    layers.set(node.id, fallback);
    fallback = Math.min(5, fallback + 1);
  }
  return layers;
}

function compileMermaid(nodes, edges) {
  const lines = ["flowchart TD"];
  for (const node of nodes) lines.push(`  ${node.id}["${escapeMermaid(node.label)}"]`);
  for (const edge of edges) lines.push(`  ${edge.from} -->|${escapeMermaid(edge.label)}| ${edge.to}`);
  return lines.join("\n");
}

export function buildGitDiagramArchitecture(inspection, options = {}) {
  const maxComponents = Math.max(4, Math.min(14, Number(options.maxComponents) || 10));
  const maxEdges = Math.max(4, Math.min(28, Number(options.maxEdges) || 18));
  const graph = inspection?.codexgraph || inspection || {};
  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const rawEdges = Array.isArray(graph.edges) ? graph.edges : [];
  const componentByNode = new Map();
  const stats = new Map();

  for (const node of rawNodes) {
    const key = componentKeyForPath(node?.path);
    if (!key) continue;
    const nodeId = String(node?.key ?? node?.id ?? "");
    if (!nodeId) continue;
    componentByNode.set(nodeId, key);
    const current = stats.get(key) || { key, symbolCount: 0, crossDegree: 0, paths: new Map(), edgeKinds: new Map() };
    current.symbolCount += 1;
    const path = normalizedPath(node?.path);
    if (path) current.paths.set(path, (current.paths.get(path) || 0) + 1);
    stats.set(key, current);
  }

  const crossEdges = [];
  for (const edge of rawEdges) {
    const from = componentByNode.get(String(edge?.source ?? edge?.fromSymbolId ?? ""));
    const to = componentByNode.get(String(edge?.target ?? edge?.toSymbolId ?? ""));
    if (!from || !to || from === to) continue;
    const kind = String(edge?.kind || "references");
    const priority = FLOW_PRIORITY.get(kind) ?? 50;
    crossEdges.push({ from, to, kind, priority });
    const left = stats.get(from);
    const right = stats.get(to);
    if (left) {
      left.crossDegree += priority <= 11 ? 2 : 1;
      left.edgeKinds.set(kind, (left.edgeKinds.get(kind) || 0) + 1);
    }
    if (right) {
      right.crossDegree += priority <= 11 ? 2 : 1;
      right.edgeKinds.set(kind, (right.edgeKinds.get(kind) || 0) + 1);
    }
  }

  const ranked = [...stats.values()]
    .map((item) => ({ ...item, score: item.symbolCount + item.crossDegree * 4 }))
    .sort((a, b) => b.score - a.score || b.symbolCount - a.symbolCount || a.key.localeCompare(b.key))
    .slice(0, maxComponents);
  const selectedKeys = new Set(ranked.map((item) => item.key));
  const idByKey = new Map(ranked.map((item, index) => [item.key, `n${index + 1}`]));

  const aggregated = new Map();
  for (const edge of crossEdges) {
    if (!selectedKeys.has(edge.from) || !selectedKeys.has(edge.to)) continue;
    const pair = `${edge.from}\u0000${edge.to}`;
    const current = aggregated.get(pair) || { from: edge.from, to: edge.to, total: 0, kinds: new Map(), bestPriority: 999 };
    current.total += 1;
    current.kinds.set(edge.kind, (current.kinds.get(edge.kind) || 0) + 1);
    current.bestPriority = Math.min(current.bestPriority, edge.priority);
    aggregated.set(pair, current);
  }

  let edges = [...aggregated.values()].map((item) => {
    const [kind, kindCount] = [...item.kinds.entries()].sort((a, b) => {
      const priority = (FLOW_PRIORITY.get(a[0]) ?? 50) - (FLOW_PRIORITY.get(b[0]) ?? 50);
      return priority || b[1] - a[1] || a[0].localeCompare(b[0]);
    })[0] || ["references", 0];
    return {
      from: idByKey.get(item.from),
      to: idByKey.get(item.to),
      kind,
      label: edgeLabel(kind),
      weight: item.total,
      kind_weight: kindCount,
      priority: item.bestPriority
    };
  }).filter((edge) => edge.from && edge.to);

  const flowEdges = edges.filter((edge) => edge.priority <= 11);
  if (flowEdges.length >= Math.min(4, ranked.length - 1)) edges = flowEdges;
  edges = edges
    .sort((a, b) => a.priority - b.priority || b.weight - a.weight || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
    .slice(0, maxEdges);

  let nodes = ranked.map((item) => {
    const representative = [...item.paths.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || item.key;
    return {
      id: idByKey.get(item.key),
      key: item.key,
      label: labelForComponent(item.key),
      description: `${item.symbolCount.toLocaleString("en-US")} symbols · ${item.crossDegree.toLocaleString("en-US")} cross-links`,
      path: representative,
      symbol_count: item.symbolCount,
      score: item.score
    };
  });

  const layers = computeLayers(nodes, edges);
  nodes = nodes.map((node) => ({ ...node, layer: layers.get(node.id) || 0 }));
  const mermaid = compileMermaid(nodes, edges);
  const coverage = graph.coverage || {};
  return {
    schema_version: 1,
    source: "GitDiagram adapter + CodexGraph",
    title: "System architecture overview",
    root: String(inspection?.root || inspection?.workspace_root || ""),
    nodes,
    edges,
    mermaid,
    stats: {
      source_symbols: Number(coverage.symbolCount || rawNodes.length) || rawNodes.length,
      source_relationships: Number(coverage.relationshipCount || rawEdges.length) || rawEdges.length,
      components: nodes.length,
      connections: edges.length
    },
    warnings: [
      ...(Array.isArray(graph.warnings) ? graph.warnings.slice(0, 2) : []),
      ...(nodes.length < 2 ? ["CodexGraph chưa đủ dữ liệu để dựng kiến trúc tổng quát."] : [])
    ]
  };
}
