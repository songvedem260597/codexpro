# CodexPro “Tin nhắn gần nhất” — smooth streaming implementation plan

Updated: 2026-08-31

Repository: `songvedem260597/codexpro`

Target branch: `win`

Reference implementation inspected: DeepSeek Harness commit `0a53fb55bea101816fa226bb964ae2bed71c343b`

Target surfaces: Chrome profiles and API workers in CodexPro Manager

## 1. Objective

Make **Tin nhắn gần nhất** render response text smoothly while it streams, without visible jumps, forced scrolling, disappearing controls, duplicated text, or different behavior between Chrome profiles and API workers.

The result must preserve CodexPro's MCP-only worker boundary. API providers remain inference plugins; rules, repository access, tools, CodexGraph, job-title generation, and future constraints continue to be managed through CodexPro MCP.

## 2. Reference findings

The DeepSeek Harness UI avoids response jumps with a combination of rendering and scroll rules, not a single CSS fix:

- Each message keeps a stable identity while its text grows.
- Streaming Markdown freezes completed top-level blocks and only reparses a small trailing window.
- Parsed nodes use stable source offsets as keys instead of indexes derived from the latest render.
- Visual updates are coalesced through `requestAnimationFrame`.
- “Follow latest” is explicit state owned by the reader, separate from raw scroll geometry.
- Scrolling away immediately disables follow; there is no timer that silently resumes it.
- A single `ResizeObserver` follows content/composer growth only while the reader is pinned.
- The “back to bottom” control occupies a zero-height sticky slot, so it does not alter transcript height.
- Regression tests cover stream growth while reading older content, finalization shrink, resize, threshold behavior, and anchor restoration.

Reference files are under the active local DeepSeek runtime at:

`C:\Users\uchih\AppData\Local\deepseek-harness-desktop\upstream\releases\0a53fb55bea101816fa226bb964ae2bed71c343b\packages\client\ui-chat\src\client\chat`

Relevant files include `ChatView.tsx`, `AssistantNodeView.tsx`, `AssistantMarkdown.tsx`, `use-throttled-visual-update.ts`, plus `ui-primitives/src/markdown/incremental.ts`.

## 3. Current CodexPro state and root causes

CodexPro already has useful foundations:

- The Chrome latest-message panel has a fixed response viewport, `overflow-anchor: none`, stable scrollbar gutter, a bottom runway, progressive transcript identity merging, and scroll diagnostics.
- `manager/src/chat-transcript.js` can reconcile progressively arriving messages.
- `manager/src/chat-scroll.js` already distinguishes automatic and manual movement in several cases.

The remaining jump and inconsistency risks are:

1. `manager/src/response-markdown.jsx` reparses the entire accumulated response on each `text` change. Long responses increasingly consume the render frame and can change the geometry of already-settled content.
2. `manager/src/chat-scroll.js` uses a broad mutation/child-resize observation model and a five-second automatic resume. A reader who scrolls upward can be dragged back down even though they did not request follow mode again.
3. Chrome and API worker responses do not use one normalized latest-message surface, so fixes can diverge.
4. The API worker agent loop receives deltas internally, but the renderer only gets the completed `last_result`. The UI therefore shows generic typing and then swaps in the entire final response, creating a large one-frame layout change.

## 4. Non-goals

- Do not copy the DeepSeek product UI wholesale.
- Do not modify the external DeepSeek Harness runtime.
- Do not expose hidden chain-of-thought or internal reasoning tokens.
- Do not bypass MCP for rules, tools, repository access, CodexGraph, titles, or worker policy.
- Do not redesign unrelated Manager cards, dropdowns, or navigation.
- Do not commit packaged release output, credentials, API keys, `.env` files, or local runtime state.

## 5. Required behavioral contract

### 5.1 Streaming

- A response node is created once per turn and keeps the same DOM identity until the turn is finalized.
- Provider text deltas are ordered, append-only within a stream revision, and delivered to the renderer before job completion.
- The final normalized text must equal the provider result exactly once: no duplicated suffix, dropped chunk, or stale chunk from an older job.
- Updates are coalesced to at most one visible render per animation frame. IPC may additionally batch within 33–50 ms.
- Tool/phase status may be shown separately but must never be concatenated into response Markdown.

### 5.2 Scroll ownership

