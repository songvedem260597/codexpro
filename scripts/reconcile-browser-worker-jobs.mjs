import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const apply = process.argv.includes("--apply");
const homeArgIndex = process.argv.indexOf("--home");
const home = homeArgIndex >= 0 && process.argv[homeArgIndex + 1]
  ? path.resolve(process.argv[homeArgIndex + 1])
  : process.env.CODEXPRO_HOME
    ? path.resolve(process.env.CODEXPRO_HOME)
    : path.join(os.homedir(), ".codexpro");
process.env.CODEXPRO_HOME = home;

const { readWorkerJob, reconcileCompletedWorkerJob } = await import("../dist/workerPolicy.js");
const auditFile = path.join(home, "manager-chat-response-audit.jsonl");
const jobsDir = path.join(home, "worker-jobs");

function parseJsonLines(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function strongCompletionEvidence(audit) {
  const readySources = [audit?.sources?.chatgptDom, audit?.sources?.canonical, audit?.sources?.networkStream]
    .filter((source) => source?.responseReady === true && source?.assistantAfterLatestUser);
  if (String(audit?.networkState || "").toLowerCase() !== "completed" || !readySources.length) return null;
  const finishedAt = String(audit?.networkCompletedAt || audit?.loggedAt || audit?.at || "");
  return Number.isFinite(Date.parse(finishedAt)) ? {
    taskId: String(audit?.requestId || ""),
    finishedAt: new Date(Date.parse(finishedAt)).toISOString(),
    conversationId: String(audit?.conversationId || ""),
    source: String(readySources[0]?.source || audit?.selectedSource || "")
  } : null;
}

const evidenceByTask = new Map();
for (const audit of parseJsonLines(auditFile)) {
  const evidence = strongCompletionEvidence(audit);
  if (!/^cpt_[a-f0-9]{24}$/.test(evidence?.taskId || "")) continue;
  const previous = evidenceByTask.get(evidence.taskId);
  if (!previous || Date.parse(evidence.finishedAt) < Date.parse(previous.finishedAt)) evidenceByTask.set(evidence.taskId, evidence);
}

const candidates = [];
for (const entry of fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir, { withFileTypes: true }) : []) {
  if (!entry.isFile() || !/^cpt_[a-f0-9]{24}\.json$/.test(entry.name)) continue;
  const taskId = entry.name.slice(0, -5);
  const job = readWorkerJob(taskId);
  const evidence = evidenceByTask.get(taskId);
  if (!job || job.status !== "running" || !evidence) continue;
  const startedAtMs = Date.parse(job.startedAt || job.preparedAt);
  if (Number.isFinite(startedAtMs) && Date.parse(evidence.finishedAt) < startedAtMs) continue;
  candidates.push({ job, evidence, file: path.join(jobsDir, entry.name) });
}
candidates.sort((left, right) => Date.parse(left.evidence.finishedAt) - Date.parse(right.evidence.finishedAt));

let backupDir = "";
if (apply && candidates.length) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  backupDir = path.join(home, "worker-jobs-backup", stamp);
  await fsp.mkdir(backupDir, { recursive: true });
  for (const candidate of candidates) {
    await fsp.copyFile(candidate.file, path.join(backupDir, path.basename(candidate.file)));
    await reconcileCompletedWorkerJob({
      jobId: candidate.job.jobId,
      workerId: candidate.job.workerId,
      finishedAt: candidate.evidence.finishedAt,
      evidence: `manager_chat_response_audit:${candidate.evidence.source}`,
      summary: `Đối soát tự động: phản hồi ChatGPT đã hoàn tất trong ${candidate.evidence.conversationId || "hội thoại đã ghi nhận"}.`
    });
  }
}

console.log(JSON.stringify({
  applied: apply,
  home,
  backup_dir: backupDir,
  candidate_count: candidates.length,
  tasks: candidates.map(({ job, evidence }) => ({
    task_id: job.jobId,
    worker_id: job.workerId,
    title: job.title,
    finished_at: evidence.finishedAt,
    conversation_id: evidence.conversationId,
    evidence_source: evidence.source
  }))
}, null, 2));
