# Windows -> macOS sync checklist

This file is the required checklist whenever changes from the `win` branch are brought into the `mac` branch.

## Purpose

The Windows branch is the upstream feature/fix source for much of the Manager and worker code, but the macOS branch contains platform-specific behavior that must not be overwritten during synchronization.

Before considering any `win` -> `mac` sync complete, review every item below.

## 1. Preserve local macOS work before syncing

- Inspect `git status` first.
- Never overwrite or discard existing uncommitted macOS changes.
- If local changes overlap incoming commits, stash them before cherry-picking/merging and restore them afterward.
- Prefer bringing over only the new Windows commits that are actually needed instead of blindly replacing macOS files.
- Resolve conflicts by preserving both the new shared behavior and the macOS-specific behavior.

## 2. Keep worker extension versions aligned

Verify that all worker-extension version references agree after the sync, especially:

- `chrome-extension/manifest.json`
- `manager/electron/main.mjs`
- `manager/src/main.jsx`
- any smoke tests or worker-version constants touched by the incoming commits

Do not leave the Electron target, Manager UI target, and extension manifest on different versions.

## 3. Preserve macOS Chrome open/focus behavior

Do not replace macOS window activation with Windows-only logic.

The macOS path must continue to use the native macOS flow, including the current `focusChromeWindowMac()` behavior and LaunchServices/frontmost-app checks where applicable.

Windows-specific PowerShell/User32 behavior must stay behind `isWindows` / `process.platform === "win32"` branches.

## 4. Preserve macOS autostart and runtime/profile bridge behavior

Keep macOS-specific startup/runtime behavior working, including:

- Electron login-item autostart via `app.setLoginItemSettings(...)`
- profile bridge startup on macOS
- native macOS runtime discovery/status behavior
- no dependency on Windows Scheduled Task behavior for macOS

Do not let Windows runtime/status code replace the macOS runtime path.

## 5. Preserve macOS headless-worker behavior

Keep the macOS-specific Chrome and profile discovery paths in `manager/electron/headless-workers.mjs`, including:

- Chrome executable discovery under `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` and user Applications when supported
- Chrome user data under `~/Library/Application Support/Google/Chrome`
- macOS-specific Chromium user agent/platform behavior
- profile/session cloning behavior that is compatible with macOS filesystem semantics

Changes from Windows must not hard-code Windows Chrome paths or Windows-only assumptions into the macOS path.

## 6. Preserve the macOS Manager UI

When syncing Manager UI changes, keep the macOS-specific visual polish already present on the `mac` branch:

- native macOS typography / SF Pro system font stack
- established font sizes, spacing, alignment, widths, and padding
- profile cards and active-repository display
- headless-worker UI
- macOS-specific labels/status text where platform wording differs

After any UI-related sync, run the Manager and visually inspect the real macOS UI. Do not consider the task complete based only on a successful build.

## 7. Preserve platform conditionals

Review incoming changes touching:

- `manager/electron/main.mjs`
- `manager/electron/headless-workers.mjs`
- `manager/src/main.jsx`
- `src/browserExtensionBridge.ts`
- `src/bashOps.ts`
- smoke tests involving Chrome/profile/runtime behavior

Make sure Windows behavior remains under Windows branches and macOS behavior remains under macOS branches. Avoid generic replacements that silently turn a cross-platform path into a Windows-only one.

## 8. Required verification after every sync

At minimum:

1. Confirm there are no unresolved conflict markers.
2. Confirm unrelated local macOS changes are still present.
3. Confirm worker-extension versions are aligned.
4. Run `npm run build`.
5. Run `npm run smoke` when shared Manager/worker/runtime behavior changed.
6. If Manager UI changed, run the app on macOS, capture/inspect the UI, and fix visual or interaction regressions before finishing.
7. Re-check `git status` and summarize exactly what was synced and what macOS-specific behavior was preserved.

## Rule for future agents/chats

Whenever the user asks to pull, sync, cherry-pick, or merge the `win` branch into `mac`, read this file first and apply it as a required completion checklist.
