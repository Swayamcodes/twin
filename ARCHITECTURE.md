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

## Scenario oracle and tool score

`ScenarioRunResult` remains raw S12/S6 command, filesystem, issue, and cleanup
evidence. The direct runner is not Twin or a recovery tool. The versioned
scenario oracle checks whether the scripted accident happened as specified in
the disposable fixture. A valid S6 oracle result means the intended deletion
occurred; it is not a safety pass. Oracle validity, later score eligibility,
and cleanup disposition are separate fields. The oracle observes seven named
fixture paths, not a complete workspace manifest.
Missing setup command evidence yields an unknown precondition and an
indeterminate oracle result; a recorded wrong command or operational failure
yields an invalid result. Cleanup-root inconsistencies affect only cleanup
interpretation, where the scenario root's disposition is unknown.
Semantic validity also requires a non-empty POSIX absolute scenario root and
the exact `workspace` child. This is a syntax check for supported POSIX, WSL,
and macOS evidence, not proof that the root existed, was safe, or came from
the runner. Setup evidence references resolve by exact command identity,
regardless of array position; duplicate identities are ambiguous. A
`scenario-run` reference names the complete enclosing raw result when a
narrower reference cannot truthfully identify evidence.

The separate versioned `ToolScore` contract has five factual dimensions:

| Dimension | Outcomes |
| --- | --- |
| `recoveredOrPreserved` | `preserved`, `recovered`, `not-recovered`, `unknown`, `not-applicable` |
| `reported` | `reported`, `not-reported`, `unknown`, `not-applicable` |
| `blockedBeforeExecution` | `blocked`, `not-blocked`, `unknown`, `not-applicable` |
| `workspaceUsable` | `usable`, `unusable`, `unknown`, `not-applicable` |
| `boundaryAccuratelyDescribed` | `accurate`, `inaccurate`, `unknown`, `not-applicable` |

Every dimension has a reason, typed evidence references, and an evaluation
method. There is no composite score, total, percentage, ranking, or color.
Structural `ToolScore` validation cannot establish that adapter evidence exists
or proves a claim. Adapters, automatic tool scoring, private raw tool artifacts,
redaction, and rendering are deferred.

Consumers import the pure oracle and versioned schemas from
`@twin-cli/scenarios/contract`, which does not import the CLI entry point.
`evaluateScenarioOracle(raw, context)` requires a strict versioned context
whose scenario ID matches the raw run. S12 context supplies nonblank expected
executable and script-path strings, preserving their exact values; this is not
independent proof of which binary executed. S6 context requires no S12 action
identity and retains its fixed `git clean -fdx` identity. The evaluator does
not derive S12 identity from its own process or installation path.
`schemaVersion: 1` identifies the public shape; `oracleVersion: 1` and
`rubricVersion: 1` identify judgment rules. The oracle's `sourceRunId` is
`sha256:` followed by the digest of canonical UTF-8 JSON for one complete raw
run. It excludes evaluation context and includes run-specific timestamps and paths; different executions are
not expected to share an ID. Object keys and named observations are sorted,
identical issues are grouped by phase and message digest, and semantically
ordered command arrays retain their order. String sorting uses JavaScript
code-unit order, independent of locale. Undefined values are rejected.

## Normalized tool evidence (Phase 2 Step 2.5a)

`NormalizedToolEvidence` is a strict version-1 record of one tool attempt,
identified by `toolRunId` and `scenarioId`. It does not require an eligible
accident oracle, a started action, or a `ToolAttemptResult`. A blocked S6
attempt can be internally valid with unknown reference-accident linkage.
The existing accident oracle still asks whether the direct scripted accident
occurred; its validity and `scoreEligibility` semantics are unchanged.

`sources.referenceAccident` either declares a
`reference-accident` source run and oracle version or explicitly records an
unknown linkage with a reason. Declaring an identity does not resolve it or
establish oracle validity. `sources.sameExecution` is either absent with a
reason or declares `same-execution-additional-evidence`; its oracle identity
may itself be unknown. It never supplies a required accident verdict and
cannot erase coherent blocking evidence. Future ToolScore bundle validation
will interpret `oracleRunId` as the resolved eligible reference accident's
`sourceRunId`, while `toolRunId` identifies the attempt being assessed.
Reference-accident observations cannot stand in for tool-attempt observations.

The fact union contains exactly `original-state-observation`, `reported-event`,
`execution`, `workspace-input`, and `boundary-observation`. Declared capabilities
live only in `declaredCapabilities`, have only `capabilityId` as record identity,
and resolve through declared-capability references. Each record carries its
run identity. Provenance distinguishes independent observer records from tool
output and documentation; these labels are assertions, not authentication.
Unknown values always have a closed reason code. Availability explains missing
collections without treating empty collections as negative evidence.

Original-state observations are timestamped/ordered points on the protected
original. Workspace inputs concern the execution workspace. Matching endpoints
do not prove uninterrupted preservation, and a final matching state does not
prove recovery. Recovery needs ordered damage followed by restoration; deciding
whether that evidence supports an outcome remains deferred. There is no interval
coverage, continuous-monitoring assertion, or automatic score.

