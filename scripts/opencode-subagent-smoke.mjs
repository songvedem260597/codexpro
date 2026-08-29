import {
  CODEXPRO_EXPLORE_AGENT,
  GEMINI_SCOUT_AGENT,
  analyzeOpenCodeSessionExport,
  analyzeOpenCodeSubagentEvents,
  discoverGeminiScoutModels,
  inspectOpenCodeScoutCapability,
  inspectOpenCodeSubagentCapability,
  parseCodexProAudit,
  parseOpenCodeAgentList,
  parseOpenCodeJsonEvents,
  shouldRunGeminiScout
} from './opencode-subagents.mjs';

function assert(value, message) {
  if (!value) throw new Error(message);
}

const agentList = `
build (primary)
[
  {"permission":"*","action":"allow","pattern":"*"}
]
codexpro-explore (subagent)
[
  {"permission":"*","action":"allow","pattern":"*"},
  {"permission":"edit","action":"deny","pattern":"*"},
  {"permission":"bash","action":"deny","pattern":"*"},
  {"permission":"task","action":"deny","pattern":"*"}
]
codexpro-orchestrator (primary)
[
  {"permission":"*","action":"allow","pattern":"*"},
  {"permission":"task","action":"deny","pattern":"*"},
  {"permission":"task","action":"allow","pattern":"codexpro-explore"}
]
gemini-scout (subagent)
[
  {"permission":"read","action":"deny","pattern":"*"},
  {"permission":"grep","action":"deny","pattern":"*"},
  {"permission":"glob","action":"deny","pattern":"*"},
  {"permission":"list","action":"deny","pattern":"*"},
  {"permission":"edit","action":"deny","pattern":"*"},
  {"permission":"bash","action":"deny","pattern":"*"},
  {"permission":"task","action":"deny","pattern":"*"},
  {"permission":"webfetch","action":"allow","pattern":"*"},
  {"permission":"websearch","action":"allow","pattern":"*"}
]
codexpro-scout-orchestrator (primary)
[
  {"permission":"task","action":"deny","pattern":"*"},
  {"permission":"task","action":"allow","pattern":"gemini-scout"}
]
`;

const agents = parseOpenCodeAgentList(agentList);
assert(agents.some((agent) => agent.name === 'codexpro-explore' && agent.mode === 'subagent'), 'custom explore agent was not parsed');
assert(agents.some((agent) => agent.name === GEMINI_SCOUT_AGENT && agent.mode === 'subagent'), 'gemini scout agent was not parsed');

const capability = inspectOpenCodeSubagentCapability(agentList, '{"model":"opencode/big-pickle","subagent_depth":1}');
assert(capability.ready, `expected ready capability: ${capability.reasons.join('; ')}`);
assert(capability.taskPermission === 'allow', 'ordered Task permission did not resolve to allow');

const disabledDepth = inspectOpenCodeSubagentCapability(agentList, '{"subagent_depth":0}');
assert(!disabledDepth.ready && disabledDepth.reasons.some((reason) => reason.includes('subagent_depth=0')), 'subagent_depth=0 was not rejected');

const scoutConfig = JSON.stringify({
  subagent_depth: 1,
  agent: { [GEMINI_SCOUT_AGENT]: { model: 'lan20127/ag/gemini-3.6-flash-high' } }
});
const scoutCapability = inspectOpenCodeScoutCapability(agentList, scoutConfig);
assert(scoutCapability.ready, `expected ready scout capability: ${scoutCapability.reasons.join('; ')}`);
assert(scoutCapability.taskPermission === 'allow', 'scout Task permission did not resolve to allow');
assert(scoutCapability.scoutModel === 'lan20127/ag/gemini-3.6-flash-high', 'scout runtime model was not parsed');
assert(scoutCapability.childPermissions.read === 'deny' && scoutCapability.childPermissions.webfetch === 'allow', 'scout safety permissions were not resolved');

const unsafeScoutList = agentList.replace(
  '{"permission":"read","action":"deny","pattern":"*"}',
  '{"permission":"read","action":"allow","pattern":"*"}'
);
const unsafeScout = inspectOpenCodeScoutCapability(unsafeScoutList, scoutConfig);
assert(!unsafeScout.ready && unsafeScout.reasons.some((reason) => reason.includes('read permission')), 'unsafe scout read permission was not rejected');

const rankedModels = discoverGeminiScoutModels([
  '9router/ag/gemini-3.7-flash-high',
  'lan20127/ag/gemini-3.6-flash-low',
  'lan20127/ag/gemini-3.6-flash-high',
  'lan20127/ag/gemini-3.5-flash-high',
  'opencode/big-pickle'
].join('\n'), 'lan20127 api');
assert(rankedModels[0] === 'lan20127/ag/gemini-3.6-flash-high', `authenticated Gemini ranking was wrong: ${rankedModels.join(', ')}`);
const preferredModels = discoverGeminiScoutModels(rankedModels.join('\n'), 'lan20127 api', 'lan20127/ag/gemini-3.6-flash-low');
assert(preferredModels[0] === 'lan20127/ag/gemini-3.6-flash-low', 'explicit authenticated scout model preference was not honored');
assert(shouldRunGeminiScout('Check the upstream SDK API release notes before fixing this dependency.'), 'external research signal did not route to Gemini scout');
assert(!shouldRunGeminiScout('Fix the local parser bug in src/parser.ts and update its unit test.'), 'local-only handoff incorrectly routed to Gemini scout');
assert(!shouldRunGeminiScout('Bump the package version and update the local changelog.'), 'local package/version maintenance incorrectly routed to Gemini scout');

