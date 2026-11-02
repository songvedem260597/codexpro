import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { listGithubCloudRepositories, validGithubRepo } from "./github-repository-list.mjs";

const templateDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "templates");
const MANAGED = [
  { remote: ".github/codexpro-cloud/agent.mjs", filename: "codexpro-worker-agent.mjs" },
  { remote: ".github/workflows/codexpro-cloud-code.yml", filename: "codexpro-cloud-code.yml" }
];
const MAX_OUTPUT = 2 * 1024 * 1024;
function gh(args, input = null) {
  return new Promise((resolve, reject) => {
    const subprocess = spawn("gh", args, { windowsHide:true, shell:false, stdio:["pipe","pipe","pipe"] });
    let stdout="", stderr="";
    const timer=setTimeout(()=>subprocess.kill(),45000);
    subprocess.stdout.on("data",data=>{stdout+=data.toString();if(stdout.length>MAX_OUTPUT)subprocess.kill()});
    subprocess.stderr.on("data",data=>{stderr+=data.toString().slice(0,200)});
    subprocess.on("error",reject);
    subprocess.on("close",code=>{
      clearTimeout(timer);
      if (code === 0 && stdout.length<=MAX_OUTPUT) resolve(stdout);
      else reject(new Error("GitHub CLI command failed (status "+code+"): "+stderr.slice(0,240)));
    });
    subprocess.stdin.end(input === null ? "" : input);
  });
}
export async function approvedGithubRepo(fullName) {
  if (!validGithubRepo(fullName)) throw new Error("Invalid GitHub repository name");
  const list=await listGithubCloudRepositories();
  const selected=list.find(repo=>repo.fullName===fullName);
  if (!selected) throw new Error("GitHub repository is not writable by the connected account.");
  if (!/^[A-Za-z0-9_.\/-]{1,100}$/.test(selected.defaultBranch) || selected.defaultBranch.includes("..")) throw new Error("Invalid GitHub default branch");
  return selected;
}
async function readRemote(repo, branch, remotePath) {
  try {
    return JSON.parse(await gh(["api","repos/"+repo+"/contents/"+remotePath+"?ref="+encodeURIComponent(branch)]));
  } catch(error) {
    if (/HTTP 404|Not Found/i.test(String(error.message))) return null;
    throw error;
  }
}
export async function ensureGithubCloudRunner(repo) {
  const selected=await approvedGithubRepo(repo);
  const branch=selected.defaultBranch;
  for(const template of MANAGED) {
    const bytes=fs.readFileSync(path.join(templateDir,template.filename));
    const old=await readRemote(repo,branch,template.remote);
    if (old && old.type!=="file") throw new Error("Unexpected GitHub runner path type: "+template.remote);
    if (old && old.content && Buffer.from(String(old.content).replace(/\s/g,""),"base64").equals(bytes)) continue;
    if (old && old.content) {
      const existing=Buffer.from(String(old.content).replace(/\s/g,""),"base64").toString("utf8");
      if (!existing.includes("CodexPro Worker Cloud") && !existing.includes("codexpro-agent-controller.onrender.com")) {
        throw new Error("Cannot overwrite an unrelated GitHub workflow or agent file");
      }
    }
    const body={message:"chore: provision CodexPro GitHub-only worker",content:bytes.toString("base64"),branch,...(old?.sha?{sha:old.sha}:{})};
    await gh(["api","-X","PUT","repos/"+repo+"/contents/"+template.remote,"--input","-"],JSON.stringify(body));
  }
  return selected;
}
export async function dispatchGithubCloudRunner({repo,branch,taskId}) {
  if (!validGithubRepo(repo) || !/^[A-Za-z0-9_.\/-]{1,100}$/.test(branch) ||
      !/^[0-9a-f-]{36}$/.test(taskId)) throw new Error("Invalid GitHub Cloud dispatch parameters");
  let lastError;
  for(let attempt=0;attempt<3;attempt++){
    try {
      await gh(["workflow","run","codexpro-cloud-code.yml","--repo",repo,"--ref",branch,"-f","task_id="+taskId]);
      return;
    } catch(error){lastError=error;await new Promise(resolve=>setTimeout(resolve,2500));}
  }
  throw new Error("Could not dispatch GitHub Windows runner: "+String(lastError?.message||"unknown").slice(0,180));
}
