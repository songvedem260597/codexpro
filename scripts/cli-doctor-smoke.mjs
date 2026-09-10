import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCliDoctor } from './cli-doctor.mjs';

const projectRoot = 'C:/codexpro-project';
const workspaceRoot = 'C:/workspace';

function normalizePath(value) {
  return String(value).replace(/\\/g, '/');
}

function optionValueFor(env) {
  return (args, profile, key, envNames, fallback = '') => {
    if (args?.[key] !== undefined) return args[key];
    for (const envName of envNames ?? []) {
      if (env[envName] !== undefined && env[envName] !== '') return env[envName];
    }
    if (profile?.[key] !== undefined) return profile[key];
    return fallback;
  };
}

function createHarness(options = {}) {
  const args = { tunnel: 'none', ...(options.args ?? {}) };
  const profile = options.profile ?? {};
  const env = { ...(options.env ?? {}) };
  const logs = [];
  const boxes = [];
  const statusLines = [];
  const calls = {
    profileLoads: 0,
    spawn: [],
    inspectRuntime: [],
    auditor: [],
    scoutAvailability: [],
    liveAgent: [],
    liveSubagent: [],
    liveScout: [],
    port: [],
    usage: 0
  };
  const processRuntime = {
    platform: options.platform ?? 'linux',
    versions: { node: options.nodeVersion ?? '22.12.0' },
    env,
    cwd: () => workspaceRoot,
    exitCode: 0
  };
  const existing = new Set(options.existingPaths ?? ['dist/http.js', 'dist/server.js', 'package.json']);
  const commandExistsSet = new Set(options.commandExists ?? ['wl-copy', 'xdg-open']);
  const pathCommands = new Set(options.pathCommands ?? []);
  const executableFiles = new Set(options.executableFiles ?? []);
  const availableAgents = new Set(options.availableAgents ?? []);
  const capability = options.capability ?? {
    ready: true,
    reasons: [],
    subagentDepth: 1,
    taskPermission: 'allow',
    explorerEdit: 'deny',
    explorerBash: 'deny',
    explorerTask: 'deny',
    model: 'anthropic/claude-sonnet'
  };
  const scoutCapability = options.scoutCapability ?? {
    ready: true,
    reasons: [],
    childPermissions: {
      read: 'deny',
      bash: 'deny',
      task: 'deny',
      webfetch: 'allow',
      websearch: 'allow'
    }
  };

  const spawnSyncPortable = (command, commandArgs, spawnOptions) => {
    calls.spawn.push({ command, args: [...commandArgs], options: spawnOptions });
    if (commandArgs[0] === 'models') {
      return { status: options.modelListStatus ?? 0, stdout: options.modelList ?? 'anthropic/claude-sonnet\n' };
    }
    if (commandArgs[0] === 'auth' && commandArgs[1] === 'list') {
      return { status: options.authListStatus ?? 0, stdout: options.authList ?? 'anthropic\n' };
    }
    return { status: 0, stdout: '' };
  };

  const api = createCliDoctor({
    projectRoot,
    numberOption(value, fallback, min, max) {
      const parsed = Number(value ?? fallback);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.max(min, Math.min(max, Math.floor(parsed)));
    },
    managerMaxSubagentsSetting: () => options.managerMaxSubagents ?? 1,
    spawnSyncPortable,
    assertPortAvailable: async (host, port) => {
      calls.port.push({ host, port });
      if (options.portError) throw new Error(options.portError);
    },
    profileSummary: () => options.profileSummary ?? 'saved profile summary',
    optionHelpers: {
      parseArgs: () => ({ ...args }),
      realDir: (value) => value,
      optionValue: optionValueFor(env),
      effectiveWriteMode: options.effectiveWriteMode ?? ((mode, value) => {
        if (!['off', 'handoff', 'workspace'].includes(String(value))) throw new Error(`invalid write: ${value}`);
        return String(value);
      })
    },
    executableHelpers: {
      commandAvailable: (command) => pathCommands.has(command),
      commandAvailableFromRoot: (command) => availableAgents.has(command),
      commandExists: (command) => commandExistsSet.has(command),
      executableFileExists: (filePath) => executableFiles.has(filePath),
      resolveAgentCommand: (name) => name,
      resolveCodexCommand: () => 'codex'
    },
    tunnelExecutableHelpers: {
      localCloudflaredPath: () => '/local/cloudflared'
    },
    openCodeHelpers: {
      CODEXPRO_AUDITOR_AGENT: 'auditor-agent',
      CODEXPRO_EXPLORE_AGENT: 'explore-agent',
      CODEXPRO_ORCHESTRATOR_AGENT: 'orchestrator-agent',
      CODEXPRO_SCOUT_ORCHESTRATOR_AGENT: 'scout-orchestrator-agent',
      GEMINI_SCOUT_AGENT: 'gemini-scout-agent',
      inspectOpenCodeScoutCapability: () => ({}),
      inspectOpenCodeRuntime: (command, root, configDir, inspectOptions) => {
        calls.inspectRuntime.push({ command, root, configDir, options: inspectOptions });
        return inspectOptions?.inspector ? scoutCapability : capability;
      },
      inspectCodexProAuditorCapability: (...callArgs) => {
        calls.auditor.push(callArgs);
        return options.auditorCapability ?? { ready: true, reason: '' };
      },
      inspectGeminiScoutAvailability: (...callArgs) => {
        calls.scoutAvailability.push(callArgs);
        return options.scoutAvailability ?? { ready: true, selectedModel: 'google/gemini-2.5-pro', reason: '' };
      },
      runOpenCodeModelProbe: async (input) => {
        calls.liveAgent.push(input);
        return options.liveAgentResult ?? { ok: true, durationMs: 9, reason: '' };
      },
      runVerifiedOpenCodeInvestigation: async (input) => {
        calls.liveSubagent.push(input);
        return options.liveSubagentResult ?? { verified: true, childSessionId: 'child-1', filesInspected: ['package.json'], fallbackReason: '' };
      },
      runVerifiedGeminiScout: async (input) => {
        calls.liveScout.push(input);
        return options.liveScoutResult ?? { verified: true, childSessionId: 'scout-1', childModel: 'google/gemini-2.5-pro', childToolNames: ['websearch'], fallbackReason: '' };
      }
    },
    profileStore: {
      loadWorkspaceProfile: () => {
        calls.profileLoads += 1;
        return { ...profile };
      }
    },
    presentation: {
      paint: (_style, value) => value,
      labelValue: (label, value) => `${label}: ${value}`,
      printBox: (title, lines) => boxes.push({ title, lines: [...lines] }),
      statusLine: (status, message) => statusLines.push({ status, message }),
      usage: () => { calls.usage += 1; }
    },
    runtime: {
      process: processRuntime,
      fs: {
        existsSync(filePath) {
          const normalized = normalizePath(filePath);
          return [...existing].some((suffix) => normalized.endsWith(suffix));
        }
      },
      console: { log: (value = '') => logs.push(String(value)) }
    }
  });

  return {
    api,
    args,
    calls,
    processRuntime,
    logs,
    boxes,
    statusLines,
    text() {
      return [
        ...logs,
        ...boxes.flatMap((box) => [box.title, ...box.lines]),
        ...statusLines.map((item) => `${item.status} ${item.message}`)
      ].join('\n');
    }
  };
}

