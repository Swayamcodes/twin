# Phase 2 build log

This log separates observations made during manual verification from planned or
automated checks. The scenario runner currently emits raw command and filesystem
evidence; it does not calculate a safety score or perform recovery.

## Research that shaped the scenarios

The Step 1.3 AgentTX v0.3.0 investigation recorded in [SPEC.md](../SPEC.md)
found that clone isolation preserved the original repository during an S6-style
`git clean -fdx`, but its clone omitted ignored files. Its report could say
"0 files changed, LOW risk" even though those ignored files were unavailable
inside the clone. An outside-project dotfile write was neither detected nor
rolled back, and a directory without a Git repository could not be run. These
findings narrowed Twin's intended differentiator to ignored/non-Git coverage
and an accurate account of what was observed and what was outside the boundary.

The project boundary in SPEC and ARCHITECTURE is clone-and-run with an evidence-based
receipt, not an OS sandbox or a claim to recover every kind of damage. A filesystem
snapshot can reduce recovery risk while absolute/outside-project writes remain
outside that protection. The scope documentation is anchored by `50fad88`
(`docs: define twin scope and architecture`) and its clarification in `76dc74d`
(`docs: normalize line endings and clarify scope`); these commits record the
boundary, not the dates of the earlier research experiments.

## Step 2.1 scaffold and Step 2.2 runner checkpoint anchors

The first Git checkpoint is `4d09f95` (`scaffold: pnpm workspace, strict tsconfig,
AGENTS.md`). The architecture separates core, CLI, and scenarios, with core depending
on neither consumer. No separate scaffold verification count is recorded here.

`b6f2232` (`feat(scenarios): add guarded S12 and S6 fixture runner`) is the initial
guarded runner checkpoint. The manual chronology below distinguishes the S12 evidence
available before that commit from the S6 evidence collected afterward. The automated
regression hardening and its final 38-test verification belong to `93a90e5`
(`test(scenarios): harden destructive runner regression coverage`), not the initial
runner checkpoint; the later prerequisite/trusted-Git controls are described in
Step 2.3 below.

## Manual scenario verification and checkpoint

- S12, the harmless new-file control, passed manual verification. The
  checkpoint commit `b6f2232` was created **after S12 passed and before S6
  was executed**.
- An accidental `git clean -fdx` was run at the real repository root. It
  deleted untracked implementation files and ignored dependency/build
  directories. Those files were reconstructed from the active Codex session's
  implementation history. **Twin did not recover them.** The incident shows
  that uncommitted, untracked work is outside Git recovery. It is not evidence
  that Twin can restore a real repository after this command.
- S12 was successfully repeated after reconstruction.
- S6 was manually run successfully after `b6f2232` in
  `/tmp/twin-scenario-3qlMpf/workspace`, not in the real repository. It removed
  the fixture `.env`, `node_modules/`, and `scratch.txt`. The independent
  verifier confirmed that tracked fixture files stayed byte-identical, the
  ignored and untracked files became absent, cleanup removed the generated
  scenario root, `issues` was empty, and the real repository stayed clean.

No unretained file hashes, timestamps, or command transcript are inferred here.
The accidental repository-level `git clean` happened before the automated
protections described below existed.

## Step 2.3 implementation and verification

The regression suite uses Vitest 5.0.1 and strict test TypeScript compilation.
The package script compiles first, runs safety prerequisites in one Vitest
process, then starts the runner tests in a separate process only if the
prerequisites pass. A preload permits exact executable and full-argv vectors
for setup and the scenario-specific S12 or S6 action on the current
`child_process.spawn` route. Automated scenario tests require the canonical
`/usr/bin/git` on Linux or macOS: the Git file and every ancestor directory
through filesystem root must be owned by uid 0 and must not be group- or
world-writable. Unsupported layouts are refused. These checks are defense in
depth, not an OS sandbox.

Invalid-input tests exposed an environment in which `process.stdout` and
`process.stderr` acknowledged writes while emitting zero bytes; direct writes
to standard file descriptors worked. The CLI now writes explicit UTF-8 bytes
to fd 1 or fd 2, retries partial writes, and rejects zero progress or invalid
write counts. The tests retained their original usage-text assertion.

An initial independent safety audit found an overly permissive preload policy,
no guaranteed prerequisite ordering, Git selected from inherited `PATH`,
cleanup and leak-accounting gaps, and special filesystem types collapsed into
one category. Corrections added exact full-argv allowlists, scenario-specific
action permissions, trusted system-Git validation, a separate prerequisite
process, preserved cleanup-error aggregation, exact root leak accounting, and
distinct filesystem object types. The final independent audit verdict was
**SAFE TO RUN AUTOMATED S12/S6**.

In normal WSL, `pnpm run test:scenarios` completed successfully: the
prerequisite process passed 5 files and 35 tests; the runner process passed
1 file and 3 tests, for 6 files and 38 tests total. The automated runner
verified that extra arguments were rejected before allocation, S12 created
only its control file in a disposable workspace, and S6 removed only
disposable untracked and ignored files. Independent observations confirmed
tracked files remained unchanged. The real repository fingerprint remained
unchanged, generated scenario and test roots were removed, and
`pnpm-lock.yaml` remained unchanged. A post-run search found no
`twin-scenario-*` or `twin-test-*` roots under `/tmp`.

## Current boundaries and deferred work

The scenario root is a runner-generated direct child of the canonical OS
temporary directory, with a separate `workspace` child and an ownership marker
outside that workspace. Path, marker, and filesystem identity checks guard
against accidental misuse at validation time. They do not pin objects against
concurrent same-user replacement and are not an OS sandbox. The in-process
registry and test preload guard are also integrity/defense-in-depth measures,
not security boundaries. Native Windows remains out of scope; Linux, macOS,
and WSL2 are the target hosts.

The current runner covers only S12 and S6 and records raw before/after
observations, command evidence, issues, and cleanup outcomes. Recursive cleanup
is non-atomic: a failure after deletion begins can leave partial contents.
Process crashes can retain roots before they can be reported. The current
preload covers `child_process.spawn` only, and concurrent same-user replacement
is outside the test model. The trusted automated Git layout requires canonical
`/usr/bin/git` on Linux or macOS and safely refuses unsupported layouts.
Automatic recovery-tool scoring, recovery, adapters, watch lists, process monitoring, a general
manifest, and the clone/cage core are deferred. The tests do not claim to prove
race-proof containment or arbitrary future process-launch behavior, and they
do not make Twin an OS sandbox.

## Step 2.4: versioned oracle and scoring contract

Chronology note: the 71-test implementation run described later in this section
preceded the 84- and 101-test correction runs. The separately labeled final full
verification reached 104 tests. These are successive runs, not competing totals.
The committed checkpoint is `0c51b04` (`feat(scenarios): add versioned oracle and scoring contracts`).

