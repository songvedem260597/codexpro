import assert from "node:assert/strict";
import { createApiWorkerPlugin } from "../electron/worker-plugins/api-worker-plugin.mjs";

let calls=0;
let localClients=0;
const history=[];
const plugin=createApiWorkerPlugin({
  configurations:[{id:"render-deepseek",enabled:true,label:"Worker Cloud",provider:"openai-compatible",model:"deepseek-v4.1-flash:free"}],
  createMcpClients:async()=>{localClients++;throw new Error("DANGER local MCP invoked");},
  createProvider:async()=>{throw new Error("DANGER local provider invoked");},
  runGithubOnlyCloudTask:async({idempotencyKey,prompt,onStatus})=>{
    calls++;
    assert.match(idempotencyKey,/^cpt_[a-f0-9]{24}$/);
    assert.equal(prompt,"Fix GitHub repository");
    onStatus({phase:"running_ci_cloud",message:"Windows cloud runner",runUrl:"https://github.com/songvedem260597/codexpro-cloud-agent/actions/runs/111"});
    return {text:"Cloud PR created https://github.com/songvedem260597/codexpro-cloud-agent/pull/2"};
  },
  chatHistoryStore:{
    read:()=>({messages:history.slice()}),
    save(_id,_scope,_root,messages){history.splice(0,history.length,...messages);}
  }
});
const id="cpt_"+"a".repeat(24);
const base={local_worker_id:"render-deepseek",task_id:id,text:"Fix GitHub repository",scope:"github",github_repo:"songvedem260597/codexpro-cloud-agent"};
for(const override of [
 {scope:"all_allowed"}, {scope:"workspace",root:"C:\\Users\\test"}, {root:"D:\\test"}, {github_repo:"../private"},
 {attachments:[{path:"C:/private"}]}, {workspaceCandidates:["C:/project"]}
]){
 await assert.rejects(plugin.send({...base,...override}),/GitHub|local|repository/i);
}
assert.equal(calls,0);
const sent=await plugin.send(base);
assert.equal(sent.accepted,true);
for(let attempts=0;attempts<20;attempts++){
 const state=await plugin.read({local_worker_id:"render-deepseek"});
 if(state.activity==="idle")break;
 await new Promise(resolve=>setTimeout(resolve,10));
}
const result=await plugin.read({local_worker_id:"render-deepseek"});
assert.equal(result.activity,"idle");
assert.equal(localClients,0);
assert.equal(calls,1);
assert.match(result.result.text,/Cloud PR created/);
assert.equal(result.chat_history.length,2);
console.log("✓ Worker Cloud GitHub-only dispatch and local MCP hard-deny passed");