async function run(options = {}) {
  const harness = createHarness(options);
  await harness.api.runDoctor(options.argv ?? []);
  return harness;
}

{
  const supported = await run();
  assert.match(supported.text(), /OK Node\s+v22\.12\.0 \(requires >=20\)/);
  assert.equal(supported.processRuntime.exitCode, 0);

  const unsupported = await run({ nodeVersion: '18.20.0' });
  assert.match(unsupported.text(), /FAIL Node\s+v18\.20\.0 \(requires >=20\)/);
  assert.equal(unsupported.processRuntime.exitCode, 1);
}

{
  const ready = await run();
  assert.match(ready.text(), /OK Build artifacts\s+dist ready/);

  const missing = await run({ existingPaths: ['package.json'] });
  assert.match(missing.text(), /FAIL Build artifacts\s+missing dist\/http\.js; run npm install && npm run build/);
  assert.equal(missing.processRuntime.exitCode, 1);
}

{
  const absent = await run();
  assert.match(absent.text(), /WARN Saved profile\s+none for this workspace/);

  const present = await run({ profile: { profilePath: 'C:/profiles/workspace.json', tunnel: 'none' }, profileSummary: 'Saved local-only setup' });
  assert.match(present.text(), /OK Saved profile\s+Saved local-only setup/);

  const noProfile = await run({ args: { tunnel: 'none', noProfile: true }, profile: { profilePath: 'should-not-load.json' } });
  assert.equal(noProfile.calls.profileLoads, 0);
  assert.match(noProfile.text(), /WARN Saved profile\s+none for this workspace/);
}

