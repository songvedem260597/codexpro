import path from "node:path";
import ts from "typescript";
import { buildTypeScriptCompilerGroups } from "./compilerProjects.js";
import type { InventoryFile, AnalysisRelationship, AnalysisRelationshipKind, AnalysisSymbol, AnalysisSymbolKind, AnalysisConfidence } from "./types.js";

const JS_TS_LANGUAGES = new Set(["typescript", "javascript"]);
const ASSIGNMENT_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken
]);

export interface SemanticGraphResult {
  symbols: AnalysisSymbol[];
  relationships: AnalysisRelationship[];
  analyzedPaths: string[];
  warnings: string[];
  truncated: boolean;
}

type DeclarationMeta = { kind: AnalysisSymbolKind; name: string; exported: boolean; callable: boolean };

type GraphContext = {
  root: string;
  roleByPath: Map<string, InventoryFile["role"]>;
  symbols: AnalysisSymbol[];
  relationships: AnalysisRelationship[];
  symbolById: Map<string, AnalysisSymbol>;
  nodeToId: Map<ts.Node, string>;
  relationKeys: Set<string>;
  maxSymbols: number;
  maxRelationships: number;
  truncated: boolean;
};

function posixRelative(root: string, fileName: string): string {
  return path.relative(root, fileName).split(path.sep).join("/");
}

function normalizedAbsolute(fileName: string): string {
  const resolved = path.resolve(fileName);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function modifiersExported(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node) ?? [];
  return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword || modifier.kind === ts.SyntaxKind.PublicKeyword);
}

function propertyNameText(name: ts.PropertyName | ts.BindingName | undefined, sourceFile: ts.SourceFile): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) return undefined;
  const text = name.getText(sourceFile).trim();
  return text || undefined;
}

function anonymousStructuralPath(node: ts.FunctionExpression | ts.ArrowFunction): string {
  const parts: string[] = [];
  let current: ts.Node = node;
  while (current.parent && !ts.isSourceFile(current.parent)) {
    const parent = current.parent;
    const children: ts.Node[] = [];
    ts.forEachChild(parent, (child) => children.push(child));
    parts.push(`${ts.SyntaxKind[parent.kind]}:${Math.max(0, children.indexOf(current))}`);
    if (
      ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isClassDeclaration(parent) ||
      ts.isConstructorDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)
    ) break;
    current = parent;
  }
  return parts.reverse().join("/") || `node:${node.kind}`;
}

type AnonymousCallIdentity = { kind: "call" | "new"; callee: string; channel: string; argumentIndex: number };

function anonymousCallIdentity(node: ts.FunctionExpression | ts.ArrowFunction, sourceFile: ts.SourceFile): AnonymousCallIdentity | undefined {
  const parent = node.parent;
  if (!ts.isCallExpression(parent) && !ts.isNewExpression(parent)) return undefined;
  const args = parent.arguments ?? ts.factory.createNodeArray<ts.Expression>();
  const argumentIndex = args.indexOf(node);
  if (argumentIndex < 0) return undefined;
  const firstArgument = args[0];
  const channel = firstArgument && (ts.isStringLiteral(firstArgument) || ts.isNoSubstitutionTemplateLiteral(firstArgument)) ? firstArgument.text : "";
  return {
    kind: ts.isNewExpression(parent) ? "new" : "call",
    callee: parent.expression.getText(sourceFile).replace(/\s+/g, ""),
    channel,
    argumentIndex
  };
}

function anonymousScope(node: ts.FunctionExpression | ts.ArrowFunction, sourceFile: ts.SourceFile): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (
      ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) || ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current)
    ) return current;
    current = current.parent;
  }
  return sourceFile;
}

function sameAnonymousCall(a: AnonymousCallIdentity, b: AnonymousCallIdentity): boolean {
  return a.kind === b.kind && a.callee === b.callee && a.channel === b.channel && a.argumentIndex === b.argumentIndex;
}