- When pinned to the bottom, new content remains followed and the distance from the bottom stays at most 2 px after layout settles.
- A wheel, touch, pointer, Page Up, Home, or keyboard scroll away immediately transfers ownership to the reader.
- While the reader is away, stream growth, image load, font reflow, Markdown finalization, and tool-status changes must not write a new `scrollTop`.
- Follow mode resumes only when the reader reaches the bottom or explicitly presses **Về cuối**.
- Remove the five-second forced auto-resume behavior.
- If finalization shortens content and the browser must clamp `scrollTop`, preserve the nearest semantic anchor where practical and accept only the unavoidable clamp.

### 5.3 Layout

- The latest-message panel keeps its configured outer height while streaming.
- The composer/send controls never shrink, disappear, or move outside the viewport because response text grows.
- The response region owns overflow; flex children that must shrink use `min-height: 0` and `min-width: 0`.
- The **Về cuối** control is sticky/overlayed in a zero-height slot and does not increase `scrollHeight`.

### 5.4 Markdown

- Completed Markdown blocks retain DOM identity during append-only growth.
- Only the trailing two top-level blocks remain mutable during streaming.
- Keys come from stable source ranges/offsets, not array indexes.
- Incomplete fenced code, tables, links, and TeX render safely during streaming and reconcile once settled.
- Existing link sanitization and untrusted-content boundaries remain intact.

## 6. Target architecture

### 6.1 Shared latest-message surface

Create `manager/src/latest-message-panel.jsx` and move the common response viewport into it. Chrome and API worker adapters should feed one normalized model:

```js
{
  turnId,
  revision,
  status,          // idle | queued | streaming | tool | complete | error
  text,
  settled,
  error,
  toolStatus,
  attachments,
  updatedAt
}
```

The component owns response rendering, typing/phase presentation, retry/error placement, scroll following, **Về cuối**, latest-message metadata, and the continuation composer. Provider-specific controls stay outside it.

### 6.2 API worker real-time bridge

Extend `manager/electron/worker-plugins/api-worker-plugin.mjs` and the MCP agent-loop integration to expose public streaming state without exposing hidden reasoning:

- `streamText`
- `streamRevision`
- `streamPhase`
- `streamUpdatedAt`
- `streamToolStatus`

Every run gets an immutable `jobId`/revision. Late events are ignored unless they match the active run. Publish text deltas only from the user-visible answer channel.

Add a renderer update channel in `manager/electron/main.mjs` and `manager/electron/preload.cjs`, for example `codexpro:worker-update` / `onWorkerUpdate`. Coalesce IPC delivery to 33–50 ms and always emit one final settled snapshot. Keep polling as a compatibility fallback, not the primary streaming path.

### 6.3 Incremental Markdown renderer

Create `manager/src/incremental-response-markdown.jsx` or split equivalent logic from `response-markdown.jsx`:

- Detect append-only updates.
- Parse top-level block boundaries.
- Freeze all completed blocks except the trailing two.
- Cache rendered React elements for frozen blocks.
- Use source offsets plus block type for stable keys.
- Reset the cache when `turnId` changes or text is edited non-append-only.
- Perform a full reconciliation when `settled` becomes true.
- Preserve current safe-link behavior.
- Render incomplete TeX literally until it is complete enough to parse safely.

Do not optimize by rendering raw unsanitized HTML.

### 6.4 Frame-coalesced visual updates

Add `manager/src/use-frame-coalesced-value.js` (or an equivalent hook) so rapid IPC/poll changes cause at most one React update per animation frame. The data store may receive all chunks; only visual reconciliation is coalesced.

### 6.5 Reader-owned scroll controller

Refactor `manager/src/chat-scroll.js` around a small explicit ledger:

```js
{
  pinned,
  observedTop,
  savedAnchor,
  lastProgrammaticTop
}
```

Rules:

- Use a 24 px bottom threshold only to detect whether the reader has returned to the bottom.
- Treat wheel/touch/pointer/keyboard intent before geometry changes so programmatic and manual scrolling are not confused.
- Remove `scheduleResponseAutoResume` and all timed ownership changes.
- Use one `ResizeObserver` on the content column and composer while pinned; disconnect or become passive while away.
- Store a semantic anchor (`turnId`, block source offset, viewport offset) when leaving follow mode.
- Restore that anchor after unavoidable reflow/finalization when the referenced block still exists.
- Replace broad mutation-driven writes with explicit calls from stream/render lifecycle events.