{
  const invalid = await run({
    args: { tunnel: 'none', write: 'banana' },
    effectiveWriteMode: () => { throw new Error('--write must be off, handoff, or workspace'); }
  });
  assert.match(invalid.text(), /FAIL Write mode\s+--write must be off, handoff, or workspace/);
  assert.equal(invalid.processRuntime.exitCode, 1);
}

{
  const available = await run({ commandExists: ['wl-copy', 'xdg-open'] });
  assert.match(available.text(), /OK Clipboard\s+wl-copy/);
  assert.match(available.text(), /OK Browser open\s+xdg-open/);

  const missing = await run({ commandExists: [] });
  assert.match(missing.text(), /WARN Clipboard\s+not found; URL will be printed for manual copy/);
  assert.match(missing.text(), /WARN Browser open\s+not found; open ChatGPT manually/);
}

{
  const unavailable = await run({ availableAgents: [] });
  assert.match(unavailable.text(), /WARN OpenCode agent\s+not found; install opencode-ai to use --agent opencode/);
  assert.equal(unavailable.calls.inspectRuntime.length, 0);
  assert.equal(unavailable.calls.spawn.length, 0);
  assert.equal(unavailable.calls.liveAgent.length, 0);
  assert.equal(unavailable.calls.liveSubagent.length, 0);
  assert.equal(unavailable.calls.liveScout.length, 0);
}

{
  const ready = await run({ availableAgents: ['opencode'] });
  assert.match(ready.text(), /OK OC subagents\s+orchestrator-agent -> explore-agent/);
  assert.match(ready.text(), /OK OC child depth\s+subagent_depth=1/);
  assert.match(ready.text(), /OK OC Task access\s+explore-agent: allow/);
  assert.match(ready.text(), /OK OC child safety\s+edit=deny bash=deny task=deny/);
  assert.match(ready.text(), /OK OC native audit\s+auditor-agent/);
  assert.match(ready.text(), /OK OC Gemini scout\s+scout-orchestrator-agent -> gemini-scout-agent/);
  assert.match(ready.text(), /OK OC scout safety\s+read=deny bash=deny task=deny webfetch=allow websearch=allow/);
  assert.match(ready.text(), /OK OC scout candidate\s+google\/gemini-2\.5-pro/);
}

{
  const listed = await run({ availableAgents: ['opencode'], modelList: 'anthropic/claude-sonnet\n' });
  assert.match(listed.text(), /OK OC model\s+anthropic\/claude-sonnet/);

  const missing = await run({ availableAgents: ['opencode'], modelList: 'openai/gpt-5\n' });
  assert.match(missing.text(), /WARN OC model\s+anthropic\/claude-sonnet \(not found in model catalog\)/);
}

{
  const visible = await run({ availableAgents: ['opencode'], authList: 'Anthropic credential\n' });
  assert.match(visible.text(), /OK OC provider auth\s+anthropic credential visible/);

  const absent = await run({ availableAgents: ['opencode'], authList: '' });
  assert.match(absent.text(), /WARN OC provider auth\s+anthropic: no saved credential visible/);
}

