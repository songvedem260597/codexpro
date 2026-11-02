import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureGithubCloudRunner, dispatchGithubCloudRunner } from "./github-cloud-runner-manager.mjs";

const CONTROLLER = "https://codexpro-agent-controller.onrender.com";
export const CLOUD_GITHUB_REPO = "songvedem260597/codexpro-cloud-agent"; // legacy default only
const TOKEN_FILE = path.join(os.homedir(), "AppData", "Roaming", "codexpro-cloud-agent", "controller-token.txt");

function controllerToken() {
  // Only read the cloud Controller's access credential, never local repository code.
  const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  if (token.length < 32) throw new Error("Worker Cloud has no configured cloud Controller credential.");
  return token;
}
async function request(resource, init, signal) {
  const response = await fetch(CONTROLLER + resource, {
    ...init,
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    headers: { authorization: "Bearer " + controllerToken(), ...init?.headers }
  });
  if (!response.ok) throw new Error("GitHub Cloud Controller HTTP " + response.status);
  return await response.json();
}
const pause = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason || new Error("Stopped watching cloud task"));
  const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, ms);
  const aborted = () => { clearTimeout(timer); reject(signal.reason || new Error("Stopped watching cloud task")); };
  signal.addEventListener("abort", aborted, { once: true });
});
export async function runGithubOnlyCloudTask({ idempotencyKey, prompt, repo = CLOUD_GITHUB_REPO, signal, onStatus }) {
  if (!/^cpt_[a-f0-9]{24}$/.test(String(idempotencyKey))) throw new Error("Cloud worker task ID invalid.");
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 4000) throw new Error("Cloud task prompt must be 1-4000 characters.");
  // Provision the selected repository with a self-contained, OIDC-authenticated
  // GitHub Actions runner. This only uses GitHub's remote API, never a local checkout.
  onStatus?.({ phase:"provisioning", message:"Đang chuẩn bị GitHub Actions cho " + repo });
  const selected = await ensureGithubCloudRunner(repo);
  signal.throwIfAborted?.();
  const created = await request("/v1/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify({ kind:"github-code-cloud", title:"Worker Cloud GitHub code and Windows CI", prompt, repo:selected.fullName, branch:selected.defaultBranch })
  }, signal);
  const id = String(created.task?.id || "");
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Controller did not provide a valid task ID.");
  await dispatchGithubCloudRunner({repo:selected.fullName,branch:selected.defaultBranch,taskId:id});
  onStatus?.({ phase:"queued", message:"Đã gửi tác vụ tới GitHub Windows Runner của " + selected.fullName, taskId:id });
  let lastStatus = "";
  for (let attempt = 0; attempt < 800; attempt++) {
    await pause(5000, signal);
    let task;
    try { task = (await request("/v1/tasks/" + id, { method:"GET" }, signal)).task; }
    catch (error) { if (attempt >= 799) throw error; continue; }
    if (!task) continue;
    if (task.status !== lastStatus) {
      lastStatus = task.status;
      onStatus?.({ phase:task.status, message:task.status === "running_ci_cloud" ? "GitHub Windows Runner đang sửa code và kiểm thử." : "Trạng thái GitHub: " + task.status, taskId:id, runUrl:task.runUrl });
    }
    if (task.status === "completed") {
      const url = task.result?.pullRequestUrl || "";
      const branch = task.result?.branchUrl || "";
      const message = url ? "GitHub Windows Runner PASS. Pull request: " + url
        : branch ? "GitHub Windows Runner PASS. GitHub chưa cho tạo PR tự động; xem nhánh: " + branch
        : "GitHub Windows Runner hoàn thành mà không ghi nhận code change/PR. Xem: " + (task.result?.ci?.runUrl || task.runUrl || "");
      return { text:message, ci:task.result?.ci, pullRequestUrl:url, branchUrl:branch, taskId:id };
    }
    if (["failed", "needs_review"].includes(task.status)) throw new Error("GitHub cloud run " + task.status + ": " + String(task.error || "Inspect Actions run") + (task.runUrl ? " (" + task.runUrl + ")" : ""));
  }
  throw new Error("Cloud task continues on GitHub; view Controller queue for final status (tracking timeout).");
}