### 6.6 Scoped CSS

Update `manager/src/styles.css` only for the shared response surface:

- Fixed/flex-safe panel shell.
- `min-height: 0` on nested flex containers.
- Stable scrollbar gutter.
- `overflow-anchor: none` on the controlled scroller.
- Zero-height sticky slot for **Về cuối**.
- Stable send button size and non-shrinking composer.
- `contain`/layout isolation only after verifying it does not break sticky positioning or Markdown measurement.

## 7. Implementation phases and commit checkpoints

Each phase should start from the latest `origin/win`, keep unrelated user changes intact, and be pushed independently after its verification passes.

### Phase 0 — Lock behavior with regression fixtures

Files:

- `manager/scripts/chat-scroll-stability-fixture.html`
- `manager/scripts/chat-scroll-stability-smoke.cjs`
- `manager/scripts/response-markdown-smoke.mjs`
- `manager/scripts/api-worker-job-modal-smoke.mjs`

Work:

- Add failing cases for append growth while pinned and while reader-owned.
- Add finalization shrink and delayed image/font reflow cases.
- Add stable DOM identity assertions for frozen Markdown paragraphs.
- Add a simulated API delta sequence and stale-job rejection case.
- Measure panel height, bottom distance, reader scroll position, duplicate text, and long tasks.

Checkpoint commit: `test(manager): define latest message streaming contracts`

### Phase 1 — Stream API worker output to the renderer

Files:

- `manager/electron/worker-plugins/api-worker-plugin.mjs`
- `manager/electron/worker-core/mcp-agent-loop.mjs`
- `manager/electron/main.mjs`
- `manager/electron/preload.cjs`
- relevant worker tests

Work:

- Promote visible answer deltas into public worker state.
- Attach `jobId` and monotonically increasing revision.
- Add coalesced worker-update IPC and cleanup listeners on unmount/window close.
- Preserve final `last_result` compatibility.
- Verify no reasoning/tool payload leaks into visible answer text.

Checkpoint commit: `feat(manager): stream API worker responses to renderer`

### Phase 2 — Share Chrome/API latest-message UI

Files:

- `manager/src/latest-message-panel.jsx` (new)
- `manager/src/main.jsx`
- `manager/src/chat-transcript.js`
- `manager/src/styles.css`

Work:

- Introduce the normalized turn model.
- Adapt Chrome transcript events and API worker events to the same component.
- Preserve existing Chrome features: **Tin nhắn gần nhất**, continue chatting, image attachment, repo/authorized-region selection, task title, error/retry, and connected-state controls.
- Keep API/Chrome card controls outside the shared response component.

Checkpoint commit: `refactor(manager): share latest message response surface`

### Phase 3 — Incremental Markdown and frame coalescing

Files:

- `manager/src/incremental-response-markdown.jsx` (new)
- `manager/src/use-frame-coalesced-value.js` (new)
- `manager/src/response-markdown.jsx`
- Markdown smoke tests

Work:

- Implement append-aware block freezing and stable keys.
- Coalesce visible updates to animation frames.
- Reconcile the complete document once on settle.
- Verify links, code fences, tables, lists, and TeX through partial states.

Checkpoint commit: `perf(manager): render streaming Markdown incrementally`

### Phase 4 — Reader-owned anti-jump scrolling

Files:

- `manager/src/chat-scroll.js`
- `manager/src/latest-message-panel.jsx`
- `manager/src/styles.css`
- scroll fixtures

Work:

- Replace the five-second resume timer with explicit pinned ownership.
- Add the semantic anchor ledger.
- Follow resize only while pinned.
- Add the zero-height **Về cuối** slot.
- Remove redundant observers/listeners after the new contract passes.

Checkpoint commit: `fix(manager): keep latest response viewport stable`

### Phase 5 — End-to-end verification and Windows release

Work:

- Exercise Chrome and API worker paths with short, long, Markdown-heavy, image-assisted, tool-using, error, retry, stop, and continue-chat cases.
- Test at common Manager window sizes and Windows display scaling.
- Run all required commands below.
- Build/package only after source tests pass.
- Install over the current Windows app, launch it, and run a final real UI smoke test.
- Do not commit generated release artifacts.