Step 2.4 added a pure S12/S6 oracle and a separate dimension-specific
`ToolScore` schema. The oracle validates the existing raw `ScenarioRunResult`
shape at runtime, compares fixture observations against independently pinned
version-1 bytes, checks the intended command and operational errors, and
derives validity and score eligibility. Cleanup disposition remains separate.
Its `sourceRunId` hashes canonical raw evidence, including run-specific paths
and timestamps. The direct runner is still not Twin and still does not score
recovery tools. A successful S6 deletion is a valid accident, not a safety
pass.

The audit corrections make missing setup records unknown/indeterminate, while
recorded wrong or failed setup commands remain invalid. The strict version-1
evaluation context is scenario-discriminated and must match the raw run. S12
supplies nonblank expected executable and script-path strings, preserving
their exact values. S6 supplies no S12 identity. Context comes from the
interpreter of the captured run, not the evaluator's own process or
installation; it is not independent attestation of the binary executed. It is
excluded from `sourceRunId`, which identifies canonical raw evidence only.
Canonical string ordering uses JavaScript code units, not locale collation.
If cleanup names a different root, cleanup disposition is unknown without
changing semantic checks or validity. The oracle still sees only seven named
fixture paths. Semantic validity requires a syntactically absolute POSIX
scenario root and its exact workspace child under the supported POSIX, WSL,
and macOS model; this does not attest to filesystem existence, safety, or
provenance. Setup references identify exact command vectors regardless of
array position. Ambiguous duplicates do not resolve, and a `scenario-run`
reference names the complete enclosing raw result when no narrower reference
is truthful.
For these corrections, production no-emit typechecking, production compilation,
and test TypeScript compilation passed. The permitted prerequisite Vitest run
passed **7 files and 84 tests**. The runner tests and scenario actions were not
run for this correction pass.
Final correction verification passed production no-emit typechecking,
production compilation, and test TypeScript compilation. The same seven
permitted prerequisite files passed **101 tests**. No scenario runner test,
S12 action, S6 action, or complete package test script ran for these final
corrections.

The score contract records factual outcomes with reasons, typed references,
and evaluation methods. Structural validation enforces the version, outcome
vocabulary, required evidence, applicable rubric rules for `not-applicable`,
and manual-review references. It does not prove that future tool evidence
exists or supports a claim. A test-private synthetic registry exercises those
future cross-evidence rules without publishing an adapter format. Private raw
tool artifacts, normalized adapter evidence, adapters, automatic scoring,
redaction, renderers, and core integration remain deferred.

Verification in this implementation turn compiled the scenarios production
and test TypeScript projects. Static inspection found no runner, fixture,
child-process, or test-harness execution imports in the new tests. Only the
seven permitted prerequisite Vitest files ran: **7 files and 71 tests passed**.
`runner.test.ts`, S12, S6, and the complete `test:scenarios` script were not
run. The previously recorded 38-test result remains the Step 2.3 checkpoint,
not a claim about this turn's complete suite.

## Final Step 2.4 verification run

The production no-emit TypeScript check passed. `pnpm run test:scenarios`
completed successfully: the prerequisite process passed **7 files and 101
tests**, and the separately gated runner process passed **1 file and 3 tests**,
for **8 files and 104 tests total**. The runner cases verified extra-argument
rejection before allocation, S12, and S6.

`git diff --cached --check` passed, and `pnpm-lock.yaml` remained unchanged.
The post-run `/tmp` search printed no `twin-scenario-*` or `twin-test-*` roots.
Git status contained only the staged 11-file Step 2.4 slice. This verification
does not extend the oracle beyond its seven observed paths or establish
executable attestation, adapters, or automated tool scoring.

## Step 2.5a: normalized tool-evidence contract

Added strict version-1 normalized schemas and inferred types through the existing
side-effect-free `@twin-cli/scenarios/contract` export. The normalized envelope
records a tool attempt independently of accident-oracle validity. Reference
accident linkage may be declared or unknown with a reason; same-execution linkage
is additional evidence only. No raw scenario result, evaluation context, oracle
verdict, or tool-attempt result is required by normalized validation. A synthetic
blocked S6 attempt validates without a reference accident. Existing oracle and
ToolScore schemas and semantics were not modified.

The five fact variants cover original-state points, reported events, execution,
workspace inputs, and boundary observations. Capabilities remain outside the fact
union with capability identity only. Point observations do not establish never-lost
preservation or infer recovery from a final matching state. Provenance, reasoned
unknowns, channel applicability, capture completeness, interpretation completeness,
and evidence availability are explicit. Positive report mentions can survive
partial capture; unreported boundary assertions require complete applicable capture
and interpretation. No ToolScore outcomes are computed.

Public private-segment metadata is a flat artifact/segment registry without raw
output, excerpts, commands, paths, storage locations, or content digests. Resolving
metadata does not authenticate or expose private bytes. Private persistence,
redaction implementation, accident-reference resolution, attempt validity, support
validation, scoring, and all real adapters remain deferred.

The pure validator checks internal identities, uniqueness, references, provenance,
channel/completeness consistency, availability, and known chronology. It preserves
unknown evidence and returns sorted, deduplicated diagnostic codes and schema
paths without rejected values, unknown property names, or exception messages.

Verification in this turn:

- Inspected both new test files before execution. They import only Vitest and the
  public contract and contain no scenario, child-process, filesystem, adapter,
  runner, or harness calls. All evidence is frozen synthetic data.
- Production no-emit TypeScript checking passed.
- Production TypeScript compilation passed.
- Test TypeScript compilation passed.
- The explicitly selected two-file Vitest run passed **2 files and 73 tests**.
  Tests include blocked S6 with unknown accident linkage, reference integrity,
  strict shapes, point-observation limits, capture/interpretation consistency,
  chronology, provenance, deterministic immutable validation, and secret-safe
  diagnostics. No test-private scorer was added.

The package script adds only the two synthetic files to its prerequisite process;
runner tests retain their separate process after the existing barrier. The complete
prerequisite suite, package script, runner tests, scenarios, tool adapters, and
compiled scenario CLI were not run. No dependencies were installed and no commit
or push was performed.

Final repository checks: `git diff --check` and the lockfile-only diff check
passed. Git status listed exactly the eight approved files (four modified and
four new), with no staged changes. Dependencies and `pnpm-lock.yaml` were unchanged.

## Step 2.5a audit corrections

Checkpoint clarification: the preceding statement "no staged changes" describes
the original implementation turn, before the user staged its eight-file slice.
That staged slice was preserved during this correction turn. These corrections
were applied as unstaged working-tree changes; no staging or unstaging occurred.

Tool-output interpretation provenance now checks every referenced segment across
all five fact kinds against matching, inventory-owned report-capture metadata.
Capture and interpretation must each be partial or complete; unknown/unavailable
capture and unknown/not-performed interpretation cannot support an interpreted
fact. Complete interpretation still requires complete capture. Positive reporting
boundary evidence must name a capture used by its provenance. The stronger global
completeness requirement for unreported boundaries remains unchanged.

