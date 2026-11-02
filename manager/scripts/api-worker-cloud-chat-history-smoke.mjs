import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApiWorkerChatHistoryStore } from "../electron/worker-core/api-worker-chat-history.mjs";
import { createApiWorkerPlugin } from "../electron/worker-plugins/api-worker-plugin.mjs";
import { WorkerPluginRegistry } from "../electron/worker-core/plugin-registry.mjs";

const home=fs.mkdtempSync(path.join(os.tmpdir(),"github-cloud-history-"));
const key=crypto.randomBytes(32);
const secure={
 isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=>"dpapi",
 encryptString(s){const iv=crypto.randomBytes(12);const c=crypto.createCipheriv("aes-256-gcm",key,iv);return Buffer.concat([iv,c.update(s),c.final(),c.getAuthTag()]);},
 decryptString(buf){const d=crypto.createDecipheriv("aes-256-gcm",key,buf.subarray(0,12));d.setAuthTag(buf.subarray(-16));return Buffer.concat([d.update(buf.subarray(12,-16)),d.final()]).toString();}
};
const storage=createApiWorkerChatHistoryStore({home,safeStorage:secure});
let n=0;
function make(){
 return createApiWorkerPlugin({
  configurations:[{id:"render-deepseek",enabled:true,label:"Worker Cloud",provider:"openai-compatible"}],
  chatHistoryStore:storage,
  runGithubOnlyCloudTask:async()=>({text:"Response "+(++n)}),
  createProvider:async()=>{throw Error("Local provider forbidden");},
  createMcpClients:async()=>{throw Error("Local MCP forbidden");}
 });
}
const base={local_worker_id:"render-deepseek",scope:"github",github_repo:"songvedem260597/codexpro-cloud-agent"};
async function run(plugin,i){
 const result=await plugin.send({...base,task_id:"cpt_"+i.toString(16).padStart(24,"0"),text:"Message "+i});
 assert.equal(result.accepted,true);
 for(let retry=0;retry<50;retry++){
  const status=await plugin.read({local_worker_id:"render-deepseek"});
  if(status.activity==="idle")return status;
  if(status.activity==="failed")throw Error(status.error);
  await new Promise(resolve=>setTimeout(resolve,5));
 }
 throw Error("Cloud worker did not complete");
}
try{
 const p=make();
 for(let i=1;i<=4;i++)await run(p,i);
 const root="github:songvedem260597/codexpro-cloud-agent";
 const messages=storage.read("render-deepseek","workspace",root).messages;
 assert.deepEqual(messages.map(x=>x.content),["Response 2","Message 3","Response 3","Message 4","Response 4"]);
 const raw=fs.readFileSync(storage.file,"utf8");
 assert.doesNotMatch(raw,/Message 4|Response 4/,"Chat history not encrypted");
 assert.deepEqual(storage.read("render-deepseek","workspace","C:\\Users\\test").messages,[]);
 const restarted=make();
 const registry=new WorkerPluginRegistry();
 registry.register(restarted);
 const summary=(await registry.list()).workers[0];
 assert.deepEqual(summary.chat_history,messages);
 await run(restarted,5);
 assert.deepEqual(storage.read("render-deepseek","workspace",root).messages.map(x=>x.content),["Response 3","Message 4","Response 4","Message 5","Response 5"]);
 console.log("✓ Worker Cloud GitHub-only encrypted 5-message restart history PASS");
}finally{fs.rmSync(home,{recursive:true,force:true})}
