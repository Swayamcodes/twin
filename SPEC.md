# twin — SPEC.md

## What it is

twin runs any AI coding agent (Codex CLI, Claude Code, Gemini CLI, opencode,
Aider, or a custom script) as a plain command, inside a full clone of your
project — including files git ignores (.env, node_modules) and folders that
aren't git repos at all. When the agent finishes, twin shows a receipt of
everything it did. You apply the changes or discard the clone.

twin also ships a scenario suite: scripted "bad agent" scripts that cause a
specific kind of damage, run through multiple recovery tools (twin, AgentTX,
plain git) and scored on what each one actually recovers versus what it
claims to have handled.

## Problem statement

Coding agents run with your full permissions and can delete, overwrite, or
run commands you didn't approve. Undo isn't automatic, and the popular undo
mechanism — git — has real gaps.

This isn't hypothetical. Hand-testing on a real repo (Sept 2026) found:

- `git clean -fdx` destroys ignored and untracked files with no way back
  through git (S6).
- The closest existing tool, AgentTX (v0.3.0), survives S6 by isolating the
  run in a clone — but its clone excludes ignored files entirely. It scored
  the run "0 files changed, LOW risk" despite ignored files never being
  available to the agent inside the clone at all (S13).
- A write outside the project folder (an agent appending to a dotfile in
  $HOME) was invisible to AgentTX's detection, uncaptured by its rollback,
  and unreported — while its receipt still described the run as clean (S9).
- AgentTX cannot run at all in a directory with no git repository (S8).

The core finding: isolation-based tools already protect git-tracked and
captured-untracked state reasonably well. The real gaps are (1) ignored
files and non-git folders, and (2) a receipt that accurately reports what a
tool did and didn't do, rather than reporting a clean run because it never
saw the damage.

## Who it's for

Developers running coding agents locally who want a safety net cheaper than
their own vigilance, and who want to know — with evidence, not marketing —
which recovery tools actually work for which kinds of accidents.

## Core features (v1)

1. Clone-and-run: wrap any CLI agent as a plain command inside a full clone
   of the project directory, including ignored files and non-git folders.
2. Receipt: a report of every file touched, categorized as tracked /
   untracked / ignored / outside-project / process / dependency change.
3. Apply or discard: keep the clone's changes (conflict-safe merge back) or
   throw the clone away.
4. Scenario suite: deterministic, scripted bad-agent scripts, no AI or
   network cost, scored against twin, AgentTX, and a plain-git baseline.
5. Watch list: a small set of paths outside the project (dotfiles, global
   npm packages) monitored and reported on, even though they aren't
   recoverable in v1.
6. Compatibility matrix: Codex CLI, Claude Code, and one more agent (Gemini
   CLI or opencode), tested and documented.
7. JSON + markdown output for suite results, versioned (schemaVersion).

## Non-goals (v1)

- Windows-native support (WSL2 is the supported path; plain-copy fallback
  since WSL2's ext4 has no reflink)
- A GUI or hosted dashboard
- Network traffic capture
- Rolling back global state (global npm installs, dotfile changes) — these
  are *reported*, not *recovered*, in v1
- Editor agents that edit files in place (Cursor-style) — needs a different
  snapshot-and-restore mode, deferred to v2
- Being "the first" tool in this space — it isn't, and the README says so

## Scope decision (from Step 1.4 evidence)

Originally the wedge was "recovers more than existing tools." Testing showed
that's mostly false for git-tracked and untracked state — AgentTX already
handles those well through isolation. The real, evidenced differentiator is
narrower: ignored-file and non-git-folder coverage, plus reporting that
doesn't claim success on damage it never saw. Effort is weighted toward
correctness of the receipt and the ignored-file clone, not toward "beating"
existing recovery counts. If in the course of building this, this holds up
at day 4/5 mark, ill continue on this path; if a later tool release closes
this gap first, the priority shifts to the receipt-accuracy layer and to
contributing findings upstream rather than duplicating solved work.

## Scoring: five independent fields per scenario

Recovery is not one yes/no. Each scenario run is scored on:

1. **Recovered or preserved?** — is the original state back / never lost?
2. **Reported?** — did the tool's own output mention the damage at all?
3. **Blocked before execution?** — did the tool prevent the action, vs.
   catching it after?
4. **Workspace usable?** — could the agent actually do its job inside the
   isolated environment (e.g. did it have ignored files it needed)?
5. **Boundary accurately described?** — does the tool's documentation match
   what it actually does (e.g. does it admit it excludes ignored files)?

"Fixed" for a scenario means a specific, checkable condition (e.g. "`.env`
exists with byte-identical contents to before the run"), never a subjective
judgment.