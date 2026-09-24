# twin — ARCHITECTURE.md

## Workspace layout (pnpm)

twin/
packages/
core/ # clone, diff, receipt logic — the reusable engine
cli/ # command parsing (Commander) — thin wrapper over core
scenarios/ # bad-agent scripts + scoring harness + adapters
web/ # (future, Phase 6+) static landing + results viewer
pnpm-workspace.yaml


`core` has no dependency on `cli` or `scenarios`. `cli` and `scenarios` both
depend on `core`. This is so the suite (Phase 2) can run standalone against
`core`'s clone/diff logic without needing the full CLI, and so `core` stays
testable in isolation.

## `core` responsibilities

- **Clone**: copy a project directory to a scratch location, choosing a
  reflink/copy-on-write strategy where available (macOS APFS, btrfs) and
  falling back to a plain recursive copy otherwise (the default and only
  tested path on WSL2/ext4). Includes files git ignores and works in
  directories with no git repository at all.
- **Manifest / diff**: hash every file before and after the run (not git),
  so tracked/untracked/ignored/non-git files are all covered the same way.
  Git is used only to *label* each path as tracked, untracked, or ignored —
  never to decide what gets copied or diffed.
- **Receipt**: turn the diff into a structured report — files
  added/changed/removed (with their git-category label), dependency
  changes, leftover processes, and a watch-list report for paths outside
  the project (reported, not recovered, in v1).
- **Apply**: a three-way, conflict-safe merge using (a) the file's state at
  clone time, (b) its current state in the real project (in case you
  changed something while the agent ran), and (c) the clone's result. Two
  states (before/after) can't detect "you also touched this file
  meanwhile" — three can.

## Receipt / results JSON (sketch)

```json
{
  "schemaVersion": 1,
  "tool": "twin",
  "scenarioId": "S6",
  "run": {
    "startedAt": "...",
    "command": ["bash", "bad-clean.sh"]
  },
  "files": [
    { "path": "scratch.txt", "category": "untracked", "change": "deleted" }
  ],
  "watchList": [
    { "path": "$HOME/.fakerc", "change": "modified", "recovered": false }
  ],
  "score": {
    "recovered": true,
    "reported": true,
    "blockedBeforeExecution": false,
    "workspaceUsable": true,
    "boundaryAccuratelyDescribed": true
  }
}
```

`schemaVersion` exists because this is a public contract other people's
scripts may parse — a breaking format change bumps it rather than silently
changing shape.

## Documented limits (known, from Step 1.3 findings and reasoning)

- **Outside-project writes** are only caught if the path is on the watch
  list; anything else is invisible to twin, same gap AgentTX had on S9.
- **Symlinks pointing outside the project** may not clone correctly and
  need explicit handling or an explicit "not supported" note.
- **Absolute paths baked into files** (e.g. Python virtualenvs) can break
  once the clone lives at a different path.
- **An agent that resolves the real project's absolute path** (rather than
  operating relative to its working directory) can write outside the clone
  entirely, bypassing isolation. This is a fundamental limit of process-level
  isolation without OS sandboxing, and the README states plainly: a clone is
  not a sandbox.

## Windows / WSL2

Development and all testing happen inside WSL2 (Ubuntu, ext4). ext4 has no
reflink, so the plain-copy fallback is the default and only path exercised
locally; the reflink/copy-on-write path is implemented but only verified in
CI on a macOS runner. Native Windows is out of scope for v1.