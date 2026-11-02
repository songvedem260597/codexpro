import assert from "node:assert/strict";
import { listGithubCloudRepositories, validGithubRepo } from "../electron/worker-core/github-repository-list.mjs";
import { createApiWorkerPlugin } from "../electron/worker-plugins/api-worker-plugin.mjs";

assert.equal(validGithubRepo("songvedem260597/stickvideo-studio"), true);
assert.equal(validGithubRepo("another-org/private-project"), true);
assert.equal(validGithubRepo("../secret"), false);
let argumentsUsed;
const repos = await listGithubCloudRepositories({ runGh: async (_cmd, args) => {
  argumentsUsed = args;
  return { stdout: JSON.stringify([
    {full_name:"songvedem260597/stickvideo-studio",permissions:{push:true},default_branch:"main",private:true,archived:false},
    {full_name:"another-org/private-project",permissions:{push:true},default_branch:"release",private:true,archived:false},
    {full_name:"another-org/read-only",permissions:{push:false},default_branch:"main",private:true,archived:false},
    {full_name:"another-org/archived",permissions:{push:true},default_branch:"main",private:false,archived:true}
  ]) };
}});
assert.ok(argumentsUsed.includes("user/repos"), "List all repositories accessible to the signed-in user, not only the account owner's repositories");
assert.ok(argumentsUsed.includes("affiliation=owner,collaborator,organization_member"));
assert.deepEqual(repos.map(r=>r.fullName),["another-org/private-project","songvedem260597/stickvideo-studio"]);
assert.equal(repos[0].defaultBranch,"release");
assert.equal(repos[0].private,true);

let calledRepo="",localCalls=0;
const p=createApiWorkerPlugin({
 configurations:[{id:"render-deepseek",label:"Worker Cloud",provider:"openai-compatible",credential_available:true}],
 createProvider:async()=>{localCalls++;throw Error("Local model forbidden")},
 createMcpClients:async()=>{localCalls++;throw Error("Local MCP forbidden")},
 runGithubOnlyCloudTask:async ({repo})=>{calledRepo=repo;return {text:"GitHub Runner PASS"}}
});
const task="cpt_"+"a".repeat(24);
const sent=await p.send({local_worker_id:"render-deepseek",scope:"github",github_repo:"another-org/private-project",text:"test",task_id:task});
assert.equal(sent.accepted,true);
for(let i=0;i<20;i++){if((await p.read({local_worker_id:"render-deepseek"})).activity==="idle")break;await new Promise(resolve=>setTimeout(resolve,5))}
assert.equal(calledRepo,"another-org/private-project");
assert.equal(localCalls,0);
console.log("✓ All writable GitHub repositories including private collaborator repos pass");