function anonymousCallOrdinal(node: ts.FunctionExpression | ts.ArrowFunction, sourceFile: ts.SourceFile, identity: AnonymousCallIdentity): number {
  const scope = anonymousScope(node, sourceFile);
  let ordinal = 0;
  let found = false;
  const visit = (candidate: ts.Node): void => {
    if (found) return;
    if (candidate === node) {
      found = true;
      return;
    }
    if (ts.isFunctionExpression(candidate) || ts.isArrowFunction(candidate)) {
      const candidateIdentity = anonymousCallIdentity(candidate, sourceFile);
      if (candidateIdentity && sameAnonymousCall(identity, candidateIdentity)) ordinal += 1;
      if (candidate !== scope) return;
    }
    ts.forEachChild(candidate, visit);
  };
  ts.forEachChild(scope, visit);
  return ordinal;
}

function anonymousFunctionName(node: ts.FunctionExpression | ts.ArrowFunction, sourceFile: ts.SourceFile): string {
  const identity = anonymousCallIdentity(node, sourceFile);
  if (identity) {
    const ordinal = anonymousCallOrdinal(node, sourceFile, identity);
    return `callback:${identity.kind}:${identity.callee}:${identity.channel}:arg${identity.argumentIndex}:occ${ordinal}`;
  }
  return `callback:${anonymousStructuralPath(node)}`;
}

function declarationMeta(node: ts.Node, sourceFile: ts.SourceFile): DeclarationMeta | undefined {
  if (ts.isFunctionDeclaration(node) && node.name) return { kind: "function", name: node.name.text, exported: modifiersExported(node), callable: true };
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
    const name = propertyNameText(node.name, sourceFile);
    if (name) return { kind: "method", name, exported: modifiersExported(node), callable: true };
  }
  if (ts.isConstructorDeclaration(node)) return { kind: "method", name: "constructor", exported: true, callable: true };
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    const name = propertyNameText(node.name, sourceFile);
    if (name) return { kind: "method", name, exported: modifiersExported(node), callable: true };
  }
  if (ts.isClassDeclaration(node) && node.name) return { kind: "class", name: node.name.text, exported: modifiersExported(node), callable: false };
  if (ts.isInterfaceDeclaration(node)) return { kind: "interface", name: node.name.text, exported: modifiersExported(node), callable: false };
  if (ts.isEnumDeclaration(node)) return { kind: "enum", name: node.name.text, exported: modifiersExported(node), callable: false };
  if (ts.isTypeAliasDeclaration(node)) return { kind: "type", name: node.name.text, exported: modifiersExported(node), callable: false };
  if (ts.isVariableDeclaration(node)) {
    const name = propertyNameText(node.name, sourceFile);
    if (!name) return undefined;
    const callable = Boolean(node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)));
    return { kind: callable ? "function" : "variable", name, exported: modifiersExported(node.parent.parent), callable };
  }
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
    const name = propertyNameText(node.name, sourceFile);
    if (!name) return undefined;
    const callable = ts.isPropertyDeclaration(node) && Boolean(node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)));
    return { kind: callable ? "method" : "property", name, exported: modifiersExported(node), callable };
  }
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    if ((ts.isVariableDeclaration(node.parent) || ts.isPropertyDeclaration(node.parent)) && node.parent.initializer === node) return undefined;
    const explicit = ts.isFunctionExpression(node) && node.name ? node.name.text : undefined;
    return { kind: "function", name: explicit ?? anonymousFunctionName(node, sourceFile), exported: false, callable: true };
  }
  return undefined;
}

function stableSymbolId(containerId: string, relPath: string, node: ts.Node, sourceFile: ts.SourceFile, kind: AnalysisSymbolKind, name: string): string {
  const base = `${containerId}/${kind}:${encodeURIComponent(name)}`;
  return base || `symbol:${relPath}:${node.getStart(sourceFile)}:${kind}:${name}`;
}

function signatureFor(node: ts.Node, checker: ts.TypeChecker): string | undefined {
  if (!ts.isFunctionDeclaration(node) && !ts.isMethodDeclaration(node) && !ts.isMethodSignature(node) && !ts.isConstructorDeclaration(node) && !ts.isGetAccessorDeclaration(node) && !ts.isSetAccessorDeclaration(node) && !ts.isFunctionExpression(node) && !ts.isArrowFunction(node)) return undefined;
  try {
    const signature = checker.getSignatureFromDeclaration(node);
    return signature ? checker.signatureToString(signature, node, ts.TypeFormatFlags.NoTruncation) : undefined;
  } catch {
    return undefined;
  }
}

