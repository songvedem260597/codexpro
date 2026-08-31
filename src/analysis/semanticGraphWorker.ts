import { parentPort, workerData } from "node:worker_threads";
import { analyzeTypeScriptSemanticGraph } from "./semanticGraph.js";
import type { InventoryFile } from "./types.js";

const input = workerData as {
  root: string;
  inventoryFiles: InventoryFile[];
  maxSymbols: number;
  maxRelationships: number;
};

parentPort?.postMessage(analyzeTypeScriptSemanticGraph(
  input.root,
  input.inventoryFiles,
  input.maxSymbols,
  input.maxRelationships
));
