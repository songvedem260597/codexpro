import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const importBuilt = (relativePath) => import(pathToFileURL(path.join(projectRoot, 'dist', relativePath)).href);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-codexgraph-'));
const graphHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-codexgraph-home-'));
process.env.CODEXPRO_HOME = graphHome;

async function write(relativePath, content) {
  const target = path.join(tmp, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

function symbolByName(analysis, name, file) {
  const matches = analysis.symbols.filter((symbol) => symbol.name === name && (!file || symbol.path === file));
  assert(matches.length > 0, `missing symbol ${name}${file ? ` in ${file}` : ''}`);
  return matches[0];
}

try {
  await write('package.json', JSON.stringify({ name: 'codexgraph-fixture', type: 'module', scripts: { test: 'node --test', build: 'tsc -p tsconfig.json' } }, null, 2));
  await write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, baseUrl: '.', paths: { '@core/*': ['src/*'] } }, include: ['src/**/*.ts', 'test/**/*.ts'] }, null, 2));
  await write('src/state.ts', `export let total = 0;
export function setTotal(value: number) { total = value; }
export function getTotal() { return total; }
`);
  const serviceSource = `import { getTotal, setTotal } from './state.js';
export function leaf() { return getTotal(); }
export function middle() { setTotal(2); return leaf(); }
export function top() { return middle(); }
export function choose(flag: boolean) { return new Promise<number>((resolve) => resolve(flag ? leaf() : 0)); }
`;
  await write('src/service.ts', serviceSource);
  await write('src/alias.ts', `import { leaf } from '@core/service.js';
export function aliasCaller() { return leaf(); }
`);
  await write('packages/a/tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, baseUrl: '.', paths: { '@a/*': ['src/*'] } }, include: ['src/**/*.ts'] }, null, 2));
  await write('packages/a/src/util.ts', `export function aLeaf() { return 'a'; }\n`);
  await write('packages/a/src/use.ts', `import { aLeaf } from '@a/util.js';\nexport function aUse() { return aLeaf(); }\n`);
  await write('packages/b/tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, baseUrl: '.', paths: { '@b/*': ['src/*'] } }, include: ['src/**/*.ts'] }, null, 2));
  await write('packages/b/src/util.ts', `export function bLeaf() { return 'b'; }\n`);
  await write('packages/b/src/use.ts', `import { bLeaf } from '@b/util.js';\nexport function bUse() { return bLeaf(); }\n`);
  await write('src/classes.ts', `export class Base { value() { return 1; } }
export class Child extends Base { run() { return this.value(); } }
`);
  await write('src/ipc-main.ts', `declare const ipcMain: { handle(channel: string, handler: (...args: any[]) => unknown): void };
export function handleOpen() { return true; }
ipcMain.handle('project:open', handleOpen);
`);
  await write('src/ipc-client.ts', `declare const ipcRenderer: { invoke(channel: string): Promise<unknown> };
export function requestOpen() { return ipcRenderer.invoke('project:open'); }
`);
  await write('src/events.ts', `declare const bus: { on(name: string, handler: () => void): void; emit(name: string): void };
export function onReady() { return true; }
export function emitReady() { bus.emit('ready'); }
bus.on('ready', onReady);
bus.on('multi', () => void 1);
bus.on('multi', () => void 2);
`);
  await write('src/routes.ts', `declare const app: { get(path: string, handler: () => unknown): void };
export function healthHandler() { return { ok: true }; }
app.get('/health', healthHandler);
`);
  await write('test/service.test.ts', `import { top } from '../src/service.js';
export function testTop() { return top(); }
void testTop();
`);

  const [{ loadConfig }, { PathGuard, WorkspaceManager }, analysisApi, persistentApi] = await Promise.all([
    importBuilt('config.js'),
    importBuilt('guard.js'),
    importBuilt('analysis/index.js'),
    importBuilt('analysis/persistent.js')
  ]);
  const config = loadConfig(['--root', tmp, '--bash', 'off', '--write', 'off']);
  const guard = new PathGuard(config);
  const workspace = new WorkspaceManager(config).defaultWorkspace();

  const first = await analysisApi.inspectWorkspace(config, guard, workspace);
  assert.equal(first.cache.hit, false);
  assert.match(first.cache.key, /:graph-v2:/, 'CodexGraph cache key did not invalidate the previous semantic engine snapshot');
  const leaf = symbolByName(first, 'leaf', 'src/service.ts');
  const middle = symbolByName(first, 'middle', 'src/service.ts');
  const top = symbolByName(first, 'top', 'src/service.ts');
  const choose = symbolByName(first, 'choose', 'src/service.ts');
  const chooseCallback = first.symbols.find((symbol) => symbol.containerId === choose.id && symbol.kind === 'function' && symbol.name.startsWith('callback:'));
  assert(chooseCallback?.id, 'anonymous callback symbol under choose missing');
  const aliasCaller = symbolByName(first, 'aliasCaller', 'src/alias.ts');
  const aLeaf = symbolByName(first, 'aLeaf', 'packages/a/src/util.ts');
  const aUse = symbolByName(first, 'aUse', 'packages/a/src/use.ts');
  const bLeaf = symbolByName(first, 'bLeaf', 'packages/b/src/util.ts');
  const bUse = symbolByName(first, 'bUse', 'packages/b/src/use.ts');
  const setTotal = symbolByName(first, 'setTotal', 'src/state.ts');
  const getTotal = symbolByName(first, 'getTotal', 'src/state.ts');
  const total = symbolByName(first, 'total', 'src/state.ts');
  assert(leaf.id && middle.id && top.id && aliasCaller.id && setTotal.id && getTotal.id && total.id);

  const hasEdge = (kind, fromId, toId) => first.relationships.some((edge) => edge.kind === kind && edge.fromSymbolId === fromId && edge.toSymbolId === toId);
  assert(hasEdge('calls', top.id, middle.id), 'top -> middle call edge missing');
  assert(hasEdge('calls', aliasCaller.id, leaf.id), 'root tsconfig paths alias call edge missing');
  assert(hasEdge('calls', aUse.id, aLeaf.id), 'packages/a tsconfig paths alias call edge missing');
  assert(hasEdge('calls', bUse.id, bLeaf.id), 'packages/b tsconfig paths alias call edge missing');
  assert(hasEdge('calls', middle.id, leaf.id), 'middle -> leaf call edge missing');
  assert(hasEdge('calls', middle.id, setTotal.id), 'middle -> setTotal call edge missing');
  assert(hasEdge('calls', leaf.id, getTotal.id), 'leaf -> getTotal call edge missing');
  assert(hasEdge('writes', setTotal.id, total.id), 'state write edge missing');
  assert(hasEdge('reads', getTotal.id, total.id), 'state read edge missing');

  const child = symbolByName(first, 'Child', 'src/classes.ts');
  const base = symbolByName(first, 'Base', 'src/classes.ts');
  assert(first.relationships.some((edge) => edge.kind === 'extends' && edge.fromSymbolId === child.id && edge.toSymbolId === base.id), 'extends edge missing');

  const ipcChannel = first.symbols.find((symbol) => symbol.id === 'virtual:ipc:project:open');
  const handleOpen = symbolByName(first, 'handleOpen', 'src/ipc-main.ts');
  const requestOpen = symbolByName(first, 'requestOpen', 'src/ipc-client.ts');
  assert(ipcChannel?.id, 'IPC channel node missing');
  assert(first.relationships.some((edge) => edge.kind === 'ipc' && edge.fromSymbolId === requestOpen.id && edge.toSymbolId === ipcChannel.id), 'IPC sender edge missing');
  assert(first.relationships.some((edge) => edge.kind === 'ipc' && edge.fromSymbolId === ipcChannel.id && edge.toSymbolId === handleOpen.id), 'IPC handler edge missing');
  const ipcImpact = await analysisApi.reviewWorkspaceChanges(config, guard, workspace, { changedPaths: ['src/ipc-main.ts'] });
  assert(!ipcImpact.dependentFiles.some((file) => file.path.startsWith('@virtual/')), 'virtual graph node leaked into dependentFiles');
  assert(ipcImpact.dependentFiles.some((file) => file.path === 'src/ipc-client.ts'), 'IPC reverse impact did not reach the renderer caller through the virtual channel node');

  const eventNode = first.symbols.find((symbol) => symbol.id === 'virtual:event:ready');
  const routeNode = first.symbols.find((symbol) => symbol.id === 'virtual:route:GET /health');
  assert(eventNode?.id, 'event node missing');
  const multiCallbacks = first.symbols.filter((symbol) => symbol.path === 'src/events.ts' && symbol.kind === 'function' && symbol.name.startsWith('callback:call:bus.on:multi:arg1:occ'));
  assert.equal(multiCallbacks.length, 2, 'same-channel anonymous callbacks collapsed into one symbol');
  assert.equal(new Set(multiCallbacks.map((symbol) => symbol.id)).size, 2, 'same-channel anonymous callbacks must have distinct stable ids');
  assert(routeNode?.id, 'route node missing');
  assert(first.relationships.some((edge) => edge.kind === 'routes' && edge.toSymbolId === routeNode.id), 'route registration edge missing');

  const impactSearch = await analysisApi.searchWorkspaceStructured(config, guard, workspace, { query: 'leaf', intent: 'impact', includeTests: true, maxResults: 20 });
  assert(impactSearch.groups.references.some((match) => match.path === 'src/service.ts' && match.reasons.some((reason) => reason.includes('symbol dependency'))), 'symbol-level impact result missing');
  assert(impactSearch.groups.tests.some((match) => match.path === 'test/service.test.ts'), 'transitive related test missing');

  const graphFile = persistentApi.persistentGraphPath(workspace);
  assert((await fs.stat(graphFile)).isFile(), 'persistent graph snapshot was not written');
  analysisApi.invalidateWorkspaceAnalysis(workspace.id);
  const diskCached = await analysisApi.inspectWorkspace(config, guard, workspace);
  assert.equal(diskCached.cache.hit, true, 'persistent graph snapshot was not reused');

  const stableIds = new Map(['leaf', 'middle', 'top'].map((name) => [name, symbolByName(first, name, 'src/service.ts').id]));
  await write('src/service.ts', `\n${serviceSource}`);
  analysisApi.invalidateWorkspaceAnalysis(workspace.id);
  const shifted = await analysisApi.inspectWorkspace(config, guard, workspace);
  for (const [name, id] of stableIds) assert.equal(symbolByName(shifted, name, 'src/service.ts').id, id, `${name} symbol id changed after line-only shift`);
  const shiftedChoose = symbolByName(shifted, 'choose', 'src/service.ts');
  const shiftedChooseCallback = shifted.symbols.find((symbol) => symbol.containerId === shiftedChoose.id && symbol.kind === 'function' && symbol.name.startsWith('callback:'));
  assert.equal(shiftedChooseCallback?.id, chooseCallback.id, 'anonymous callback symbol id changed after line-only shift');
  const shiftReview = await analysisApi.reviewWorkspaceChanges(config, guard, workspace, { changedPaths: ['src/service.ts'] });
  assert.equal(shiftReview.graphDiff?.removedSymbols ?? 0, 0, 'line-only shift produced removed symbols');
  assert.equal(shiftReview.graphDiff?.removedRelationships ?? 0, 0, 'line-only shift produced removed dependency edges');

  await write('src/service.ts', `import { getTotal, setTotal } from './state.js';
export function leaf() { return getTotal(); }
export function middle() { setTotal(2); return 0; }
export function top() { return middle(); }
export function choose(flag: boolean) { return new Promise<number>((resolve) => resolve(flag ? leaf() : 0)); }
`);
  analysisApi.invalidateWorkspaceAnalysis(workspace.id);
  await analysisApi.inspectWorkspace(config, guard, workspace);
  const changedReview = await analysisApi.reviewWorkspaceChanges(config, guard, workspace, { changedPaths: ['src/service.ts'] });
  assert((changedReview.graphDiff?.removedRelationships ?? 0) > 0, 'removed call edge was not detected by graph diff');
  assert(changedReview.riskSignals.some((risk) => risk.id === 'graph-integrity'), 'graph-integrity risk was not surfaced');
  assert(changedReview.dependentFiles.some((file) => file.path === 'src/service.ts') || changedReview.relatedTests.some((file) => file.path === 'test/service.test.ts'), 'reverse impact traversal did not surface dependents');

  console.log('✓ CodexGraph correctness smoke test passed');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(graphHome, { recursive: true, force: true });
}
