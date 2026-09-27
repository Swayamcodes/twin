# twin — ARCHITECTURE.md

## Offline retained-capture foundation (Phase 2 Step 2.5c-1)

Internal `scenarios/src/capture/{records,project,artifact}.ts` modules add bounded
private records, pure projection, and offline four-file retention. They are not
public package exports. The format and exact limits are documented in
[retained-s12-capture.md](docs/retained-s12-capture.md).

Version-one artifacts contain only `reservation.json`, `capture.json`, `outcome.json`,
and a final `manifest.json`. Directories/files use private modes and exclusive
creation, complete writes, file sync, and supported directory sync. Reopening checks
bounded sizes before parsing, exact inventory/digests, regular non-symlink objects,
versions, and ownership before reporting retention. This is not crash-atomic
multi-file publication or authenticated evidence. No default/user-state destination
or production cleanup is provided; the caller supplies a private destination.
The parent must be an existing canonical absolute directory owned by the current
POSIX UID; unavailable UID support refuses operation. All four files and their
directory require UID ownership and restrictive modes. Same-user ancestor
replacement/TOCTOU remains outside these checks. Manifest kind and completeness
must agree with the capture/outcome. Persistence errors retain primary and close
failures in causal order; later prerequisite files stop after an earlier failure.

Reference-only records replay the oracle and return explicit attempt-not-started
disposition without a normalized attempt or bundle. Reference-plus-attempt records
preserve A/B identities and observations separately; clocks are never compared
across runs. Pure projection is retention-neutral and accepts no verification
capability. Only strict filesystem reopening reaches a non-exported retention
finalizer, bound to the exact four reopened files rather than an artifact ID.
Projection reevaluates the reference oracle and validates actual private
normalized/protocol evidence before sanitization. Unexpected known B content hashes
cause a closed projection refusal, never a weakened unknown verdict. Neither
envelope is an authoritative on-disk file. Raw paths, output, errors, and private integrity digests are
excluded from public projection. The writer returns a separate private locator
that must not be published with its path-free inspection result.

This advances only the offline persistence portion of the earlier deferrals below.
No scenario execution, real adapter, capture guard, CLI, preload, integration setup,
or automatic scorer is implemented. Step 2.5c-2 remains separately gated, and the
Step 2.6 scoring-reference compatibility boundary is unchanged. Only the artifact
test mutates exclusively registered, marker-checked disposable `twin-test-*` roots.
It resolves one canonical temporary base and rejects the repository and the complete
default `$HOME/.local/state/twin` and configured `$XDG_STATE_HOME/twin` state roots,
including all descendants, before allocation. Only `..` and `../` relative prefixes
indicate outside paths; descendant names such as `..capture-temp` remain excluded.
The guard checks supplied and canonical paths, then reuses one owned test parent
for allocation and leak accounting. These test exclusions create no storage default.
B streams retain canonical base64 bytes (65,536 decoded / 87,384 encoded maximum);
A raw strings remain unchanged. Incomplete diagnostics permit at most 16 closed
issues. Private B identities/references must be unique, owned and resolvable.

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

Step 2.5b below adds attempt protocol validation and supplied oracle resolution.
ToolScore support validation, manual reviews, required-input rubrics, scoring, real adapters, raw-artifact
persistence, private access authorization, redaction implementation, and rendering
remain deferred. A valid normalized bundle establishes internal consistency only.

## Tool-attempt protocol (Phase 2 Step 2.5b)

The separate version-1 `ToolAttemptBundle` combines a semantic request, unchanged
normalized evidence, optional supplied reference and same-execution oracles, and
independent protocol observations. `validateToolAttemptBundle(input: unknown)` is
pure, deterministic, nonthrowing, and non-mutating. It does not execute a tool or
read a filesystem, process, clock, environment, or external registry. It checks
supplied records, not their authenticity. The contract is exported through the
existing `@twin-cli/scenarios/contract` entry point.

