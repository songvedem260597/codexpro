# Recovery of legacy timeout cancellations

Task inactivity is not cancellation. Coordination must keep running tasks and
their source claims until an explicit lifecycle transition. Disconnection or a
long blocked interval must not silently terminate ownership during a status read.

## Explicit legacy recovery

An authorized, owner-bound caller can use `resume_repo_task` with
`recover_stale_cancellation: true`. Ordinary resume remains running-only.

The legacy option is narrowly limited to a cancelled code job whose canonical
coordination record is still running, with matching owner and retained claims.
The last reconciliation event must record cancellation at the job's exact
finished time, more than six hours after the unchanged coordination timestamp.
Any explicit finalization, terminal coordination, completion confirmation,
summary/error, or missing provenance rejects recovery.

Existing permission, profile, workspace, rules and exact Git worktree checks
still apply. Under the coordination lock, recovery rechecks the verified record,
claims, competing writer/worktree ownership and live integration lease. It does
not recreate claims or rewrite coordination. The conditional atomic job update
clears only the terminal status/time and appends recovery evidence; original
history, progress, checklist, task identity and source diff remain intact.

The gate is published only after the durable update and a final owner/status
check. A failure before that point is retried through the same API, never by
preparing a replacement task or editing state JSON. Repeated/concurrent calls
within the runtime are deduplicated. Deployment must use one authoritative MCP
runtime per state store; this change does not provide universal cross-process
worker execution fencing.

## Verification

- `npm run build`
- `node scripts/task-restart-recovery-smoke.mjs` (normal and legacy modes)
- `node scripts/workspace-coordination-smoke.mjs`
- `node scripts/worker-policy-smoke.mjs`
- `npm run manager:check`
- `npm run smoke`

The HTTP regression covers long inactivity, opt-in recovery, missing provenance,
completed/failed/explicit-cancelled jobs, terminal coordination, revoked roots,
wrong owner, missing worktree, stolen/missing claims, another writer, live and
expired integration leases, concurrent recovery and actual workspace reads.