Execution chronology includes the direct attempt-to-completion comparison even
when start position is unknown. Workspace pre-action observations are compared
with every applicable known attempt, start, block, and completion boundary.
Equal sequence values are a shared batch, not reversed order or proof of strict
precedence. Unknown intermediate evidence cannot conceal contradictory known
endpoints, while internally coherent incomplete ordering remains representable.

Public token regexes now use absolute end-of-input assertions, including shared
source-run and SHA-256 schemas. Timestamp validation requires exact UTC millisecond
syntax, a finite epoch, and calendar round-tripping. Public version identifiers
exclude both forward and backward slashes; unsafe version output must become a
reasoned unknown. The exported diagnostic issue schema and the validator share
one closed property-key vocabulary and nonnegative safe numeric indexes.

Public normalized evidence may contain an original-state file-content SHA-256
when the producer determines disclosure is appropriate. Producers must use a
reasoned unknown hash such as redacted or private-only for secret-bearing content
where a public digest creates disclosure or guessing risk. Version 1 publishes
no raw artifact or raw segment integrity digests. Schema validation cannot prove
whether an opaque ID or supplied hash derives from secret material, or prevent a
malicious producer from encoding secrets in permitted tokens. Adapter privacy
policy remains deferred.

Focused verification performed during this correction turn:

- Inspected both normalized test files before execution; their imports and test
  bodies cannot invoke scenarios, child commands, Git, AgentTX, Twin, filesystem
  mutation, or destructive helpers. Inputs remain frozen synthetic evidence.
- Production no-emit TypeScript checking and production compilation passed.
- Test TypeScript compilation passed, including after the final test correction.
- The initial focused run passed 129 tests and exposed one assertion assuming
  only one Zod issue for an unsafe integer. The test was corrected to require
  every issue to identify the same exact intended path, allowing duplicate checks
  at that location. No production rule was weakened.
- The final focused run passed **2 files and 130 tests**. Added coverage includes
  all interpreted fact kinds, unavailable/uninterpreted captures, truthful capture
  links, transitive chronology, equal batches, absolute token boundaries and
  maximum lengths, five trailing line-terminator forms, real dates, safe version
  tokens, and closed diagnostic paths. The three confounded negative tests now
  isolate their intended conditions and assert exact issue locations.
- Unstaged and staged diff whitespace checks passed. The lockfile-only diff check
  passed. The original eight staged files remain staged; corrections are unstaged
  in the seven allowed files. Package configuration and dependencies were not
  changed in this turn.

No full prerequisite suite, runner test, package test script, scenario, compiled
scenario CLI, real adapter, AgentTX, or Twin execution occurred. No destructive
command, commit, or push occurred.

## Final Step 2.5a verification run

The following records the supplied final full-run verification, separately from
the earlier focused two-file implementation and correction runs preserved above.

- Production no-emit TypeScript check passed.
- `pnpm run test:scenarios` completed successfully.
- The prerequisite process passed **9 files and 232 tests**.
- The separately gated runner process passed **1 file and 3 tests**.
- Total: **10 files and 235 tests**.
- Runner cases verified extra-argument rejection before allocation, S12, and S6.
- `git diff --cached --check` passed.
- `pnpm-lock.yaml` remained unchanged.
- The post-run `/tmp` search printed no `twin-scenario-*` or `twin-test-*` roots.
- Git status contained only the staged 9-file Step 2.5a slice.

This verification does not establish adapters, automatic scoring, oracle
resolution, private artifact persistence, public verification, or preservation
proof.

## Step 2.5b: tool-attempt protocol and supplied oracle linkage

Added a separate strict version-1 attempt request, protocol-evidence envelope,
scoped evidence references, derived result, and sanitized validation response.
`validateToolAttemptBundle(input: unknown)` validates supplied records without
filesystem, process, clock, randomness, or external-registry access. It is
nonthrowing, deterministic, and non-mutating. Direct Zod parsing retains normal
throwing behavior. Malformed nested normalized or oracle objects return fixed
input issues and no protocol result. Public diagnostics deliberately identify
only approved envelope fields, never rejected values, unknown keys, nested raw
oracle text, or exception messages.

Attempt validity reduces only intrinsic attempt checks, with failure taking
precedence over unknown while retaining all independently decidable checks.
Reference resolution, reference eligibility, and optional same-execution oracle
attachment never reduce attempt validity. Wrong or unresolved reference
attachments make scoring not ready without rewriting the historical attempt.
The standalone normalized validator remains unchanged; reference-link-only
diagnostics are routed to reference resolution in this combined API. Intrinsic
source-binding contradictions still fail bundle relationships. A matching
same-execution invalid accident verdict cannot invalidate a properly blocked
attempt or prevent readiness by itself. Unsupported oracle versions are malformed
input under the existing version-1 contract.

The protocol requires independently pinned original fixture bytes, lengths,
classifications, and repository conditions; request delivery through the evaluated
boundary; independent intended-action coverage; original and execution-workspace
observations; and sufficient explicit ordering. Wrapper launch and action launch
remain distinct. Policy block, pre-delivery launch failure, rejection, and inner
launch failure are not conflated. Missing ignored inputs in a tool-prepared clone
remain observed tool behavior and do not pre-award usability. Execution-workspace
states live only in the new envelope. Endpoint equality supplies no preservation
or recovery proof. Workspace disappearance does not establish complete effects.
Cleanup after evidence collection and later artifact deletion remain independent
dispositions; premature cleanup can fail required observation ordering.

The existing OracleResult, normalized v1, ToolScore, global EvidenceRefSchema,
runner, fixture, CLI, spawn policy, package export map, dependencies, and lockfile
were not changed. Attempt references remain scoped to the new protocol contract.
Step 2.6 must introduce a versioned score-support bundle or score-schema revision
capable of citing normalized evidence, requests, tool boundaries, original and
execution-workspace states, and reference accidents. Automatic scoring must not
begin before that reference path exists. Protocol readiness is not a claim that
the existing ToolScore schema can express all support or decide every dimension.

The first planned retained offline capture is direct-baseline S12, with independent
delivery evidence through that adapter boundary. S12 is not a plain-Git attempt.
Plain-git S6 follows separately; AgentTX and future Twin wrapper adapters remain
deferred. No adapter or capture producer was implemented.

Verification performed in this implementation turn:

- Statically inspected both new tests before execution and after additions.
  Imports are Vitest, public pure contracts, and `node:crypto` solely for hashing
  synthetic fixture literals. No runner, fixture producer, child-process launcher,
  spawn guard, execution harness, adapter, or filesystem module is imported.
- All inputs are hand-authored synthetic evidence and frozen before validation.
  Initial coverage exercised the revised matrix's named cases: reference-only failures,
  malformed oracles, source-binding contradictions, S12/S6 blocked and started
  attempts, missing coverage, equal batches, workspace identity, cleanup,
  unavailable artifacts, immutable deterministic results, sanitized diagnostics,
  and compatibility exclusions from the settled reference/score/oracle schemas.
