# Worker plugin architecture implementation plan

## Goal

Turn CodexPro Manager's Chrome-profile-specific worker flow into a plugin system. Chrome, OpenRouter, OpenAI-compatible endpoints, and future providers plug into the same worker runtime. CodexPro MCP remains the mandatory policy and tool boundary for workspace selection, global and repository rules, CodexGraph, job titles, permissions, execution evidence, and completion.

## Non-goals

- Do not expose model execution as a public remote MCP tool.
- Do not let provider plugins call filesystem, Git, shell, browser, or analysis implementations directly.
- Do not store API credentials in the repository, renderer state, manager settings JSON, diagnostics, or chat cache.
- Do not replace the existing Chrome worker behavior during the compatibility phase.
- Do not make CodexPro a hosted model proxy or quota-sharing service.

## Architecture

```text
Manager renderer
    -> Electron IPC
    -> WorkerRegistry
        -> ChromeWorkerPlugin
        -> OpenRouterWorkerPlugin
        -> OpenAICompatibleWorkerPlugin
    -> WorkerJobRunner
    -> scoped CodexPro MCP session
        -> prepare/bootstrap policy
        -> rules and AGENTS chain
        -> CodexGraph when required
        -> guarded workspace tools
        -> completion obligations
```

The provider API performs inference only. Every repository capability and every job lifecycle transition that grants or proves authority goes through a profile-bound CodexPro MCP session.

## Common contracts

### Plugin manifest

- Stable plugin ID and version.
- Protocol and provider kind.
- Declared capabilities: streaming, tool calling, resume, cancellation, usage.
- Credential type reference, never the credential value.
- Configuration schema and supported endpoint policy.

### Worker summary

- Namespaced `worker_id`, such as `chrome:<profile-id>` or `api:<configuration-id>`.
- `worker_type`, provider, model, connectivity, activity, current task, workspace, run/conversation ID, capabilities, and bounded last error.
- Browser-only extension, connector, and tab fields remain optional and capability-gated.

### Job policy

- Versioned policy recorded on every job.
- Job-title validation and normalization.
- Required global rules and AGENTS-chain evidence.
- Conditional CodexGraph evidence for code work.
- Tool allow/deny lists, write/bash modes, timeout, tool-call and output budgets.
- Completion obligations such as change review, tests, audit, or user approval.

## Phase 0 - Plan and baseline

1. Record this plan without overwriting `.ai-bridge/current-plan.md`.
2. Create a dedicated `codex/worker-plugin-architecture` branch.
3. Confirm the existing build and focused worker/browser smoke tests.
4. Commit and push the plan as the review anchor.

Exit criteria: clean baseline, remote branch available, no runtime behavior changed.

## Phase 1 - Worker plugin core and Chrome compatibility adapter

1. Add pure worker types, manifest validation, namespaced IDs, capability normalization, plugin registry, and aggregate status helpers.
2. Add `ChromeWorkerPlugin` as a compatibility adapter over the existing profile/list/send/read/stop callbacks.
3. Keep existing `browserProfiles` and IPC methods unchanged; add generic worker APIs behind an opt-in path.
4. Extract deterministic presentation helpers so API workers are not treated as broken Chrome extensions.
5. Add unit-style smoke coverage for registry isolation, duplicate IDs, capability gates, status mapping, and partial provider failure.

Exit criteria: Chrome behavior and existing smoke tests remain unchanged; registry can list a normalized Chrome worker.

## Phase 2 - MCP policy socket and durable jobs

1. Extract the local Streamable HTTP MCP client from the Electron main monolith into a reusable module.
2. Add a worker job store under `CODEXPRO_HOME`, using atomic writes, bounded event history, stable IDs, and restart recovery.
3. Add local-manager-only MCP lifecycle tools/actions for prepare, bootstrap, status, record-event, finalize, and cancel.
4. Bind every API worker job to a namespaced profile ID, task ID, workspace, policy version, and MCP session.
5. Produce bootstrap proof containing canonical title, rules hash, AGENTS files, CodexGraph snapshot/evidence, tool policy, and outstanding obligations.
6. Fail closed when required bootstrap or completion evidence is unavailable.

Exit criteria: a fake worker can complete a deterministic MCP-gated job without any provider API.

## Phase 3 - Provider plugins and agent loop

1. Add a provider contract for probe, model discovery, streaming inference, continuation, usage, and cancellation.
2. Implement OpenAI-compatible transport with strict URL, redirect, header, timeout, body, and stream limits.
3. Implement OpenRouter as a configured specialization, including routing options and usage metadata.
4. Add an agent loop that exposes only MCP-derived tool schemas, validates tool arguments, executes calls through the scoped MCP client, and returns bounded results to the model.
5. Require tool-calling capability for code jobs. Plain-answer models may only handle explicitly allowed general jobs.
6. Add loop limits, idempotency, retry classification, cancellation, token/cost accounting, and resumable provider state where supported.

Exit criteria: mocked OpenRouter and generic endpoints complete tool and non-tool fixtures; no plugin receives direct repository primitives.

## Phase 4 - Generic IPC and Manager UI

1. Add generic list/send/read/stop worker IPC while keeping legacy profile IPC as wrappers.
2. Merge browser and API worker event sources into a generic worker event stream.
3. Render explicit Browser/API badges, provider/model, job/run status, usage, and errors.
4. Capability-gate Chrome-only setup, reload, open-tab, and recovery actions.
5. Add provider configuration and health testing. Store credential values through the OS-backed secret broker only; renderer receives credential IDs and redacted status.
6. Support job history, resume, cancellation, and policy/obligation inspection.

Exit criteria: Browser and API workers coexist without misleading extension warnings or mixed actions.

## Phase 5 - Hardening, documentation, and release verification

1. Add credential and diagnostic redaction tests.
2. Add SSRF, unsafe redirect/header, oversized response, invalid tool call, policy bypass, stale session, cancellation, restart, and concurrent-job tests.
3. Add end-to-end Manager fixtures for Browser/API cards and task lifecycle.
4. Document provider setup, trust boundaries, policy extension, and plugin authoring.
5. Run the narrow smoke tests, root build, Manager build, full smoke suite, and `git diff --check`.
6. Commit and push each independently passing phase.

Exit criteria: all verification passes and the feature remains disabled until a provider configuration is explicitly created.

## Security invariants

- MCP is the only repository capability boundary.
- Plugin manifests declare capabilities but never grant them.
- Server-side policy and tool registration are authoritative; prompts and annotations are not security controls.
- Public HTTP tokens are not reused as provider credentials.
- Provider credentials never enter renderer-visible or repository files.
- Custom endpoints require HTTPS, except explicitly configured loopback development endpoints.
- Worker jobs default to the narrowest workspace and tool policy.
- Missing evidence blocks completion instead of silently degrading.

## Verification sequence per phase

1. Run the narrow new smoke test first.
2. Run affected existing browser/HTTP/Manager smoke tests.
3. Run `npm run build`.
4. Run `npm run manager:build` when Manager code changes.
5. Run `npm run smoke` for shared CLI/server or cross-subsystem changes.
6. Run `git diff --check`, commit only phase-owned files, and push the branch.
