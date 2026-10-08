# twin — SPEC.md

## What it is

twin runs coding agents as plain commands inside a full clone of your
project — including files git ignores (.env, node_modules) and folders that
aren't git repos at all. When the agent finishes, twin shows a receipt of
observed before/after file differences and bounded command, process,
dependency, and outside-project observations. You apply the changes or discard
the clone.

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
files and non-git folders, and (2) a receipt that reports observed changes
and its coverage limits, rather than reporting a clean run because it never
saw the damage.

## Who it's for

Developers running coding agents locally who want a safety net cheaper than
their own vigilance, and who want to know — with evidence, not marketing —
which recovery tools actually work for which kinds of accidents.

## Core features (v1)

1. Clone-and-run: wrap any CLI agent as a plain command inside a full clone
   of the project directory, including ignored files and non-git folders.
2. Receipt: a report of observed file differences between before/after
   inventories, labeled tracked / untracked / ignored / unclassified, with
   separate bounded outside-project watch, command, process, and dependency
   observations. Reads and writes reverted within a run that leave no net
   difference are unobserved.
3. Apply or discard: keep the clone's changes (conflict-safe merge back) or
   throw the clone away.
4. Scenario suite: deterministic, scripted bad-agent scripts, no AI or
   network cost, scored against twin, AgentTX, and a plain-git baseline.
5. Watch list: a small set of paths outside the project (dotfiles, global
   npm packages) monitored and reported on, even though they aren't
   recoverable in v1.
6. Compatibility matrix: Codex CLI and Claude Code, tested and documented
   as plain commands. A blocked agent check remains unverified.
7. JSON + markdown output for suite results, versioned (schemaVersion).

The unreleased checkout accepts structurally contained relative symlinks and
remaps accepted absolute targets beneath the canonical source spelling into
relative links in the copy. Original link text is preserved in the source.
Parent components are allowed only before named target components; `alias/../x`
is rejected. Copy and cleanup never deliberately follow link targets. Unchanged
verified baseline links permit unrelated regular-file apply; added, removed,
replaced or modified links refuse the whole plan. Discovery caps total entries
at 100,000, component depth at 128, and relative paths and original/emitted targets
at 4,096 bytes. Non-UTF-8 source entry names are rejected. This is neither universal
pnpm compatibility nor an OS sandbox; see the current copy/apply boundary.

## Non-goals (v1)

