# CodexPro Architecture Upgrade Roadmap

This note captures the highest-value architecture upgrades for the current CodexPro codebase after reviewing the active `mac` branch.

## Current position

CodexPro already has a broad capability set:

- MCP workspace tools
- Browser Agent and Chrome extension bridge
- Headless workers
- Control Plane workflows
- CodexGraph static/semantic analysis
- Runtime tracing
- Git, file, image, import, and Bash operations
- Repo task gating and review flow
- Handoff to implementation agents
- Profile-based ChatGPT workers
- Response/network recovery in CodexPro Manager

The main bottleneck is no longer missing features. The next stage should focus on making these capabilities operate through one coherent runtime.

Current large integration surfaces include roughly:

- `src/server.ts`: ~3.9k lines
- `manager/src/main.jsx`: ~3.5k lines
- `manager/electron/main.mjs`: ~3.1k lines
- `chrome-extension/service-worker.js`: ~2.7k lines
- `src/http.ts`: ~2.1k lines

Recent recovery-focused work also shows that task, network, profile, MCP-session, and UI state are currently coordinated across several independent layers.

---

## P0 — Unified Agent Runtime + Event Store

This is the most important upgrade.

Today CodexPro observes state from several places:

- MCP tool execution
- Chrome extension events
- Browser network state
- Manager renderer state
- Electron IPC
- worker/profile state
- repo-task state
- runtime traces

The target architecture should make one runtime event stream the canonical source for task state.

### Target event model

Examples:

```text
task.created
task.started

profile.opened
profile.focused

message.sent

network.started
network.completed
network.failed

response.detected
response.saved

tool.started
tool.completed
tool.failed

repo.changed

test.started
test.completed
test.failed

task.checkpointed
task.completed
task.failed
```

Each event should carry stable IDs where relevant:

```text
eventId
traceId
spanId
parentSpanId
taskId
workspaceId
profileId
conversationId
workerId
timestamp
source
payload
```

### State reconstruction

Manager and runtime consumers should derive current state from events instead of independently guessing it.

```text
Events
  ↓
TaskStateReducer
  ↓
Current Task State
  ↓
Manager / recovery / automation
```

This enables:

- deterministic recovery after restart
- less heuristic polling
- one place to reason about task state
- reproducible debugging
- resumable tasks
- future replay/fork support
- cleaner multi-agent orchestration

---

## P0 — Evolve Runtime Trace into the runtime foundation

`src/analysis/runtimeTrace.ts` is already a strong base.

It currently provides:

- `traceId`
- `spanId`
- `parentSpanId`
- `workspaceId`
- AsyncLocalStorage propagation
- JSONL persistence
- trace rotation
- runtime kinds such as tool, browser-extension, IPC, network, and test

Do not replace this work.

Instead evolve it from observability-only data into a broader runtime event foundation:

```text
RuntimeTrace
    ↓
RuntimeEvent
    ↓
TaskEventStore
    ↓
TaskStateReducer
    ↓
resume / recover / replay
```

Tracing can remain span-oriented while the event store records task/domain transitions.

A trace answers:

> Why did this operation take this path?

An event stream answers:

> What is the durable state of this task now?

Both should share IDs and correlation metadata.

---

## P1 — Capability/plugin boundary

CodexPro should become more modular, but it should not turn into a generic plugin framework prematurely.

The first step is to extract capability boundaries from the MCP server.

Suggested interface:

```ts
interface CodexProCapability {
  id: string;

  setup(runtime: CodexProRuntime): Promise<void>;

  tools(): ToolDefinition[];

  health(): Promise<CapabilityHealth> | CapabilityHealth;

  dispose(): Promise<void>;
}
```

Suggested modules:

```text
capabilities/
  filesystem/
  git/
  bash/
  browser/
  codexgraph/
  control-plane/
  handoff/
  workers/
  sessions/
```

### Target server responsibility

`src/server.ts` should eventually focus on:

```text
load config
↓
create runtime
↓
load capabilities
↓
register MCP tools
↓
serve requests
```

It should not need to contain the implementation details for every subsystem.

### Important constraint

Do not copy an "everything is a plugin" architecture wholesale.

Start with capability registration and lifecycle only.

Keep:

- security boundaries
- workspace guard
- auth/session handling
- event/runtime core

as explicit core responsibilities.

---

## P1 — Manager state architecture

The most important Manager refactor is state ownership, not JSX splitting.

`manager/src/main.jsx` currently owns a large amount of state related to:

- profiles
- projects
- requests
- responses
- network state
- recovery state
- task labels
- attachments
- inspection
- headless workers
- settings

Move domain state into dedicated stores/state machines.

Suggested structure:

```text
manager/src/runtime/
  task-store.js
  profile-store.js
  chat-store.js
  worker-store.js
  runtime-store.js
```

Renderer components should consume derived state:

```jsx
const task = useTask(taskId);
const profile = useProfile(profileId);
```

instead of reproducing recovery/state transition rules across `useEffect`, refs, and local state.

This should reduce regressions around:

- aborted network recovery
- stale response reads
- optimistic messages
- project switching
- connection interruption
- active MCP sessions
- worker/profile transitions

---

## P1 — Platform adapters: preserve the macOS fast path

The current macOS profile-open path is fast and should be protected.

Current high-level flow:

```text
ready runtime
↓
navigate if required
↓
activate Chrome tab
↓
focus Chrome window
```

Windows requires additional foreground-window handling through Win32/PowerShell APIs.

Do not force macOS through Windows compatibility logic.

Introduce an explicit platform abstraction:

```text
ProfileLauncher
    │
 ┌──┴──────────┐
 │             │
macOS        Windows
fast path    compatibility path
```

Possible boundary:

```ts
interface PlatformWindowAdapter {
  focusBrowserWindow(input: FocusWindowInput): Promise<FocusWindowResult>;
  ensureAutostart(...): Promise<...>;
  launchRuntime(...): Promise<...>;
}
```

Platform-specific behavior should remain isolated in adapters rather than branching throughout the Manager runtime.

---

## P2 — Turn CodexGraph into execution intelligence

CodexGraph is currently one of the strongest newer CodexPro features.

On the current repository it can analyze a large symbol/relationship graph without truncation.

The next value comes from using the graph to reduce work, not from adding more visual effects.

### Context targeting

For a request such as:

```text
fix profile opening
```

CodexGraph should help identify a bounded path such as:

```text
Manager UI
↓
Electron IPC
↓
browser bridge
↓
extension service worker
```

Then the agent can preferentially read that impact surface instead of broadly loading the repository.

### Test selection

After a change:

```text
changed symbols
↓
CodexGraph impact radius
↓
affected modules
↓
relevant smoke tests
```

The runtime can use this to suggest or automatically execute the smallest relevant verification set before broader tests.

### Future capabilities

- change impact summaries
- related-symbol retrieval
- graph-backed context packing
- regression-test selection
- architecture boundary warnings
- dead/isolated subsystem detection

---

## P2 — Unified task/session recovery

Once the Event Store exists, recovery should become a runtime concern instead of a collection of UI heuristics.

Target flow:

```text
process restarts
↓
load task events
↓
rebuild task state
↓
reconnect runtime resources
↓
resume from last safe checkpoint
```

Recovery rules should distinguish:

- idempotent operations that can safely retry
- non-idempotent mutations that require proof/checkpoint validation
- browser actions that should re-read current DOM/network state
- repo writes that should validate Git/file state before continuing

---

## P2 — Runtime health and capability health

Each subsystem should expose a small health contract.

Example:

```ts
type CapabilityHealth = {
  status: "ok" | "degraded" | "offline";
  checkedAt: string;
  latencyMs?: number;
  reason?: string;
};
```

Manager can then display one derived status model instead of manually interpreting many raw signals.

Suggested capabilities:

- MCP runtime
- tunnel
- browser extension
- selected Chrome profile
- headless worker
- CodexGraph cache/index
- Control Plane
- repo-task gate

---

## P3 — Scheduler and long-running automation

Scheduler/long-running orchestration is valuable, but it should come after the runtime event/state foundation.

Once tasks are durable and resumable, CodexPro can safely add:

- scheduled checks
- delayed retries
- long-running workers
- watch conditions
- recurring repository maintenance
- persistent multi-agent workflows

Without durable task state, scheduling would add another layer of recovery complexity.

---

## P3 — Visual CodexGraph improvements

Visual polish is useful but lower priority than execution intelligence.

Keep improving the graph UI only when it helps answer questions such as:

- what is connected to this module?
- what will this change affect?
- where is this runtime event coming from?
- which subsystem owns this behavior?

Avoid investing heavily in decorative animation before graph-derived context and impact analysis are integrated into the agent runtime.

---

# Recommended architecture

```text
                    CodexPro
                       │
          ┌────────────┴────────────┐
          │                         │
     Agent Runtime              Manager UI
          │                         │
      Event Store ──────────────────┘
          │
   Task State Reducer
          │
 ┌────────┼─────────────────────────────────┐
 │        │        │        │        │      │
Git      FS     Browser  CodexGraph Worker Handoff
 │        │        │        │        │      │
 └──────────── Capability Boundary ──────────┘
          │
     Platform Adapter
       /          \
    macOS        Windows
   fast path   compatibility path
```

---

# Upgrade order

| Priority | Upgrade | Expected value |
| --- | --- | --- |
| P0 | Unified Agent Runtime + Event Store | Very high |
| P0 | Durable task/session resume and recovery | Very high |
| P1 | Capability/plugin boundary | Very high |
| P1 | Manager domain state stores/state machines | Very high |
| P1 | macOS/Windows platform adapters | High |
| P2 | CodexGraph context + impact intelligence | High |
| P2 | Runtime/capability health model | High |
| P3 | Scheduler and persistent long-running tasks | Later |
| P3 | Additional graph visual effects | Lower |

---

# Guiding principle

CodexPro does not currently need many more standalone features.

The highest-leverage upgrade is to turn its existing capabilities into one coherent, durable runtime:

> **Model/tool capability is already strong. Runtime consistency, recoverability, state ownership, and modular boundaries are now the main product multiplier.**

When adding a future feature, prefer asking:

1. Which capability owns it?
2. Which runtime events does it emit?
3. How is its state reconstructed?
4. How does it recover after interruption?
5. Which platform adapter does it require?
6. How can CodexGraph limit its context and verification surface?

That keeps future additions such as memory, schedulers, multi-agent execution, additional model providers, and autonomous workflows from creating another independent state/recovery path.