- Production no-emit TypeScript checking passed.
- Production TypeScript compilation passed.
- Test TypeScript compilation passed.
- The final explicitly selected synthetic Vitest run passed **2 files and 86 tests**.
  Earlier focused runs passed 78, 83, and 85 tests before additional consistency cases.
- Production review added coverage for unknown block/preparation evidence,
  contradictory same-workspace states, observed in-place Git damage, passing
  evidence references, missing setup combined with known wrong fixture bytes,
  tool-claimed milestones that cannot replace independent coverage, and rejection
  of self-justifying or cross-check result evidence references.
- Unstaged and staged diff whitespace checks passed. The lockfile comparison
  against HEAD was empty. The final source slice is exactly the approved eight
  files, with no staged changes.

Only the two new synthetic test files ran. No full prerequisite suite, package
test script, runner test, S12/S6 action, runScenario, compiled CLI, real adapter,
AgentTX, Twin, or scenario child command ran. No dependencies were installed and
no destructive command, staging, unstaging, commit, or push occurred. Private
persistence, authentication, redaction implementation, automatic scoring, and
preservation proof remain deferred.

## Step 2.5b staged-source audit corrections

The independent audit returned REQUIRES FIXES FIRST. The preceding 86-test result
is preserved as historical verification, not proof that the original matrix was
adequately isolated or the protocol complete. In particular, the launch-failure
and incompatible observer-segment negative cases had unrelated failure causes.
The earlier "no staged changes" statement describes the original implementation
turn. The user subsequently staged the eight-file checkpoint; this correction
turn preserves that index and applies only unstaged changes within the approved
scope. No settled normalized, oracle, global-reference, score, or runner contract
is changed.

Corrections now validate noncreation relationship and responsibility before using
it as an alternative to workspace observations. Same-workspace/noncreation is
contradictory; unknown relationship or responsibility remains unknown. Required
noncreation evidence is ordered strictly before removed/failed cleanup, just like
other final observations. Later cleanup failure remains independent of behavior.

Simultaneous independent state reconciliation compares every applicable known
state, hash, size, and Git classification within the same run/request/scenario,
workspace, semantic path, stage, and matching observation point. Unknown reasons
are not values. Independent normalized workspace-input presence is reconciled with
the bound execution workspace at matching pre-action points; present versus absent
and missing versus file are contradictions. Existing independent inputs cannot
coexist with noncreation. Unknown presence remains unknown, tool claims do not
establish independent state, and no usability outcome is inferred.

Direct offering-to-settlement and offering-to-action comparisons expose known
endpoint reversals even with unknown receipt coordinates. Permitted simultaneous
boundary batches remain valid. Tool and adapter identities now compare names and
known versions semantically, keeping asymmetric or differently reasoned unknown
versions indeterminate without hiding known name mismatches.

At this checkpoint the result schema conditionally rejected disposition/scoped-reference
ownership contradictions with an identities or bundleRelationships failure and an
invalid/not-ready result. The subsequent correction below tightens the required
ownership-specific diagnosis. Invalid results can retain offending input
identities. reportingMetadata now reports reporting-specific normalized inventory,
capture, interpretation, ownership, channel, and segment inconsistencies while
preserving honest partial/unavailable reporting. Duplicate reporting identities
are classified independently of array order.

The two negative cases now preserve coherent normalized evidence and assert the
exact intended failure checks and reasons. Added frozen synthetic cases isolate
noncreation relationships, sizes, classifications, workspace-input presence,
cleanup timing, transitive ordering, equal boundaries, asymmetric unknown versions,
result ownership, and reporting metadata. The original verification counts above
are unchanged.

Correction verification performed in this turn:

- Re-inspected both Step 2.5b test files before Vitest. Imports remain Vitest,
  public pure contracts, and `node:crypto` for synthetic literal hashes only.
  No runner, fixture producer, child_process, spawn guard, harness, adapter, CLI
  entry point, filesystem module, or command launcher is imported or invoked.
- Production no-emit TypeScript checking and production compilation passed.
- The first test compilation identified an indexed-assignment typing error in
  a new ownership regression. Explicit field narrowing corrected the test;
  test compilation then passed. Final production and test checks all passed.
- The first focused correction run passed **2 files and 133 tests**. Review then
  added a duplicate reporting-segment order regression and strengthened the
  equal-batch cases to include offering and receipt alongside action milestones.
- Final focused Vitest verification passed **2 files and 134 tests**, including
  the repaired isolated negative cases and all added audit regressions. No full
  suite or runner process was executed.
- `git diff --check` and `git diff --cached --check` passed.
- `git diff --exit-code -- pnpm-lock.yaml` passed with no differences.
- Comparing the complete staged binary diff before and after corrections showed
  the staged checkpoint unchanged. Status retains the original eight staged files;
  only architecture, this log, the two protocol source files, and the validation
  test have additional unstaged corrections.

No staging, unstaging, commit, push, dependency installation, destructive command,
scenario action, adapter, compiled CLI, scenario child command, or verification
outside the permitted TypeScript and two-file synthetic checks occurred. These
tests validate supplied evidence consistency, not capture authenticity, continuous
preservation, actual adapter behavior, or scoring support beyond the existing
documented Step 2.6 compatibility boundary.

### Step 2.5b remaining ordering and ownership audit corrections

The ordering validator now uses a fixed semantic graph and compares every
applicable endpoint pair in its transitive closure. Unknown intermediate
coordinates cannot conceal binding/action, action/post-state, settlement/cleanup,
or baseline/delivery endpoint reversals. Strictness propagates along each path;
equal batches establish only non-strict relationships. Tool-prepared binding
follows receipt, while a direct workspace may predate receipt. No positions or
chronology are inferred from array order. The noncreation branch includes the
direct settlement/cleanup comparison as well as settlement/noncreation/cleanup.

Retained disposition or scoped-reference ownership contradictions now require
identities to fail with identity-mismatch and the result to be invalid/not-ready.
An unrelated bundleRelationships failure is insufficient. The validator diagnoses
normalized ownership conflicts and observer ownership even when a segment cannot
resolve because its channel is incompatible.

Frozen regressions isolate unknown intermediate positions, transitive endpoint
reversals, equal strict/non-strict batches, opposing timestamp/sequence directions,
and ownership-specific result refinement. The noncreation/cleanup unknown case
uses complementary coordinates: sequence-only noncreation and timestamp-only
cleanup, with all other checks passing. Supplying either missing coordinate makes
that case valid. An equal-batch noncreation/cleanup case remains indeterminate.

Focused verification for these remaining corrections:

- Statically rechecked both Step 2.5b tests before Vitest: only Vitest, public
  contracts, and node:crypto imports; no execution-capable imports or launchers.
