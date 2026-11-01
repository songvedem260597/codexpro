const PAYLOAD_OVERHEAD_BYTES = 32 * 1024;
const NODE_BUDGET_RATIO = 0.68;
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
    ["tests", 10],
    ["references", 11],
    ["extends", 12],
    ["implements", 13],
    ["imports", 14],
    ["stores", 15],
    ["contains", 16]
]);
function endpointId(relationship, side) {
    const explicit = side === "from" ? relationship.fromSymbolId : relationship.toSymbolId;
    if (explicit)
        return explicit;
    const filePath = side === "from" ? relationship.from : relationship.to;
    return filePath ? `module:${filePath}` : undefined;
}
function encodedBytes(value) {
    return Buffer.byteLength(JSON.stringify(value), "utf8") + 1;
}
function nodeTier(symbol) {
    if (symbol.virtual)
        return 4;
    if (["context", "store", "ref", "channel", "event", "route"].includes(symbol.kind))
        return 4;
    if (symbol.kind === "module")
        return 3;
    if (symbol.exported)
        return 2;
    return 1;
}
function compareSymbols(a, b, degree) {
    const tier = nodeTier(b) - nodeTier(a);
    if (tier)
        return tier;
    const degreeDelta = (degree.get(b.id ?? "") ?? 0) - (degree.get(a.id ?? "") ?? 0);
    if (degreeDelta)
        return degreeDelta;
    if (a.path !== b.path)
        return a.path.localeCompare(b.path);
    if (a.line !== b.line)
        return a.line - b.line;
    if (a.kind !== b.kind)
        return a.kind.localeCompare(b.kind);
    if (a.name !== b.name)
        return a.name.localeCompare(b.name);
    return String(a.id ?? "").localeCompare(String(b.id ?? ""));
}
function compactNode(symbol, key) {
    return {
        key,
        name: symbol.name,
        kind: symbol.kind,
        path: symbol.path,
        line: symbol.line,
        ...(symbol.virtual ? { virtual: true } : {}),
        ...(symbol.exported ? { exported: true } : {}),
        ...(symbol.confidence ? { confidence: symbol.confidence } : {}),
        ...(symbol.source ? { source: symbol.source } : {})
    };
}
export function projectCompactGraph(symbols, relationships, options) {
    const maxNodes = Math.max(1, Math.floor(options.maxNodes));
    const maxEdges = Math.max(1, Math.floor(options.maxEdges));
    const maxPayloadBytes = Math.max(256 * 1024, Math.floor(options.maxPayloadBytes));
    const symbolById = new Map(symbols.filter((symbol) => Boolean(symbol.id)).map((symbol) => [symbol.id, symbol]));
    const degree = new Map();
    for (const relationship of relationships) {
        const fromId = endpointId(relationship, "from");
        const toId = endpointId(relationship, "to");
        if (!fromId || !toId || !symbolById.has(fromId) || !symbolById.has(toId))
            continue;
        degree.set(fromId, (degree.get(fromId) ?? 0) + 1);
        degree.set(toId, (degree.get(toId) ?? 0) + 1);
    }
    const rankedSymbols = [...symbolById.values()].sort((a, b) => compareSymbols(a, b, degree));
    const usableBytes = Math.max(128 * 1024, maxPayloadBytes - PAYLOAD_OVERHEAD_BYTES);
    const nodeByteBudget = Math.floor(usableBytes * NODE_BUDGET_RATIO);
    const nodes = [];
    const keyBySymbolId = new Map();
    let estimatedBytes = 4;
    let byteLimited = false;
    for (const symbol of rankedSymbols) {
        if (nodes.length >= maxNodes)
            break;
        const node = compactNode(symbol, nodes.length);
        const bytes = encodedBytes(node);
        if (estimatedBytes + bytes > nodeByteBudget) {
            byteLimited = true;
            break;
        }
        keyBySymbolId.set(symbol.id, node.key);
        nodes.push(node);
        estimatedBytes += bytes;
    }
    const eligible = [];
    relationships.forEach((relationship, order) => {
        const fromId = endpointId(relationship, "from");
        const toId = endpointId(relationship, "to");
        if (!fromId || !toId || !keyBySymbolId.has(fromId) || !keyBySymbolId.has(toId))
            return;
        eligible.push({
            relationship,
            fromId,
            toId,
            degree: (degree.get(fromId) ?? 0) + (degree.get(toId) ?? 0),
            order
        });
    });
    eligible.sort((a, b) => {
        const kindPriority = (FLOW_PRIORITY.get(a.relationship.kind) ?? 100) - (FLOW_PRIORITY.get(b.relationship.kind) ?? 100);
        if (kindPriority)
            return kindPriority;
        if (a.degree !== b.degree)
            return b.degree - a.degree;
        return a.order - b.order;
    });
    const edges = [];
    for (const item of eligible) {
        if (edges.length >= maxEdges)
            break;
        const edge = {
            source: keyBySymbolId.get(item.fromId),
            target: keyBySymbolId.get(item.toId),
            kind: item.relationship.kind
        };
        const bytes = encodedBytes(edge);
        if (estimatedBytes + bytes > usableBytes) {
            byteLimited = true;
            break;
        }
        edges.push(edge);
        estimatedBytes += bytes;
    }
    const outputLimited = nodes.length < rankedSymbols.length || edges.length < eligible.length || byteLimited;
    return {
        nodes,
        edges,
        eligibleNodes: rankedSymbols.length,
        eligibleEdges: eligible.length,
        outputLimited,
        byteLimited,
        limits: {
            max_nodes: maxNodes,
            max_edges: maxEdges,
            max_payload_bytes: maxPayloadBytes,
            estimated_payload_bytes: estimatedBytes + PAYLOAD_OVERHEAD_BYTES
        }
    };
}
//# sourceMappingURL=projection.js.map