function addRelationship(context: GraphContext, relationship: AnalysisRelationship): void {
  if (context.relationships.length >= context.maxRelationships) {
    context.truncated = true;
    return;
  }
  const key = [relationship.kind, relationship.from, relationship.to, relationship.fromSymbolId ?? "", relationship.toSymbolId ?? "", relationship.detail ?? ""].join("\u0000");
  if (context.relationKeys.has(key)) return;
  context.relationKeys.add(key);
  context.relationships.push(relationship);
}

function addSymbol(context: GraphContext, symbol: AnalysisSymbol): boolean {
  if (context.symbols.length >= context.maxSymbols) {
    context.truncated = true;
    return false;
  }
  if (symbol.id && context.symbolById.has(symbol.id)) return false;
  context.symbols.push(symbol);
  if (symbol.id) context.symbolById.set(symbol.id, symbol);
  return true;
}

function moduleSymbol(relPath: string): AnalysisSymbol {
  return {
    id: `module:${relPath}`,
    name: relPath,
    kind: "module",
    path: relPath,
    line: 1,
    exported: true,
    confidence: "exact",
    source: "typescript-compiler"
  };
}

function virtualPath(kind: "ipc" | "event" | "route", key: string): string {
  return `@virtual/${kind}/${encodeURIComponent(key)}`;
}

function ensureVirtualSymbol(context: GraphContext, kind: "channel" | "event" | "route", namespace: "ipc" | "event" | "route", key: string, label: string, confidence: AnalysisConfidence): AnalysisSymbol | undefined {
  const id = `virtual:${namespace}:${key}`;
  const existing = context.symbolById.get(id);
  if (existing) return existing;
  const symbol: AnalysisSymbol = {
    id,
    name: label,
    kind,
    path: virtualPath(namespace, key),
    line: 1,
    exported: false,
    confidence,
    virtual: true,
    source: namespace === "ipc" ? "electron-ipc-literal" : namespace === "route" ? "express-route-literal" : "event-literal"
  };
  return addSymbol(context, symbol) ? symbol : undefined;
}

function resolvedSymbol(checker: ts.TypeChecker, location: ts.Node): ts.Symbol | undefined {
  let symbol = checker.getSymbolAtLocation(location);
  if (!symbol) return undefined;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      symbol = checker.getAliasedSymbol(symbol);
    } catch {
      return undefined;
    }
  }
  return symbol;
}

function graphIdForSymbol(checker: ts.TypeChecker, nodeToId: Map<ts.Node, string>, location: ts.Node): string | undefined {
  const symbol = resolvedSymbol(checker, location);
  if (!symbol) return undefined;
  const declarations = [...(symbol.declarations ?? []), ...(symbol.valueDeclaration ? [symbol.valueDeclaration] : [])];
  for (const declaration of declarations) {
    let current: ts.Node | undefined = declaration;
    while (current && !ts.isSourceFile(current)) {
      const id = nodeToId.get(current);
      if (id) return id;
      current = current.parent;
    }
  }
  return undefined;
}

function graphIdForHandler(checker: ts.TypeChecker, context: GraphContext, node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  const direct = context.nodeToId.get(node);
  if (direct) return direct;
  return graphIdForSymbol(checker, context.nodeToId, ts.isPropertyAccessExpression(node) ? node.name : node);
}

function stringLiteralValue(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function memberCall(node: ts.CallExpression): { receiver: ts.Expression; receiverText: string; method: string } | undefined {
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined;
  return { receiver: node.expression.expression, receiverText: node.expression.expression.getText(), method: node.expression.name.text };
}

function receiverLooksExpress(checker: ts.TypeChecker, receiver: ts.Expression, receiverText: string): { match: boolean; confidence: AnalysisConfidence } {
  if (/^(app|router)$/i.test(receiverText)) return { match: true, confidence: "inferred" };
  try {
    const typeText = checker.typeToString(checker.getTypeAtLocation(receiver));
    if (/\b(?:Express|Router|Application)\b/.test(typeText)) return { match: true, confidence: "strong" };
  } catch {
    // Type information is optional for framework hints.
  }
  return { match: false, confidence: "inferred" };
}

function sourceLocation(sourceFile: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: location.line + 1, column: location.character + 1 };
}