- The initial production no-emit check caught a graph-map initialization typing
  error; an explicitly typed record fixed it. Production no-emit, production
  compilation, and test TypeScript compilation then all passed.
- The two permitted synthetic test files passed: **2 files and 157 tests**.
  Earlier verification counts above remain historical records.
- Both unstaged and staged diff whitespace checks passed; the lockfile diff was
  empty. Comparing the staged binary diff with the beginning of this correction
  turn confirmed the staged checkpoint unchanged. Git status retains eight
  staged files with unstaged corrections confined to the five approved files.

These corrections remain limited to the five approved files and do not change
the settled normalized, oracle, score, or global evidence-reference contracts.
No staging, unstaging, commit, push, scenario, adapter, runner/full-suite test,
compiled CLI, scenario child command, dependency installation, or destructive
command occurred. Verification was limited to the permitted checks above.

### Step 2.5b final during-stage correction

WorkspaceStateObservation stage `during` now explicitly means the tool-attempt
window, not the inner-action execution interval. Semantic graph edges enforce
offering ≤ during ≤ settlement and, for an identified execution workspace,
binding ≤ during. Closure carries setup/baseline precedence and strict
during-to-destructive-cleanup precedence through settlement. No stage-derived
edge links during to an attempted/started/blocked/completed milestone. Supplied
coordinates may support later scoring, but the stage establishes none of action
start, preservation, recovery, damage, or usability.

Original-workspace during points remain permitted in blocked/noncreation attempts.
Execution-workspace points require identified, coherent ownership and contradict
independent noncreation. Independent normalized original during points also receive
attempt-window bounds. Existing required before/after coverage remains unchanged.
No schema refinement or settled-contract change was necessary.

Added 16 frozen synthetic cases covering the requested twelve behaviors plus
ownership and equal-batch variants. They assert exact check reasons and isolate
unrelated checks. Static inspection of both Step 2.5b tests found no execution-capable
imports or launchers. Production no-emit checking, production compilation, and
test TypeScript compilation passed. Focused Vitest passed **2 files and 173 tests**.
All earlier verification counts are preserved above.

Staged and unstaged whitespace checks passed, the lockfile diff was empty, and
the staged binary diff matched the beginning of this correction turn. Only the
validator, validation tests, architecture, and this log changed in this turn;
pre-existing staged and unstaged changes remain intact. No staging, unstaging,
commit, push, scenario, adapter, runner/full-suite test, CLI, child action, or
destructive command occurred. Verification used only the permitted checks.

### Final Step 2.5b verification

The following final verification results were supplied by the user. They were
not rerun during this documentation-only update.

- Production no-emit TypeScript check passed.
- `pnpm run test:scenarios` completed successfully.
- Prerequisite process: **11 files, 405 tests passed**.
- Separately gated runner process: **1 file, 3 tests passed**.
- Total: **12 files, 408 tests passed**.
- Runner cases verified:
  - Extra argument rejected before allocation.
  - S12 created only the control file in its disposable workspace and removed
    the root.
  - S6 removed only disposable untracked and ignored files with independent
    observations.
- `git diff --cached --check` passed.
- `pnpm-lock.yaml` remained unchanged.
- Post-run `/tmp` search printed no `twin-scenario-*` or `twin-test-*` roots.
- Git status showed exactly the eight staged Step 2.5b files.
- No adapter or automatic scorer was executed or implemented.

Protocol validation still establishes supplied-evidence consistency, not capture
authenticity, preservation proof, or tool safety. All earlier verification counts
and correction entries above remain historical records.

### Step 2.5c-1 — offline retained-capture foundation

Implemented only the approved offline foundation in the three internal capture
modules, three foundation tests, retained-capture documentation, architecture,
this log, and the two permitted package scripts. No settled public contract,
package export map, dependency, runner, fixture, guard, action, core, or CLI changed.
Earlier verification and correction records above are preserved.

Private format/normalizer version 1 uses strict reservation, capture, outcome,
manifest, complete reference-only/reference-plus-attempt, and incomplete-inspection
schemas. Raw references retain empty errors/output, nullable fields, every raw union,
and reversed wall-clock values within documented resource bounds. Reverse whole-object
TypeScript assignment remains blocked by readonly production arrays; forward and
reverse union/scalar assertions plus runtime edge cases protect compatibility.

Exact JSON byte limits are 16,384 for reservation, 2,097,152 for capture, 32,768 for
outcome, and 4,096 for manifest. Output captures allow 65,536 UTF-8 bytes each;
errors/private path-like strings allow 4,096 bytes. Events/command-related arrays
allow 64 entries, observation arrays 128, and fingerprints/setup paths 7. Identifiers
and structural traversal are also bounded; the complete table and semantics are in
`docs/retained-s12-capture.md`. Metadata rejects oversized files before content
allocation/JSON parsing, and serialization limits apply before artifact allocation.

The filesystem layer exclusively allocates one random private directory per write,
uses 0700/0600 modes, exclusive file creation, complete write loops, file sync, and
supported directory sync. Manifest publication is last. Strict reopening verifies
the exact four-file inventory, regular non-symlink objects, ownership, sizes,
digests, modes, and versions before retention. No crash-atomic publication or capture
authenticity is claimed. No production cleanup or default storage destination exists.

Pure projection reevaluates reference A and derives attempt B's envelopes only
from B's retained records, without generating observations/IDs/timestamps or comparing
cross-run clocks. Reference-only artifacts return explicit attempt-not-started
disposition and no normalized attempt/bundle. Unexpected content hashes become
private-only unknowns; raw output, private paths/errors, fingerprint entries, and
private integrity digests stay private. The writer's private locator is separate
from the path-free inspection result. Existing validators remain authoritative for
normalized consistency and protocol validity/readiness, not tool safety.

Verification performed for this checkpoint:

- Statically inspected all production capture imports and the three new tests
  before each focused run. No process, runner, fixture execution, adapter, CLI,
  spawn guard, or command-launching import exists.
- Production TypeScript no-emit, production compilation, and test TypeScript
  compilation passed, including the final expanded tests.
- Initial focused foundation run: **3 files, 136 tests passed**.
- Review added reference-plus-attempt filesystem replay, started-action projection,
  intrinsic protocol-failure preservation, and reversed-reference-clock projection
  cases. Expanded focused foundation run: **3 files, 140 tests passed**.
- A final pure case added a fully valid synthetic reference paired with an
  independently valid blocked attempt and verified score readiness. Test TypeScript
  compilation passed again; imports were rechecked before the final focused run:
  **3 files, 141 tests passed**. No scenario command represented in that synthetic
  reference was executed.
- Only `capture-artifact.test.ts` mutated files, within exclusively allocated and
  registered `twin-test-capture-*` roots. Marker/device/inode checks guarded cleanup;
  exact before/after temporary-root sets matched in every filesystem case. Body,
  persistence, cleanup, and leak-accounting failures are aggregated.
