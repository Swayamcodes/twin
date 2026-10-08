# twin — ARCHITECTURE.md

## Separate fixed-action Phase 2 comparison result

`packages/scenarios/src/comparison-{actions,runner,result,entry}.ts` produce
a separate version-one 39-row Twin/AgentTX/plain-Git comparison. It leaves
the frozen retained `ToolScore`, S8/S9/S13 result and combined Twin S12/S6
contracts unchanged. Each row carries a public scenario/tool identity,
observed action/recovery/compatibility dispositions, closed target and report
observations, and five independently reasoned fields with row-local evidence
references to named sanitized fields; unresolved references are rejected.
Action output is separate from tool reporting: plain Git S6 removal text
does not earn reporting credit. A `blocked` score requires observed prevention
before the fixed action starts; policy metadata and a null exit alone leave it
unknown. AgentTX S6's five fields remain unknown without equivalent deletion
preconditions. The producer runs only fixed scenario actions in freshly owned
disposable roots; AgentTX 0.3.0 uses a fake HOME/store and documented commands.
Plain Git's sole recovery recipe is `git restore --source=HEAD --worktree -- .`
inside its disposable repository. Harness teardown is excluded from all
recovery assessments. JSON and Markdown deliberately omit raw output, private
paths, secret bytes and environment values. Documentation accuracy and
continuous preservation remain unknown without supporting observations.

## Retained fixed Twin S8/S13 measurement (Phase 2)

The scenarios package has a separate version-one S8/S13 result path. It uses the
committed proof actions and fresh disposable originals: S8 has no Git repository;
S13 uses the existing fixed Git fixture and verifies ignored input bytes in the
returned Twin copy before the action reads them. The producer records complete
relative-path inventories, bounded action streams, direct-child disposition,
the Twin receipt separately from action output, and four root dispositions.
It reopens a private bounded evidence artifact before removing the original and
support roots. Incomplete settlement or uncertain authority yields an incomplete
result and retains still-owned roots; an artifact failure may leave an unknown
private artifact directory. Same-user mutation races and descendants are not
contained by this fixed-action path.

The new strict five-field result does not reinterpret the frozen S12/S6
`ToolScore` or change their combined Twin-only report. S8 receipt evidence may
support reporting of the copied target deletion. S13's read-only action makes
no file change, and no read-reporting claim is inferred. Original endpoint
equality does not establish continuous preservation or recovery. Neither
AgentTX nor plain Git gets a five-field score from this path.

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
cli/ # manual command parsing and PATH resolution — thin wrapper over core
scenarios/ # bad-agent scripts + scoring harness + adapters
web/ # landing + results viewer; production export in packages/web/out
pnpm-workspace.yaml


`core` has no dependency on `cli` or `scenarios`. `cli` and `scenarios` both
depend on `core`. This is so the suite (Phase 2) can run standalone against
`core`'s clone/diff logic without needing the full CLI, and so `core` stays
testable in isolation.

## `core` responsibilities

- **Clone**: copy a project directory to a scratch location using ordinary
  independent file reads and writes, preserving supported modes and accepted
  relative symlinks and remapping accepted absolute source links. There is no implemented reflink/copy-on-write selection. Includes
  files git ignores and works in directories with no git repository at all.
- **Manifest / diff**: inventory project files before and after the run (not
  git) and compare their recorded state, subject to scan coverage and limits.
  Tracked/untracked/ignored/non-git files use the same comparison. Git is used
  only to *label* each path as tracked, untracked, or ignored — never to decide
  what gets copied or diffed. Reads and writes reverted within the run that
  leave no net difference are unobserved; there is no live access history.
- **Receipt**: turn the diff into a structured report — files
  added/changed/removed (with their git-category label), dependency
  changes, leftover processes, and a watch-list report for paths outside
  the project (reported, not recovered, in v1).
- **Apply**: a three-way, conflict-safe merge using (a) the file's state at
  clone time, (b) its current state in the real project (in case you
  changed something while the agent ran), and (c) the clone's result. Two
  states (before/after) can't detect "you also touched this file
  meanwhile" — three can.

## Phase 5 apply boundary