function relationshipBetweenSymbols(context: GraphContext, kind: AnalysisRelationshipKind, fromId: string, toId: string, confidence: AnalysisConfidence, source: string, detail?: string, line?: number): void {
  if (fromId === toId && kind !== "reads" && kind !== "writes") return;
  const from = context.symbolById.get(fromId);
  const to = context.symbolById.get(toId);
  if (!from || !to) return;
  addRelationship(context, {
    from: from.path,
    to: to.path,
    kind,
    confidence,
    source,
    fromSymbolId: fromId,
    toSymbolId: toId,
    fromLine: line ?? from.line,
    toLine: to.line,
    detail
  });
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isEnumDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent) || ts.isFunctionExpression(parent)) && parent.name === node) return true;
  return ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isExportSpecifier(parent) || ts.isBindingElement(parent) && parent.name === node;
}

function assignmentMode(node: ts.Identifier): "read" | "write" | "readwrite" {
  const access: ts.Node = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ? node.parent : node;
  const parent = access.parent;
  if (ts.isBinaryExpression(parent) && parent.left === access && ASSIGNMENT_KINDS.has(parent.operatorToken.kind)) {
    return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken ? "write" : "readwrite";
  }
  if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) return "readwrite";
  return "read";
}

function isCallTargetIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isCallExpression(parent) && parent.expression === node) return true;
  if (ts.isNewExpression(parent) && parent.expression === node) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node && (ts.isCallExpression(parent.parent) || ts.isNewExpression(parent.parent)) && parent.parent.expression === parent) return true;
  return false;
}

function handlerCandidates(node: ts.CallExpression, startIndex: number): ts.Expression[] {
  return node.arguments.slice(startIndex).filter((argument): argument is ts.Expression => ts.isExpression(argument));
}

