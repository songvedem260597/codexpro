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
  await write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, jsx: 'react-jsx', baseUrl: '.', paths: { '@core/*': ['src/*'] } }, include: ['src/**/*.ts', 'src/**/*.tsx', 'test/**/*.ts'] }, null, 2));
  await write('.ai-bridge/transient.ts', `export const transient = true;\n`);
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
  const hooksSource = `declare function useEffect(callback: () => void): void;
export function Hooks() {
  useEffect(() => console.log('alpha'));
  useEffect(() => console.log('beta'));
}
`;
  await write('src/hooks.ts', hooksSource);
  await write('src/routes.ts', `declare const app: { get(path: string, handler: () => unknown): void };
export function healthHandler() { return { ok: true }; }
app.get('/health', healthHandler);
`);
  await write('node_modules/react/package.json', JSON.stringify({ name: 'react', version: '0.0.0', types: 'index.d.ts', exports: { '.': './index.d.ts', './jsx-runtime': './jsx-runtime.d.ts' } }, null, 2));
  await write('node_modules/react/index.d.ts', `export interface Context<T> { Provider: unknown; Consumer: unknown; }
export interface RefObject<T> { current: T | null; }
export function createContext<T>(value: T): Context<T>;
export function useContext<T>(context: Context<T>): T;
export function useRef<T>(value: T | null): RefObject<T>;
export function createRef<T>(): RefObject<T>;
export function forwardRef<T, P>(render: (props: P, ref: unknown) => unknown): (props: P & { ref?: unknown }) => unknown;
export function useImperativeHandle(ref: unknown, create: () => unknown): void;
`);
  await write('node_modules/react/jsx-runtime.d.ts', `export namespace JSX { interface IntrinsicElements { input: any; button: any; } }
export const Fragment: unknown;
export function jsx(type: unknown, props: unknown, key?: unknown): unknown;
export function jsxs(type: unknown, props: unknown, key?: unknown): unknown;
`);
  await write('node_modules/zustand/package.json', JSON.stringify({ name: 'zustand', version: '0.0.0', types: 'index.d.ts', exports: { '.': './index.d.ts' } }, null, 2));
  await write('node_modules/zustand/index.d.ts', `export type StoreHook<T> = ((selector: (state: T) => unknown) => unknown) & { getState(): T; setState(value: Partial<T>): void; subscribe(listener: () => void): () => void; };
export function create<T>(): (creator: (set: (value: unknown) => void, get: () => T) => T) => StoreHook<T>;
export function create<T>(creator: (set: (value: unknown) => void, get: () => T) => T): StoreHook<T>;
export function createStore<T>(creator: (set: (value: unknown) => void, get: () => T) => T): StoreHook<T>;
export function useStore<T>(store: StoreHook<T>, selector: (state: T) => unknown): unknown;
`);
  await write('src/react-app.tsx', `import { createContext, forwardRef, useContext, useRef } from 'react';
import { create } from 'zustand';
export const ThemeContext = createContext('light');
export const useCountStore = create<{ count: number }>()((_set, _get) => ({ count: 0 }));
export function handleSave() { return true; }
export const FancyInput = forwardRef<unknown, { onSave: () => void }>((_props, ref) => <input ref={ref} />);
export function Parent() {
  const theme = useContext(ThemeContext);
  const localRef = useRef<unknown>(null);
  const count = useCountStore((state) => state.count);
  const snapshot = useCountStore.getState();
  return <ThemeContext.Provider value={theme}><FancyInput ref={localRef} onSave={handleSave} /><button onClick={() => useCountStore.setState({ count: count + snapshot.count })}>save</button></ThemeContext.Provider>;
}
`);
  await write('test/service.test.ts', `import { top } from '../src/service.js';
export function testTop() { return top(); }
void testTop();
`);

  const [{ loadConfig }, { PathGuard, WorkspaceManager }, analysisApi, persistentApi, projectionApi] = await Promise.all([
    importBuilt('config.js'),
    importBuilt('guard.js'),
    importBuilt('analysis/index.js'),
    importBuilt('analysis/persistent.js'),
    importBuilt('analysis/projection.js')
  ]);
  const config = loadConfig(['--root', tmp, '--bash', 'off', '--write', 'off']);
  const guard = new PathGuard(config);
  const workspace = new WorkspaceManager(config).defaultWorkspace();

  const first = await analysisApi.inspectWorkspace(config, guard, workspace);
  assert.equal(first.cache.hit, false);
  assert(!first.files.some((file) => file.path.startsWith('.ai-bridge/')), 'analysis inventory must exclude transient .ai-bridge files');
  assert.match(first.cache.key, /:graph-v3:/, 'CodexGraph cache key did not invalidate the previous semantic engine snapshot');
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

  const parent = symbolByName(first, 'Parent', 'src/react-app.tsx');
  const themeContextDecl = symbolByName(first, 'ThemeContext', 'src/react-app.tsx');
  const storeDecl = symbolByName(first, 'useCountStore', 'src/react-app.tsx');
  const localRefDecl = symbolByName(first, 'localRef', 'src/react-app.tsx');
  const fancyInput = symbolByName(first, 'FancyInput', 'src/react-app.tsx');
  const handleSave = symbolByName(first, 'handleSave', 'src/react-app.tsx');
  const contextNode = first.symbols.find((symbol) => symbol.kind === 'context' && symbol.source === 'react-context');
  const storeNode = first.symbols.find((symbol) => symbol.kind === 'store' && symbol.source === 'zustand-store');
  const localRefNode = first.symbols.find((symbol) => symbol.kind === 'ref' && symbol.name === 'Ref localRef');
  const forwardedRefNode = first.symbols.find((symbol) => symbol.kind === 'ref' && symbol.name === 'Forwarded ref FancyInput');
  assert(parent.id && themeContextDecl.id && storeDecl.id && localRefDecl.id && fancyInput.id && handleSave.id);
  assert(contextNode?.id && storeNode?.id && localRefNode?.id && forwardedRefNode?.id, 'React/Zustand semantic resource nodes missing');
  assert(hasEdge('stores', themeContextDecl.id, contextNode.id), 'createContext resource edge missing');
  assert(hasEdge('provides', parent.id, contextNode.id), 'React Context Provider edge missing');
  assert(hasEdge('consumes', parent.id, contextNode.id), 'useContext consumer edge missing');
  assert(hasEdge('stores', storeDecl.id, storeNode.id), 'Zustand store resource edge missing');
  assert(hasEdge('consumes', parent.id, storeNode.id), 'Zustand hook consumer edge missing');
  assert(first.relationships.some((edge) => edge.kind === 'reads' && edge.toSymbolId === storeNode.id && edge.detail === 'getState'), 'Zustand getState edge missing');
  assert(first.relationships.some((edge) => edge.kind === 'writes' && edge.toSymbolId === storeNode.id && edge.detail === 'setState'), 'Zustand setState edge missing');
  assert(hasEdge('passes', parent.id, handleSave.id), 'JSX callback prop edge missing');
  assert(hasEdge('stores', localRefDecl.id, localRefNode.id), 'React useRef resource edge missing');
  assert(hasEdge('passes', parent.id, localRefNode.id), 'JSX ref prop edge missing');
  assert(hasEdge('passes', localRefNode.id, forwardedRefNode.id), 'forwardRef bridge edge missing');
  assert(hasEdge('provides', fancyInput.id, forwardedRefNode.id), 'forwardRef component edge missing');
  assert(first.relationships.some((edge) => edge.kind === 'passes' && edge.fromSymbolId === forwardedRefNode.id), 'forwardRef callback edge missing');

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
  const multiCallbacks = first.symbols.filter((symbol) => symbol.path === 'src/events.ts' && symbol.kind === 'function' && symbol.name.startsWith('callback:call:bus.on:multi:arg1:key'));
  assert.equal(multiCallbacks.length, 2, 'same-channel anonymous callbacks collapsed into one symbol');
  assert.equal(new Set(multiCallbacks.map((symbol) => symbol.id)).size, 2, 'same-channel anonymous callbacks must have distinct stable ids');
  const hooks = symbolByName(first, 'Hooks', 'src/hooks.ts');
  const stableHookCallbackIds = new Set(first.symbols
    .filter((symbol) => symbol.containerId === hooks.id && symbol.kind === 'function' && symbol.name.startsWith('callback:call:useEffect::arg0:key'))
    .map((symbol) => symbol.id));
  assert.equal(stableHookCallbackIds.size, 2, 'hook callbacks were not indexed with distinct anchored ids');
  assert(routeNode?.id, 'route node missing');
  assert(first.relationships.some((edge) => edge.kind === 'routes' && edge.toSymbolId === routeNode.id), 'route registration edge missing');

  const prioritySymbols = [
    { id: 'symbol:local-a', name: 'Local A', kind: 'variable', path: 'src/a.ts', line: 1, exported: false },
    { id: 'symbol:local-b', name: 'Local B', kind: 'variable', path: 'src/b.ts', line: 1, exported: false },
    { id: 'virtual:ipc:important', name: 'Important IPC', kind: 'channel', path: '@virtual/ipc/important', line: 1, virtual: true, exported: false }
  ];
  const priorityRelationships = [
    { from: 'src/a.ts', to: '@virtual/ipc/important', kind: 'contains', fromSymbolId: 'symbol:local-a', toSymbolId: 'virtual:ipc:important' },
    { from: 'src/b.ts', to: '@virtual/ipc/important', kind: 'ipc', fromSymbolId: 'symbol:local-b', toSymbolId: 'virtual:ipc:important' }
  ];
  const nodePriorityProjection = projectionApi.projectCompactGraph(prioritySymbols, priorityRelationships, { maxNodes: 2, maxEdges: 2, maxPayloadBytes: 262144 });
  assert(nodePriorityProjection.nodes.some((node) => node.name === 'Important IPC'), 'compact graph truncation did not preserve a high-priority virtual node');
  const edgePriorityProjection = projectionApi.projectCompactGraph(prioritySymbols, priorityRelationships, { maxNodes: 3, maxEdges: 1, maxPayloadBytes: 262144 });
  assert.equal(edgePriorityProjection.edges[0]?.kind, 'ipc', 'compact graph truncation did not prioritize a flow edge');

  const bulkySymbols = Array.from({ length: 3000 }, (_, index) => ({
    id: `bulk:${index}`,
    name: `${'x'.repeat(120)}-${index}`,
    kind: 'variable',
    path: `src/${'deep/'.repeat(8)}file-${index}.ts`,
    line: index + 1,
    exported: false
  }));
  const byteProjection = projectionApi.projectCompactGraph(bulkySymbols, [], { maxNodes: 5000, maxEdges: 100, maxPayloadBytes: 262144 });
  assert.equal(byteProjection.byteLimited, true, 'compact graph byte cap was not enforced');
  assert(byteProjection.nodes.length < bulkySymbols.length, 'compact graph byte cap returned every oversized node');
  assert(byteProjection.limits.estimated_payload_bytes <= byteProjection.limits.max_payload_bytes, 'compact graph byte estimate exceeded its configured payload cap');

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

  await write('src/hooks.ts', `declare function useEffect(callback: () => void): void;
export function Hooks() {
  useEffect(() => console.log('new'));
  useEffect(() => console.log('alpha'));
  useEffect(() => console.log('beta'));
}
`);
  analysisApi.invalidateWorkspaceAnalysis(workspace.id);
  const insertedHook = await analysisApi.inspectWorkspace(config, guard, workspace);
  const insertedHooks = symbolByName(insertedHook, 'Hooks', 'src/hooks.ts');
  const insertedHookCallbackIds = new Set(insertedHook.symbols
    .filter((symbol) => symbol.containerId === insertedHooks.id && symbol.kind === 'function' && symbol.name.startsWith('callback:call:useEffect::arg0:key'))
    .map((symbol) => symbol.id));
  for (const id of stableHookCallbackIds) assert(insertedHookCallbackIds.has(id), `existing hook callback id changed after inserting a sibling callback: ${id}`);

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