`TwinSession.apply()` is available after a settled run. Creation records
original and copy inventories; apply requires complete coverage, rechecks the
settled copy, scans the current original, and plans all copy changes before
writing. Matching original changes are no-ops. A conflicting path, incomplete
inventory, unsupported symlink change, changed copy, or changed original root refuses the whole
plan. Files, modes, deletions, and
directory/file transitions use the same inventory for Git, ignored, and non-Git
projects. `twin run --review -- ...` prints the existing receipt, then accepts
`apply` or `discard` on stdin within that same process. Other responses retain
the copy and print its location and manual-inspection instructions. EOF and
interruption also retain it. Default `run` still discards. See the [CLI usage
flow](docs/cli-usage.md).

## Unreleased bounded startup I/O

`core/src/io-pool.ts` provides a private session-owned coordinator shared by copy
and manifest jobs. It permits four active jobs and eight queued
jobs. Each serial producer keeps at most twelve admitted but uncommitted outcomes,
including completed results, and one admission waiter per operation. Ordered
commit prevents a delayed oldest result from accumulating unbounded later
results. Workers do not acquire another permit or await descendants. Standalone
walks use a local coordinator; independent Git/watch/dependency observations are
outside this filesystem-job cap. No ambient pool or threadpool setting is changed.

Final preparation link reconciliation instead creates one private eight-worker
coordinator shared by its two complete root walks. Its queue remains eight jobs;
each operation retains at most twelve outcomes and one admission waiter. Across
both walks there can be at most sixteen active/queued jobs and twenty-four retained
outcomes. Default standalone walks and Apply retain four workers. Every per-job
ancestor check remains fresh and serial; only cross-job interleaving changes.
Both walks drain before reconciliation returns or guarded cleanup begins.

Copy admission remains serial for entry kinds, Git policy and link remapping.
Ordinary files use pinned `O_NOFOLLOW` inputs, exclusive destinations, complete
buffered writes and before/opened/post-read/source-path identity, size, mode and
time checks. Detected changes reject creation. `.git/config` validation remains
serial and copies the validated bounded bytes without a second data read.
Directories remain 0700 through all admitted file work, then ordinary modes are
restored in postorder. Native copying, reflinks and writable hard links are not
implemented. First failure/cancellation stops admissions; all workers and handles
settle before copy throws and guarded root cleanup begins.

Manifest work coordinates metadata and file reads in bounded stages. Hash-byte
reservations are admitted in discovery order before worker admission; successful
complete hashes commit bytes, while failed or incomplete work releases its
reservation. A later path waits for outstanding reservations before a hash-limit
decision. Committed plus reserved bytes cannot exceed 2 GiB. Growing, shrinking,
interrupted and incomplete reads receive no digest. This is an accepted-hash
allowance, not a total I/O-byte cap. Time budgets include queue waits; each fresh
inventory still receives its own deadline.

`captureManifestViews` obtains one fresh full inventory with all directories and
07777 modes, then projects receipt and apply views without changing coverage or
issues. Receipt retains non-directories and `.git` directories; apply retains all
directories with 0777 modes. The legacy `captureManifest` views remain supported.
Creation first settles Git/watch/dependency observations, then scans the original
apply baseline, then one full copy baseline for both views, then freshly reconciles
links. The receipt file baseline is deliberately later than before this checkpoint.
After command settlement one fresh copy scan supplies receipt-after and settled
apply views alongside the other observers. Observers have distinct non-atomic
intervals. Original inventories, later apply scans and per-path verification remain
independent fresh reads; no copy-time hash or cached baseline replaces them.

Link discovery retains every ancestor and directory pre/post identity check while
coordinating independent entry jobs. Both root walks share a coordinator and settle
before reconciliation returns. Apply's link phases use a function-local shared
coordinator and remain separate from its fresh scans. Preparation/copy checks
cancellation between traversal and transfer operations, but cannot interrupt a
pending native call. Limits, raw link validation, original link text and guarded
non-dereferencing cleanup remain unchanged. Same-user races and non-atomic apply
remain limitations; no real-repository performance guarantee follows.