Three concepts remain distinct: `OracleResult.validity` establishes whether a
direct reference accident met its specification; normalized validation establishes
internal coherence; `attemptValidity` establishes whether the tool received a
legitimate, sufficiently observed attempt. A blocked action and a started action
can both qualify. None of these fields is a safety verdict or ToolScore dimension.

Attempt validity reduces only the twelve intrinsic checks: normalized consistency,
identities, request identity, fixture baseline, workspace binding, tool opportunity,
action-boundary coverage, original coverage, execution-workspace coverage, report
metadata, ordering, and bundle relationships. Any failure yields `invalid`;
otherwise an unknown yields `indeterminate`; otherwise the attempt is `valid`.
All independently decidable checks remain visible, including unknown checks when
another check fails. Reference-link-only normalized diagnostics are assigned to
reference resolution, not intrinsic normalized consistency; the existing standalone
normalized validator is unchanged.

`referenceResolution`, `referenceEligibility`, and `sameExecutionAttachment` never
reduce attempt validity. Missing or unresolved references, wrong scenario/source
attachments, and invalid/ineligible reference accidents make `scoreReadiness`
`not-ready` without rewriting the observed attempt. A matching indeterminate
reference has unknown eligibility. `ready` requires a valid attempt, a resolved
valid eligible reference, and consistent attachment of any supplied same-execution
oracle. Absence of that optional oracle passes the attachment check as absence,
not as resolved evidence. Its accident verdict does not gate readiness: a valid
blocked attempt can have an invalid same-execution accident verdict.

Intrinsic `SourceBindingObservation` contradictions, request/run substitutions,
and observation ownership conflicts can fail `bundleRelationships`. An incorrectly
attached oracle cannot. Resolution compares supplied scenario, source-run ID, and
oracle version; it does not authenticate a capture or re-evaluate raw accidents.
Malformed nested normalized or oracle objects produce input issues and no protocol
result. Version 1 is the only supported oracle version, so an unsupported version
is an input failure, not a semantic attachment verdict.

### Request and tool boundary

S12 request version 1 means exclusive creation of semantic path `control` with
the pinned bytes `S12 control file.\n`, for a harmless control purpose. S6 means
the exact intended Git operation `git clean -fdx` at the execution-workspace root,
with no extra pathspec, redirect, dry-run option, or alternate command. Public
requests contain semantic identities only. Concrete executable locations, argv,
cwd, and S12 script bindings remain private. Independent boundary observations
record whether their binding matches, with observer-segment references.

`ToolBoundaryObservation` records tool and adapter versions, request delivery,
route, response, wrapper launch, complete/partial observation coverage, and the
intended-action execution-fact reference. Wrapper startup is not intended-action
startup. Nonzero exit or launch failure is not a policy block. Failure before
delivery denies a real opportunity; unknown delivery is indeterminate. A known
operational failure after receipt may still be a valid observed attempt.
Existing execution `attemptedAt` identifies intended-action dispatch, not wrapper
startup or request receipt. Unknown required identity/version evidence remains
unknown rather than being copied from unsafe command output.
Tool and adapter names are compared independently of version availability.
Different known versions fail identity checks; an unknown version on either side
leaves required version evidence unknown. Different unknown reason codes are not
identity contradictions, and an unknown version cannot conceal a name mismatch.

### Fixture and observation coverage

Both scenarios require all six original regular files to match independently
pinned bytes, sizes, and hashes before the tool can prepare its workspace, with
`control` absent. The three tracked inputs are notes, app, and gitignore; scratch
is untracked; env and dependency are ignored. The original must be a local
non-bare repository at the expected root with the baseline commit, matching index
and tracked working tree, and no additional working-tree entries outside repository
metadata. Setup observations record these conditions independently; they do not
require installation paths, network remotes, or identical commit IDs across runs.

`WorkspaceBindingObservation` identifies the original and execution workspace as
the same workspace or a distinct tool-prepared workspace. Evaluator-prepared
replacement workspaces do not qualify for this protocol. A tool's omission of
ignored files is observed behavior, not a defective original fixture. Protocol
validity does not award workspace usability. Git state of a tool-prepared workspace
must be observed but is not required to be successful as a tool outcome.

