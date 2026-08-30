# Worker GIF packs

This directory is the Git-tracked source of truth for worker animations shared by
the macOS and Windows builds of CodexPro Manager. Vite bundles packs imported by
`manager/src/main.jsx`, so both platforms use the exact same GIF bytes.

Each pack lives in its own directory and contains:

- `manifest.json` with the pack id, version, state mapping, size, and SHA-256.
- `idle.gif`, `working.gif`, and `hung.gif` for the three runtime states.

To publish or update a pack, add its files here, update its manifest and the
imports in `manager/src/main.jsx`, then run `npm run manager:check`. Once the
commit is pushed, individual files can also be downloaded from GitHub Raw using:

`https://raw.githubusercontent.com/<owner>/<repo>/<commit>/manager/src/assets/worker-packs/<pack-id>/<file>`

Use a commit SHA instead of a branch name when another installer needs stable,
verifiable bytes.
