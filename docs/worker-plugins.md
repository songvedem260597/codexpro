# CodexPro worker plugins

CodexPro treats Chrome, OpenRouter, OpenAI-compatible endpoints, and future runtimes as interchangeable worker plugins. The plugin is the plug; CodexPro MCP is the socket. A provider performs inference, but it never receives direct filesystem, Git, shell, browser, rules, or CodexGraph implementations.

## Trust boundary

```text
Manager UI -> WorkerPluginRegistry -> API/Chrome worker
                                  -> profile-bound CodexPro MCP session
                                     -> job policy and title
                                     -> global CODEXPRO.md
                                     -> repository AGENTS.md chain
                                     -> CodexGraph for code jobs
                                     -> guarded workspace tools
                                     -> durable completion evidence
```

The MCP server is authoritative. A manifest can advertise a capability, but it cannot grant one. API models see only tool schemas returned by their scoped MCP session, and every tool call is executed through that same session. Lifecycle tools are withheld from the model and are called by the runner itself.

Code jobs fail closed unless MCP confirms all of the following:

- a valid, clear 4–6 word job title;
- the exact selected workspace;
- global rules hash;
- repository `AGENTS.md` chain hash;
- an active CodexGraph snapshot;
- no outstanding completion obligations.

General jobs do not receive repository access. They still register and finalize their title and policy through MCP.

## Configure an API worker

Open CodexPro Manager, go to **Cài đặt**, and find **API Worker Plugins**.

1. Choose a stable worker ID, display name, provider, model, and base URL.
2. Paste the API key. The Manager encrypts it with Electron `safeStorage` (Windows DPAPI on Windows). The renderer receives only an `os-secret:` reference and a redacted availability flag after saving.
3. Select **Test** to probe the provider's model endpoint.
4. Return to the overview and choose **Chạy job** on the API worker card.
5. For a code job, select the exact repository. CodexPro will load rules and CodexGraph through MCP before the first inference request.

Custom endpoints must use HTTPS. Plain HTTP is accepted only for `localhost`, `127.0.0.0/8`, or `::1` development fixtures. Redirects are rejected.

Provider metadata is stored under `CODEXPRO_HOME/api-workers.json`. Encrypted credential bytes are stored separately under `CODEXPRO_HOME/api-worker-secrets.json`. Neither file belongs in a repository.

## Runtime contracts

Worker IDs are namespaced as `<plugin>:<local-id>`, for example `chrome:profile-a` or `api:openrouter-main`.

A worker plugin provides:

- `manifest`: stable ID, version, worker type, protocol, credential reference type, and advertised capabilities;
- `list(context)`: normalized worker summaries;
- optional `send(payload)`, `read(payload)`, and `stop(payload)` operations.

A provider provides:

- `manifest`: provider identity and inference capabilities;
- `complete(input)`: OpenAI-style messages and MCP-derived tool schemas;
- optional `probe()` and `listModels()` operations.

The API worker runner injects two MCP clients:

- a control session, used only to prepare the worker/job binding;
- a namespaced job session, used to bootstrap policy, list/call tools, and finalize the job.

Provider plugins must not accept repository service objects or local execution callbacks. New repository capabilities belong in the MCP server, where existing path, write, bash, Git, and policy checks apply uniformly to every worker.

## Adding a provider specialization

Prefer configuring the OpenAI-compatible transport when the service supports `/models` and `/chat/completions`. A specialization should only translate provider-specific routing options, attribution headers, response usage, or model metadata.

Keep these invariants:

- obtain secrets through an injected `getApiKey()` callback;
- never put credentials in manifests, settings metadata, diagnostics, errors, or renderer responses;
- keep authorization and content-type headers controlled by the transport;
- reject cross-origin redirects, unsafe URLs, oversized requests/responses, and invalid tool arguments;
- propagate cancellation and bounded usage information;
- let MCP validate tool arguments and authorize the actual operation.

## Verification

Focused tests:

```bash
node scripts/worker-plugin-smoke.mjs
node scripts/worker-policy-smoke.mjs
node scripts/provider-plugin-smoke.mjs
node scripts/api-worker-store-smoke.mjs
node scripts/http-smoke.mjs
npm run manager:build
```

Before release:

```bash
npm run build
npm run smoke
npm audit --omit=dev
git diff --check
```

The provider smoke test covers loopback-only HTTP, redirect rejection, request/response limits, streaming, credential redaction, lifecycle-tool rejection, concurrency, cancellation, and MCP-only tool execution.
