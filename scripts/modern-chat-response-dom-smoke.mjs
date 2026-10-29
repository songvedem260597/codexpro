import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const worker=readFileSync(new URL('../chrome-extension/service-worker.js',import.meta.url),'utf8');
const begin=worker.indexOf('async function readChatResponsePage() {');
const end=worker.indexOf('\nfunction inspectChatSendAttemptPage',begin);
assert.ok(begin>=0&&end>begin,'response reader must be available');
const reader=worker.slice(begin,end);
const content={
  textContent:'OK',
  cloneNode(){return {textContent:'OK',querySelectorAll(){return []}};},
  querySelectorAll(){return []}
};
const userRoot={innerText:'You said:\nCodexPro smoke',textContent:'You said:\nCodexPro smoke'};
const userHeading={innerText:'You said:',textContent:'You said:',parentElement:userRoot};
const assistantRoot={querySelector(s){return s==='[data-chatgpt-selection-message-id]'?content:null}};
const assistantHeading={closest(s){return s==='[data-content-search-unit-key]'?assistantRoot:null}};
const turn={
  getClientRects(){return [{}];},
  getAttribute(){return null;},
  querySelector(s){
    if(s==='h4[data-conversation-role="user"]')return userHeading;
    if(s==='h4[data-conversation-role="assistant"]')return assistantHeading;
    if(s==='[data-talvt-turn-state="complete"]')return {};
    return null;
  },
  querySelectorAll(){return []}
};
const document={
  title:'Smoke response',
  body:{innerText:'You said: CodexPro smoke ChatGPT said: OK'},
  querySelectorAll(s){
    if(s==='[data-turn-key]')return [turn];
    return [];
  }
};
const sandbox={
  document,
  location:{pathname:'/c/smoke',href:'https://chatgpt.com/c/smoke'},
  getComputedStyle:()=>({display:'block',visibility:'visible'}),
  globalThis:{}
};
const actual=await runInNewContext(reader+'\nreadChatResponsePage()',sandbox);
assert.equal(actual.ok,true);
assert.equal(actual.text,'OK','new transcript must extract actual assistant response');
assert.equal(actual.response_ready,true,'finished assistant turn must be ready');
assert.equal(actual.turn_complete,true,'nested data-talvt-turn-state must prove short reply completion');
assert.deepEqual([...actual.messages].map(m=>m.role),['user','assistant']);
assert.equal(actual.messages[0].text,'CodexPro smoke');
assert.equal(actual.messages[1].text,'OK');
console.log('modern chat response DOM smoke passed');