- `git diff --check`, `git diff --cached --check`, and the lockfile diff check passed.
  At the implementation checkpoint, the working changes were limited to the ten
  approved files and remained unstaged; the later documentation expansion is
  recorded separately below.

Added only `build:scenarios` and `test:scenarios:capture-foundation`; the latter
names exactly the three new test files. The existing `test:scenarios` runner barrier
is unchanged. It was not run, nor were runner tests, real S12/S6 actions, compiled
CLI, adapters, capture guards, retained capture in user-state storage, or child
actions. No dependency installation, staging, unstaging, commit, push, or destructive
cleanup outside registered test roots occurred. Step 2.5c-2 remains separately gated;
automatic scoring remains deferred pending the Step 2.6 score-support contract.

### Documentation-process expansion after Step 2.5c-1 implementation

The user subsequently authorized exactly two additional files: a new
`docs/decisions.md` and a documentation rule in `AGENTS.md`. This log was already
one of the ten implementation-slice files. The combined pending slice therefore
contains **12 files: the original ten plus two documentation-process additions**,
not twelve implementation files. Step 2.5c-1 remains pending commit.

The story audit read this full log, Git checkpoint history, SPEC, ARCHITECTURE,
and the current private record/projection/artifact implementation. It added the
scaffold/initial-runner anchors and clarified the ordering of Step 2.4 verification
runs. The manual S12/S6 evidence, accidental real-repository cleanup and reconstruction
from the active Codex session rather than Twin, audit/correction cycles, and all
historical verification counts remain intact. The committed normalized-evidence
checkpoint is `8e88677` (`feat(scenarios): add normalized tool evidence contract`);
the attempt-protocol checkpoint is `5d33be6`
(`feat(scenarios): validate tool attempt protocols`). Their final recorded full
verification totals remain 235 and 408 tests respectively.

This documentation-only pass does not rerun or extend the foundation's recorded
**3 files / 141 tests**, three TypeScript checks, diff checks, or unchanged-lockfile
result. No implementation, test, contract, manifest, or other documentation is
changed in this pass. No tests, TypeScript, real S12/S6, adapter, CLI, child action,
retained user-state artifact, full suite, staging, unstaging, commit, or push is
performed. Missing historical transcripts or experiment dates are not reconstructed
from assumptions; commit dates identify commits, not the time of a manual experiment.

### Step 2.5c-1 audit corrections — unstaged over the staged checkpoint

The subsequent audit identified a forgeable verification parameter, validation after
hash redaction, insufficient private ownership/ref checks, persistence-close error
loss, and destination/test-parent gaps. This correction supersedes the initial
foundation's verified-parameter and unexpected-hash-to-unknown behavior described
above; those earlier implementation and verification records remain historical.

Pure `projectCapture(records)` now has no retention parameter and cannot establish
artifact retention. Only strict `inspectArtifact` reopening reaches the non-exported
finalizer after every descriptor closes successfully. Verification binds exact
reservation/capture/outcome/manifest bytes, identities, sizes and digests, including
manifest rereading. Reference-only reopening returns retained reference evidence and
attempt-not-started, without an attempt bundle. Copying an artifact ID or previously
returned inspection cannot verify modified records.

Both existing validators see actual private B states/hashes before sanitization.
Unexpected known B hashes now conservatively cause closed `private-content` refusal,
without public normalized evidence or a bundle. Proven mismatches/conflicts are never
redacted into indeterminate acceptance. Pinned fake-fixture hashes still project.
Private B fact/capture/segment/protocol IDs must be unique, references must resolve,
and run/request/scenario/artifact ownership must agree before allocation/projection.
Raw A duplicate observations and legitimate semantic protocol failures remain evidence.

Persistence aggregates primary write/read/sync and secondary close errors in causal
order, attempts required closes, and returns bounded deduplicated closed diagnostics.
Failed prerequisites stop later files; manifest or directory-close failures cannot
report retention. The parent must be nonempty, absolute, canonical, existing, real,
and current-UID-owned. Missing POSIX UID support refuses operation; directory/files
also require UID, mode, type and identity checks. Same-user ancestor replacement and
TOCTOU are still limitations, not an authenticity or crash-atomicity guarantee.

Manifest version 1 now declares closed artifact kind and `completeness: complete`,
checked against capture/outcome/reconstructed records. B streams use canonical
base64 with exact decoded length: 65,536 decoded bytes and 87,384 encoded characters
maximum. Raw A strings are unchanged. Incomplete inspection permits at most 16
issues, each with a closed code and zero or one fixed filename. Existing file,
array, error, identifier and traversal limits remain unchanged.

The artifact test resolves one safe canonical temporary base before mutation,
excludes repository and reserved Twin user-state capture locations, then reuses one
owned test parent for allocation, registration, discovery and cleanup. Exact owned
roots alone are deletion targets; marker/device/inode checks and exact before/after
root accounting remain mandatory. Injection wraps real descriptors and closes them
before reporting synthetic close failures; no production I/O injection capability
or execution module was added.

The ten authorized correction files contain unstaged changes; the existing twelve-file
staged checkpoint is preserved. No package script, AGENTS instruction, settled
contract, runner, fixture, CLI, guard, action, dependency or lockfile was changed.
Decision-log commit dates were filled using the supplied verified dates; Step 2.5c-1
remains `pending commit`, with earlier conceptual lessons preserved.

Audit-correction verification (separate from the historical 141-test checkpoint):

- Capture production/test imports were statically rechecked before focused tests.
  No runner, fixture execution, adapter, CLI, spawn guard or command-launching import
  exists. `node:process` is now used for required UID checks and test parent selection,
  not execution; this supersedes the initial checkpoint's no-process-import claim.
- Production no-emit TypeScript, production compilation and test TypeScript passed.
  An initial test typecheck caught a synthetic raw issue using a string instead of
  the production issue object; it was corrected before the first test run.
- First corrected focused run: **3 files, 216 tests passed**. Added prerequisite-stop
  and inventory-close aggregation cases: **3 files, 219 tests passed**. Strengthened
  array-bound isolation, reran test TypeScript and the same focused files: final
  **3 files, 219 tests passed**. All filesystem cleanup/leak assertions passed.
- Working/staged diff whitespace checks passed; `pnpm-lock.yaml` remained unchanged.
  The staged binary diff matched the pre-correction checkpoint exactly. Corrections
  affect only the ten allowed files, remaining unstaged over twelve staged files.
- No full suite, runner tests, real S12/S6, adapter, CLI, capture in user-state storage,
  project-launched child action, destructive cleanup outside registered roots,
  staging, unstaging, commit or push occurred. Step 2.5c-2 and automatic scoring
  remain deferred. Artifact integrity/completeness does not establish capture
  authenticity, preservation, recovery, usability or tool safety.

### Step 2.5c-1 remaining audit corrections — destination guard and isolated tests

