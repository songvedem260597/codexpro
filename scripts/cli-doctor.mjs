import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  CODEXPRO_AUDITOR_AGENT,
  CODEXPRO_EXPLORE_AGENT,
  CODEXPRO_ORCHESTRATOR_AGENT,
  CODEXPRO_SCOUT_ORCHESTRATOR_AGENT,
  GEMINI_SCOUT_AGENT,
  inspectOpenCodeScoutCapability
} from './opencode-subagents.mjs';
import {
  inspectCodexProAuditorCapability,
  inspectGeminiScoutAvailability,
  inspectOpenCodeRuntime,
  runOpenCodeModelProbe,
  runVerifiedGeminiScout,
  runVerifiedOpenCodeInvestigation
} from './opencode-subagent-runner.mjs';
import {
  effectiveWriteMode,
  optionValue,
  parseArgs,
  realDir
} from './cli-options.mjs';
import {
  commandAvailable,
  commandAvailableFromRoot,
  commandExists,
  executableFileExists,
  resolveAgentCommand,
  resolveCodexCommand
} from './cli-executables.mjs';
import { createCliTunnelExecutables } from './cli-tunnel-executables.mjs';
import { labelValue, paint, printBox, statusLine, usage } from './cli-presentation.mjs';
import { loadWorkspaceProfile } from './workspace-profile-store.mjs';

