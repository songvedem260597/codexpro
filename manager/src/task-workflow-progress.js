function escaped(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function statusFromMarker(marker) {
  if (String(marker).toLowerCase() === "x") return "completed";
  if (marker === "!") return "issue";
  return "skipped";
}

export function deriveTaskWorkflowProgress(workflow, evidenceText, options = {}) {
  const text = String(evidenceText ?? "");
  const lines = text.split(/\r?\n/);
  const steps = (workflow?.steps || []).map((step) => {
    const idPattern = escaped(step.id);
    const titlePattern = escaped(step.title);
    const matcher = new RegExp(`\\[([xX!\\-])\\][^\\n]*(?:\\(${idPattern}\\)|${titlePattern})`, "i");
    const evidence = [...lines].reverse().find((line) => matcher.test(line)) || "";
    const marker = evidence.match(/\[([xX!\-])\]/)?.[1];
    return { ...step, status: marker ? statusFromMarker(marker) : "pending", evidence: evidence.trim() };
  });
  if (options.running) {
    const next = steps.find((step) => step.status === "pending");
    if (next) next.status = "running";
  }
  return {
    steps,
    completed: steps.filter((step) => step.status === "completed").length,
    issues: steps.filter((step) => step.status === "issue").length,
    skipped: steps.filter((step) => step.status === "skipped").length,
    total: steps.length
  };
}
