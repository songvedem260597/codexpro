import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../chrome-extension/service-worker.js', import.meta.url), 'utf8');
const detectors = [...source.matchAll(/const messageStreamError=Array\.from\(latestTurn[\s\S]*?\n  \}\);/g)].map(match=>match[0]);
assert.equal(detectors.length,2,'activity probe and response reader must both be covered');
for(const detector of detectors){
  const detect=(text,{quoted=false,hidden=false,latest=true}={})=>Function('latestTurn','getComputedStyle',`${detector};return messageStreamError;`)(
    {querySelectorAll:()=>latest?[{innerText:text,getBoundingClientRect:()=>({width:200,height:30}),closest:()=>quoted?{}:null}]:[]},
    ()=>({display:hidden?'none':'block',visibility:'visible'})
  );
  for(const text of ['Error in message stream','Error in message stream\nRetry','Error in message stream Try again','Lỗi trong luồng tin nhắn','Lỗi trong luồng tin nhắn\nThử lại','Lỗi trong luồng tin nhắn'.normalize('NFD')]){
    assert.equal(detect(text),true,`live banner: ${text}`);
    assert.equal(detect(text,{quoted:true}),false,'quoted user/assistant content is not a banner');
    assert.equal(detect(text,{hidden:true}),false,'hidden banner is not active');
    assert.equal(detect(text,{latest:false}),false,'historical turn must not trigger recovery');
  }
  assert.equal(detect('Tôi giải thích lỗi: Lỗi trong luồng tin nhắn'),false);
  assert.equal(detect('Thử lại'),false);
}

const recovery = await readFile(new URL('../manager/src/hooks/use-chat-recovery.js', import.meta.url),'utf8');
const start=recovery.indexOf('      const messageStreamTab');
const end=recovery.indexOf('      if (longRunningChatWatchdogCandidate',start);
assert.ok(start>=0&&end>start);
const branch=recovery.slice(start,end);
const taskId='cpt_0123456789abcdef01234567';
const tab={id:1,url:'https://chatgpt.com/c/current-chat',message_stream_error:true};
const profile={profile_id:'owner',current_task_id:taskId,current_task_conversation_id:'current-chat',conversation_tabs:[tab]};
const job={job_id:taskId,worker_id:'owner',status:'running'};
const run=(p,jobs,times={current:new Map()},observeDownstream=false)=>{
  const calls=[];
  Function('profiles','jobs','operationsRecoveryTimes','recoverProfileTab','logRendererDiagnostic','api','managerSettings','downstream',`for(const profile of profiles){const tabs=profile.conversation_tabs;${branch}downstream();}`)(
    [p],jobs,times,(_profile,options)=>{calls.push(options);return Promise.resolve(null);},()=>{}, {},{taskNotifications:false},()=>{if(observeDownstream)calls.push({downstream:true});}
  );
  return calls;
};
const times={current:new Map()};
const [call]=run(profile,[job],times);
assert.equal(call.taskId,taskId);
assert.equal(call.forceContinuation,true);
assert.equal(call.conversationId,'current-chat');
assert.equal(run(profile,[job],times).length,0,'repeated snapshot is throttled');
for(const status of ['completed','cancelled'])assert.equal(run(profile,[{...job,status}]).length,0);
assert.equal(run(profile,[]).length,0,'missing durable job cannot start a new task');
assert.equal(run(profile,[{...job,worker_id:'another-owner'}]).length,0);
assert.equal(run({...profile,current_task_id:''},[job]).length,0);
assert.equal(run({...profile,current_task_conversation_id:'another-chat'},[job]).length,0);
assert.equal(run({...profile,conversation_tabs:[{...tab,id:9,url:'https://chatgpt.com/c/old-chat'},tab]},[job])[0].targetTab.id,1,'pick current task tab, not first historical failure');
assert.deepEqual(run({...profile,conversation_tabs:[{...tab,id:9,url:'https://chatgpt.com/c/old-chat'},{...tab,message_stream_error:false,renderer_unresponsive:true}]},[job],{current:new Map()},true),[{downstream:true}],'old stream error must not suppress current renderer/network recovery');
console.log('message-stream-language-smoke: PASS (EN/VI live banners; quote/history exclusions; same-task ownership, terminal and dedupe guards)');
