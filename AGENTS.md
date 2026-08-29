# CodexPro agent instructions

These instructions apply to local implementation/review agents working on the CodexPro repository.

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

## Windows -> macOS synchronization

- Before pulling, cherry-picking, or merging changes from `win` into `mac`, read and follow `docs/MAC_SYNC_CHECKLIST.md` completely.
- Treat that checklist as a required completion gate for preserving macOS-specific behavior and verification.

## Repository boundaries

- Treat `.ai-bridge/current-plan.md` as task input when present; do not rewrite it unless acting as the designated reviewer/orchestrator.
- Do not commit secrets, tokens, `.env` files, credentials, or generated release output.
- Do not weaken CodexPro's local-execution safety boundary just to make agent execution more convenient.
- Preserve compatibility across Windows and non-Windows command execution paths.