- Windows-native support (WSL2 is the supported path; plain-copy fallback
  since WSL2's ext4 has no reflink)
- A GUI or hosted dashboard
- Network traffic capture
- Rolling back global state (global npm installs, dotfile changes) — these
  are *reported*, not *recovered*, in v1
- Editor integrations that modify the original in place, outside a Twin copy —
  need a different snapshot-and-restore mode, deferred to v2
- Being "the first" tool in this space — it isn't, and the README says so

## v1 agent compatibility scope

Codex CLI and Claude Code are the only required v1 compatibility checkpoints.
OpenCode, Aider, Gemini CLI, and Cursor CLI are deferred and are not Phase 5
acceptance requirements. Twin's plain-command design does not exclude them.
Cursor's [headless CLI](https://cursor.com/docs/cli/headless) can run an
agent as a terminal command; its setup cost defers this checkpoint. That CLI
path is distinct from an editor integration that edits the original project
in place, which Twin's clone-and-run workflow does not cover.

The [v1 compatibility matrix](docs/compatibility-matrix.md) records verified
Codex behavior and Claude's billing-blocked model work separately. The funded
Claude rerun is on indefinite hold for budget reasons; it is optional
follow-up, not a Phase 5 prerequisite. [Phase 5 acceptance](docs/phase-5-acceptance.md)
records the final v1 decision and its limits.

## Scope decision (from Step 1.4 evidence)

Originally the wedge was "recovers more than existing tools." Testing showed
that's mostly false for git-tracked and untracked state — AgentTX already
handles those well through isolation. The real, evidenced differentiator is
narrower: ignored-file and non-git-folder coverage, plus reporting that
doesn't claim success on damage it never saw. Effort is weighted toward
correctness of the receipt and the ignored-file clone, not toward "beating"
existing recovery counts. We will continue while the evidence supports
this direction. If a later tool release closes this gap first, the priority
shifts to the receipt-accuracy layer and to contributing findings upstream
rather than duplicating solved work.

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

## Combined retained S12 and S6 JSON

The Tier B combined entry reads exactly two saved JSON lines from the existing
S12 and S6 score entries, in either argument order. Each file must be a distinct,
regular, non-symlink file of at most 8 MiB containing one compact JSON object
and exactly one final LF. A complete output is one version-1 JSON line with
S12 then S6. Each result carries only its public scenario ID, retained reference
and attempt identities, tool and adapter identities, and unchanged five-dimension
`ToolScore`. It adds no total, ranking, winner, Markdown, or AgentTX result.
Invalid or incomplete inputs yield one closed, identity-free incomplete line and
a nonzero exit. The combiner does not run either producer or authenticate saved
results or retained artifacts. Plain Git receives no five-dimension score here.

## Current Twin S12/S6 Markdown report

The Tier B Markdown entry reads one existing combined-result JSON file through a
bounded, no-follow regular-file descriptor. It accepts only a complete version-1
combined object followed by one LF, and renders the current Twin S12/S6 outcomes
and their closed reasons in the five-dimension order above. Fixed limitations and
sanitized public tool/adapter identities are included. This is not the final
AgentTX/plain-Git comparison report. It performs no producer work or cleanup and
does not authenticate the saved file or retained artifacts.

## Interim inventory reliability policy

`scanTimeoutMs` defaults to 30,000 milliseconds and accepts an integer from 1
to 3,600,000. Each preparation, receipt and apply inventory receives its own
fresh monotonic deadline; this is not a budget for the entire run. Longer
budgets can multiply total waiting time, especially when apply verifies paths
with additional inventories. Command `timeoutMs` remains separate.

Coverage limits remain 100,000 entries, 2 GiB hashed content, 128 directory
levels and 4,096 path bytes. Ignored files and `.git` remain included, with fresh
hashes and identity checks. Timeout, cancellation and stable unfinished reads
are reported as `scan-timeout`, `scan-cancelled` and `file-read-incomplete`.
`entry-changed-during-scan` requires detected metadata or identity differences;
a confirmed change and termination can both be reported. Partial reads never
produce a file digest. Partial preparation inventories permit execution, but
partial baselines still prevent apply even if later inventories complete.

Cancellation is cooperative. Preparation waits for started observations before
guarded cleanup; copying and pending native operations may delay cancellation.
Before command handoff, cancellation prevents launch and leaves the child
settled. Once handed off, command interruption uses its separate signal. Apply
refuses cancellation or incomplete verification before original mutation
attempts; after any mutation attempt, including temporary sibling creation,
failure reports possible partial application and retains the copy. Cleanup
retains its authority checks and does not depend on an un-aborted scan signal.

This checkpoint does not establish acceptable performance across real
repositories. The observed Prizzle DrvFS inventory timeout remains unresolved;
Prizzle compatibility has not passed. The bounded startup work below retains
fresh hashes, complete-coverage requirements and inclusion of ignored contents.

## Unreleased bounded startup observations

A private session coordinator admits at most four independent filesystem jobs,
with eight queued jobs. Each operation retains at most twelve admitted but
uncommitted results, commits them in discovery order, and has at most one pending
admission waiter. Workers never wait for descendants or another permit. These
are job bounds, not bounds on every syscall or the independent Git, dependency
and watch observers. No public concurrency setting or threadpool change is added.

Final preparation link reconciliation uses a separate shared coordinator for
both complete root walks, admitting eight active jobs with the same eight-job
queue and twelve-result window per operation. Copy, inventories and Apply retain
four active jobs. Every job keeps its fresh serial ancestor checks; no observation
is shared or cached. Interleaving changes within the existing non-atomic phase,
and cleanup still waits for both walks to settle.

Ordinary files still receive independent buffered copies through no-follow source
handles and exclusive destinations. Detected source identity, size, mode or time
changes reject preparation. Directories stay private until file workers settle;
Git configuration is copied from its bounded validated bytes. Native copy/reflink
and writable hard links remain excluded. Failure or cancellation stops new work
and drains admitted work and closes its handles before guarded cleanup.

Preparation completes the independently timed Git/watch/dependency observations,
reads the original apply baseline, then reads one fresh full copy inventory for
both receipt and apply baselines. The receipt file baseline therefore moves to
this later preparation boundary. After command settlement one fresh copy inventory
also supplies both views. Raw observations retain all directories and 07777 modes;
receipt views retain non-directories and Git directories, while apply views retain
all directories with modes masked to 0777. Both views retain all coverage failures.
Neither original bytes nor later apply inventories are inferred from copied data
or reused hashes; link reconciliation remains a separate fresh observation.

The 30-second per-inventory default and all entry, byte, depth and path limits
remain. Queue waiting counts toward an inventory's own deadline; copying receives
cooperative cancellation rather than a whole-copy scan deadline. Pending native
operations can delay cancellation. This work does not make observations atomic,
resolve same-user races, establish universal project compatibility, or demonstrate
acceptable Prizzle startup time. Performance evidence must identify its fixture
and measurement boundary.

## Unreleased explicit affected-path Apply

`TwinSession.apply()` and default CLI Apply retain the whole-tree contract above.
`TwinSession.applyAffected()` is a separate opt-in method with no caller paths.
Its frozen selection contains every nonlink copy-baseline/settled difference;
complete historical original/copy/settled observations and unfiltered historical
symlink validation remain mandatory. Historical Apply modes are projected to 0777.

Affected validation freshly checks every planned target (including no-ops), its
ordinary root-to-parent components in both trees, and all original descendants of
removed/replaced directories. Unknown original children conflict before writes;
late arrivals prevent nonrecursive removal. Ignored, untracked, non-Git and .git
paths receive the same checks. Fresh hashes, full raw metadata stability,
no-follow opens, root authority, session/settlement gates, bounded observation,
conflict detection and guarded owned-object cleanup remain required.

This alternative removes fresh whole-tree equality and full live link discovery
at Apply. Unrelated late original/copy edits, unreadable or special siblings, and
new or replaced unrelated links do not independently refuse affected Apply. Late
copy changes outside the frozen selection are not applied. Success verifies the
explicit affected scope, not unrelated tree health or continuous preservation.
Preparation and command receipts retain their full-tree observation costs.

CLI selection requires literal `--review --apply-scope=affected` before `--`.
`-r` alone and saved review=true do not authorize affected scope. Invalid values,
duplicates and missing explicit review are rejected before session creation.
Scope is neither read nor saved in configuration. Help, review before choice and
separate Apply output disclose: “Apply verification: affected paths and ancestors.
Unrelated files and links will not be rechecked.” The schema-5 command receipt
and its byte framing remain unchanged; it is not an Apply verification receipt.

Affected results always identify scope/outside-scope status, phase, planned and
finally verified target counts, destructive-subtree count and complete/incomplete/
not-observed scope coverage. Before any original mutation attempt, uncertain
checks refuse and known conflicts report conflict, retaining the copy. Once any
original mutation is attempted, including exclusive sibling creation, failures
report possible partial application, retain the copy, and preserve primary and
bounded secondary cleanup errors. No rollback or all-path atomicity is promised.
Same-user ancestor swaps between checks and path syscalls remain a limit;
O_NOFOLLOW does not atomically pin parent resolution. Writable hard links,
snapshot backends, stale observation reuse and combined inventory/link walking
are excluded. No universal preparation or Apply latency is promised.
