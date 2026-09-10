import assert from 'node:assert/strict';
import fs from 'node:fs';
import process from 'node:process';
import { createCliProcessRuntime } from './cli-process-runtime.mjs';
import { createCliSetupWizard } from './cli-setup-wizard.mjs';
import { createCliTunnelRuntime } from './cli-tunnel-runtime.mjs';

const { normalizePort } = createCliProcessRuntime();
const { normalizePublicHostname } = createCliTunnelRuntime();
const tokenFixture = ['fixture', 'token'].join('-');
const stableToken = (value = '') => value || tokenFixture;
const shellCommandPreview = (parts) => parts.join(' ');

function runtime(overrides = {}) {
  return {
    process: {
      env: {},
      stdin: { isTTY: true },
      stdout: { isTTY: true },
      cwd: () => process.cwd(),
      ...overrides.process
    },
    console: overrides.console ?? { log() {} },
    createInterface: overrides.createInterface
  };
}

function readlineFromAnswers(answers, prompts = [], closeCalls = []) {
  let index = 0;
  return () => ({
    async question(prompt) {
      prompts.push(prompt);
      const answer = answers[index];
      index += 1;
      return answer ?? '';
    },
    close() {
      closeCalls.push(true);
    }
  });
}

function wizard(overrides = {}) {
  return createCliSetupWizard({
    normalizePublicHostname,
    normalizePort,
    stableToken,
    shellCommandPreview,
    ...overrides
  });
}

{
  const api = wizard();
  assert.equal(api.profileSummary({ tunnel: 'ngrok', hostname: 'demo.ngrok-free.dev' }), 'Saved ngrok URL: demo.ngrok-free.dev');
  assert.equal(api.profileSummary({ tunnel: 'cloudflare-named', hostname: 'demo.example.com' }), 'Saved Cloudflare URL: demo.example.com');
  assert.equal(api.profileSummary({ tunnel: 'tailscale', hostname: 'demo.tailnet.ts.net' }), 'Saved Tailscale Funnel URL: demo.tailnet.ts.net');
  assert.equal(api.profileSummary({ tunnel: 'cloudflare' }), 'Saved Cloudflare quick-tunnel setup');
  assert.equal(api.profileSummary({ tunnel: 'none' }), 'Saved local-only setup');
  assert.equal(api.profileSummary({}), '');
  assert.equal(api.profileOneLine({ root: 'C:/repo', tunnel: 'ngrok', hostname: 'demo.ngrok-free.dev', port: '8787' }, 2), '2. C:/repo  ngrok -> demo.ngrok-free.dev :8787');

  assert.equal(api.normalizeSetupChoice('st', ['quick', 'stable', 'local'], 'quick'), 'stable');
  assert.equal(api.normalizeSetupChoice('', ['quick', 'stable'], 'quick'), 'quick');
  assert.equal(api.normalizeSetupChoice('unknown', ['quick', 'stable'], 'quick'), 'quick');

  assert.equal(api.tunnelChoiceFromProfile({ tunnel: 'cloudflare-named' }), 'stable');
  assert.equal(api.tunnelChoiceFromProfile({ tunnel: 'cloudflare' }), 'cloudflare');
  assert.equal(api.tunnelChoiceFromProfile({ tunnel: 'ngrok' }), 'ngrok');
  assert.equal(api.tunnelChoiceFromProfile({ tunnel: 'tailscale' }), 'tailscale');
  assert.equal(api.tunnelChoiceFromProfile({ tunnel: 'none' }), 'local');
  assert.equal(api.tunnelModeFromChoice('quick'), 'cloudflare');
  assert.equal(api.tunnelModeFromChoice('stable'), 'cloudflare-named');
  assert.equal(api.tunnelModeFromChoice('tailscale'), 'tailscale');
  assert.equal(api.tunnelModeFromChoice('local'), 'none');
  assert.equal(api.commandPreview(['start', '--root', 'C:/repo']), 'codexpro start --root C:/repo');
}

