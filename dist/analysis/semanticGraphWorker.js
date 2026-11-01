import { parentPort, workerData } from "node:worker_threads";
import { analyzeTypeScriptSemanticGraph } from "./semanticGraph.js";
const input = workerData;
parentPort?.postMessage(analyzeTypeScriptSemanticGraph(input.root, input.inventoryFiles, input.maxSymbols, input.maxRelationships));
//# sourceMappingURL=semanticGraphWorker.js.map