`WorkspaceStateObservation` remains in the attempt envelope, outside the unchanged
normalized fact union. It records path-keyed state, hash, size, classification,
workspace identity, stage, position, and independent filesystem provenance.
Original facts continue to describe only the protected original. Clone damage and
original observations therefore remain distinguishable. For the same run, request,
scenario, workspace, path, stage, and comparable matching point, known conflicting
state, hash, size, or Git classification is an intrinsic contradiction. Matching
points require at least one shared known coordinate and no differing shared known
coordinate. Unknown attribute/coordinate reasons are not compared as values.
Independent normalized workspace-input presence is reconciled with execution
workspace pre-state through the workspace binding: present agrees with file and
missing with absent. Unknown presence remains unknown; tool-claimed input facts
cannot independently establish or contradict that state. State observations do
not imply usability. An independent existing input contradicts workspace noncreation.

Required coverage includes seven original before/after states, seven execution
workspace before/after states, independent request/action boundaries, and reporting
inventory/capture metadata. Before-state fixture and existing execution-file hashes
must be known; after-state hashes may be reasoned unknown. Complete interpretation
or report bytes are not required: unavailable reporting can leave later dimensions
unknown. Tool claims cannot substitute for required independent observations.
Independent non-creation of a workspace following rejection/blocking is a specific
alternative to workspace snapshots, requiring a coherent tool-prepared-workspace
relationship and tool preparation responsibility. Noncreation cannot describe the
already existing original through a same-workspace relationship. Unknown relationship
or responsibility does not establish this alternative. Disappearance of an existing
workspace does not establish complete effects.

The reportingMetadata check also fails for reporting-specific internal normalized
inconsistencies in inventories, capture/interpretation, ownership, channels, and
segment relationships. General normalized issues remain under normalizedConsistency.
Honest partial or unavailable reporting is permitted; complete bytes and complete
interpretation are not prerequisites for a valid attempt.

Original baseline precedes request offering and preparation; execution pre-state
precedes intended-action dispatch and applicable milestones; request receipt does
not follow dispatch; settlement follows applicable action milestones; post-state
strictly follows settlement. Supplied known positions must be mutually coherent
and within known run bounds. Either timestamps or ordered sequences can establish
precedence. Equal sequence batches alone cannot establish strict precedence;
array order is never chronology. Matching endpoints do not establish preservation
or recovery, and there is no continuous-monitoring claim.
Ordering uses a fixed semantic graph and compares every applicable endpoint pair
in its transitive closure, even when intermediate coordinates are unknown. This
includes binding through execution pre-state, action milestones, settlement,
required post-state, and destructive cleanup, and the noncreation alternative
from settlement through noncreation evidence to cleanup. Baseline, setup, offering,
and receipt relationships participate in the same closure. Receipt precedes an
identified tool-prepared binding; a direct workspace may predate receipt. A path
requires strict precedence if any edge is strict. Equal coordinates establish only
non-strict relationships; insufficient coordinates remain unknown. Known reversals
and opposing timestamp/sequence directions fail without using array order.

Workspace state with stage `during` means a point collected during the tool-attempt
window, not during the inner-action execution interval. Offering must be at or
before the point, and the point at or before settlement. An identified execution
workspace's binding must also be at or before its during points. These explicit
graph points inherit setup/baseline precedence and strict precedence over destructive
cleanup through settlement. Equal batches satisfy the non-strict window/binding
bounds; insufficient comparable coordinates remain unknown and known reversals fail.
The stage imposes no ordering relative to attempted, started, blocked, or completed
milestones. Explicit coordinates remain available for later scoring.
Original-workspace during points are allowed in blocked attempts, including when
execution-workspace noncreation is established. Execution-workspace during points
require an identified, coherently owned execution workspace and contradict known
noncreation. Independent normalized original during points receive the same window
bounds. During evidence does not establish action start, preservation, recovery,
damage, or usability and does not replace required before/after observations.

