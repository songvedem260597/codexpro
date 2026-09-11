import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../chrome-extension/service-worker.js', import.meta.url), 'utf8');
const prepareSource = source.slice(source.indexOf('async function sendChatRequestPage('), source.indexOf('async function cleanupChatRequestDraftPage('));
const recoveryStart = source.indexOf('function classifyChatPrepareRecovery(');
const recoveryEndOffset = source.slice(recoveryStart).search(/\r?\n\r?\nasync function execute\(/);
const recoveryEnd = recoveryEndOffset < 0 ? -1 : recoveryStart + recoveryEndOffset;
assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart, 'prepare recovery classifier must exist');
const classifyChatPrepareRecovery = Function(`${source.slice(recoveryStart, recoveryEnd)}; return classifyChatPrepareRecovery;`)();
assert.deepEqual(classifyChatPrepareRecovery('Chrome renderer không phản hồi khi chuẩn bị tin nhắn.', 0, false), { hard_renderer_hang: true, mode: 'replace-tab' });
assert.deepEqual(classifyChatPrepareRecovery('Không tìm thấy ô nhập ChatGPT.', 0, false), { hard_renderer_hang: false, mode: 'wait' });
assert.deepEqual(classifyChatPrepareRecovery('Chrome renderer không phản hồi khi chuẩn bị tin nhắn.', 1, false), { hard_renderer_hang: true, mode: 'none' });
assert.deepEqual(classifyChatPrepareRecovery('Chrome renderer không phản hồi khi chuẩn bị tin nhắn.', 0, true), { hard_renderer_hang: true, mode: 'none' });
console.log('prepare-injection-smoke: PASS (hard renderer hang selects one replace-tab retry)');
const injection = source.match(/chrome\.scripting\.executeScript\(\{[^\n]+func:sendChatRequestPage[^\n]+\}\)/)?.[0];
assert.ok(injection, 'test must execute the actual production prepare injection options');
let dispatches = 0;
const chrome = { scripting: { executeScript: options => {
  dispatches++;
  // A loading page answers CDP, but never reaches document_idle.
  if (!options.injectImmediately) return new Promise(() => {});
  return Promise.resolve([{ result: { prepared: true, submitted: false } }]);
} } };
const result = await Promise.race([
  vm.runInNewContext(injection, { chrome, tab: { id: 1 }, text: 'test', attachments: [], attemptId: 'a', deadlineAt: Date.now()+1000, staleAttachmentOwnership: null, targetConversationId: 'expected', sendChatRequestPage() {} }),
  new Promise(resolve => setTimeout(() => resolve('document_idle_wait'), 30))
]);
assert.notEqual(result, 'document_idle_wait', 'prepare must not wait for document_idle after a healthy CDP probe');
assert.equal(dispatches, 1);
assert.equal(result[0].result.submitted, false);

let domTouches = 0;
const document = new Proxy({}, { get() { domTouches++; throw new Error('late prepare touched DOM'); } });
const context = vm.createContext({ document, Date, setTimeout, location: { origin: 'https://chatgpt.com', pathname: '/c/expected' } });
vm.runInContext(prepareSource, context);
const expired = await context.sendChatRequestPage('test', [], 'old', Date.now()-1000, null, 'expected');
assert.equal(expired.expired, true);
assert.equal(domTouches, 0, 'late execution must not read or mutate drafts/attachments');
context.location.pathname = '/c/different';
const navigated = await context.sendChatRequestPage('test', [], 'old', Date.now()+1000, null, 'expected');
assert.equal(navigated.ok, false);
assert.match(navigated.error, /CONVERSATION_CHANGED/);
assert.equal(domTouches, 0, 'same-tab navigation must not write to a different conversation');
console.log('prepare-injection-smoke: PASS (loading page, expired execution, navigation fence)');

// Resume a composer-readiness await after its deadline: no focus/click/write.
let now = 1000, ready = false, mutations = 0;
const composer = {
  getBoundingClientRect: () => ({width:100,height:20}),
  focus() { mutations++; },
  get dataset() { mutations++; throw new Error('expired prepare accessed mutable ownership'); }
};
const waiting = vm.createContext({
  Date: { now: () => now },
  location: {origin:'https://chatgpt.com',pathname:'/c/expected'},
  document: {querySelector: () => ready ? composer : null,querySelectorAll:()=>[]},
  getComputedStyle: () => ({display:'block',visibility:'visible'}),
  setTimeout(callback) { now=3000; ready=true; callback(); }
});
vm.runInContext(prepareSource, waiting);
const resumed = await waiting.sendChatRequestPage('test', [], 'late', 2000, null, 'expected');
assert.equal(resumed.expired, true);
assert.equal(mutations, 0);
console.log('prepare-injection-smoke: PASS (deadline crossed during await)');

let composerLookups = 0;
const limitContainer={innerText:"You've reached the maximum length for this conversation. Start new chat",textContent:"You've reached the maximum length for this conversation. Start new chat",parentElement:null};
const limitControl={innerText:'Start new chat',textContent:'Start new chat',parentElement:limitContainer,getBoundingClientRect:()=>({width:100,height:20}),getAttribute:()=>''};
const limitContext=vm.createContext({
  Date,
  location:{origin:'https://chatgpt.com',pathname:'/c/expected'},
  document:{querySelectorAll:()=>[limitControl],querySelector:()=>{composerLookups++;return null;}},
  getComputedStyle:()=>({display:'block',visibility:'visible'}),
  setTimeout
});
vm.runInContext(prepareSource,limitContext);
const limited=await limitContext.sendChatRequestPage('test',[],'limit',Date.now()+1000,null,'expected');
assert.equal(limited.conversation_limit_reached,true);
assert.equal(composerLookups,0,'conversation limit must stop the consolidated prepare before composer discovery or mutation');

const cleanupSource=source.slice(source.indexOf('async function cleanupChatRequestDraftPage('),source.indexOf('async function readChatResponsePage('));
const editedComposer={isContentEditable:true,innerText:'user edited draft',dataset:{codexproDraftAttempt:'old',codexproDraftText:'original'},closest:()=>null,getBoundingClientRect:()=>({width:100,height:20}),focus(){throw new Error('must not focus user draft');}};
const cleanupContext=vm.createContext({Date,setTimeout,location:{pathname:'/c/expected'},CSS:{escape:x=>x},document:{querySelector:()=>editedComposer},getComputedStyle:()=>({display:'block',visibility:'visible'})});
vm.runInContext(cleanupSource,cleanupContext);
const cleanup=await cleanupContext.cleanupChatRequestDraftPage('old','expected',Date.now()+1000);
assert.equal(cleanup.draft_changed,true);
assert.equal(editedComposer.innerText,'user edited draft');

// Execute the actual retry predicate: a guarded abort must never enter cleanup/retry.
const retryExpression=source.match(/const recoverablePrepareFailure=([^;]+);/)[1];
for(const prepareResult of [expired,resumed,navigated])assert.equal(vm.runInNewContext(retryExpression,{prepareResult}),false);
assert.match(source,/if\(injected\?\.result\?\.cleanup_skipped\)return/);
console.log('prepare-injection-smoke: PASS (preserve edited draft, no retry after fenced abort)');
