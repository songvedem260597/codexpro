import type { ExtractedFile } from "./extract.js";
import type { AnalysisRelationship, AnalysisRelationshipKind, AnalysisSymbol, InventoryFile } from "./types.js";

export function relationshipIdentity(relationship: AnalysisRelationship): string {
  return [
    relationship.kind,
    relationship.from,
    relationship.to,
    relationship.fromSymbolId ?? "",
    relationship.toSymbolId ?? "",
    relationship.detail ?? ""
  ].join("\u0000");
}

export function mergeRelationships(groups: AnalysisRelationship[][], maxRelationships: number): AnalysisRelationship[] {
  const merged: AnalysisRelationship[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const relationship of group) {
      if (merged.length >= maxRelationships) return merged;
      const key = relationshipIdentity(relationship);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(relationship);
    }
  }
  return merged;
}

export function buildRelationships(extractedFiles: ExtractedFile[], inventoryFiles: InventoryFile[], maxRelationships: number): AnalysisRelationship[] {
  const roles = new Map(inventoryFiles.map((file) => [file.path, file.role]));
  const relationships: AnalysisRelationship[] = [];
  for (const file of extractedFiles) {
    for (const target of file.imports) {
      if (relationships.length >= maxRelationships) return relationships;
      relationships.push({
        from: file.path,
        to: target,
        kind: roles.get(file.path) === "test" ? "tests" : "imports",
        confidence: "strong",
        source: "built-in import extraction"
      });
    }
  }
  return relationships;
}

export function reverseDependencies(relationships: AnalysisRelationship[], targetPath: string): AnalysisRelationship[] {
  return relationships.filter((relationship) => relationship.to === targetPath);
}

export interface GraphNeighborhood {
  symbolIds: Set<string>;
  distance: Map<string, number>;
  relationships: AnalysisRelationship[];
}

const IMPACT_EDGE_KINDS = new Set<AnalysisRelationshipKind>([
  "calls",
  "references",
  "reads",
  "writes",
  "extends",
  "implements",
  "tests",
  "ipc",
  "emits",
  "listens",
  "routes",
  "provides",
  "consumes",
  "passes",
  "stores",
  "contains"
]);

function symbolIdSet(symbols: AnalysisSymbol[]): Set<string> {
  return new Set(symbols.map((symbol) => symbol.id).filter((id): id is string => Boolean(id)));
}

function indexSymbolRelationships(
  relationships: AnalysisRelationship[],
  kinds: Set<AnalysisRelationshipKind>,
  direction: "incoming" | "connected"
): Map<string, AnalysisRelationship[]> {
  const indexed = new Map<string, AnalysisRelationship[]>();
  const append = (symbolId: string, relationship: AnalysisRelationship): void => {
    const bucket = indexed.get(symbolId);
    if (bucket) bucket.push(relationship);
    else indexed.set(symbolId, [relationship]);
  };
  for (const relationship of relationships) {
    if (!kinds.has(relationship.kind) || !relationship.fromSymbolId || !relationship.toSymbolId) continue;
    append(relationship.toSymbolId, relationship);
    if (direction === "connected" && relationship.fromSymbolId !== relationship.toSymbolId) append(relationship.fromSymbolId, relationship);
  }
  return indexed;
}

export function reverseSymbolNeighborhood(
  symbols: AnalysisSymbol[],
  relationships: AnalysisRelationship[],
  seedIds: Iterable<string>,
  options: { maxDepth?: number; kinds?: Set<AnalysisRelationshipKind> } = {}
): GraphNeighborhood {
  const knownSymbols = symbolIdSet(symbols);
  const maxDepth = Math.max(0, Math.min(options.maxDepth ?? 4, 12));
  const kinds = options.kinds ?? IMPACT_EDGE_KINDS;
  const incoming = indexSymbolRelationships(relationships, kinds, "incoming");
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const seed of seedIds) {
    if (!knownSymbols.has(seed) || distance.has(seed)) continue;
    distance.set(seed, 0);
    queue.push(seed);
  }
  const related: AnalysisRelationship[] = [];
  const relatedKeys = new Set<string>();
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const targetId = queue[cursor];
    const depth = distance.get(targetId) ?? 0;
    if (depth >= maxDepth) continue;
    for (const relationship of incoming.get(targetId) ?? []) {
      const key = relationshipIdentity(relationship);
      if (!relatedKeys.has(key)) {
        relatedKeys.add(key);
        related.push(relationship);
      }
      const callerId = relationship.fromSymbolId!;
      if (!knownSymbols.has(callerId) || distance.has(callerId)) continue;
      distance.set(callerId, depth + 1);
      queue.push(callerId);
    }
  }
  return { symbolIds: new Set(distance.keys()), distance, relationships: related };
}

export function connectedSymbolNeighborhood(
  symbols: AnalysisSymbol[],
  relationships: AnalysisRelationship[],
  seedIds: Iterable<string>,
  options: { maxDepth?: number; kinds?: Set<AnalysisRelationshipKind> } = {}
): GraphNeighborhood {
  const knownSymbols = symbolIdSet(symbols);
  const maxDepth = Math.max(0, Math.min(options.maxDepth ?? 2, 12));
  const kinds = options.kinds ?? IMPACT_EDGE_KINDS;
  const connected = indexSymbolRelationships(relationships, kinds, "connected");
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const seed of seedIds) {
    if (!knownSymbols.has(seed) || distance.has(seed)) continue;
    distance.set(seed, 0);
    queue.push(seed);
  }
  const related: AnalysisRelationship[] = [];
  const relatedKeys = new Set<string>();
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const currentId = queue[cursor];
    const depth = distance.get(currentId) ?? 0;
    if (depth >= maxDepth) continue;
    for (const relationship of connected.get(currentId) ?? []) {
      const key = relationshipIdentity(relationship);
      if (!relatedKeys.has(key)) {
        relatedKeys.add(key);
        related.push(relationship);
      }
      const neighborId = relationship.fromSymbolId === currentId ? relationship.toSymbolId! : relationship.fromSymbolId!;
      if (!knownSymbols.has(neighborId) || distance.has(neighborId)) continue;
      distance.set(neighborId, depth + 1);
      queue.push(neighborId);
    }
  }
  return { symbolIds: new Set(distance.keys()), distance, relationships: related };
}