export function createCliDoctor({
  projectRoot,
  numberOption,
  managerMaxSubagentsSetting,
  spawnSyncPortable,
  assertPortAvailable,
  profileSummary,
  optionHelpers = {},
  executableHelpers = {},
  tunnelExecutableHelpers = {},
  openCodeHelpers = {},
  profileStore = {},
  presentation = {},
  runtime = {}
} = {}) {
  const processRuntime = runtime.process ?? process;
  const fsRuntime = runtime.fs ?? fs;
  const consoleRuntime = runtime.console ?? console;

  const effectiveWriteModeFn = optionHelpers.effectiveWriteMode ?? effectiveWriteMode;
  const optionValueFn = optionHelpers.optionValue ?? optionValue;
  const parseArgsFn = optionHelpers.parseArgs ?? parseArgs;
  const realDirFn = optionHelpers.realDir ?? realDir;

  const commandAvailableFn = executableHelpers.commandAvailable ?? commandAvailable;
  const commandAvailableFromRootFn = executableHelpers.commandAvailableFromRoot ?? commandAvailableFromRoot;
  const commandExistsFn = executableHelpers.commandExists ?? commandExists;
  const executableFileExistsFn = executableHelpers.executableFileExists ?? executableFileExists;
  const resolveAgentCommandFn = executableHelpers.resolveAgentCommand ?? resolveAgentCommand;
  const resolveCodexCommandFn = executableHelpers.resolveCodexCommand ?? resolveCodexCommand;

  const tunnelExecutables = tunnelExecutableHelpers.localCloudflaredPath
    ? tunnelExecutableHelpers
    : createCliTunnelExecutables({ spawnSyncPortable });
  const localCloudflaredPathFn = tunnelExecutables.localCloudflaredPath;

  const inspectCodexProAuditorCapabilityFn = openCodeHelpers.inspectCodexProAuditorCapability ?? inspectCodexProAuditorCapability;
  const inspectGeminiScoutAvailabilityFn = openCodeHelpers.inspectGeminiScoutAvailability ?? inspectGeminiScoutAvailability;
  const inspectOpenCodeRuntimeFn = openCodeHelpers.inspectOpenCodeRuntime ?? inspectOpenCodeRuntime;
  const inspectOpenCodeScoutCapabilityFn = openCodeHelpers.inspectOpenCodeScoutCapability ?? inspectOpenCodeScoutCapability;
  const runOpenCodeModelProbeFn = openCodeHelpers.runOpenCodeModelProbe ?? runOpenCodeModelProbe;
  const runVerifiedGeminiScoutFn = openCodeHelpers.runVerifiedGeminiScout ?? runVerifiedGeminiScout;
  const runVerifiedOpenCodeInvestigationFn = openCodeHelpers.runVerifiedOpenCodeInvestigation ?? runVerifiedOpenCodeInvestigation;
  const agentNames = {
    auditor: openCodeHelpers.CODEXPRO_AUDITOR_AGENT ?? CODEXPRO_AUDITOR_AGENT,
    explore: openCodeHelpers.CODEXPRO_EXPLORE_AGENT ?? CODEXPRO_EXPLORE_AGENT,
    orchestrator: openCodeHelpers.CODEXPRO_ORCHESTRATOR_AGENT ?? CODEXPRO_ORCHESTRATOR_AGENT,
    scoutOrchestrator: openCodeHelpers.CODEXPRO_SCOUT_ORCHESTRATOR_AGENT ?? CODEXPRO_SCOUT_ORCHESTRATOR_AGENT,
    scout: openCodeHelpers.GEMINI_SCOUT_AGENT ?? GEMINI_SCOUT_AGENT
  };

  const loadWorkspaceProfileFn = profileStore.loadWorkspaceProfile ?? loadWorkspaceProfile;

  const labelValueFn = presentation.labelValue ?? labelValue;
  const paintFn = presentation.paint ?? paint;
  const printBoxFn = presentation.printBox ?? printBox;
  const statusLineFn = presentation.statusLine ?? statusLine;
  const usageFn = presentation.usage ?? usage;

  function compareMajorVersion(version, minimumMajor) {
    const major = Number(String(version).split('.')[0]);
    return Number.isFinite(major) && major >= minimumMajor;
  }

  function browserOpenCommand() {
    if (processRuntime.platform === 'darwin') return commandExistsFn('open') ? 'open' : '';
    if (processRuntime.platform === 'win32') return 'cmd start';
    return commandExistsFn('xdg-open') ? 'xdg-open' : '';
  }

  function clipboardCommand() {
    if (processRuntime.platform === 'darwin') return commandExistsFn('pbcopy') ? 'pbcopy' : '';
    if (processRuntime.platform === 'win32') return 'clip';
    for (const command of ['wl-copy', 'xclip', 'xsel']) {
      if (commandExistsFn(command)) return command;
    }
    return '';
  }

  function localOrPathCommand(command, localPath) {
    if (command && commandAvailableFn(command)) return command;
    if (localPath && executableFileExistsFn(localPath)) return localPath;
    return '';
  }

  function doctorLine(status, label, detail = '') {
    const marker = status === 'ok' ? paintFn('green', 'OK') : status === 'warn' ? paintFn('yellow', 'WARN') : paintFn('red', 'FAIL');
    consoleRuntime.log(`${marker} ${label.padEnd(18)} ${detail}`);
  }

  async function runDoctor(argv) {
    const args = parseArgsFn(argv);
    if (args.help) {
      usageFn();
      return;
    }

    const root = realDirFn(args.root ?? processRuntime.env.CODEXPRO_ROOT ?? processRuntime.cwd());
    const profile = args.noProfile ? {} : loadWorkspaceProfileFn(root);
    const effectiveArgs = { ...profile, ...args };
    const tunnel = optionValueFn(args, profile, 'tunnel', ['CODEXPRO_TUNNEL'], 'cloudflare');
    const host = optionValueFn(args, profile, 'host', ['CODEXPRO_HOST'], '127.0.0.1');
    const port = String(optionValueFn(args, profile, 'port', ['CODEXPRO_PORT'], '8787'));
    const mode = optionValueFn(args, profile, 'mode', ['CODEXPRO_MODE'], 'agent');
    const bash = optionValueFn(args, profile, 'bash', ['CODEXPRO_BASH_MODE'], 'safe');
    const rawWrite = optionValueFn(args, profile, 'write', ['CODEXPRO_WRITE_MODE'], mode === 'agent' ? 'workspace' : 'handoff');
    let write = String(rawWrite);
    let writeError = '';
    try {
      write = effectiveWriteModeFn(mode, rawWrite);
    } catch (error) {
      writeError = error instanceof Error ? error.message : String(error);
    }
    const toolMode = optionValueFn(args, profile, 'toolMode', ['CODEXPRO_TOOL_MODE'], 'standard');
    const stableHostname = args.hostname
      ?? args.url
      ?? processRuntime.env.CODEXPRO_PUBLIC_HOSTNAME
      ?? processRuntime.env.CODEXPRO_HOSTNAME
      ?? processRuntime.env.NGROK_DOMAIN
      ?? profile.hostname
      ?? '';
    const httpPath = path.join(projectRoot, 'dist', 'http.js');
    const serverPath = path.join(projectRoot, 'dist', 'server.js');
    const cloudflaredPath = localOrPathCommand(
      effectiveArgs.cloudflared ?? processRuntime.env.CLOUDFLARED_BIN ?? 'cloudflared',
      localCloudflaredPathFn()
    );
    const ngrokPath = localOrPathCommand(effectiveArgs.ngrok ?? processRuntime.env.NGROK_BIN ?? 'ngrok', '');
    const tailscalePath = localOrPathCommand(effectiveArgs.tailscale ?? processRuntime.env.TAILSCALE_BIN ?? 'tailscale', '');
    const clipboard = clipboardCommand();
    const browser = browserOpenCommand();
    const opencodeCommand = resolveAgentCommandFn('opencode');
    const piCommand = resolveAgentCommandFn('pi');
    const codexCommand = resolveCodexCommandFn();
    const checks = [];

    function record(status, label, detail) {
      checks.push(status);
      doctorLine(status, label, detail);
    }

    consoleRuntime.log('');
    printBoxFn('CodexPro doctor', [
      labelValueFn('Workspace', root),
      labelValueFn('Mode', `${mode}  tools=${toolMode}  write=${write}  bash=${bash}`),
      labelValueFn('Tunnel', tunnel),
      ...(stableHostname ? [labelValueFn('Hostname', stableHostname)] : []),
      ...(profile.profilePath ? [labelValueFn('Profile', profile.profilePath)] : [])
    ]);

    record(compareMajorVersion(processRuntime.versions.node, 20) ? 'ok' : 'fail', 'Node', `v${processRuntime.versions.node} (requires >=20)`);
    record(fsRuntime.existsSync(httpPath) && fsRuntime.existsSync(serverPath) ? 'ok' : 'fail', 'Build artifacts', fsRuntime.existsSync(httpPath) ? 'dist ready' : 'missing dist/http.js; run npm install && npm run build');
    record(fsRuntime.existsSync(path.join(projectRoot, 'package.json')) ? 'ok' : 'fail', 'Package root', projectRoot);
    record(profile.profilePath ? 'ok' : 'warn', 'Saved profile', profile.profilePath ? profileSummary(profile) || profile.profilePath : 'none for this workspace');
    record(['agent', 'handoff', 'pro'].includes(mode) ? 'ok' : 'fail', 'Mode', ['agent', 'handoff', 'pro'].includes(mode) ? mode : '--mode must be agent, handoff, or pro');
    record(['off', 'safe', 'full'].includes(bash) ? 'ok' : 'fail', 'Bash mode', ['off', 'safe', 'full'].includes(bash) ? bash : '--bash must be off, safe, or full');
    record(!writeError && ['off', 'handoff', 'workspace'].includes(write) ? 'ok' : 'fail', 'Write mode', writeError || write);
    record(['minimal', 'standard', 'full'].includes(toolMode) ? 'ok' : 'fail', 'Tool mode', ['minimal', 'standard', 'full'].includes(toolMode) ? toolMode : '--tool-mode must be minimal, standard, or full');
    record(clipboard ? 'ok' : 'warn', 'Clipboard', clipboard || 'not found; URL will be printed for manual copy');
    record(browser ? 'ok' : 'warn', 'Browser open', browser || 'not found; open ChatGPT manually');
    const openCodeAvailable = commandAvailableFromRootFn(opencodeCommand, root);
    record(openCodeAvailable ? 'ok' : 'warn', 'OpenCode agent', openCodeAvailable ? opencodeCommand : 'not found; install opencode-ai to use --agent opencode');
    record(commandAvailableFromRootFn(piCommand, root) ? 'ok' : 'warn', 'Pi agent', commandAvailableFromRootFn(piCommand, root) ? piCommand : 'not found; install @mariozechner/pi-coding-agent to use --agent pi');
    record(commandAvailableFromRootFn(codexCommand, root) ? 'ok' : 'warn', 'Codex agent', commandAvailableFromRootFn(codexCommand, root) ? codexCommand : 'not found; install Codex CLI to use --agent codex');

    if (openCodeAvailable) {
      const openCodeConfigDir = path.join(projectRoot, '.opencode');
      const capability = inspectOpenCodeRuntimeFn(opencodeCommand, root, openCodeConfigDir);
      record(capability.ready ? 'ok' : 'warn', 'OC subagents', capability.ready
        ? `${agentNames.orchestrator} -> ${agentNames.explore}`
        : capability.reasons.join('; '));
      record(capability.subagentDepth >= 1 ? 'ok' : 'warn', 'OC child depth', `subagent_depth=${capability.subagentDepth}`);
      record('ok', 'OC handoff cap', `max_subagents=${numberOption(args.maxSubagents ?? processRuntime.env.CODEXPRO_MAX_SUBAGENTS ?? managerMaxSubagentsSetting(), managerMaxSubagentsSetting(), 1, 1)} (Manager setting)`);
      record(capability.taskPermission === 'allow' ? 'ok' : 'warn', 'OC Task access', `${agentNames.explore}: ${capability.taskPermission || 'not allowed'}`);
      record(capability.explorerEdit === 'deny' && capability.explorerBash === 'deny' && capability.explorerTask === 'deny' ? 'ok' : 'warn', 'OC child safety', `edit=${capability.explorerEdit || '?'} bash=${capability.explorerBash || '?'} task=${capability.explorerTask || '?'}`);

      const auditorCapability = inspectCodexProAuditorCapabilityFn(opencodeCommand, root, openCodeConfigDir);
      record(auditorCapability.ready ? 'ok' : 'warn', 'OC native audit', auditorCapability.ready ? agentNames.auditor : auditorCapability.reason);

      const scoutCapability = inspectOpenCodeRuntimeFn(opencodeCommand, root, openCodeConfigDir, { inspector: inspectOpenCodeScoutCapabilityFn });
      record(scoutCapability.ready ? 'ok' : 'warn', 'OC Gemini scout', scoutCapability.ready
        ? `${agentNames.scoutOrchestrator} -> ${agentNames.scout}`
        : scoutCapability.reasons.join('; '));
      record(
        scoutCapability.childPermissions?.read === 'deny' &&
        scoutCapability.childPermissions?.bash === 'deny' &&
        scoutCapability.childPermissions?.task === 'deny' &&
        scoutCapability.childPermissions?.webfetch === 'allow' &&
        scoutCapability.childPermissions?.websearch === 'allow'
          ? 'ok'
          : 'warn',
        'OC scout safety',
        `read=${scoutCapability.childPermissions?.read || '?'} bash=${scoutCapability.childPermissions?.bash || '?'} task=${scoutCapability.childPermissions?.task || '?'} webfetch=${scoutCapability.childPermissions?.webfetch || '?'} websearch=${scoutCapability.childPermissions?.websearch || '?'}`
      );
      const scoutAvailability = inspectGeminiScoutAvailabilityFn(opencodeCommand, root, openCodeConfigDir);
      record(scoutAvailability.ready ? 'ok' : 'warn', 'OC scout candidate', scoutAvailability.ready
        ? `${scoutAvailability.selectedModel} (catalog + credential; use --live-scout-check for end-to-end verification)`
        : scoutAvailability.reason);

      const selectedModel = String(args.model ?? capability.model ?? '').trim();
      const modelList = spawnSyncPortable(opencodeCommand, ['models'], { cwd: root, encoding: 'utf8', maxBuffer: 2_000_000, env: { ...processRuntime.env, NO_COLOR: '1' } });
      const modelListed = Boolean(selectedModel && modelList.status === 0 && String(modelList.stdout || '').split(/\r?\n/).some((line) => line.trim() === selectedModel));
      record(modelListed ? 'ok' : 'warn', 'OC model', selectedModel ? `${selectedModel}${modelListed ? '' : ' (not found in model catalog)'}` : 'no model selected or configured');

      const provider = selectedModel.includes('/') ? selectedModel.split('/')[0] : '';
      const authList = spawnSyncPortable(opencodeCommand, ['auth', 'list'], { cwd: root, encoding: 'utf8', maxBuffer: 200_000, env: { ...processRuntime.env, NO_COLOR: '1' } });
      const authText = String(authList.stdout || '');
      const providerCredentialVisible = provider === 'opencode' || Boolean(provider && authList.status === 0 && authText.toLowerCase().includes(provider.toLowerCase()));
      record(providerCredentialVisible ? 'ok' : 'warn', 'OC provider auth', provider ? (providerCredentialVisible ? `${provider}${provider === 'opencode' ? ' built-in' : ' credential visible'}` : `${provider}: no saved credential visible`) : 'provider unknown');

      if (args.liveAgentCheck) {
        const probe = await runOpenCodeModelProbeFn({ command: opencodeCommand, root, configDir: openCodeConfigDir, model: selectedModel });
        record(probe.ok ? 'ok' : 'fail', 'OC live model', probe.ok ? `${selectedModel || 'default'} responded in ${probe.durationMs} ms` : probe.reason);
      } else {
        record('warn', 'OC live model', 'not called; use --live-agent-check to verify provider/model end-to-end');
      }

      if (args.liveSubagentCheck) {
        const liveSubagent = await runVerifiedOpenCodeInvestigationFn({
          command: opencodeCommand,
          root,
          configDir: openCodeConfigDir,
          model: selectedModel,
          planText: 'Read package.json and report the exact package name plus the file path used as evidence. Do not modify anything.',
          timeoutMs: 120_000,
          maxOutputBytes: 120_000
        });
        record(liveSubagent.verified ? 'ok' : 'fail', 'OC live child', liveSubagent.verified ? `${liveSubagent.childSessionId}; files=${liveSubagent.filesInspected.join(', ') || '(none reported)'}` : liveSubagent.fallbackReason);
      } else {
        record('warn', 'OC live child', 'not called; use --live-subagent-check to require a real Task child session');
      }

      if (args.liveScoutCheck) {
        const liveScout = await runVerifiedGeminiScoutFn({
          command: opencodeCommand,
          root,
          configDir: openCodeConfigDir,
          model: selectedModel,
          planText: 'Verify from official OpenCode documentation how subagent_depth controls child-agent nesting and report the source URL. This is an external documentation verification task; do not inspect workspace files.',
          timeoutMs: 90_000,
          probeTimeoutMs: 12_000,
          maxOutputBytes: 120_000
        });
        record(liveScout.verified ? 'ok' : 'fail', 'OC live scout', liveScout.verified
          ? `${liveScout.childSessionId}; model=${liveScout.childModel}; tools=${liveScout.childToolNames.join(', ') || '(none)'}`
          : liveScout.fallbackReason);
      }
    }

    try {
      await assertPortAvailable(host, port);
      record('ok', 'Local port', `${host}:${port} available`);
    } catch (error) {
      record('fail', 'Local port', error instanceof Error ? error.message.split('\n')[0] : String(error));
    }

    if (tunnel === 'none') {
      record('ok', 'Tunnel', 'local-only mode');
    } else if (tunnel === 'cloudflare') {
      record(cloudflaredPath ? 'ok' : 'warn', 'cloudflared', cloudflaredPath || 'missing now; codexpro start can auto-install unless --no-install-cloudflared is used');
    } else if (tunnel === 'cloudflare-named') {
      record(stableHostname ? 'ok' : 'fail', 'Hostname', stableHostname || 'required for Cloudflare stable mode');
      record(cloudflaredPath ? 'ok' : 'warn', 'cloudflared', cloudflaredPath || 'missing now; run codexpro install-cloudflared or pass --cloudflared');
      record(
        optionValueFn(args, profile, 'tunnelName', ['CLOUDFLARE_TUNNEL_NAME', 'CODEXPRO_TUNNEL_NAME'], '') ||
          optionValueFn(args, profile, 'cloudflareTokenFile', ['CLOUDFLARE_TUNNEL_TOKEN_FILE', 'CODEXPRO_CLOUDFLARE_TUNNEL_TOKEN_FILE'], '') ||
          optionValueFn(args, profile, 'cloudflareConfig', ['CLOUDFLARE_TUNNEL_CONFIG', 'CODEXPRO_CLOUDFLARE_CONFIG'], '') ||
          optionValueFn(args, profile, 'cloudflareToken', ['CLOUDFLARE_TUNNEL_TOKEN', 'CODEXPRO_CLOUDFLARE_TUNNEL_TOKEN'], '')
          ? 'ok'
          : 'fail',
        'Cloudflare setup',
        'needs tunnel name, config, token file, or tunnel token'
      );
    } else if (tunnel === 'ngrok') {
      record(stableHostname ? 'ok' : 'fail', 'Hostname', stableHostname || 'required for ngrok mode');
      record(ngrokPath ? 'ok' : 'fail', 'ngrok', ngrokPath || 'not found on PATH; install ngrok and run ngrok config add-authtoken <token>');
    } else if (tunnel === 'tailscale') {
      record(stableHostname ? 'ok' : 'fail', 'Hostname', stableHostname || 'required for Tailscale Funnel mode');
      record(tailscalePath ? 'ok' : 'fail', 'tailscale', tailscalePath || 'not found on PATH; install Tailscale and enable Funnel');
    } else {
      record('fail', 'Tunnel', `unknown tunnel mode: ${tunnel}`);
    }

    const failures = checks.filter((status) => status === 'fail').length;
    const warnings = checks.filter((status) => status === 'warn').length;
    consoleRuntime.log('');
    if (failures) {
      statusLineFn('warn', `${failures} blocker${failures === 1 ? '' : 's'} and ${warnings} warning${warnings === 1 ? '' : 's'} found.`);
      processRuntime.exitCode = 1;
      return;
    }
    statusLineFn('ok', warnings ? `Ready with ${warnings} warning${warnings === 1 ? '' : 's'}.` : 'Ready.');
  }

  return { runDoctor };
}
