import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;
export function validGithubRepo(value) {
  return typeof value === "string" && FULL_NAME.test(value) && !value.includes("..") && !value.endsWith(".git");
}

export async function listGithubCloudRepositories({ runGh = run } = {}) {
  // Queries account metadata only. Does not read the contents of local repositories.
  const result = await runGh("gh", ["api","-X","GET","user/repos",
    "-f","affiliation=owner,collaborator,organization_member","-f","per_page=100"], {
      timeout: 25000, windowsHide: true, maxBuffer: 1024 * 1024
    });
  const entries = JSON.parse(result.stdout || "[]");
  if (!Array.isArray(entries)) throw new Error("GitHub returned an invalid repository listing");
  return entries.filter(r => validGithubRepo(r?.full_name) &&
    r.permissions?.push === true && !r.archived)
    .map(r => ({
      fullName: r.full_name,
      defaultBranch: String(r.default_branch || "main").slice(0,100),
      private: Boolean(r.private)
    })).sort((a,b)=>a.fullName.localeCompare(b.fullName)).slice(0,100);
}