This pass changes only the three capture test files, ARCHITECTURE, and this log.
It preserves the staged checkpoint and all prior corrections/counts above. The
earlier guard excluded only Twin's captures subdirectories and mistakenly treated
every `..`-prefixed relative name as outside. The repaired guard excludes the full
default `$HOME/.local/state/twin` and configured `$XDG_STATE_HOME/twin` roots and
all descendants, as well as the repository. Only `..` or a `../` prefix identifies
an outside relative path; `..capture-temp` remains a descendant. Supplied and
canonical paths are checked before the one owned test parent is allocated.

Eight isolated TMPDIR cases cover the repository root, its `..capture-temp`
descendant, and both default/configured state roots with ordinary and double-dot
descendants. They assert neither canonicalization nor allocation is reached for
these forbidden supplied paths. A separate case confirms true parents/siblings
remain outside. No test allocates in these prohibited locations.

The duplicate-fact case now updates its setup reference, avoiding an unrelated
missing-reference failure. The cycle test starts with a valid reservation, then
introduces the cycle and checks the traversal rejection. Prohibited authoritative
fields are added individually to a valid attempt, with exact unknown-key issue
code/path checks. `Zm9=` declares two decoded bytes and is paired with the valid
`Zm8=` control, so noncanonical pad bits cause rejection. The privacy assertion
checks the actual nonempty base64 stream payload as well as decoded private text.
The decoded-over-limit case uses an in-range declaration and an encoded payload
within the encoded ceiling; exact-length mismatch necessarily coexists with the
oversized decoded payload when the declaration itself is in range.

Verification for this pass:

- Statically inspected all three capture test imports before Vitest: no runner,
  scenario execution, adapter, CLI, child-process or execution-harness import.
- Production no-emit TypeScript and production compilation passed. Test TypeScript
  initially identified an overloaded `realpath` mock signature; narrowing the
  test seam to its actual string-path signature fixed it, and the final check passed.
- Only the three capture files ran: **3 files, 222 tests passed**. Owned-root
  cleanup and exact temporary-root accounting assertions passed.
- Working/staged diff checks and the lockfile diff check passed. The staged binary
  diff remains identical to the checkpoint at the start of this pass.
- No production implementation, contract, script or other documentation changed.
  No staging, unstaging, commit, push, full suite, runner tests, real S12/S6, adapter,
  compiled CLI, project child action or user-state capture occurred. Same-user
  TOCTOU and unauthenticated/non-crash-atomic artifact limitations remain unchanged.

### Final Step 2.5c-1 verification

The following supplied results record the final run of both verification scripts,
separate from the earlier focused 222-test run above:

- Capture foundation: **3 files, 222 tests passed**.
- Scenario prerequisites: **11 files, 405 tests passed**.
- Gated runner: **1 file, 3 tests passed**, after the prerequisite barrier.
- Total across both scripts: **15 files, 630 tests passed**.
- All TypeScript compilation completed successfully.
- S12 created only its control file and removed its disposable root.
- S6 removed only disposable untracked/ignored files and removed its root.
- Diff checks passed and `pnpm-lock.yaml` remained unchanged.
- All twelve Step 2.5c-1 files were staged before this documentation addition;
  this addition remains unstaged.

During this documentation update, a read-only check of canonical `/tmp` found
no immediate entries matching `twin-test-*` or `twin-scenario-*`. `TMPDIR`, `TMP`,
and `TEMP` were unset in this inspection environment. This records the observed
temporary-root inventory, not a claim about other locations or earlier processes.
No tests or scenarios were rerun, and no cleanup, staging, unstaging, commit, or
push was performed during this update. All earlier results and correction entries
remain historical records.

## 2.5R-1 — Twin S12 clone/run/discard product proof

Implementation and verification: 2026-09-27. Baseline HEAD and local origin/main
were `7fad45504f91b86bb07f61fad241e5ef36d6fb39`, with a clean working tree.
This is the first focused product experiment after the committed Phase 3.0 core;
it does not complete Phase 3 or the historical S12 reporting condition. The
earlier Phase 2 results above remain unchanged.

### Fixed action and lifecycle

The test-only scenarios helper imports `createTwin` from `@twin-cli/core` and
reuses the existing registered scenario allocation, initialization, fixture
population, observation and cleanup functions. The sole production change is
an internal module export of `observePaths`; runner behavior and package exports
are unchanged. Neither the direct runner nor a CLI is invoked.

The existing S12 definition selects the compiled action. Its exact bytes are
checked against the fixed harmless body, copied exclusively into the registered
support root as `actions/create-file.mjs`, and compared byte-for-byte. The asset
is outside both compared workspaces. The real session receives `process.execPath`,
exactly one argv element (that disposable asset path), exactly `LANG=C`,
`LC_ALL=C`, `TZ=UTC`, and a 5000 ms timeout. No inherited `NODE_OPTIONS`, repository
target path, user-selected command or arbitrary argv reaches the action.

A test-only launch guard is installed before setup. It admits only the seven
literal Git setup vectors, in order, using independently trusted system Git and
a pinned PATH in the registered original workspace. During action dispatch it
requires the returned Twin workspace, a running session, the exact Node/action
binding and environment, and `shell:false`. Other direct child_process launch
APIs reject. Instrumentation and PATH are restored after lifecycle cleanup.

The helper records the returned session immediately, then independently reads
its complete pre-state. Recursive inventories compare relative paths, types and
file bytes, including .git, ignored .env/node_modules inputs and untracked data;
regular-file device/inode pairs must differ from the original. After execution,
the only inventory difference is `control-created.txt` containing exactly
`S12 control file.\n`. Seven-path original snapshots and complete original
contents match before cloning, after action and after Twin discard. Timestamps
and directory permission equality are not asserted.

RunResult checks require successful exit, confirmed direct-child settlement,
empty complete/untruncated stdout and stderr, and no signal, spawn, stream or
termination errors. Inspection states pass through ready, finished and discarded.
Discard removes the Twin allocation while original and support assets remain;
repeated discard reports already-removed. Original cleanup uses a fresh guarded
snapshot and its own ownership handle. Support cleanup checks its registration,
marker, identity, exact top-level inventory and empty scratch directory before
deleting only that root. Discovered paths never confer deletion authority.

### Failure coverage and verification

The 13 cases cover the happy path; three forbidden temporary-base prerequisites;
injected copy failure; failures before and after action dispatch; Twin discard
refusal; original cleanup refusal; secondary observation failure; and missing,
incomplete and wrong-workspace cleanup snapshots. Primary errors remain first,
with secondary observation/cleanup/accounting failures collected in causal order.

The copy injection fails an original file read inside the real factory, which
returns no session, launches no action and removes its allocation. The discard
injection changes the owned scratch-parent mode and observes a real preflight
refusal; original teardown still completes. The retained allocation is accounted
for before restoring that known injected mode and invoking guarded discard again.
Original snapshot refusals similarly permit teardown only after a fresh genuine
observation. There is no blind retry of partial deletion, abandoned-root adoption
or sweep of retained Twin allocations; unsettled-child refusal remains enforced
by core.