{
  const noLive = await run({ availableAgents: ['opencode'] });
  assert.equal(noLive.calls.liveAgent.length, 0);
  assert.equal(noLive.calls.liveSubagent.length, 0);
  assert.equal(noLive.calls.liveScout.length, 0);
  assert.match(noLive.text(), /WARN OC live model\s+not called; use --live-agent-check/);
  assert.match(noLive.text(), /WARN OC live child\s+not called; use --live-subagent-check/);

  const liveAgent = await run({ availableAgents: ['opencode'], args: { tunnel: 'none', liveAgentCheck: true } });
  assert.equal(liveAgent.calls.liveAgent.length, 1);
  assert.deepEqual(liveAgent.calls.liveAgent[0], {
    command: 'opencode',
    root: workspaceRoot,
    configDir: 'C:\\codexpro-project\\.opencode',
    model: 'anthropic/claude-sonnet'
  });
  assert.match(liveAgent.text(), /OK OC live model\s+anthropic\/claude-sonnet responded in 9 ms/);

  const liveChild = await run({ availableAgents: ['opencode'], args: { tunnel: 'none', liveSubagentCheck: true } });
  assert.equal(liveChild.calls.liveSubagent.length, 1);
  assert.equal(liveChild.calls.liveSubagent[0].planText, 'Read package.json and report the exact package name plus the file path used as evidence. Do not modify anything.');
  assert.equal(liveChild.calls.liveSubagent[0].timeoutMs, 120_000);
  assert.equal(liveChild.calls.liveSubagent[0].maxOutputBytes, 120_000);
  assert.match(liveChild.text(), /OK OC live child\s+child-1; files=package\.json/);

  const liveScout = await run({ availableAgents: ['opencode'], args: { tunnel: 'none', liveScoutCheck: true } });
  assert.equal(liveScout.calls.liveScout.length, 1);
  assert.equal(liveScout.calls.liveScout[0].planText, 'Verify from official OpenCode documentation how subagent_depth controls child-agent nesting and report the source URL. This is an external documentation verification task; do not inspect workspace files.');
  assert.equal(liveScout.calls.liveScout[0].timeoutMs, 90_000);
  assert.equal(liveScout.calls.liveScout[0].probeTimeoutMs, 12_000);
  assert.equal(liveScout.calls.liveScout[0].maxOutputBytes, 120_000);
  assert.match(liveScout.text(), /OK OC live scout\s+scout-1; model=google\/gemini-2\.5-pro; tools=websearch/);
}

{
  const available = await run();
  assert.deepEqual(available.calls.port, [{ host: '127.0.0.1', port: '8787' }]);
  assert.match(available.text(), /OK Local port\s+127\.0\.0\.1:8787 available/);

  const occupied = await run({ portError: 'Port 8787 is already in use\nextra detail' });
  assert.match(occupied.text(), /FAIL Local port\s+Port 8787 is already in use/);
  assert.equal(occupied.processRuntime.exitCode, 1);
}

{
  const local = await run({ args: { tunnel: 'none' } });
  assert.match(local.text(), /OK Tunnel\s+local-only mode/);

  const cloudflare = await run({ args: { tunnel: 'cloudflare' }, pathCommands: [], executableFiles: [] });
  assert.match(cloudflare.text(), /WARN cloudflared\s+missing now; codexpro start can auto-install unless --no-install-cloudflared is used/);

  const stableMissingSetup = await run({ args: { tunnel: 'cloudflare-named', hostname: 'stable.example.com' }, pathCommands: [], executableFiles: [] });
  assert.match(stableMissingSetup.text(), /FAIL Cloudflare setup\s+needs tunnel name, config, token file, or tunnel token/);
  assert.equal(stableMissingSetup.processRuntime.exitCode, 1);

  const ngrok = await run({ args: { tunnel: 'ngrok' }, pathCommands: [] });
  assert.match(ngrok.text(), /FAIL Hostname\s+required for ngrok mode/);
  assert.match(ngrok.text(), /FAIL ngrok\s+not found on PATH; install ngrok/);
  assert.equal(ngrok.processRuntime.exitCode, 1);

  const tailscale = await run({ args: { tunnel: 'tailscale' }, pathCommands: [] });
  assert.match(tailscale.text(), /FAIL Hostname\s+required for Tailscale Funnel mode/);
  assert.match(tailscale.text(), /FAIL tailscale\s+not found on PATH; install Tailscale and enable Funnel/);
  assert.equal(tailscale.processRuntime.exitCode, 1);
}

{
  const help = createHarness({ args: { help: true } });
  await help.api.runDoctor(['--help']);
  assert.equal(help.calls.usage, 1);
  assert.equal(help.calls.port.length, 0);
}

{
  const source = fs.readFileSync(new URL('./codexpro.mjs', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/cli-doctor\.mjs'/);
  assert.match(source, /const \{ runDoctor \} = createCliDoctor\(/);
  for (const name of ['compareMajorVersion', 'browserOpenCommand', 'clipboardCommand', 'localOrPathCommand', 'doctorLine']) {
    assert.doesNotMatch(source, new RegExp(`function\\s+${name}\\s*\\(`));
  }
  assert.doesNotMatch(source, /async function runDoctor\s*\(/);
  assert.doesNotMatch(source, /inspectOpenCodeRuntime|runOpenCodeModelProbe|CODEXPRO_AUDITOR_AGENT/);
}

console.log('✓ CLI doctor smoke test passed');