export function analyzeTypeScriptSemanticGraph(root: string, inventoryFiles: InventoryFile[], maxSymbols: number, maxRelationships: number): SemanticGraphResult {
  const sourceInventory = inventoryFiles.filter((file) => JS_TS_LANGUAGES.has(file.language) && !file.generated);
  if (!sourceInventory.length || maxSymbols <= 0 || maxRelationships <= 0) return { symbols: [], relationships: [], analyzedPaths: [], warnings: [], truncated: false };

  const workspaceRootNames = sourceInventory.map((file) => path.resolve(root, file.path));
  const roleByPath = new Map(sourceInventory.map((file) => [file.path, file.role]));
  const compilerPlan = buildTypeScriptCompilerGroups(root, inventoryFiles, sourceInventory);
  const compilerPrograms = compilerPlan.groups.map((group) => {
    const program = ts.createProgram({
      rootNames: group.rootNames,
      options: group.options,
      projectReferences: group.projectReferences
    });
    return { group, program, checker: program.getTypeChecker() };
  });
  const context: GraphContext = {
    root,
    roleByPath,
    symbols: [],
    relationships: [],
    symbolById: new Map(),
    nodeToId: new Map(),
    relationKeys: new Set(),
    maxSymbols,
    maxRelationships,
    truncated: false
  };
  const workspaceFiles = new Set(workspaceRootNames.map(normalizedAbsolute));
  const analyzedPaths: string[] = [];

  for (const { program, checker } of compilerPrograms) {
    for (const sourceFile of program.getSourceFiles()) {
      const absolute = path.resolve(sourceFile.fileName);
      const normalized = normalizedAbsolute(absolute);
      if (!workspaceFiles.has(normalized) || sourceFile.isDeclarationFile) continue;
      const relPath = posixRelative(root, absolute);
      analyzedPaths.push(relPath);
      const module = moduleSymbol(relPath);
      if (!addSymbol(context, module) || !module.id) continue;

      const visitDeclarations = (node: ts.Node, containerId: string): void => {
        const meta = declarationMeta(node, sourceFile);
        let nextContainer = containerId;
        if (meta) {
          const id = stableSymbolId(containerId, relPath, node, sourceFile, meta.kind, meta.name);
          const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
          const symbol: AnalysisSymbol = {
            id,
            name: meta.name,
            kind: meta.kind,
            path: relPath,
            line: start.line + 1,
            endLine: end.line + 1,
            column: start.character + 1,
            endColumn: end.character + 1,
            exported: meta.exported,
            confidence: "strong",
            containerId,
            signature: signatureFor(node, checker),
            source: "typescript-compiler"
          };
          const added = addSymbol(context, symbol);
          if (added || context.symbolById.has(id)) {
            context.nodeToId.set(node, id);
            relationshipBetweenSymbols(context, "contains", containerId, id, "strong", "typescript-ast", undefined, symbol.line);
            if (meta.callable || meta.kind === "class" || meta.kind === "interface") nextContainer = id;
          }
        }
        ts.forEachChild(node, (child) => visitDeclarations(child, nextContainer));
      };
      ts.forEachChild(sourceFile, (child) => visitDeclarations(child, module.id!));
    }
  }

  const roleForSymbol = (id: string) => context.roleByPath.get(context.symbolById.get(id)?.path ?? "") ?? "other";

  for (const { program, checker } of compilerPrograms) {
    for (const sourceFile of program.getSourceFiles()) {
      const absolute = path.resolve(sourceFile.fileName);
      const normalized = normalizedAbsolute(absolute);
      if (!workspaceFiles.has(normalized) || sourceFile.isDeclarationFile) continue;
      const relPath = posixRelative(root, absolute);
      const moduleId = `module:${relPath}`;
      if (!context.symbolById.has(moduleId)) continue;

      const visitEdges = (node: ts.Node, currentId: string): void => {
        const ownId = context.nodeToId.get(node);
        const ownSymbol = ownId ? context.symbolById.get(ownId) : undefined;
        const nextCurrent = ownId && ownSymbol && ["function", "method", "class", "interface"].includes(ownSymbol.kind) ? ownId : currentId;
        const location = sourceLocation(sourceFile, node);

        if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && ownId && node.heritageClauses) {
          for (const clause of node.heritageClauses) {
            const kind: AnalysisRelationshipKind = clause.token === ts.SyntaxKind.ImplementsKeyword ? "implements" : "extends";
            for (const type of clause.types) {
              const targetId = graphIdForSymbol(checker, context.nodeToId, type.expression);
              if (targetId) relationshipBetweenSymbols(context, kind, ownId, targetId, "strong", "typescript-type-checker", undefined, location.line);
            }
          }
        }

        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const expression = node.expression;
          const targetLocation = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
          const targetId = graphIdForSymbol(checker, context.nodeToId, targetLocation);
          if (targetId) {
            relationshipBetweenSymbols(context, "calls", nextCurrent, targetId, "strong", "typescript-type-checker", undefined, location.line);
            const target = context.symbolById.get(targetId);
            if (target && roleForSymbol(nextCurrent) === "test" && context.roleByPath.get(target.path) !== "test") {
              addRelationship(context, {
                from: relPath,
                to: target.path,
                kind: "tests",
                confidence: "strong",
                source: "typescript-call-test-coverage",
                fromSymbolId: nextCurrent,
                toSymbolId: targetId,
                fromLine: location.line,
                toLine: target.line,
                detail: `test calls ${target.name}`
              });
            }
          }

          if (ts.isCallExpression(node)) {
            const member = memberCall(node);
            const channel = stringLiteralValue(node.arguments[0]);
            if (member && channel) {
              const receiverTail = member.receiverText.split(".").at(-1) ?? member.receiverText;
              const method = member.method;
              if (receiverTail === "ipcRenderer" && ["invoke", "send", "sendSync", "postMessage"].includes(method)) {
                const virtual = ensureVirtualSymbol(context, "channel", "ipc", channel, `IPC ${channel}`, "strong");
                if (virtual?.id) relationshipBetweenSymbols(context, "ipc", nextCurrent, virtual.id, "strong", "electron-ipc-literal", `${receiverTail}.${method}`, location.line);
              } else if (receiverTail === "ipcMain" && ["handle", "handleOnce", "on", "once"].includes(method)) {
                const virtual = ensureVirtualSymbol(context, "channel", "ipc", channel, `IPC ${channel}`, "strong");
                if (virtual?.id) {
                  relationshipBetweenSymbols(context, "ipc", nextCurrent, virtual.id, "strong", "electron-ipc-literal", `${receiverTail}.${method}`, location.line);
                  for (const handler of handlerCandidates(node, 1)) {
                    const handlerId = graphIdForHandler(checker, context, handler);
                    if (handlerId) relationshipBetweenSymbols(context, "ipc", virtual.id, handlerId, "strong", "electron-ipc-literal", `${receiverTail}.${method}`, location.line);
                  }
                }
              } else if (method === "emit") {
                const virtual = ensureVirtualSymbol(context, "event", "event", channel, `Event ${channel}`, "inferred");
                if (virtual?.id) relationshipBetweenSymbols(context, "emits", nextCurrent, virtual.id, "inferred", "event-literal", member.receiverText, location.line);
              } else if (["on", "once", "addListener"].includes(method)) {
                const virtual = ensureVirtualSymbol(context, "event", "event", channel, `Event ${channel}`, "inferred");
                if (virtual?.id) {
                  relationshipBetweenSymbols(context, "listens", nextCurrent, virtual.id, "inferred", "event-literal", member.receiverText, location.line);
                  for (const handler of handlerCandidates(node, 1)) {
                    const handlerId = graphIdForHandler(checker, context, handler);
                    if (handlerId) relationshipBetweenSymbols(context, "listens", virtual.id, handlerId, "inferred", "event-literal", member.receiverText, location.line);
                  }
                }
              }

              const routeMethods = new Set(["get", "post", "put", "patch", "delete", "options", "head", "use", "all"]);
              if (routeMethods.has(method.toLowerCase())) {
                const express = receiverLooksExpress(checker, member.receiver, member.receiverText);
                if (express.match) {
                  const routeKey = `${method.toUpperCase()} ${channel}`;
                  const virtual = ensureVirtualSymbol(context, "route", "route", routeKey, routeKey, express.confidence);
                  if (virtual?.id) {
                    relationshipBetweenSymbols(context, "routes", nextCurrent, virtual.id, express.confidence, "express-route-literal", member.receiverText, location.line);
                    for (const handler of handlerCandidates(node, 1)) {
                      const handlerId = graphIdForHandler(checker, context, handler);
                      if (handlerId) relationshipBetweenSymbols(context, "routes", virtual.id, handlerId, express.confidence, "express-route-literal", member.receiverText, location.line);
                    }
                  }
                }
              }
            }
          }
        }

        if (ts.isIdentifier(node) && !isDeclarationName(node) && !isCallTargetIdentifier(node)) {
          const targetId = graphIdForSymbol(checker, context.nodeToId, node);
          const target = targetId ? context.symbolById.get(targetId) : undefined;
          if (targetId && target && targetId !== nextCurrent) {
            if (target.kind === "variable" || target.kind === "property") {
              const mode = assignmentMode(node);
              if (mode === "read" || mode === "readwrite") relationshipBetweenSymbols(context, "reads", nextCurrent, targetId, "strong", "typescript-type-checker", undefined, location.line);
              if (mode === "write" || mode === "readwrite") relationshipBetweenSymbols(context, "writes", nextCurrent, targetId, "strong", "typescript-type-checker", undefined, location.line);
            } else if (["function", "method", "class"].includes(target.kind)) {
              relationshipBetweenSymbols(context, "references", nextCurrent, targetId, "strong", "typescript-type-checker", undefined, location.line);
            }
          }
        }

        ts.forEachChild(node, (child) => visitEdges(child, nextCurrent));
      };
      ts.forEachChild(sourceFile, (child) => visitEdges(child, moduleId));
    }
  }

  const diagnostics = compilerPrograms.flatMap(({ program }) =>
    ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
  );
  const warnings = [
    ...compilerPlan.warnings,
    ...(diagnostics.length ? [`TypeScript semantic graph completed with ${diagnostics.length} compiler diagnostic${diagnostics.length === 1 ? "" : "s"}; resolved edges remain compiler-backed but unresolved code may be missing from the graph.`] : []),
    ...(context.truncated ? ["TypeScript semantic graph reached the configured symbol or relationship limit."] : [])
  ];

  return {
    symbols: context.symbols,
    relationships: context.relationships,
    analyzedPaths: [...new Set(analyzedPaths)].sort(),
    warnings,
    truncated: context.truncated
  };
}
