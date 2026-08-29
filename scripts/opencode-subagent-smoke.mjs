import {
  CODEXPRO_EXPLORE_AGENT,
  analyzeOpenCodeSessionExport,
  analyzeOpenCodeSubagentEvents,
  inspectOpenCodeSubagentCapability,
  parseOpenCodeAgentList,
  parseOpenCodeJsonEvents
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
`;

const agents = parseOpenCodeAgentList(agentList);
assert(agents.some((agent) => agent.name === 'codexpro-explore' && agent.mode === 'subagent'), 'custom explore agent was not parsed');
const capability = inspectOpenCodeSubagentCapability(agentList, '{"model":"opencode/big-pickle","subagent_depth":1}');
assert(capability.ready, `expected ready capability: ${capability.reasons.join('; ')}`);
assert(capability.taskPermission === 'allow', 'ordered Task permission did not resolve to allow');

const disabledDepth = inspectOpenCodeSubagentCapability(agentList, '{"subagent_depth":0}');
assert(!disabledDepth.ready && disabledDepth.reasons.some((reason) => reason.includes('subagent_depth=0')), 'subagent_depth=0 was not rejected');

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

const noTask = analyzeOpenCodeSubagentEvents(JSON.stringify({ type: 'text', sessionID: 'ses_parent', part: { type: 'text', text: 'pretend delegated' } }));
assert(!noTask.verified && noTask.reason.includes('no task tool event'), 'text-only delegation was incorrectly accepted');

const childExport = JSON.stringify({
  info: { id: 'ses_child', summary: { files: 0, additions: 0, deletions: 0 } },
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

const unsafeExport = analyzeOpenCodeSessionExport(JSON.stringify({
  info: { id: 'ses_child' },
  messages: [{ parts: [{ type: 'tool', tool: 'bash', state: { input: { command: 'echo nope' } } }] }]
}));
assert(unsafeExport.forbiddenTools.includes('bash'), 'forbidden child tool was not detected');

console.log('✓ OpenCode subagent evidence smoke test passed');
