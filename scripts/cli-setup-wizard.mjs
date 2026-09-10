import path from 'node:path';
import process from 'node:process';
import { createInterface as createReadlineInterface } from 'node:readline/promises';
import {
  configuredProjectRoots,
  expandHome,
  optionalChoice,
  optionalWriteOption,
  optionValue,
  parseArgs,
  realDir
} from './cli-options.mjs';
import {
  bashSessionOptions,
  bashTranscriptOption,
  codexSessionsOption,
  toolCardsCliArgs,
  toolCardsProfileEntry
} from './cli-runtime-options.mjs';
import { paint, printBox, statusLine } from './cli-presentation.mjs';
import {
  listWorkspaceProfiles,
  loadWorkspaceProfile,
  reusableProfilePayload,
  saveWorkspaceProfile
} from './workspace-profile-store.mjs';

export function createCliSetupWizard({
  normalizePublicHostname,
  normalizePort,
  stableToken,
  shellCommandPreview,
  optionHelpers = {},
  runtimeOptionHelpers = {},
  profileStore = {},
  presentation = {},
  runtime = {}
} = {}) {
  const processRuntime = runtime.process ?? process;
  const createInterfaceFn = runtime.createInterface ?? createReadlineInterface;
  const consoleRuntime = runtime.console ?? console;

  const configuredProjectRootsFn = optionHelpers.configuredProjectRoots ?? configuredProjectRoots;
  const expandHomeFn = optionHelpers.expandHome ?? expandHome;
  const optionalChoiceFn = optionHelpers.optionalChoice ?? optionalChoice;
  const optionalWriteOptionFn = optionHelpers.optionalWriteOption ?? optionalWriteOption;
  const optionValueFn = optionHelpers.optionValue ?? optionValue;
  const parseArgsFn = optionHelpers.parseArgs ?? parseArgs;
  const realDirFn = optionHelpers.realDir ?? realDir;

  const bashSessionOptionsFn = runtimeOptionHelpers.bashSessionOptions ?? bashSessionOptions;
  const bashTranscriptOptionFn = runtimeOptionHelpers.bashTranscriptOption ?? bashTranscriptOption;
  const codexSessionsOptionFn = runtimeOptionHelpers.codexSessionsOption ?? codexSessionsOption;
  const toolCardsCliArgsFn = runtimeOptionHelpers.toolCardsCliArgs ?? toolCardsCliArgs;
  const toolCardsProfileEntryFn = runtimeOptionHelpers.toolCardsProfileEntry ?? toolCardsProfileEntry;

  const listWorkspaceProfilesFn = profileStore.listWorkspaceProfiles ?? listWorkspaceProfiles;
  const loadWorkspaceProfileFn = profileStore.loadWorkspaceProfile ?? loadWorkspaceProfile;
  const reusableProfilePayloadFn = profileStore.reusableProfilePayload ?? reusableProfilePayload;
  const saveWorkspaceProfileFn = profileStore.saveWorkspaceProfile ?? saveWorkspaceProfile;

  const paintFn = presentation.paint ?? paint;
  const printBoxFn = presentation.printBox ?? printBox;
  const statusLineFn = presentation.statusLine ?? statusLine;

  function profileSummary(profile) {
    if (!profile?.tunnel) return '';
    if (profile.tunnel === 'ngrok' && profile.hostname) return `Saved ngrok URL: ${profile.hostname}`;
    if (profile.tunnel === 'cloudflare-named' && profile.hostname) return `Saved Cloudflare URL: ${profile.hostname}`;
    if (profile.tunnel === 'tailscale' && profile.hostname) return `Saved Tailscale Funnel URL: ${profile.hostname}`;
    if (profile.tunnel === 'cloudflare') return 'Saved Cloudflare quick-tunnel setup';
    if (profile.tunnel === 'none') return 'Saved local-only setup';
    return '';
  }

  function profileOneLine(profile, index = 0) {
    const prefix = index ? `${index}. ` : '';
    const tunnel = profile.tunnel ?? 'cloudflare';
    const host = profile.hostname ? ` -> ${profile.hostname}` : '';
    const port = profile.port ? ` :${profile.port}` : '';
    return `${prefix}${profile.root}  ${tunnel}${host}${port}`;
  }

  function printSavedProfileHint(profile) {
    const summary = profileSummary(profile);
    if (!summary) return;
    printBoxFn('Saved setup found', [
      summary,
      'From this folder, future launches only need: codexpro start',
      'Use codexpro setup when you want to change the port, mode, tool mode, tunnel, hostname, or token.'
    ]);
  }

  function normalizeSetupChoice(value, allowed, fallback) {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return fallback;
    const match = allowed.find((item) => item === normalized || item.startsWith(normalized));
    return match ?? fallback;
  }

  async function ask(rl, question, fallback = '') {
    const suffix = fallback ? ` ${paintFn('dim', `[${fallback}]`)}` : '';
    const hint = fallback ? `${paintFn('dim', '> Enter to proceed with default')}\n` : '';
    const answer = await rl.question(`${paintFn('cyan', '?')} ${question}${suffix}\n${hint}> `);
    return answer.trim() || fallback;
  }

  function tunnelChoiceFromProfile(profile, fallback = 'cloudflare') {
    if (profile?.tunnel === 'ngrok') return 'ngrok';
    if (profile?.tunnel === 'cloudflare-named') return 'stable';
    if (profile?.tunnel === 'tailscale') return 'tailscale';
    if (profile?.tunnel === 'none') return 'local';
    if (profile?.tunnel === 'cloudflare') return 'cloudflare';
    return fallback;
  }

  function tunnelModeFromChoice(choice) {
    if (choice === 'quick' || choice === 'cloudflare') return 'cloudflare';
    if (choice === 'stable') return 'cloudflare-named';
    if (choice === 'tailscale') return 'tailscale';
    if (choice === 'local') return 'none';
    return choice;
  }

  function hasExplicitTunnelInput(args) {
    return Boolean(
      args.tunnel ||
      args.noProfile ||
      processRuntime.env.CODEXPRO_TUNNEL
    );
  }

  async function collectTunnelPreference(rl, defaults, profile, options = {}) {
    const defaultTunnel = options.defaultTunnel ?? tunnelChoiceFromProfile(profile, 'cloudflare');
    const tunnelAnswer = await ask(rl, 'Tunnel: cloudflare, ngrok, tailscale, stable, or local?', defaultTunnel);
    const tunnelChoice = normalizeSetupChoice(tunnelAnswer, ['cloudflare', 'quick', 'ngrok', 'tailscale', 'stable', 'local'], defaultTunnel);
    const tunnel = tunnelModeFromChoice(tunnelChoice);
    let hostname = '';
    let tunnelName = '';
    let ngrokConfig = '';
    let cloudflareConfig = '';
    let cloudflareTokenFile = '';

    if (tunnel === 'ngrok') {
      hostname = await ask(
        rl,
        'Ngrok domain or URL, without /mcp',
        optionValueFn(defaults, profile, 'hostname', ['CODEXPRO_PUBLIC_HOSTNAME', 'CODEXPRO_HOSTNAME', 'NGROK_DOMAIN'], '')
      );
      if (!hostname) throw new Error('Ngrok setup needs your reserved domain, for example name.ngrok-free.dev.');
      hostname = normalizePublicHostname(hostname);
      ngrokConfig = optionValueFn(defaults, profile, 'ngrokConfig', ['NGROK_CONFIG', 'CODEXPRO_NGROK_CONFIG'], '');
    } else if (tunnel === 'cloudflare-named') {
      hostname = await ask(
        rl,
        'Stable Cloudflare hostname, without /mcp',
        optionValueFn(defaults, profile, 'hostname', ['CODEXPRO_PUBLIC_HOSTNAME', 'CODEXPRO_HOSTNAME'], '')
      );
      if (!hostname) throw new Error('Stable public URL setup needs a real hostname, for example codexpro.yourdomain.com.');
      hostname = normalizePublicHostname(hostname);
      tunnelName = await ask(rl, 'Cloudflare tunnel name', optionValueFn(defaults, profile, 'tunnelName', ['CODEXPRO_TUNNEL_NAME', 'CLOUDFLARE_TUNNEL_NAME'], 'codexpro'));
      cloudflareConfig = optionValueFn(defaults, profile, 'cloudflareConfig', ['CODEXPRO_CLOUDFLARE_CONFIG', 'CLOUDFLARE_TUNNEL_CONFIG'], '');
      cloudflareTokenFile = optionValueFn(defaults, profile, 'cloudflareTokenFile', ['CODEXPRO_CLOUDFLARE_TUNNEL_TOKEN_FILE', 'CLOUDFLARE_TUNNEL_TOKEN_FILE'], '');
    } else if (tunnel === 'tailscale') {
      hostname = await ask(
        rl,
        'Tailscale Funnel hostname, without /mcp',
        optionValueFn(defaults, profile, 'hostname', ['CODEXPRO_PUBLIC_HOSTNAME', 'CODEXPRO_HOSTNAME', 'TAILSCALE_FUNNEL_HOSTNAME'], '')
      );
      if (!hostname) throw new Error('Tailscale setup needs your Funnel hostname, for example machine.tailnet.ts.net.');
      hostname = normalizePublicHostname(hostname);
    }

    return {
      tunnel,
      hostname,
      tunnelName,
      ngrokConfig,
      cloudflareConfig,
      cloudflareTokenFile
    };
  }

  function applyTunnelPreferenceToArgs(args, preference) {
    args.tunnel = preference.tunnel;
    if (preference.hostname) args.hostname = preference.hostname;
    if (preference.tunnelName) args.tunnelName = preference.tunnelName;
    if (preference.ngrokConfig) args.ngrokConfig = preference.ngrokConfig;
    if (preference.cloudflareConfig) args.cloudflareConfig = preference.cloudflareConfig;
    if (preference.cloudflareTokenFile) args.cloudflareTokenFile = preference.cloudflareTokenFile;
  }

  function profileFromPreference(root, args, profile, preference) {
    const mode = optionValueFn(args, profile, 'mode', ['CODEXPRO_MODE'], 'agent');
    const port = String(optionValueFn(args, profile, 'port', ['CODEXPRO_PORT'], '8787'));
    const bash = optionValueFn(args, profile, 'bash', ['CODEXPRO_BASH_MODE'], '');
    const bashTranscript = bashTranscriptOptionFn(args, profile);
    const codexSessions = codexSessionsOptionFn(args, profile);
    const codexDir = optionValueFn(args, profile, 'codexDir', ['CODEXPRO_CODEX_DIR'], '');
    const { bashSession, requireBashSession } = bashSessionOptionsFn(args, profile);
    const write = optionalWriteOptionFn(args, profile, mode);
    const toolMode = optionValueFn(args, profile, 'toolMode', ['CODEXPRO_TOOL_MODE'], '');
    const widgetDomain = optionValueFn(args, profile, 'widgetDomain', ['CODEXPRO_WIDGET_DOMAIN'], '');
    const existingToken = optionValueFn(args, profile, 'token', ['CODEXPRO_HTTP_TOKEN', 'CODEBASE_BRIDGE_HTTP_TOKEN'], '');
    const token = preference.tunnel === 'none' ? existingToken : stableToken(existingToken);
    const allowedRoots = configuredProjectRootsFn(root, args, profile);
    return {
      port,
      mode,
      tunnel: preference.tunnel,
      ...(preference.hostname ? { hostname: preference.hostname } : {}),
      ...(preference.tunnelName ? { tunnelName: preference.tunnelName } : {}),
      ...(preference.ngrokConfig ? { ngrokConfig: preference.ngrokConfig } : {}),
      ...(preference.cloudflareConfig ? { cloudflareConfig: preference.cloudflareConfig } : {}),
      ...(preference.cloudflareTokenFile ? { cloudflareTokenFile: preference.cloudflareTokenFile } : {}),
      ...(token ? { token } : {}),
      ...(bash ? { bash } : {}),
      ...(bashTranscript !== 'compact' ? { bashTranscript } : {}),
      ...(codexSessions !== 'off' ? { codexSessions } : {}),
      ...(codexDir ? { codexDir } : {}),
      ...(bashSession ? { bashSession } : {}),
      ...(requireBashSession ? { requireBashSession: true } : {}),
      ...(write ? { write } : {}),
      ...(toolMode ? { toolMode } : {}),
      ...(widgetDomain ? { widgetDomain } : {}),
      ...toolCardsProfileEntryFn(args, profile),
      ...(allowedRoots.length ? { allowedRoots } : {}),
      ...(args.noInstallCloudflared ? { noInstallCloudflared: true } : {}),
      root
    };
  }

  async function maybeConfigureFirstRun(root, args, profile) {
    if (profile.profilePath || args.headless || !processRuntime.stdin.isTTY || !processRuntime.stdout.isTTY || processRuntime.env.CI || hasExplicitTunnelInput(args)) {
      return profile;
    }

    const reusableProfiles = listWorkspaceProfilesFn().filter((item) => item.root !== root);
    if (reusableProfiles.length) {
      const shown = reusableProfiles.slice(0, 9);
      printBoxFn('Saved setups', [
        'No saved settings exist for this workspace, but CodexPro found saved setups from other workspaces.',
        ...shown.map((item, index) => profileOneLine(item, index + 1)),
        'Use a number to reuse one here, or type new to choose a fresh tunnel.'
      ]);
      const rl = createInterfaceFn({ input: processRuntime.stdin, output: processRuntime.stdout });
      try {
        const answer = await ask(rl, 'Use saved setup number, or new?', shown.length === 1 ? '1' : 'new');
        const normalized = answer.trim().toLowerCase();
        const selectedIndex = Number(normalized);
        if (Number.isInteger(selectedIndex) && selectedIndex >= 1 && selectedIndex <= shown.length) {
          const selected = shown[selectedIndex - 1];
          const payload = reusableProfilePayloadFn(selected, {
            port: String(optionValueFn(args, selected, 'port', ['CODEXPRO_PORT'], selected.port ?? '8787')),
            mode: optionValueFn(args, selected, 'mode', ['CODEXPRO_MODE'], selected.mode ?? 'agent')
          });
          const savedPath = saveWorkspaceProfileFn(root, payload);
          statusLineFn('ok', `Saved workspace settings from ${selected.root}: ${savedPath}`);
          return loadWorkspaceProfileFn(root);
        }
      } finally {
        rl.close();
      }
    }

    printBoxFn('First run setup', [
      'No saved tunnel preference exists for this workspace.',
      'Choose once now. CodexPro will reuse this choice on future codexpro start runs until you change or delete it with codexpro settings.'
    ]);

    const rl = createInterfaceFn({ input: processRuntime.stdin, output: processRuntime.stdout });
    try {
      const preference = await collectTunnelPreference(rl, args, profile, { defaultTunnel: 'cloudflare' });
      applyTunnelPreferenceToArgs(args, preference);
      const saveAnswer = await ask(rl, 'Save this as the default for this workspace?', 'yes');
      if (!['n', 'no'].includes(saveAnswer.trim().toLowerCase())) {
        const savedPath = saveWorkspaceProfileFn(root, profileFromPreference(root, args, profile, preference));
        statusLineFn('ok', `Saved workspace settings: ${savedPath}`);
        return loadWorkspaceProfileFn(root);
      }
      return profileFromPreference(root, args, profile, preference);
    } finally {
      rl.close();
    }
  }

  function commandPreview(args) {
    return shellCommandPreview(['codexpro', ...args]);
  }

  async function runSetupWizard(argv) {
    if (!processRuntime.stdin.isTTY) {
      throw new Error('codexpro setup needs an interactive terminal. Use codexpro start --root /path/to/repo for non-interactive scripts.');
    }
    const defaults = parseArgsFn(argv);
    const defaultRoot = path.resolve(expandHomeFn(defaults.root ?? processRuntime.env.CODEXPRO_ROOT ?? processRuntime.cwd()));

    printBoxFn('CodexPro setup', [
      'This wizard prepares a ChatGPT connector for the folder you choose.',
      'Press Enter to accept defaults. Stable tunnel choices are saved per workspace under ~/.codexpro.'
    ]);

    const rl = createInterfaceFn({ input: processRuntime.stdin, output: processRuntime.stdout });
    try {
      const rootInput = await ask(rl, 'Where is your project located?', defaultRoot);
      const root = realDirFn(rootInput);
      const profile = defaults.noProfile ? {} : loadWorkspaceProfileFn(root);
      if (profile.profilePath) {
        statusLineFn('ok', `Loaded saved profile: ${profile.profilePath}`);
        printSavedProfileHint(profile);
      }

      const savedTunnel = optionValueFn(defaults, profile, 'tunnel', ['CODEXPRO_TUNNEL'], 'cloudflare');
      const defaultTunnel = savedTunnel === 'cloudflare-named'
        ? 'stable'
        : savedTunnel === 'ngrok'
          ? 'ngrok'
          : savedTunnel === 'tailscale'
            ? 'tailscale'
            : savedTunnel === 'none'
              ? 'local'
              : 'quick';
      const defaultPort = String(optionValueFn(defaults, profile, 'port', ['CODEXPRO_PORT'], '8787'));
      const defaultMode = normalizeSetupChoice(optionValueFn(defaults, profile, 'mode', ['CODEXPRO_MODE'], 'agent'), ['agent', 'handoff', 'pro'], 'agent');

      const port = normalizePort(await ask(rl, 'Which local port should CodexPro use?', defaultPort));
      const modeAnswer = await ask(rl, 'Mode: agent, handoff, or pro?', defaultMode);
      const mode = normalizeSetupChoice(modeAnswer, ['agent', 'handoff', 'pro'], defaultMode);

      printBoxFn('Public URL', [
        'ChatGPT needs an HTTPS URL it can reach.',
        'quick  = CodexPro creates a Cloudflare quick tunnel for demos and local work.',
        'stable = use your own domain with a Cloudflare named tunnel so the ChatGPT app URL does not change.',
        'ngrok  = use your ngrok free dev domain, for example https://name.ngrok-free.dev.',
        'tailscale = use Tailscale Funnel, for example https://device.tailnet.ts.net.',
        'local  = no tunnel, only useful for local MCP clients that can reach 127.0.0.1.'
      ]);

      const tunnelAnswer = await ask(rl, 'Public access: quick, stable, ngrok, tailscale, or local?', defaultTunnel);
      const tunnelChoice = normalizeSetupChoice(tunnelAnswer, ['quick', 'stable', 'ngrok', 'tailscale', 'local'], defaultTunnel);
      const args = ['start', '--root', root, '--port', port, '--mode', mode];
      const bash = optionValueFn(defaults, profile, 'bash', ['CODEXPRO_BASH_MODE'], '');
      const bashTranscript = bashTranscriptOptionFn(defaults, profile);
      const codexSessions = codexSessionsOptionFn(defaults, profile);
      const codexDir = optionValueFn(defaults, profile, 'codexDir', ['CODEXPRO_CODEX_DIR'], '');
      const write = optionalWriteOptionFn(defaults, profile, mode);
      const toolMode = optionalChoiceFn('tool-mode', optionValueFn(defaults, profile, 'toolMode', ['CODEXPRO_TOOL_MODE'], ''), ['minimal', 'standard', 'full']);
      const widgetDomain = optionValueFn(defaults, profile, 'widgetDomain', ['CODEXPRO_WIDGET_DOMAIN'], '');
      const toolCardsEntry = toolCardsProfileEntryFn(defaults, profile);
      if (bash) args.push('--bash', bash);
      if (bashTranscript !== 'compact') args.push('--bash-transcript', bashTranscript);
      if (codexSessions !== 'off') args.push('--codex-sessions', codexSessions);
      if (codexDir) args.push('--codex-dir', codexDir);
      const { bashSession, requireBashSession } = bashSessionOptionsFn(defaults, profile);
      if (bashSession) args.push('--bash-session', bashSession);
      if (requireBashSession) args.push('--require-bash-session');
      if (write) args.push('--write', write);
      if (toolMode) args.push('--tool-mode', toolMode);
      if (widgetDomain) args.push('--widget-domain', widgetDomain);
      args.push(...toolCardsCliArgsFn(defaults, profile));
      if (defaults.noInstallCloudflared) args.push('--no-install-cloudflared');
      if (defaults.openChatgpt) args.push('--open-chatgpt');
      if (defaults.noCopyUrl) args.push('--no-copy-url');

      let profileTunnel = 'cloudflare';
      let profileHostname = '';
      let profileTunnelName = '';
      let profileNgrokConfig = '';
      let profileCloudflareConfig = '';
      let profileCloudflareTokenFile = '';
      let profileToken = optionValueFn(defaults, profile, 'token', ['CODEXPRO_HTTP_TOKEN', 'CODEBASE_BRIDGE_HTTP_TOKEN'], '');

      if (tunnelChoice === 'local') {
        profileTunnel = 'none';
        args.push('--tunnel', 'none');
      } else if (tunnelChoice === 'stable') {
        profileTunnel = 'cloudflare-named';
        let hostname = await ask(
          rl,
          'Stable Cloudflare hostname, without /mcp',
          optionValueFn(defaults, profile, 'hostname', ['CODEXPRO_PUBLIC_HOSTNAME', 'CODEXPRO_HOSTNAME'], '')
        );
        if (!hostname) throw new Error('Stable public URL setup needs a real hostname, for example codexpro.yourdomain.com.');
        hostname = normalizePublicHostname(hostname);
        profileHostname = hostname;
        const tunnelName = await ask(rl, 'Cloudflare tunnel name', optionValueFn(defaults, profile, 'tunnelName', ['CODEXPRO_TUNNEL_NAME', 'CLOUDFLARE_TUNNEL_NAME'], 'codexpro'));
        profileTunnelName = tunnelName;
        args.push('--tunnel', 'cloudflare-named', '--hostname', hostname, '--tunnel-name', tunnelName);
        profileCloudflareConfig = optionValueFn(defaults, profile, 'cloudflareConfig', ['CODEXPRO_CLOUDFLARE_CONFIG', 'CLOUDFLARE_TUNNEL_CONFIG'], '');
        profileCloudflareTokenFile = optionValueFn(defaults, profile, 'cloudflareTokenFile', ['CODEXPRO_CLOUDFLARE_TUNNEL_TOKEN_FILE', 'CLOUDFLARE_TUNNEL_TOKEN_FILE'], '');
        if (profileCloudflareConfig) args.push('--cloudflare-config', profileCloudflareConfig);
        if (profileCloudflareTokenFile) args.push('--cloudflare-token-file', profileCloudflareTokenFile);
      } else if (tunnelChoice === 'ngrok') {
        profileTunnel = 'ngrok';
        let hostname = await ask(
          rl,
          'Ngrok domain or URL, without /mcp',
          optionValueFn(defaults, profile, 'hostname', ['CODEXPRO_PUBLIC_HOSTNAME', 'CODEXPRO_HOSTNAME', 'NGROK_DOMAIN'], '')
        );
        if (!hostname) throw new Error('Ngrok setup needs your reserved domain, for example name.ngrok-free.dev.');
        hostname = normalizePublicHostname(hostname);
        profileHostname = hostname;
        args.push('--tunnel', 'ngrok', '--hostname', hostname);
        const ngrokConfig = optionValueFn(defaults, profile, 'ngrokConfig', ['NGROK_CONFIG', 'CODEXPRO_NGROK_CONFIG'], '');
        if (ngrokConfig) {
          profileNgrokConfig = ngrokConfig;
          args.push('--ngrok-config', ngrokConfig);
        }
      } else if (tunnelChoice === 'tailscale') {
        profileTunnel = 'tailscale';
        let hostname = await ask(
          rl,
          'Tailscale Funnel hostname, without /mcp',
          optionValueFn(defaults, profile, 'hostname', ['CODEXPRO_PUBLIC_HOSTNAME', 'CODEXPRO_HOSTNAME', 'TAILSCALE_FUNNEL_HOSTNAME'], '')
        );
        if (!hostname) throw new Error('Tailscale setup needs your Funnel hostname, for example machine.tailnet.ts.net.');
        hostname = normalizePublicHostname(hostname);
        profileHostname = hostname;
        args.push('--tunnel', 'tailscale', '--hostname', hostname);
      } else {
        profileTunnel = 'cloudflare';
        args.push('--tunnel', 'cloudflare');
      }

      if (profileTunnel !== 'none') {
        profileToken = await ask(rl, 'CodexPro auth token for this workspace', stableToken(profileToken));
        if (profileToken) args.push('--token', profileToken);
      }

      const saveDefault = defaults.noSaveConfig ? 'no' : 'yes';
      const saveAnswer = await ask(rl, 'Save this setup for future runs from this workspace?', saveDefault);
      const shouldSave = !['n', 'no'].includes(saveAnswer.trim().toLowerCase());
      if (shouldSave) {
        const allowedRoots = configuredProjectRootsFn(root, defaults, profile);
        const savedPath = saveWorkspaceProfileFn(root, {
          port,
          mode,
          tunnel: profileTunnel,
          ...(profileHostname ? { hostname: profileHostname } : {}),
          ...(profileTunnelName ? { tunnelName: profileTunnelName } : {}),
          ...(profileNgrokConfig ? { ngrokConfig: profileNgrokConfig } : {}),
          ...(profileCloudflareConfig ? { cloudflareConfig: profileCloudflareConfig } : {}),
          ...(profileCloudflareTokenFile ? { cloudflareTokenFile: profileCloudflareTokenFile } : {}),
          ...(profileToken ? { token: profileToken } : {}),
          ...(bash ? { bash } : {}),
          ...(bashTranscript !== 'compact' ? { bashTranscript } : {}),
          ...(codexSessions !== 'off' ? { codexSessions } : {}),
          ...(codexDir ? { codexDir } : {}),
          ...(bashSession ? { bashSession } : {}),
          ...(requireBashSession ? { requireBashSession: true } : {}),
          ...(write ? { write } : {}),
          ...(toolMode ? { toolMode } : {}),
          ...(widgetDomain ? { widgetDomain } : {}),
          ...toolCardsEntry,
          ...(allowedRoots.length ? { allowedRoots } : {}),
          ...(defaults.noInstallCloudflared ? { noInstallCloudflared: true } : {})
        });
        statusLineFn('ok', `Saved workspace profile: ${savedPath}`);
      }

      const startAnswer = await ask(rl, 'Start CodexPro now?', 'yes');
      const shouldStart = !['n', 'no'].includes(startAnswer.trim().toLowerCase());
      consoleRuntime.log('');
      consoleRuntime.log(paintFn('bold', 'Command'));
      consoleRuntime.log(`  ${commandPreview(args)}`);
      consoleRuntime.log('');
      if (!shouldStart) {
        consoleRuntime.log('Setup complete. Run the command above when you are ready.');
        return null;
      }
      return args;
    } finally {
      rl.close();
    }
  }

  return {
    profileSummary,
    profileOneLine,
    printSavedProfileHint,
    normalizeSetupChoice,
    ask,
    tunnelChoiceFromProfile,
    tunnelModeFromChoice,
    hasExplicitTunnelInput,
    collectTunnelPreference,
    applyTunnelPreferenceToArgs,
    profileFromPreference,
    maybeConfigureFirstRun,
    commandPreview,
    runSetupWizard
  };
}
