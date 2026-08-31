import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-worker-policy-"));
process.env.CODEXPRO_HOME = home;

const {
  WORKER_POLICY_VERSION,
  bootstrapWorkerJob,
  finalizeWorkerJob,
  prepareWorkerJob,
  readWorkerJob,
  workerJobPublicRecord
} = await import("../dist/workerPolicy.js");

try {
  const generalId = "cpt_111111111111111111111111";
  const prepared = await prepareWorkerJob({ jobId: generalId, workerId: "api.openrouter", scope: "workspace", root: "C:\\repo" });
  assert.equal(prepared.policyVersion, WORKER_POLICY_VERSION);
  assert.equal(prepared.status, "prepared");
  assert.ok(fs.existsSync(path.join(home, "worker-jobs", `${generalId}.json`)), "prepared jobs must persist outside the repository");

  const general = await bootstrapWorkerJob({
    jobId: generalId,
    workerId: "api.openrouter",
    title: "Explain worker policy",
    kind: "general",
    root: "",
    workspaceId: "",
    scope: "workspace"
  });
  assert.deepEqual(general.requiredObligations, ["job_title"]);
  assert.deepEqual(general.completedObligations, ["job_title"]);
  const completedGeneral = await finalizeWorkerJob({ jobId: generalId, workerId: "api.openrouter", outcome: "completed", summary: "done" });
  assert.equal(completedGeneral.status, "completed");

  const codeId = "cpt_222222222222222222222222";
  await prepareWorkerJob({ jobId: codeId, workerId: "api.custom", scope: "workspace", root: "C:\\repo" });
  const incomplete = await bootstrapWorkerJob({
    jobId: codeId,
    workerId: "api.custom",
    title: "Implement policy socket",
    kind: "code",
    root: "C:\\repo",
    workspaceId: "ws_fixture",
    scope: "workspace",
    rulesHash: "rules",
    rulesPath: "CODEXPRO.md",
    agentsFiles: ["AGENTS.md"],
    agentsHash: "agents",
    codexGraphActive: false
  });
  assert.deepEqual(workerJobPublicRecord(incomplete).missing_obligations, ["codexgraph"]);
  await assert.rejects(
    () => finalizeWorkerJob({ jobId: codeId, workerId: "api.custom", outcome: "completed" }),
    /missing obligations: codexgraph/
  );

  const bootstrapped = await bootstrapWorkerJob({
    jobId: codeId,
    workerId: "api.custom",
    title: "Implement policy socket",
    kind: "code",
    root: "C:\\repo",
    workspaceId: "ws_fixture",
    scope: "workspace",
    rulesHash: "rules",
    rulesPath: "CODEXPRO.md",
    agentsFiles: ["AGENTS.md"],
    agentsHash: "agents",
    codexGraphActive: true,
    codexGraphSymbolCount: 12,
    codexGraphRelationshipCount: 20
  });
  assert.deepEqual(bootstrapped.completedObligations, ["global_rules", "agents_chain", "codexgraph"]);
  assert.equal((await finalizeWorkerJob({ jobId: codeId, workerId: "api.custom", outcome: "completed" })).status, "completed");
  assert.equal(readWorkerJob(codeId)?.codexGraphSymbolCount, 12);
  await assert.rejects(
    () => finalizeWorkerJob({ jobId: codeId, workerId: "api.other", outcome: "failed" }),
    /owner mismatch/
  );

  console.log("✓ Worker MCP policy persistence smoke test passed");
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
