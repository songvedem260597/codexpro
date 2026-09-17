# CodexPro agent instructions

These instructions apply to local implementation/review agents working on the CodexPro repository.

## CodexPro stabilization mode

CodexPro is in a repository-specific stabilization / feature-freeze period. These rules apply to this CodexPro repository only; they must not be propagated into global CodexPro rules for unrelated repositories.

- **NO NEW FEATURES.** Work is limited to bug fixes, crash/hang fixes, reliability, timeout/race/state fixes, compatibility/security work, bug-focused diagnostics/observability, and regression coverage.
- **NO OPTIONAL REFACTORING.** Make the smallest root-cause fix. Do not do unrelated cleanup or "while I'm here" changes.
- **ROOT CAUSE BEFORE FIX.** Before editing for a bug, reproduce the real failure when practical, read the exact error/stack/log, trace the relevant call/data flow, inspect recent related changes, identify the failing layer, and state the root cause supported by evidence.
- **OBSERVABILITY FIRST WHEN EVIDENCE IS INSUFFICIENT.** If current logs cannot identify the failing layer or stage, extend the existing diagnostic infrastructure first (for example diagnostic-log, send-trace-log, runtime health/tunnel diagnostics, hang flight recorder, causal telemetry, or user-reported-error), reproduce again, and use the new evidence before fixing. Do not create a parallel logging framework just for a bug.
- For multi-component operations, instrument useful component boundaries, state transitions, and failure points rather than every function. When relevant, capture timestamp, correlation/operation id, component, stage, START/PASS/FAIL/TIMEOUT, elapsed time, task/profile/conversation/runtime ids, last successful stage, first failed stage, and the exact sanitized error. Never log tokens, cookies, credentials, passwords, API keys, or other secrets.
- **REGRESSION MUST MATCH THE FAILURE MODE.** For deterministic bugs, add/update a regression that reproduces the real failure mode; observe it fail before the fix when practical, then pass after the fix.
- **AUTOMATED TESTS ARE NOT FINAL ACCEPTANCE FOR USER-VISIBLE BUGS.** A smoke/build PASS does not by itself mean the bug is fixed. For bugs crossing Manager UI, Electron/runtime, Chrome worker, extension, ChatGPT/browser, network, or OS integration, use the sanctioned real product path after automated verification when a safe runtime is available.
- Real acceptance must verify the final user-visible outcome, not an intermediate ACK or dispatch step. For example, an IPC ACK, mouse dispatch, or text entry is not send success; the real message appearing or network-confirmed final outcome is.
- If required real acceptance is unavailable or unsafe, keep the task in `WAITING_RUNTIME_ACCEPTANCE` / `BLOCKED`; do not fake PASS and do not finalize only because smoke tests are green.
- If evidence proves the bug is external/environmental and CodexPro source is not wrong, document the evidence and do not change code merely to produce a commit.
- After three or more unsuccessful fix attempts for the same failure, stop patching. Return to architecture/root-cause investigation and gather new evidence before another fix.

## Bug-fix workflow

- Read the relevant code and nearby tests before editing. Prefer root-cause fixes over symptom masking.
- Reproduce the failure first when a deterministic reproduction is practical.
- Use repository structure, symbol/reference searches, and call/data-flow tracing to narrow the impact surface before changing code.
- Keep fixes scoped. Do not refactor unrelated code while fixing a bug.
- Add or update a regression test for behavior that can be tested deterministically.
- Verify with the narrowest relevant smoke test first, then run `npm run build`. Run `npm run smoke` when the change affects shared CLI/server behavior or multiple subsystems.
- Report the root cause, changed files, commands run, and exact verification result.

## Multi-agent investigation

- When the primary runtime supports subagents, delegate independent read-only investigation before editing when that can reduce uncertainty.
- Useful independent tracks include: architecture/call graph, bug localization/data flow, regression-test discovery, and upstream/dependency behavior.
- Parallelize only independent investigations. Synthesize findings in the primary agent before edits.
- Keep source modifications and final verification coordinated by one primary implementation agent unless the task explicitly partitions files cleanly.
- Avoid delegating trivial work or asking multiple agents to repeat the same search.

## Repository boundaries

- Treat `.ai-bridge/current-plan.md` as task input when present; do not rewrite it unless acting as the designated reviewer/orchestrator.
- Do not commit secrets, tokens, `.env` files, credentials, or generated release output.
- Do not weaken CodexPro's local-execution safety boundary just to make agent execution more convenient.
- Preserve compatibility across Windows and non-Windows command execution paths.