const auditPass = parseCodexProAudit('CODEXPRO_AUDIT=PASS\nSUMMARY=All acceptance criteria are verified.\nREQUIRED_FIXES=NONE');
assert(auditPass.valid && auditPass.verdict === 'PASS', 'valid CodexPro PASS audit was not parsed');
const auditFail = parseCodexProAudit('CODEXPRO_AUDIT=FAIL\nSUMMARY=One requirement is still missing.\nREQUIRED_FIXES:\n- Add the missing retry guard.\n- Cover it with a regression test.');
assert(auditFail.valid && auditFail.verdict === 'FAIL' && auditFail.fixes.length === 2, 'valid CodexPro FAIL audit was not parsed');
const invalidAuditFail = parseCodexProAudit('CODEXPRO_AUDIT=FAIL\nSUMMARY=Something is wrong.\nREQUIRED_FIXES=NONE');
assert(!invalidAuditFail.valid, 'FAIL audit without actionable fixes was incorrectly accepted');

const ndjson = [
  JSON.stringify({ type: 'step_start', sessionID: 'ses_parent', part: { type: 'step-start' } }),
  JSON.stringify({
    type: 'tool_use',
    sessionID: 'ses_parent',
    part: {
      type: 'tool',
      tool: 'task',
      state: {
        status: 'completed',
        input: { subagent_type: CODEXPRO_EXPLORE_AGENT, prompt: 'inspect marker.txt' },
        metadata: { sessionId: 'ses_child', parentSessionId: 'ses_parent' },
        output: 'CODEXPRO_SUBAGENT_MARKER=orange-otter-7319'
      }
    }
  }),
  JSON.stringify({ type: 'text', sessionID: 'ses_parent', part: { type: 'text', text: 'Child reported orange-otter-7319.' } })
].join('\n');

const parsed = parseOpenCodeJsonEvents(ndjson);
assert(parsed.events.length === 3 && parsed.invalid.length === 0, 'NDJSON parser did not preserve events');
const observed = analyzeOpenCodeSubagentEvents(ndjson);
assert(observed.verified, `expected verified task event: ${observed.reason}`);
assert(observed.childSessionId === 'ses_child', 'child session id was not extracted');
assert(observed.childResult.includes('orange-otter-7319'), 'child result was not extracted');

const scoutNdjson = JSON.stringify({
  type: 'tool_use',
  sessionID: 'ses_scout_parent',
  part: {
    type: 'tool',
    tool: 'task',
    state: {
      status: 'completed',
      input: { subagent_type: GEMINI_SCOUT_AGENT, prompt: 'check official docs' },
      metadata: { sessionId: 'ses_scout_child' },
      output: 'Official docs say the current behavior is documented.'
    }
  }
});
const observedScout = analyzeOpenCodeSubagentEvents(scoutNdjson, GEMINI_SCOUT_AGENT);
assert(observedScout.verified && observedScout.childSessionId === 'ses_scout_child', 'Gemini scout Task event was not verified');

const noTask = analyzeOpenCodeSubagentEvents(JSON.stringify({ type: 'text', sessionID: 'ses_parent', part: { type: 'text', text: 'pretend delegated' } }));
assert(!noTask.verified && noTask.reason.includes('no task tool event'), 'text-only delegation was incorrectly accepted');

const childExport = JSON.stringify({
  info: {
    id: 'ses_child',
    model: { providerID: 'opencode', id: 'big-pickle' },
    summary: { files: 0, additions: 0, deletions: 0 }
  },
  messages: [
    {
      info: { role: 'assistant' },
      parts: [
        { type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: 'marker.txt' } } },
        { type: 'tool', tool: 'grep', state: { status: 'completed', input: { pattern: 'MARKER', path: '.' } } },
        { type: 'text', text: 'CODEXPRO_SUBAGENT_MARKER=orange-otter-7319' }
      ]
    }
  ]
});
const exported = analyzeOpenCodeSessionExport(childExport);
assert(exported.parsed, 'child export did not parse');
assert(exported.filesInspected.includes('marker.txt'), 'read file path was not collected');
assert(exported.forbiddenTools.length === 0, 'read-only tools were incorrectly flagged');
assert(exported.model === 'opencode/big-pickle', `child export model was not extracted: ${exported.model}`);

const scoutExport = analyzeOpenCodeSessionExport(JSON.stringify({
  info: { id: 'ses_scout_child', model: { providerID: 'lan20127', id: 'ag/gemini-3.6-flash-high' } },
  messages: [{ parts: [
    { type: 'tool', tool: 'websearch', state: { input: { query: 'official docs' } } },
    { type: 'tool', tool: 'webfetch', state: { input: { url: 'https://opencode.ai/docs/' } } }
  ] }]
}));
assert(scoutExport.forbiddenTools.length === 0, 'external read-only scout tools were incorrectly flagged');
assert(scoutExport.model === 'lan20127/ag/gemini-3.6-flash-high', `scout model proof was wrong: ${scoutExport.model}`);

const unsafeExport = analyzeOpenCodeSessionExport(JSON.stringify({
  info: { id: 'ses_child' },
  messages: [{ parts: [{ type: 'tool', tool: 'bash', state: { input: { command: 'echo nope' } } }] }]
}));
assert(unsafeExport.forbiddenTools.includes('bash'), 'forbidden child tool was not detected');

console.log('✓ OpenCode subagent + Gemini scout evidence smoke test passed');