Checkpoint commit, only if release metadata/source changes are required: `chore(manager): release smooth latest message UI`

## 8. Test and verification matrix

### Automated commands

Run the narrow checks first, then repository-wide checks:

```powershell
node scripts/provider-plugin-smoke.mjs
npm --prefix manager run test:markdown
npm --prefix manager run test:api-worker-job-modal
node manager/scripts/chat-scroll-stability-smoke.cjs
npm --prefix manager run build
npm run build
npm run smoke
```

If a package script name differs on the current branch, use the equivalent command defined in `package.json` and record the exact command/result in the handoff.

### Dedicated performance fixture

Add an Electron/browser fixture that streams at least 50,000 characters in at least 200 chunks and asserts:

- no duplicated or missing characters;
- no message-node remount for frozen blocks;
- no response-panel outer-height change;
- no scroll writes while reader-owned;
- pinned bottom distance at most 2 px;
- no new UI long task above 50 ms attributable to full-document parsing on each chunk.

### Manual acceptance cases

1. Start at bottom and stream a long answer: text grows smoothly and remains pinned.
2. Scroll upward during streaming: viewport stays on the selected text indefinitely.
3. Wait more than five seconds: it still does not jump to the bottom.
4. Press **Về cuối**: follow resumes immediately.
5. Load an image/code block/table late: reader position remains stable.
6. Finalize a partial Markdown block: no flash/remount of settled paragraphs.
7. Stop and retry an API job: old deltas never enter the new response.
8. Continue chatting with text and image: existing Chrome behavior remains available to API workers where supported.
9. Resize the Manager window: composer/send button stays visible and response overflow remains internal.
10. Trigger 429/provider error and retry: error is stable, readable, and replaced by the correct new run only.

## 9. Performance and correctness gates

- No IPC event per token without batching/coalescing.
- No full Markdown parse/render for every appended chunk.
- No duplicated/lost response characters.
- No stale event crossing job revisions.
- No hidden reasoning exposed.
- No automatic `scrollTop` write while the reader owns the viewport.
- No mutation/resize feedback loop.
- No event-listener or observer leak after closing/reopening the panel.
- No new long task above 50 ms in the dedicated streaming fixture.
- No weakening of link sanitization, MCP policy, repo authorization, or local-execution safety.

## 10. Expected source impact

Likely modified or added files:

- `manager/src/main.jsx`
- `manager/src/latest-message-panel.jsx`
- `manager/src/response-markdown.jsx`
- `manager/src/incremental-response-markdown.jsx`
- `manager/src/use-frame-coalesced-value.js`
- `manager/src/chat-scroll.js`
- `manager/src/chat-transcript.js`
- `manager/src/styles.css`
- `manager/electron/main.mjs`
- `manager/electron/preload.cjs`
- `manager/electron/worker-plugins/api-worker-plugin.mjs`
- `manager/electron/worker-core/mcp-agent-loop.mjs`
- related `manager/scripts/*smoke*` fixtures/tests

This is an impact map, not permission to refactor every file. Keep each change scoped to the phase and proven by its regression test.

## 11. Handoff instructions for the implementing CodexPro agent

1. Read repository `AGENTS.md` and this plan completely.
2. Pull/fetch and confirm the latest `origin/win` before editing.
3. Inspect `.ai-bridge/current-plan.md` for local task context.
4. Reconfirm current symbols and tests because the branch may have advanced after this plan was written.
5. Implement Phase 0 first; demonstrate the intended failures before source changes.
6. Execute phases in order and push each verified checkpoint to `win`.
7. Do not overwrite unrelated dirty changes or force-push.
8. Report root cause, files changed, exact commands, exact results, commit hash, and push state after every phase.
9. Stop before any destructive cleanup or scope expansion not listed here.
10. After Phase 5, package/install the Windows app only when explicitly authorized in the active task, then verify the launched build contains the new bundle.

## 12. Definition of done

The work is complete only when both Chrome profiles and API workers use the shared latest-message surface; API output appears before completion; long streaming Markdown remains visually smooth; scrolling away never auto-snaps back; settled content retains stable identity; all automated and manual acceptance cases pass; source commits are pushed to `origin/win`; and the installed Windows build has been launched and smoke-tested when installation is in scope.