Fresh S12/S6/S8S13 execution fingerprints include `io-pool.js`; previously retained
fingerprints and frozen evidence contracts are unchanged.

## Unreleased contained-link preparation and apply

`core/src/symlink-policy.ts` validates raw target bytes without dereferencing
targets. Relative targets retain exact bytes, but parent components are accepted
only in their initial prefix and cannot climb above the physical source parent
depth. `alias/../outside` is rejected even if lexical normalization is inside.
Absolute targets must use the canonical source-root component prefix with no dot
components; outside aliases and double-leading slashes are refused. Accepted
absolute targets become relative links to corresponding copy locations, retaining
trailing-slash directory semantics. Dangling targets, chains and cycles need no
target resolution. This structural rule contains expansion of the accepted links
in a stationary captured tree; arbitrary caller suffixes, agent-created links and
same-user replacements remain outside that guarantee. It is not an OS sandbox.
Relative Git `core.worktree` receives the same parent-prefix restriction; all other
Git metadata restrictions remain, and metadata is never rewritten.

Copy records a private ledger of original/copied raw text, digests, modes and
identities separately. Raw manifests are unchanged. After baseline captures,
complete link-set reconciliation and source/scratch identity checks occur inside
guarded preparation cleanup. Apply validates raw manifest link sets and ledger
identities before excluding verified unchanged link keys from its file delta.
Original links must retain original text; copies must retain expected copied text.
Any added, removed, retargeted or replaced link, including a directory transition
removing a baseline link, refuses preflight. Remapping predates receipt baselines
and is not reported as command activity. Later link changes remain reportable.
Apply never mutates link objects or writes through them: alias edits are observed
and applied at the physical ordinary file path.

Full link sets are reconciled at creation, apply preflight, before the first write,
and after writes. Each file mutation checks ordinary ancestor identities in both
trees; sibling cleanup also refuses substituted parents. A detected late link
change returns partial-application failure and retains the copy. These checks are
not atomic against same-user mutation. Discovery counts all visited entries,
with limits of 100,000 entries, depth 128, 4,096-byte relative paths and original or
emitted targets. Non-UTF-8 source names and NUL targets are refused; relative target
bytes need not be UTF-8. Native `readdir` allocation and individual I/O duration
are not hard-bounded. Existing manifest time/hash limits can still refuse apply.

CLI preparation errors use fixed-field, cycle-aware cause inspection, capped at
four nodes and 512 UTF-8 bytes including markers and newline. Messages/paths are
local disclosures, escaped rather than secret-redacted. Receipts, raw child output,
postlaunch error disclosure and public APIs are unchanged.

Before each mutation, apply rechecks root authority and the relevant path. File
content is copied to a new sibling and renamed after another path check. These
checks narrow ordinary races but cannot make a check-and-rename atomic against a
concurrent writer with the same permissions. Applying a multi-path plan is not
atomic: I/O failure may leave earlier paths changed. A failure retains the copy
for inspection. Running descendants that escape the observed process group are
outside the command settlement claim. No rollback of outside-project changes is
provided. Review mode retains the copy on an interrupted or uncertain run; its
printed location is for manual inspection, and there is no cross-process apply
command or persistent session authority.

Future work beyond the accepted Phase 5 scope includes a durable reviewed-session
handoff if apply/discard must happen in a later CLI invocation, and an OS-backed
conditional replacement primitive if stronger same-user race guarantees or
all-path atomicity are required. Current apply does not retry or roll back a
partly written plan.

## v1 agent compatibility boundary

Codex CLI and Claude Code are the required v1 plain-command compatibility
checkpoints. OpenCode, Aider, Gemini CLI, and Cursor CLI are deferred and are
not Phase 5 acceptance requirements. The CLI launches a selected executable
inside Twin's copy; vendor-specific adapters belong only where an observed
defect calls for one. A blocked real-agent check remains unverified.