Reporting has an explicit stdout/stderr/log/receipt applicability inventory.
Capture completeness and interpretation completeness are separate assertions.
One resolved captured mention may later support a positive reported judgment,
even with partial capture. An unreported boundary observation requires complete
capture and complete interpretation for every applicable channel, with no
unknown channel applicability. Explicit denials remain tool claims. Empty event
collections never prove non-reporting. A block is reportable under rubric v1;
this contract does not calculate that or any other ToolScore outcome.
Every tool-output provenance segment, across all five fact kinds, must resolve
to a matching inventory-owned reporting capture whose capture and interpretation
states are usable (partial or complete). Unknown/unavailable capture and unknown/
not-performed interpretation cannot support an interpreted claim. Complete
interpretation still requires complete capture. Positive reporting boundary
observations must name at least one capture used by their provenance; unrelated
channels need not be complete for a positive claim.

The flat public `segments` registry resolves artifact/segment pairs and records
channel, capture ownership, private-reference existence, redaction status,
semantic redaction policy version when applicable, and public verifiability.
It contains no raw bytes, excerpts, storage locations, byte offsets, commands,
filesystem paths, exception text, or raw-artifact/segment content digests.
Public normalized evidence may contain an original-state file-content SHA-256
when the producer determines that disclosure is appropriate. For secret-bearing
content where a digest creates disclosure or guessing risk, producers must emit
a reasoned unknown hash, such as `redacted` or `private-only`. Version 1 does not
publish raw artifact or raw segment integrity digests. Schema validation cannot
prove whether an opaque ID or supplied hash was derived from secret material;
it cannot prevent a malicious producer from encoding secrets in permitted tokens.
Adapter privacy policy remains deferred. Private reference metadata does not prove
that bytes are retained, authentic, publicly inspectable, or correctly redacted.
Version 1 has no public verified status.

`NormalizedToolEvidenceSchema.parse` checks strict local shape and refinements.
`validateNormalizedToolEvidence` first parses and then checks internal identity,
uniqueness, references, provenance/channel compatibility, capture/availability
consistency, and supplied chronology. It accepts no raw scenario result or oracle
evaluation context and performs no filesystem, environment, clock, process, URL,
or external-registry access. Unknown order stays unknown; array position is not
chronology. Known attempt/completion endpoints are checked even when an intermediate
start position is unknown. Workspace pre-action points are compared with every
applicable known attempt, start, block, and completion boundary. Equal sequence
values identify a shared observation batch: they are not reversed order and do
not establish strict precedence. Timestamps may still order points within a batch.
Absence of a chronology conflict does not prove sufficient pre-action evidence;
that support judgment is deferred. Different claims and independent observations
may disagree.

Public token patterns require absolute end of input, including source-run and
SHA-256 tokens. Timestamps require exact UTC millisecond syntax and a finite,
round-tripping calendar value. Public version tokens exclude both slash forms;
an interpreter unable to supply a safe identifier must emit a reasoned unknown
version rather than copy a path or version-command output.

The exported diagnostic issue schema and validator share the closed
`DiagnosticPathKeySchema`; indexes must be nonnegative safe integers.
Diagnostics contain only fixed codes and schema paths, sorted and deduplicated;
rejected values, unknown property names, and exception messages are not returned.
Use this validator when diagnostics may be exposed publicly: direct Zod errors
are ordinary validation errors and are not the sanitized diagnostic API.

Accident-reference resolution, tool-attempt validity, ToolScore support validation,
manual reviews, required-input rubrics, scoring, real adapters, raw-artifact
persistence, private access authorization, redaction implementation, and rendering
remain deferred. A valid normalized bundle establishes internal consistency only.

## Documented limits (known, from Step 1.3 findings and reasoning)

- **Outside-project writes** are only caught if the path is on the watch
  list; anything else is invisible to twin, same gap AgentTX had on S9.
- **Symlinks pointing outside the project** may not clone correctly and
  need explicit handling or an explicit "not supported" note.
- **Absolute paths baked into files** (e.g. Python virtualenvs) can break
  once the clone lives at a different path.
- **Concurrent mutation of Twin-owned temporary roots** is unsupported.
  Path and identity checks validate filesystem state at specific moments;
  Twin does not pin filesystem objects against concurrent same-user
  replacement. A clone is still not an OS sandbox.
- **An agent that resolves the real project's absolute path** (rather than
  operating relative to its working directory) can write outside the clone
  entirely, bypassing isolation. This is a fundamental limit of process-level
  isolation without OS sandboxing, and the README states plainly: a clone is
  not a sandbox.

## Windows / WSL2

Development and all testing happen inside WSL2 (Ubuntu, ext4). ext4 has no
reflink, so the plain-copy fallback is the default and only path exercised
locally; the reflink/copy-on-write path is planned for implementation and
future verification in CI on a macOS runner. Native Windows is out of scope
for v1.
