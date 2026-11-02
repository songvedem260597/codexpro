import assert from "node:assert/strict";
import { registerWorkerIpcHandlers } from "../electron/ipc/worker-ipc.mjs";
let materialized=0;
const handlers=new Map();
const sends=[];
registerWorkerIpcHandlers({
 diagnosticIpcHandle:(name,details,handler)=>handlers.set(name,handler),
 runtimeStatus:async()=>({workers:[],workerSources:[]}),
 materializeApiWorkerRequest:async payload=>{materialized++;return payload;},
 recordUserReportedError:()=>{},
 workerPluginRegistry:{invoke:async(operation,id,payload)=>{sends.push({operation,id,payload});return {accepted:true};}},
 apiWorkerStore:{list:()=>[]},discoverApiWorkerModels:async()=>[],createProviderForApiWorker:async()=>({})
});
const invoke=(payload)=>handlers.get("codexpro:worker-send")(null,payload);
const id="cpt_"+"a".repeat(24);
const cloud={workerId:"api:render-deepseek",task_id:id,scope:"github",github_repo:"songvedem260597/codexpro-cloud-agent",text:"Test a GitHub change"};
for(const override of [
 {scope:"all_allowed"},
 {root:"C:\\Users\\test"},
 {attachments:[{path:"D:/private.txt"}]},
 {attachment_names:["private.txt"]},
 {workspaceCandidates:["C:/project"]},
 {github_repo:"../private"}
]){
 await assert.rejects(invoke({...cloud,...override}),/GitHub|local/);
}
assert.equal(materialized,0,"Cloud Worker must not even materialize local file data");
assert.equal(sends.length,0);
await invoke(cloud);
await invoke({...cloud, github_repo:"another-org/private-project"});
assert.equal(materialized,0);
assert.equal(sends[0].payload.root,"");
assert.equal(sends[0].payload.github_repo,cloud.github_repo);
assert.equal(sends[1].payload.github_repo,"another-org/private-project");
assert.deepEqual(sends[0].payload.attachments,[]);
await invoke({workerId:"api:other-worker",scope:"workspace",root:"C:/project",text:"Test"});
assert.equal(materialized,1,"Existing non-cloud workers must retain their original flow");
console.log("✓ IPC rejects local Worker Cloud input before materialization PASS");