Cleanup and artifact disposition remain separate operational metadata. Cleanup
failure after complete collection, retention for investigation, and private artifact
deletion after normalization do not rewrite behavior or prevent readiness. Removed
or failed cleanup must strictly follow required final observations, including a
noncreation binding used instead of workspace snapshots; proven premature cleanup
fails ordering, and unavailable required order is unknown. A crash without required
final observations is indeterminate. Segment metadata is not proof that private
bytes remain retained or publicly verifiable.

### References, diagnostics, and scoring compatibility

The scoped `AttemptEvidenceRefSchema` references requests, protocol observations,
protocol checks, disposition, run-scoped normalized records, and supplied oracle
identities. References use stable names, never array indexes. The evaluator emits
input-evidence references, not self-justifying check references. Reasons and
references are deduplicated and sorted by code-unit order; check order is fixed.
Input diagnostics have only a fixed code and an optional single approved envelope
field. Nested Zod paths, unknown property names, rejected values, raw oracle reasons,
and arbitrary exceptions are not returned. Direct schema parsing retains ordinary
Zod errors. Safe opaque tokens still cannot prevent a dishonest producer from
encoding undisclosed information or inventing observations.
The result schema rejects ownership contradictions in disposition and scoped
references unless identities explicitly fails with identity-mismatch and the
result is invalid/not-ready. An unrelated bundleRelationships failure cannot
substitute for this ownership-specific diagnosis. This rule preserves offending identities
in invalid evidence without accepting forged valid/ready results. It checks the
ownership fields present in the result, not the authenticity of referenced records.

Global `EvidenceRefSchema`, `OracleResult`, `NormalizedToolEvidence` v1, and
`ToolScoreSchema` are unchanged. Existing ToolScore references cannot establish
support from attempt observations. Step 2.6 must add a versioned score-support
bundle or ToolScore revision that cites normalized records, requests, tool-boundary
observations, original and execution-workspace states, and reference accident
evidence. Automatic scoring must not begin until that reference path exists.
Attempt references must not be added silently to global evidence references,
which would also admit inappropriate references into the oracle. Future
`ToolScore.oracleRunId` resolves to the eligible reference accident's `sourceRunId`.
Protocol readiness does not mean the existing score contract can express all
support, or that all five dimension outcomes are known.

### Future adapter sequence

The first retained offline capture in Step 2.5c is the **direct-baseline S12**
adapter. It must independently establish delivery through its evaluated boundary;
Git does not mediate control creation, and an unrelated Git command proves nothing
about delivery. **Plain-git S6** follows separately for the destructive action.
AgentTX and future Twin adapters must establish wrapper receipt, inner-action
boundaries, and the identity and state of their tool-prepared workspaces. These
are future requirements, not implementations or claims about current releases.
All protocol tests are frozen synthetic evidence; real adapters, retained capture
production, scoring, private persistence/redaction, and preservation proof remain
deferred.

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

## Early Phase 3.0 — minimal Twin core

The dependency-free core now exposes `createTwin({ sourceDirectory, scratchParent })`,
which returns a fully copied session with `workspacePath`, `run`, `inspect` and
explicit guarded `discard`. Five production modules implement ordinary independent
file copies, lexically in-tree relative symlinks, conservative self-contained Git
layout checks, bounded direct-child output/timeout, and in-memory cleanup authority.
The Git checks conservatively refuse root/nested bare inventories and noncanonical
case variants of reserved metadata names; they are not a general Git parser or
complete filesystem alias detector. Execution locks before caller-controlled input
access and validates a single independent command snapshot. Invalid input, including
sparse argv and throwing accessors, restores ready without consuming execution.
Explicit listener disposal preserves only necessary late-settlement handlers.
Copy failure returns no session. The marker lives outside the command workspace;
cleanup never traverses symlinks and refuses missing or replaced authority.

This early slice does not implement the planned reflink, manifest/diff, receipt,
apply, watch-list or descendant-process responsibilities above. It does not
integrate or change the frozen scenario/evidence contracts. A clone is not an OS
sandbox. See [minimal core](docs/phase-3-minimal-core.md) for the public lifecycle,
exact symlink/Git boundaries, timeout limits and focused verification history.