{
  const prompts = [];
  const api = wizard({
    presentation: { paint: (_style, value) => value },
    runtime: runtime({ createInterface: readlineFromAnswers([]) })
  });
  const rl = { question: async (prompt) => { prompts.push(prompt); return ''; } };
  assert.equal(await api.ask(rl, 'Choose?', 'yes'), 'yes');
  assert.equal(prompts[0], '? Choose? [yes]\n> Enter to proceed with default\n> ');
}

{
  const fakeProcess = runtime({ process: { env: {} } }).process;
  const api = wizard({ runtime: { process: fakeProcess } });
  assert.equal(api.hasExplicitTunnelInput({ tunnel: 'none' }), true);
  assert.equal(api.hasExplicitTunnelInput({ noProfile: true }), true);
  assert.equal(api.hasExplicitTunnelInput({}), false);
  fakeProcess.env.CODEXPRO_TUNNEL = 'ngrok';
  assert.equal(api.hasExplicitTunnelInput({}), true);
}

{
  const answers = ['stable', 'https://stable.example.com/', 'named-tunnel'];
  const api = wizard({ runtime: runtime({ createInterface: readlineFromAnswers(answers) }) });
  const rl = runtime({ createInterface: readlineFromAnswers(answers) }).createInterface();
  const preference = await api.collectTunnelPreference(rl, {}, {}, { defaultTunnel: 'cloudflare' });
  assert.deepEqual(preference, {
    tunnel: 'cloudflare-named',
    hostname: 'stable.example.com',
    tunnelName: 'named-tunnel',
    ngrokConfig: '',
    cloudflareConfig: '',
    cloudflareTokenFile: ''
  });
  const args = {};
  api.applyTunnelPreferenceToArgs(args, preference);
  assert.deepEqual(args, { tunnel: 'cloudflare-named', hostname: 'stable.example.com', tunnelName: 'named-tunnel' });
}

{
  const api = wizard();
  await assert.rejects(
    () => api.collectTunnelPreference(readlineFromAnswers(['ngrok', ''])(), {}, {}, { defaultTunnel: 'cloudflare' }),
    /Ngrok setup needs your reserved domain/
  );
  await assert.rejects(
    () => api.collectTunnelPreference(readlineFromAnswers(['tailscale', ''])(), {}, {}, { defaultTunnel: 'cloudflare' }),
    /Tailscale setup needs your Funnel hostname/
  );
}

{
  const api = wizard({
    optionHelpers: { configuredProjectRoots: () => ['C:/extra'] },
    runtimeOptionHelpers: {
      bashSessionOptions: () => ({ bashSession: 'session-a', requireBashSession: true }),
      bashTranscriptOption: () => 'full',
      codexSessionsOption: () => 'read',
      toolCardsProfileEntry: () => ({ toolCards: 'on' })
    }
  });
  const profile = api.profileFromPreference(
    'C:/repo',
    { bash: 'safe', write: 'workspace', toolMode: 'full', widgetDomain: 'https://widgets.example', noInstallCloudflared: true },
    {},
    { tunnel: 'cloudflare', hostname: '', tunnelName: '', ngrokConfig: '', cloudflareConfig: '', cloudflareTokenFile: '' }
  );
  assert.equal(profile.token, tokenFixture);
  assert.equal(profile.port, '8787');
  assert.equal(profile.mode, 'agent');
  assert.equal(profile.bash, 'safe');
  assert.equal(profile.write, 'workspace');
  assert.equal(profile.toolMode, 'full');
  assert.equal(profile.widgetDomain, 'https://widgets.example');
  assert.equal(profile.toolCards, 'on');
  assert.equal(profile.bashSession, 'session-a');
  assert.equal(profile.requireBashSession, true);
  assert.equal(profile.bashTranscript, 'full');
  assert.equal(profile.codexSessions, 'read');
  assert.deepEqual(profile.allowedRoots, ['C:/extra']);
  assert.equal(profile.noInstallCloudflared, true);

  const local = api.profileFromPreference(
    'C:/repo',
    { token: tokenFixture },
    {},
    { tunnel: 'none', hostname: '', tunnelName: '', ngrokConfig: '', cloudflareConfig: '', cloudflareTokenFile: '' }
  );
  assert.equal(local.token, tokenFixture);
}

