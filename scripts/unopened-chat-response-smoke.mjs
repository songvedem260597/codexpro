import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { completedResponseNeedsDomFallback } from '../manager/src/chat-transcript.js';

const worker = readFileSync(new URL('../chrome-extension/service-worker.js', import.meta.url), 'utf8');
const helper = worker.slice(worker.indexOf('async function readUnopenedChatResponse('), worker.indexOf('async function execute('));
const action = worker.slice(worker.indexOf("if(action==='get_chat_response'){"), worker.indexOf("if(action==='open_tab'){"));
const absentTabPath = action.slice(action.indexOf('if(!tab){'), action.indexOf('if(!tab?.id)'));
assert.match(absentTabPath, /recent\.find/, 'history reads must retain the recent-conversation access boundary');
assert.match(absentTabPath, /return \{\.\.\.response/, 'unopened conversation must return without navigating the source tab');
assert.doesNotMatch(absentTabPath, /createChatGptTab|waitForTab/, 'background history loading must never open/navigate tabs');

const calls = [];
let canonical = { ok: true, text: 'Hoàn tất', messages: [{ role: 'user', text: 'Kiểm tra' }, { role: 'assistant', text: 'Hoàn tất', end_turn: true }], response_ready: true, busy: false };
const context = {
  CANONICAL_READ_TIMEOUT_MS: 15000,
  isChatGptTabUrl: url => String(url).startsWith('https://chatgpt.com/'),
  readCanonicalConversationForTab: async (tabId, conversationId, budget) => {
    calls.push({ target: { tabId }, args: [conversationId], budget });
    return canonical;
  },
  withResponseAudit: (result, evidence) => ({ ...result, evidence }),
};
const { readUnopenedChatResponse } = vm.runInNewContext(`${helper}; ({readUnopenedChatResponse});`, context);
const conversation = { id: 'recent-conversation-1234', title: 'Requested history' };
const tabs = [{ id: 1, url: 'https://chatgpt.com/', active: true, title: 'Unrelated current tab', busy: true }];

const fast = await readUnopenedChatResponse(tabs, conversation, { read_dom: false });
assert.equal(calls.length, 0, 'network-only read does not inject code or call the API');
assert.equal(completedResponseNeedsDomFallback(fast), true, 'Manager must request canonical history after empty live read');
for (const args of [{ read_dom: true }, { read_dom: false, canonical_only: true }, { recover_stale_dom: true }]) {
  const result = await readUnopenedChatResponse(tabs, conversation, args);
  assert.equal(result.text, 'Hoàn tất');
  assert.equal(result.title, conversation.title);
  assert.equal(result.conversation_id, conversation.id);
  assert.equal(result.url, `https://chatgpt.com/c/${conversation.id}`);
  assert.equal(result.target_id, undefined, 'source tab must not be advertised as the conversation target');
  assert.equal(result.source_tab_id, 1);
  assert.equal(result.busy, false, 'unrelated source-tab activity must not contaminate history');
  assert.equal(completedResponseNeedsDomFallback(result), false);
}
assert.equal(tabs[0].url, 'https://chatgpt.com/');
assert.ok(calls.every(call => call.args[0] === conversation.id && call.target.tabId === 1));
await assert.rejects(readUnopenedChatResponse([], conversation), /CHAT_TAB_MISSING/);
const before = calls.length;
await assert.rejects(readUnopenedChatResponse(tabs, conversation, {}, Date.now() - 1), /COMMAND_EXPIRED/);
assert.equal(calls.length, before, 'expired command must not inject another read');
canonical = { ok: false, error: 'session expired' };
await assert.rejects(readUnopenedChatResponse(tabs, conversation), /CHAT_HISTORY_UNAVAILABLE.*session expired/);
canonical = { ok: false, error: 'ChatGPT HTTP 429', status: 429, rate_limited: true, canonical_rate_limit_count: 3, retry_at: new Date(Date.now() + 30000).toISOString(), retry_after_ms: 30000 };
const throttled = await readUnopenedChatResponse(tabs, conversation);
assert.equal(throttled.canonical_rate_limited, true, 'HTTP 429 must be returned as transient state instead of blanking the Manager UI');
assert.equal(throttled.canonical_rate_limit_count, 3);
canonical = { ok: true, messages: [], busy: true, response_ready: false };
assert.equal((await readUnopenedChatResponse(tabs, conversation)).busy, true, 'canonical generation state is preserved');
console.log('✓ Recent unopened chat reads without navigation or cross-conversation state passed');
