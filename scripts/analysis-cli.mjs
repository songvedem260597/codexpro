import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

function analysisChangedPaths(status) {
  if (!status || status === '(no output)') return [];
  const paths = [];
  for (const rawLine of String(status).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^(fatal:|error:|git unavailable)/i.test(line)) continue;
    let filePath = '';
    if (line.startsWith('?? ')) filePath = line.slice(3).trim();
    else if (line.includes('\t')) filePath = line.split('\t').pop()?.trim() ?? '';
    else if (/^.{2}\s/.test(line)) filePath = line.slice(3).trim();
    if (filePath.includes(' -> ')) filePath = filePath.split(' -> ').pop() ?? filePath;
    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      try { filePath = JSON.parse(filePath); } catch { filePath = filePath.slice(1, -1); }
    }
    if (filePath && !paths.includes(filePath)) paths.push(filePath);
  }
  return paths;
}

function assertGitStatusAvailable(status) {
  const value = String(status || '').trim();
  if (/^(fatal:|error:|git unavailable or failed:|git exited with status|usage: git )/i.test(value) || /not a git repository/i.test(value)) {
    throw new Error(`Unable to read Git changes: ${value}`);
  }
}

function printWorkspaceInspection(result, json) {
  const payload = {
    schema_version: result.schemaVersion,
    workspace_id: result.workspaceId,
    root: result.root,
    languages: result.languages,
    project_types: result.projectTypes,
    entrypoints: result.entrypoints,
    important_files: result.importantFiles,
    areas: result.areas,
    files: result.files,
    symbols: result.symbols,
    relationships: result.relationships,
    coverage: result.coverage,
    warnings: result.warnings,
    cache: result.cache
  };
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log([
    'CodexPro Repository Analysis',
    '',
    `Workspace: ${result.root}`,
    `Projects: ${result.projectTypes.join(', ') || 'unknown'}`,
    `Languages: ${result.languages.join(', ') || 'unknown'}`,
    `Entrypoints: ${result.entrypoints.join(', ') || 'none detected'}`,
    `Important areas: ${result.areas.slice(0, 8).map((area) => `${area.path} (${area.files})`).join(', ') || 'none'}`,
    `Coverage: ${result.coverage.analyzedFiles}/${result.coverage.inventoryFiles} files, ${result.coverage.symbolCount} symbols, ${result.coverage.relationshipCount} relationships${result.coverage.truncated ? ' (partial)' : ''}`,
    ...(result.warnings.length ? ['', 'Warnings:', ...result.warnings.map((warning) => `- ${warning}`)] : [])
  ].join('\n'));
}

function printChangeReview(result, json) {
  const payload = {
    schema_version: result.schemaVersion,
    changed_files: result.changedPaths,
    affected_areas: result.affectedAreas,
    dependent_files: result.dependentFiles,
    related_tests: result.relatedTests,
    risk_signals: result.riskSignals,
    recommended_commands: result.recommendedCommands,
    coverage: result.coverage,
    warnings: result.warnings,
    cache: result.cache
  };
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log([
    'CodexPro Change Review',
    '',
    `Changed files: ${result.changedPaths.join(', ') || 'none'}`,
    `Affected areas: ${result.affectedAreas.join(', ') || 'none'}`,
    `Risk: ${result.riskSignals.map((risk) => risk.label).join(', ') || 'none detected'}`,
    `Related tests: ${result.relatedTests.map((file) => file.path).join(', ') || 'none detected'}`,
    `Recommended verification: ${result.recommendedCommands.map((item) => item.command).join(', ') || 'none detected'}`,
    `Coverage: ${result.coverage.analyzedFiles}/${result.coverage.inventoryFiles} files${result.coverage.truncated ? ' (partial)' : ''}`,
    ...(result.warnings.length ? ['', 'Warnings:', ...result.warnings.map((warning) => `- ${warning}`)] : [])
  ].join('\n'));
}

export function createAnalysisCli({ projectRoot, parseArgs, realDir }) {
  return async function runAnalysisCli(command, argv) {
    const args = parseArgs(argv);
    const root = realDir(args.root ?? process.cwd());
    const [{ loadConfig }, { PathGuard, WorkspaceManager }, analysis, git] = await Promise.all([
      import(pathToFileURL(path.join(projectRoot, 'dist', 'config.js')).href),
      import(pathToFileURL(path.join(projectRoot, 'dist', 'guard.js')).href),
      import(pathToFileURL(path.join(projectRoot, 'dist', 'analysis', 'index.js')).href),
      import(pathToFileURL(path.join(projectRoot, 'dist', 'gitOps.js')).href)
    ]);
    const config = loadConfig(['--root', root, '--bash', 'off', '--write', 'off']);
    const guard = new PathGuard(config);
    const workspace = new WorkspaceManager(config).defaultWorkspace();
    if (args.path) guard.resolve(workspace, args.path);
    if (command === 'inspect') {
      printWorkspaceInspection(await analysis.inspectWorkspace(config, guard, workspace), Boolean(args.json));
      return;
    }
    const status = await git.gitDiffStatus(config, guard, workspace, args.path, Boolean(args.staged));
    assertGitStatusAvailable(status);
    const changedPaths = analysisChangedPaths(status);
    const review = await analysis.reviewWorkspaceChanges(config, guard, workspace, { changedPaths });
    printChangeReview(review, Boolean(args.json));
  };
}