{
  let interfaceCalls = 0;
  const api = wizard({
    runtime: runtime({ createInterface: () => { interfaceCalls += 1; return readlineFromAnswers([])(); } })
  });
  const saved = { root: 'C:/repo', profilePath: 'C:/profile.json', tunnel: 'cloudflare' };
  assert.equal(await api.maybeConfigureFirstRun('C:/repo', {}, saved), saved);
  assert.equal(interfaceCalls, 0);
}

{
  const boxes = [];
  const savedPayloads = [];
  const reusable = Array.from({ length: 11 }, (_, index) => ({
    root: `C:/saved-${index + 1}`,
    port: String(8800 + index),
    mode: index === 1 ? 'handoff' : 'agent',
    tunnel: 'cloudflare'
  }));
  const closes = [];
  const api = wizard({
    runtime: runtime({ createInterface: readlineFromAnswers(['2'], [], closes) }),
    presentation: {
      paint: (_style, value) => value,
      printBox: (title, lines) => boxes.push({ title, lines }),
      statusLine() {}
    },
    profileStore: {
      listWorkspaceProfiles: () => reusable,
      reusableProfilePayload: (profile, overrides) => ({ ...profile, ...overrides, root: undefined }),
      saveWorkspaceProfile: (root, payload) => { savedPayloads.push({ root, payload }); return 'saved-profile.json'; },
      loadWorkspaceProfile: (root) => ({ root, profilePath: 'saved-profile.json', tunnel: 'cloudflare' })
    }
  });
  const result = await api.maybeConfigureFirstRun('C:/current', {}, {});
  assert.equal(result.profilePath, 'saved-profile.json');
  assert.equal(boxes[0].title, 'Saved setups');
  assert.equal(boxes[0].lines.some((line) => line.includes('C:/saved-9')), true);
  assert.equal(boxes[0].lines.some((line) => line.includes('C:/saved-10')), false);
  assert.equal(savedPayloads[0].root, 'C:/current');
  assert.equal(savedPayloads[0].payload.port, '8801');
  assert.equal(savedPayloads[0].payload.mode, 'handoff');
  assert.equal(closes.length, 1);
}

{
  const api = wizard({ runtime: runtime({ process: { stdin: { isTTY: false }, stdout: { isTTY: false }, env: {}, cwd: () => process.cwd() } }) });
  await assert.rejects(
    () => api.runSetupWizard([]),
    /codexpro setup needs an interactive terminal\. Use codexpro start --root \/path\/to\/repo for non-interactive scripts\./
  );
}

{
  const prompts = [];
  const closes = [];
  const logs = [];
  const api = wizard({
    runtime: runtime({
      createInterface: readlineFromAnswers(['', '', '', 'local', 'no', 'yes'], prompts, closes),
      console: { log: (value = '') => logs.push(value) }
    }),
    presentation: {
      paint: (_style, value) => value,
      printBox() {},
      statusLine() {}
    },
    profileStore: {
      loadWorkspaceProfile: () => ({}),
      saveWorkspaceProfile: () => { throw new Error('local no-save flow should not save'); }
    }
  });
  const args = await api.runSetupWizard([]);
  assert.deepEqual(args, ['start', '--root', process.cwd(), '--port', '8787', '--mode', 'agent', '--tunnel', 'none']);
  assert.equal(prompts.some((prompt) => prompt.includes('Public access: quick, stable, ngrok, tailscale, or local?')), true);
  assert.equal(logs.some((line) => line.includes('codexpro start --root')), true);
  assert.equal(closes.length, 1);
}

{
  const source = fs.readFileSync(new URL('./codexpro.mjs', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/cli-setup-wizard\.mjs'/);
  for (const name of [
    'profileSummary',
    'profileOneLine',
    'printSavedProfileHint',
    'normalizeSetupChoice',
    'ask',
    'tunnelChoiceFromProfile',
    'tunnelModeFromChoice',
    'hasExplicitTunnelInput',
    'collectTunnelPreference',
    'applyTunnelPreferenceToArgs',
    'profileFromPreference',
    'maybeConfigureFirstRun',
    'commandPreview',
    'runSetupWizard'
  ]) {
    assert.doesNotMatch(source, new RegExp(`function\\s+${name}\\s*\\(`));
  }
}

console.log('✓ CLI setup wizard smoke test passed');