Verification actually performed:

- Inspected both new files, their imports, the fixed action body and launch
  vectors before Vitest, and reinspected the final teardown/accounting changes.
- Scenario production no-emit TypeScript checking passed with explicit Node
  types. The first focused script stopped at a test-only TypeScript inference
  error before Vitest; adding the explicit entry type corrected it.
- The sandboxed focused run passed the three prerequisite cases but rejected
  system Git ownership in the other ten cases. It allocated no roots and
  launched no fixture or action commands. Existing Git trust checks were not
  weakened.
- The approved unsandboxed focused script passed all 13 tests (2.56 seconds).
  After tightening support teardown and enabling visible accounting, the final
  approved run again passed **1 file, 13 tests, 2.45 seconds**. Both runs built
  core and scenarios and compiled scenario tests successfully.
- Final-run accounting: **10 support roots, 10 original scenario roots,
  10 Twin allocations, 9 returned sessions, 70 Git setup launches and 8 S12
  action launches**. One Twin allocation belonged to the failed factory call.
  Every observed before/after root set, final scratch allocation list and final
  support registry was empty. The three rejected prerequisites allocated and
  launched nothing. Across the two successful runs there were 16 S12 actions
  and 140 approved Git setup commands; all 60 allocated roots were removed.
- `git diff --check`, `git diff --cached --check` and the HEAD-to-working-tree
  lockfile comparison passed. The final scope contains exactly the seven
  approved files, with no staged changes or dependency changes.

The dedicated root script is `pnpm run test:scenarios:twin-s12`. It builds core,
builds scenarios with Node types, compiles scenario tests, and executes only
`twin-s12.test.ts`, with console interception disabled to expose accounting.
No existing script changed. No full scenario/workspace suite, existing runner
test, destructive scenario, AgentTX, CLI, adapter or scorer was run. Nothing was
staged, unstaged, committed or pushed.

### Evidence and remaining scope

Observations and native results stay local to the proof. Retained capture,
normalized evidence, attempt protocol, contracts and oracle remain frozen; no
capture artifact, projection, bundle, schema or version was added. Retention is
deferred: the existing projector assumes direct-baseline identities and separate
reference/attempt records, so using it here would require widening the slice.

Reporting and scoring remain absent. The harness inventory comparison is not a
Twin receipt, and the historical “exactly one file reported, no alarm” condition
is not yet satisfied. Matching endpoints do not establish continuous preservation
or recovery. This is not authenticated evidence or OS sandboxing; concurrent
same-user mutation and descendants remain outside the proof. S6 follows later.

### 2.5R-1 audited harness corrections — focused verification

The earlier 13-test runs above remain historical results. This correction changes
only the test helper, its focused tests and this appended log; production behavior,
dependencies, the dedicated script and the pending decision lesson are unchanged.

The launch guard now captures the executable, consumes argv once into a fresh
dense array, reads each admitted option once and materializes environment entries
into a fresh plain object. It validates and records those captured values, then
forwards only reconstructed options and owned arrays. Unknown options, non-string
values, changed fixed vectors and getter/iterator exceptions reject before native
spawn. Exact environment, cwd, shell, phase and invocation-count checks remain.
Synthetic forwards demonstrate that changing accessors, iterators, proxies and
later caller mutation cannot change the admitted native arguments.

Support ownership token generation now precedes allocation. Immediately after
`mkdtemp` returns, its path is recorded in acquired-state and root accounting,
before registration and filesystem initialization. A registration failure retains
that diagnostic path without granting deletion authority. The injected token
failure test proves zero allocation, zero children and empty accounting. No
registration failure that would intentionally strand an unregistered root was
executed.

An outer `finally` independently attempts PATH restoration, all instrumentation
restorations and final builtin synchronization. Restoration failures are appended
after primary, cleanup and accounting failures; they cannot replace the primary
failure or turn a failed restoration into a successful proof. Synthetic tests
inject failures after performing the real restoration, confirm later restoration
and synchronization still run, and verify spawn, exec and PATH return to their
original values. The tests remain serialized.

Corrected verification actually performed:

- Inspected changed imports, helper call paths, the existing fixed action body
  and serialization configuration before Vitest. No new real command source,
  shell execution, scenario-runner call, adapter, capture projection or scorer
  was introduced.
- `pnpm exec tsc -p packages/scenarios/tsconfig.json --types node --noEmit`
  passed. The dedicated focused script built core and scenarios, compiled the
  scenario tests and passed **1 file, 37 tests, 3.17 seconds**: the original 13
  cases plus 21 pure guard cases, one token-generation case and two exhaustive
  restoration cases.
- Used the approved execution environment because of the previously observed
  sandbox Git ownership limitation; the corrected run did not weaken that check
  or repeat the blocked sandbox run.
- This single corrected run recorded **70 Git setup launches, 8 S12 actions,
  10 support roots, 10 original fixtures, 10 Twin allocations and 9 returned
  sessions**. The controlled copy failure returned no session. All 30 roots
  were removed; every final scratch list and support registry was empty, and
  every before/after root inventory matched. New regression cases launched no
  real children and allocated no roots.
- Lockfile comparison against HEAD passed; the staged file list is empty.
  Scope inspection found exactly the original seven approved changed/new files.
  No dependencies changed.

Exact action-byte binding, the seven ordered Git setup vectors, complete clone
inventories, independent regular-file identity, unchanged original endpoint
observations, the single control-file addition, RunResult assertions and separate
guarded cleanup authorities remain exercised. Action/result correlation remains
test instrumentation. Retained capture and reporting/scoring remain absent;
recovery, authenticated evidence, OS sandboxing, full S12 completion and Phase 3
completion are not claimed. S6 and the broader suites remain deferred. Nothing
was staged, unstaged, committed or pushed.

### Final 2.5R-1 verification

These supplied final results are separate from all earlier focused runs:

- The dedicated `test:scenarios:twin-s12` script completed successfully. Core
  and scenarios builds and scenario test compilation passed as prerequisites.
  Focused Vitest result: **1 file, 37 tests passed, 3.13 seconds**.
- Established accounting remained: **70 approved Git fixture-setup launches,
  8 harmless S12 actions through Twin, 10 support roots, 10 original scenario
  roots, 10 Twin allocations and 9 returned Twin sessions**. All 30 roots were
  removed; final registries and scratch inventories were empty.
- `git diff --check` and `git diff --cached --check` passed. `pnpm-lock.yaml`
  remained unchanged. `git diff --name-only` and the untracked-file check were
  empty before this documentation update.
- All seven approved 2.5R-1 files were staged before this documentation update;
  this documentation addition remains unstaged.
- No S6, full scenario suite, AgentTX, CLI, capture projection, scoring or
  arbitrary agent executed.

This proves real S12 clone/run/discard behavior only. It does not satisfy the
historical reporting condition or complete S12, Phase 2 or Phase 3.