Cursor documents a [headless CLI](https://cursor.com/docs/cli/headless) that
runs from a terminal, so the plain-command architecture does not exclude it.
Its checkpoint is deferred for setup cost. An editor integration that changes
the original project in place is a different execution path and does not get
Twin's copy and apply/discard behavior simply because the editor also offers
a CLI.

The [v1 compatibility matrix](docs/compatibility-matrix.md) distinguishes
Codex's tested `codex exec` behavior from Claude's billing-blocked model work.
The funded Claude rerun is on indefinite hold for budget reasons. It is an
optional follow-up, not a Phase 5 prerequisite; the unverified model-backed
cells stay unverified. The [Phase 5 acceptance review](docs/phase-5-acceptance.md)
records the final v1 decision.

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
reflink. Ordinary independent file copying is the only implemented strategy;
the reflink/copy-on-write path is planned for implementation and
future verification in CI on a macOS runner. Native Windows is out of scope
for v1.

## Early Phase 3.0 — minimal Twin core

The dependency-free core now exposes `createTwin({ sourceDirectory, scratchParent })`,
which returns a fully copied session with `workspacePath`, `run`, `inspect` and
explicit guarded `discard`. Five production modules implement ordinary independent
file copies, lexically in-tree relative symlinks, conservative self-contained Git
layout checks, bounded output/timeout, POSIX process-group settlement for ordinary
descendants, and in-memory cleanup authority.
The Git checks conservatively refuse root/nested bare inventories and noncanonical
case variants of reserved metadata names; they are not a general Git parser or
complete filesystem alias detector. Execution locks before caller-controlled input
access and validates a single independent command snapshot. Invalid input, including
sparse argv and throwing accessors, restores ready without consuming execution.
Explicit listener disposal preserves only necessary late-settlement handlers.
Copy failure returns no session. A settled direct child alone no longer permits
discard when its process group or captured pipes remain open. Process groups do
not contain descendants that create a new session. The marker lives outside the
command workspace;
cleanup never traverses symlinks and refuses missing or replaced authority.

The initial Phase 3.0 slice has since gained a bounded file manifest, a minimal
file/watch receipt, and a public CLI with captured and inherited stdio. Apply,
reflink/CoW, full dependency and process reporting, and complete descendant
discovery remain open. It does not change the frozen scenario/evidence contracts.
The receipt now uses schema version 2 to add root-level project dependency
observations. It compares `package.json` declaration strings in the four npm
dependency fields and hashes supported lockfiles (`package-lock.json`,
`npm-shrinkwrap.json`, `pnpm-lock.yaml`) separately. Each input is capped at
1 MiB, with a 4 MiB aggregate cap; regular files are opened without following
symlinks and checked for identity before and after reading. The existing root
authority check runs before each dependency capture. The CLI's byte framing
remains `TWIN-RECEIPT/1`; the JSON payload carries `schemaVersion: 2`. Missing
or invalid `package.json`, malformed or unreadable lockfiles, and a lockfile
removed during the run produce explicit incomplete coverage and issues. A
missing lockfile on both sides is an ordinary absence. The pnpm check validates
only its version header; lockfile changes are whole-file digests, not resolved
package diffs. Installed packages are explicitly unobserved. Nested workspace
manifests, Yarn/Bun/Python manifests, and global packages remain outside this
checkpoint.

Phase 4 adds `globalNpm` to receipt schema version 3, leaving the CLI's
`TWIN-RECEIPT/1` byte frame intact. The observation uses the admitted command's
explicit `NPM_CONFIG_PREFIX` or `npm_config_prefix` and reads only
`<prefix>/lib/node_modules` on POSIX. It captures package `name` and `version`
metadata, separate from project declarations and lockfile digests. Missing,
conflicting or overridden prefixes yield unavailable coverage; incomplete
inventory never yields an empty clean comparison. See
[global npm observation](docs/phase-4-global-npm.md) for limits. Frozen Phase 2
results remain historical measurements and are not rescored by this receipt.

The next Phase 4 slice adds one top-level command report in receipt schema
version 4. It derives admission from the validated command snapshot and process
start/disposition from the existing runner result. Executable disclosure is an
allowlisted basename; arguments and environment values are omitted. The report
states that nested commands are unobserved. The CLI frame remains
`TWIN-RECEIPT/1`; historical Phase 2 results and frozen score contracts are
unchanged. See [command report](docs/phase-4-commands.md).

Receipt schema version 5 adds bounded lifecycle observations from the same
runner launch, group probes and termination path. It records direct-child
settlement, group presence after direct-child exit, attempted signal delivery,
final group status and captured pipe status. Group absence covers only the
original process group; unreadable checks remain unknown. The CLI frame and
existing discard gates remain unchanged. See [process report](docs/phase-4-processes.md).

The CLI now selects a bounded human receipt only with `--receipt=text` before
`--`; its default schema-5 JSON frame and consumers are unchanged. Rendering
uses the existing receipt and marks incomplete coverage without a clean claim.
See [presentation](docs/phase-4-presentation.md). The planned receipt
checkpoint is closed against the approved before/after observation scope in
the [Phase 4 acceptance review](docs/phase-4-acceptance.md).

Current S11 process testing now waits for an owned worker marker that records
the action's process group, then checks that Twin settles and terminates that
group before discard. Any later harness signal is cleanup only and earns no
Twin recovery credit. The earlier published S11 measurement records its own
observed attempt and is unchanged by this current test reconciliation.
A clone is not an OS sandbox. See [minimal core](docs/phase-3-minimal-core.md) for
the public lifecycle, exact symlink/Git boundaries, execution limits and current
acceptance status.

## 2.6R-1 — first retained Twin S12 score

The S12-only scenario producer runs one fresh direct reference accident and one
separate Twin attempt. A valid eligible direct reference uses the existing
reference-only four-file capture. The Twin attempt uses a distinct private
`twin-s12-attempt` artifact with `identity.json`, `attempt.json`, `outcome.json`,
and a final `manifest.json`. Both must pass strict filesystem reopening before
the scorer uses them. Their identities and fixture roots remain separate.

The attempt record stores the truthful pre-publication artifact status `unknown`.
Only strict reopening establishes `retained` in the JSON result. The narrow
version-one score-support bridge resolves attempt-scoped facts and protocol
observations against the reopened attempt while leaving global `EvidenceRef`,
the oracle, normalized evidence, attempt protocol, and `ToolScore` unchanged.
For the successful S12 run, `blockedBeforeExecution` is `not-blocked` and
`workspaceUsable` is `usable`; recovery/preservation, reporting, and boundary
description remain `unknown`. The result is one strict JSON line; Markdown,
receipts, S6, other tools and further scenarios are outside this slice.

The two artifact formats verify local inventory, modes, sizes and digests. They
do not authenticate collection or provide crash-atomic multi-file publication.
This S12 result is not a Phase 2 completion claim.

### 2.6R-1 audit corrections

The S12 adapter freezes the semantic request before handing it to its fixed
Twin boundary. A private monotonic recorder captures offer, receipt, verified
workspace binding, native action dispatch, observed child start, settled result,
poststates and cleanup at their runtime points. Assembly of the attempt bundle
uses those captured positions and refuses a missing or duplicate required
event. The direct reference guard binds the first Git launch to one canonical
registered fixture workspace and rechecks the pinned compiled action through a
no-follow descriptor immediately before native forwarding.

Twin reopening returns a frozen property-free handle backed by module-private
storage. Copying or serializing the handle does not carry authority. A narrow
score projection returns a parsed attempt bundle, freshly derived protocol
result and bounded process facts without private command paths or streams. The
private artifact binds the observed execution workspace and fixed action path
separately from the command record and reconciles them on reopening.

An internal per-allocation ledger records the direct runner fixture, Twin
original, support root and returned Twin session. Complete output requires a
removed disposition for each. An allocation whose authority cannot be safely
established remains unknown and forces incomplete output. Focused test teardown
uses its own registered artifact-parent authority, with no-follow child checks;
artifact IDs are verification data, not deletion authority. These checks remain
local integrity controls, without authentication or crash-atomic publication.

### 2.6R-1 registered-root admission and teardown correction

The direct S12 runner now supplies one frozen primitive attestation for the
fixture it registered and initialized, before any fixture command can launch.
The producer starts with no authorized direct cwd and arms its fixed command
guard only from that callback. Each direct Git command and the action must use
the attested canonical workspace and its still-matching directory and marker
identities. The attestation conveys identity only: the runner keeps its
`OwnedScenarioRoot` handle and uses that handle for cleanup even when the
observer refuses delivery. No registry listing or cleanup-by-path API is
exposed.

Focused test teardown reads artifact files only after no-follow descriptor
checks and records their identities before deletion. It rechecks those
identities before unlink or directory removal under its registered parent.
These checks do not eliminate a same-user swap between a final check and a
filesystem operation.

Artifact reopening establishes local structure, inventory, digest integrity
and cross-record consistency. A coherent rewrite of all private records and
their manifest can satisfy those checks; the format does not authenticate its
producer or original private paths. Decisive public score support resolves to
retained normalized facts and protocol observations, not private path strings.
External authentication and crash-atomic publication remain deferred.

## 2.6R-2 — retained Twin S6 score and current receipt reconciliation

The fixed S6 producer runs a fresh direct `git clean -fdx` reference and a
separate Twin attempt. Each complete run owns four disposable allocations:
direct fixture, Twin original, support root, and Twin root. The reference and
attempt are retained in distinct four-file artifacts and strictly reopened
before support is derived. The private attempt records exact action output,
original and Twin endpoint inventories, command binding, and cleanup. Complete
JSON requires all four allocations removed; retained artifacts are controlled
by the caller's separate artifact-parent authority.

Current core builds its receipt during `session.run()`. Each complete attempt
admits four ordered Git classification calls before the action and four after,
using only `/usr/bin/git`, the allocation-derived Twin workspace, core's fixed
argv, environment, timeout, buffer/encoding policy and `shell: false`. The
producer counts these eight calls separately from seven direct fixture setup
Git children, one direct `git clean`, seven Twin-original setup Git children,
and one Twin `git clean`: **24 Git children per complete S6 comparison**.
S12 uses the same current-core admission pattern; its complete path has 22 Git
children (seven direct setup, seven Twin-original setup, eight classification)
plus two Node action children. Both compiled fingerprints now cover the core
manifest, Git classification, watch and receipt modules and the shared private
four-file persistence helper, alongside their execution modules.

S6's five public outcomes are `unknown`, `unknown`, `not-blocked`, `usable`,
`unknown` in SPEC order. The two known outcomes resolve to reopened attempt
facts and observations. Git stdout is the action's output, not Twin reporting;
the core receipt is not retained as decisive report evidence. Equal endpoint
inventories do not prove continuous preservation, and discard is cleanup.
Local artifact integrity does not authenticate provenance or provide crash-atomic
publication; same-user filesystem races remain possible. This checkpoint does
not complete Phase 2 or general S6 scoring.

## 2.6R-3 — pure combined score projection

The combined score entry reads two already produced public JSON results through
bounded, no-follow regular-file descriptors. It decodes strict UTF-8, requires
the existing entries' compact single-line form, strictly parses both frozen
scenario result schemas, and checks nested and cross-result identities. Its pure
combiner emits only public retention identities, tool/adapter identities, and
the unchanged `ToolScore` for S12 then S6. Incomplete output contains only
version fields, status, and a closed reason code. No producer, root allocation,
artifact reopening, cleanup, or child process belongs to this Tier B boundary.
The saved input files and their public retained labels are not authenticated
provenance; the combiner cannot establish that artifacts still exist.

## 2.6R-4 — current Twin-only S12/S6 Markdown reader

The standalone Markdown entry opens one existing combined JSON file with
`O_NOFOLLOW`, checks a regular-file descriptor and an 8 MiB limit, decodes fatal
UTF-8, and requires a single object with one final LF. The pure renderer strictly
parses the committed combined schema, requires complete status and the current
closed S12/S6 outcome/reason pairs, then emits fixed sections in SPEC order.
Only public sanitized tool/adapter identities enter the output. Validation and
rendering finish before stdout is written; failures produce a closed stderr code.
This reader invokes no producer, process, root allocation or cleanup. The report
is current Twin-only evidence, not the final AgentTX/plain-Git comparison report.

## Per-inventory budgets and cooperative cancellation

Core normalizes and freezes `CreateTwinOptions.scanTimeoutMs` (default 30,000;
integer 1–3,600,000) and `scanSignal` before allocation. Every production
`captureManifest` caller, including apply parent inventories, receives that
policy. Each call creates a fresh `performance.now()` deadline. Command timeout
and interruption remain independent core options; CLI forwards its existing
interruption signal to both command and scan cancellation.

The scanner checks termination around awaited operations and before
claiming completion. It closes file descriptors and performs post-read identity
checks even after interrupted reads. Only confirmed identity/metadata changes
produce `entry-changed-during-scan`; termination and unchanged short EOF have
separate closed reasons. Coverage limits, byte-safe paths, no-follow reads,
fresh hashes, symlink policy and `.git` handling remain intact. The bounded startup
coordinator and fresh dual views above preserve these reliability requirements.

Preparation settles all started observers before guarded cleanup. Cancellation
may wait for copying, link discovery, other observers and native operations.
Session run checks cancellation before handoff and marks the child unsettled
only when handing it to the runner. Apply keeps all raw coverage and link
reconciliation guards, checks cancellation before mutation attempts, and records
possible partial application after any issued original mutation (including
temporary sibling open). Guarded temporary cleanup and discard still run when
the scan signal is aborted.

Budgets apply separately to each inventory, not the whole run; larger budgets
can multiply total waiting time. Incomplete preparation baselines still forbid
apply. This is an interim reliability checkpoint, not evidence of acceptable
real-repository performance, universal project compatibility or an OS sandbox.
Prizzle's DrvFS timeout remains a separate unresolved issue.

## Unreleased affected-path coordinator

The existing whole-tree `apply.ts` and full inventory `manifest.ts` remain
unchanged. `apply-affected.ts` is a separate coordinator exposed only through
`TwinSession.applyAffected()`; `apply-affected-observer.ts` performs bounded fresh
physical path checks and required destructive-subtree observations. Both methods
share the session applying lock and existing settlement/admission gates.

Private complete B/Bc/F Apply snapshots freeze the nonlink delta D in memory.
Unfiltered historical symlink sets pass the existing ledger policy before
exclusion; these snapshots project modes to 0777, while fresh reads require full
raw stat stability. Ordinary ancestors are checked directly rather than scanning
siblings. Directory removal/type replacement additionally observes complete
original destructive subtrees S. Every no-op remains in D and final verification.
No later copy delta is discovered. Three-way C==F no-op / C==B apply / otherwise
conflict admits all planned operations before any write. Preflight, before-write,
each mutation/transfer boundary and final verification use fresh observations.

The observer uses the private four-worker/eight-queue/twelve-result limits,
per-observation configured monotonic deadlines, 100,000 unique entries, 2 GiB
accepted hash bytes, depth 128 and 4,096-byte paths. Partial EOF, raw metadata
changes, unreadable paths and termination cannot produce confirmed digests.
Started work drains and descriptors close before cleanup. Each original mutation
attempt flips one irreversible attempt flag before its syscall. All subsequent
failures, including cleanup, become failed/partial results; cleanup cannot replace
a primary transfer/verification error. File writes use exclusive independent
0600 siblings, descriptor-derived identity pins and fresh guarded rename/cleanup;
never unlink a same-name replacement. Directory removals are nonrecursive.

Live global copy/original inventories and full link-set reconciliation are absent
from this coordinator. Its result explicitly disclaims unrelated rechecking.
Scoped unsafe targets or ancestors still refuse/fail, and required destructive
children cannot be skipped. Existing same-user check/syscall races and non-atomic
multi-path application remain. This is a deliberate safety-contract alternative,
not an optimization of whole-tree Apply or an OS sandbox.

The CLI parses scope only from this invocation, requires literal --review,
rejects invalid/duplicate options before allocation and selects the new method
only after an explicit Apply choice. It prints the narrower contract before
review and a separate scope-bearing Apply result. Command receipt schema 5,
renderers and framing remain unchanged. Fresh S12/S6/S8S13 core fingerprints add
both new runtime modules; retained fingerprints and evidence stay frozen.
