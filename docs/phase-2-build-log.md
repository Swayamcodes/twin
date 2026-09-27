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


## 2.5R-2 — Twin S6 destructive-action product proof

Implementation and verification: 2026-09-27. HEAD and local origin/main both
matched `48e316c10abe9b5109db3c6ed92655c031154730`; the initial working tree was
clean. This six-file slice adds a separate test-only S6 helper and focused tests,
one root script, this log, the current S6 catalog status and decision bookkeeping.
Core, scenario production, S12's helper/tests/script, configuration, dependencies,
lockfile and all frozen evidence infrastructure remain unchanged. Earlier results
and historical scenario conditions above are preserved.

### Trusted command and observations

The helper accepts only closed fault selectors. Before allocation it installs a
closed launch guard, checks the temporary base against the repository and both
reserved Twin state roots, resolves trusted system Git using the unchanged
`git-trust.cts` resolver, and generates support ownership material. The observed
trusted executable was `/usr/bin/git`. Trust discovery executes no Git command;
canonical path, root ownership, permissions and ancestor checks are unchanged.

Setup admits only the seven established literal Git vectors in order, the
fixture's semantic executable `git`, and its registered original workspace.
After snapshot validation it forwards the trusted absolute executable. The action
requires that absolute executable directly, exactly `["clean", "-fdx"]`, and the
exact returned Twin workspace; it cannot normalize an alternative executable.
No `-C`, pathspec, shell, wrapper or additional action flag is admitted.

Both phases use the explicit fixture Git environment: PATH contains only the
trusted Git directory; LANG/LC_ALL are C and TZ is UTC; system/global Git config,
hooks, excludes and attributes are disabled with the established `/dev/null`
settings, prompts are disabled, and commit signing is false. Exactly four
controlled Git configuration entries are present. HOME, XDG_CONFIG_HOME,
NODE_OPTIONS, loader variables, Git directory/worktree overrides and arbitrary
caller environment are not inherited. Only the temporary setup PATH modification
is made to the worker environment, and it is restored.

The guard snapshots caller arguments/options once, validates captured primitives,
and forwards independent arrays and plain options/environment objects. The action
requires completed pre-state, a returned running session, a private dispatch flag,
canonical workspace identity and an unused single-action allowance. It consumes
that allowance before forwarding. Other direct child_process launch APIs reject.
Tests are serialized, and overlapping proof calls reject. An unexpected real
RunResult or output stops subsequent proof calls instead of permitting further
real destructive actions.

The original's seven named states use independently pinned fixture bytes, checked
against production literals. Complete recursive inventories include `.git` and
all ignored/untracked inputs, reject symlinks and unsupported types, and compare
relative paths, entry types and file bytes. Every regular-file device/inode pair
in the Twin differs from its original. Successful S6 removes exactly `.env`,
`scratch.txt`, `node_modules/lib.txt` and the `node_modules` directory. The tracked
files and complete prior `.git` inventory/bytes remain unchanged, and the control
file stays absent. Original seven-path states and complete contents match after
action and after discard. Timestamps and unsupported metadata are excluded.

Real RunResult assertions require started/exited, confirmed direct-child
settlement, exit 0, no signal/spawn/termination error, and complete untruncated
error-free streams. On the first authorized run, stdout matched exactly these
complete lines (the assertion does not depend on order):

```text
Removing .env
Removing node_modules/
Removing scratch.txt
```

Stderr was empty. The assertion was not weakened or broadened. Git's removal
output is not a Twin receipt.

### Failure isolation and independent cleanup

The helper collects Twin and original post-state independently of result
assertions. The same session follows ready, finished and discarded on success;
repeated discard returns already-removed. Original cleanup requires its own
registered handle and fresh successful observation. Support cleanup checks its
registration, marker, identity and exact inventory, requires empty scratch, and
uses only nonrecursive rmdir/unlink operations. Discovered paths never authorize
deletion. Allocation-return instrumentation records factory allocations even
when no session returns; each acquired path receives removed/retained/unknown
accounting after exhaustive restoration.

The 16 lifecycle/prerequisite cases include three forbidden bases; injected trust
and token failures before allocation; a real factory copy-read failure; failure
after session return; guard rejection before native action forwarding; synthetic
nonzero/spawn-failed/unsettled children; post-state observation failures; and real
Twin/original cleanup refusals. Synthetic child objects have no OS child and
never execute a command. The unsettled case observes a real core discard refusal,
accounts for retention, then emits an explicitly synthetic late settlement before
using the same guarded discard. Known injected mode/snapshot refusals are recorded
before restoring the known cause or collecting fresh real observations. Unknown
refusal and partial deletion are never retried or swept.

Another 48 pure admission cases exercise exact cwd, executable, argv, environment,
phase/session/dispatch requirements, one-action consumption, changing single-read
inputs, later mutation and throwing accessors. Three pure cleanup/restoration
cases verify independent authority attempts, no retry after simulated cleanup
failure, exhaustive restoration and preservation of the primary error. Those 51
cases allocate no roots and launch no native commands. Cleanup-failure callbacks
are synthetic; they do not deliberately induce real partial deletion.

### Focused verification and accounting

- Inspected both new files, transitive runtime imports, fixed command vectors,
  compiled execution routes, cleanup bodies and serialization before Vitest.
  The runner module is imported only for `observePaths`; no direct runner is
  called. No S12 action/helper, CLI entry point, AgentTX, arbitrary agent, shell,
  capture projection or scorer is invoked.
- Production scenarios no-emit TypeScript checking passed. Initial scenario test
  compilation found one entry inference error and two overly narrow synthetic
  cwd assignments; explicit types corrected them before any Vitest execution.
  Scenario test compilation then passed.
- The dedicated `test:scenarios:twin-s6` script builds core/scenarios, compiles
  scenario tests and executes only `twin-s6.test.ts`. The first approved run
  passed **1 file, 67 tests, 13.24 seconds**.
- Used the approved execution environment because S12 verification had already
  documented the sandbox Git ownership limitation. No blocked sandbox run was
  repeated and no trust check was relaxed.
- First-run accounting: **77 approved setup Git launches, 5 real S6 actions,
  3 synthetic action forwards, 11 support roots, 11 original fixtures,
  11 Twin allocations and 10 returned sessions**. One additional action attempt
  was rejected before forwarding; copy and before-run faults dispatched none.
  All **33 allocated roots** were removed. Every before/after temporary-root set
  matched, and final scratch inventories and support registries were empty.
- The five real actions were the success case plus Twin/original observation
  failure and Twin/original refusal cases. Each action used its own returned
  Twin workspace. No destructive action ran in an original fixture or repository.

Retained capture, normalized evidence, attempt protocol and scoring stay frozen.
No artifact, projection, bundle, adapter framework, schema or version is added.
The original survives because the fixed command ran in Twin's disposable copy;
this does not establish recovery, continuous preservation, reporting, receipts,
OS sandboxing, S13 coverage, full historical S6 completion or Phase 3 completion.
Concurrent same-user mutation and arbitrary descendants remain outside the proof.
No full suite, runner test, S12 test, CLI, AgentTX or capture/scoring pipeline ran.
Nothing was staged, unstaged, committed or pushed.

Final verification after tightening negative-case error counts: the same dedicated
script passed **1 file, 67 tests, 13.22 seconds**, including all three compilation
stages. Static inspection confirmed the follow-up changed assertions only.
Per-run accounting again recorded **77 setup launches, 5 real S6 actions,
3 synthetic action forwards, 11 support roots, 11 original fixtures,
11 Twin allocations and 10 returned sessions**, with all 33 roots removed and
empty final scratch inventories/registries. Across the two successful focused
runs: **154 setup launches, 10 real S6 actions, 6 synthetic action forwards,
66 allocated roots removed and 20 returned sessions**. No additional scenario
or test suite ran.

Final working-tree and staged whitespace checks passed. The HEAD-to-working-tree
lockfile comparison was empty. Exact tracked/untracked inspection showed only the
six approved files; the staged file list was empty. S12's pending decision identity
was replaced with `48e316c — test(scenarios): prove Twin S12 clone-run-discard behavior`
without changing its lesson, and the approved first-person S6 lesson remains
`pending commit`. S6's current catalog status was updated only after verification;
historical definitions, predictions and S12's reporting condition remain intact.

### Corrected stdout framing verification — 2026-09-27

The final audit identified that sorting all LF-separated tokens could accept a
misplaced blank line in place of the terminal LF. The corrected pure parser first
requires a terminal LF, removes exactly one final LF, splits the remaining body,
and requires exactly three nonempty lines before comparing their exact contents
with order differences permitted. No trimming, blank-line filtering or whitespace
normalization is used. Missing/additional terminal LF, blank lines, duplicate,
missing or extra lines, spaces, CRLF/stray CR and partial/prefixed/suffixed matches
reject. Stderr must still be exactly empty.

Before Vitest, changed imports and parser call sites were inspected: the 24 new
pure cases call only the parser and assertions, with no path to native spawn,
root allocation or cleanup. They cover all six accepted permutations and 18
malformed inputs, including the exact previously accepted blank-middle-line and
unterminated-final-line example. The original 67 cases remain unchanged.

The dedicated `pnpm run test:scenarios:twin-s6` verification passed all three
compilation stages and **1 file, 91 tests, 13.86 seconds** in the approved execution
environment. Trusted-Git checks were unchanged; the resolved executable remained
`/usr/bin/git`. This corrected run recorded **77 real setup launches, 5 real S6
actions and 3 synthetic action forwards with no OS child**. The additional parser
cases launched no process, allocated no root and invoked no cleanup. Allocation
accounting remained **11 support roots, 11 original roots, 11 Twin allocations
and 10 returned sessions**; all **33 roots were removed**, with empty before/after
temporary-root sets, final scratch inventories and support registries. Copy failure
still accounts for the allocation without a returned session. These are counts
for this corrected run only; the two historical 67-test runs above are preserved.

This correction changes only the S6 helper, S6 tests and this appended log entry.
Working-tree/staged whitespace checks passed, the staged file list was empty,
and the HEAD-to-working-tree lockfile comparison was empty. Scope inspection
showed exactly the same four approved tracked modifications and two approved new
files. Package scripts, dependency declarations, catalog and decisions were not
changed by this correction. Destructive routing, exact Twin cwd, single-action
allowance, complete filesystem-effect/original endpoint checks and independent
cleanup authorities remain unchanged. No S12 or broader scenario suite ran.

Recovery, receipts/reporting, retained capture, scoring, OS sandboxing, full
historical S6 completion and Phase 2/3 completion remain unestablished or deferred.
Concurrent same-user mutation and arbitrary descendants remain outside this proof.
Nothing was staged, unstaged, committed or pushed.

### BOM and byte-empty stderr correction verification — 2026-09-27

Both successful-result UTF-8 decoders now use `fatal: true, ignoreBOM: true`:
a leading UTF-8 BOM remains U+FEFF and fails the exact stdout line comparison.
No trimming, normalization or BOM removal occurs. Stderr must have both zero
bytes and an empty decoded string; stream completeness, truncation and error
checks remain unchanged. Strict LF framing and permutation-only line comparison
are unchanged.

Four new pure synthetic RunResult cases exercise `assertSuccessfulResult` through
its normal decoding path: exact valid stdout with zero-byte stderr passes;
EF BB BF-prefixed stdout fails the exact comparison; BOM-only stderr fails the
byte-length assertion; malformed UTF-8 fails fatally with TypeError. Before
Vitest, the type-only import and assertion call path were inspected. These cases
construct only synthetic records and byte arrays; they launch no process,
allocate no roots, create no fixture/session, and invoke no cleanup or global
instrumentation.

The approved `pnpm run test:scenarios:twin-s6` verification passed all three
compilation stages and **1 file, 95 tests, 15.01 seconds**. The historical 67-test
and 91-test records above remain unchanged. The corrected run retained **77 real
setup launches, 5 real S6 actions and 3 synthetic action forwards without OS
children**, using trusted `/usr/bin/git` with unchanged trust checks. Accounting
remained **11 support roots, 11 original roots, 11 Twin allocations and 10 returned
sessions**; all **33 roots were removed**, and before/after temporary-root sets,
final scratch inventories and support registries were empty.

Only the S6 helper, S6 tests and this appended verification entry changed in this
correction. Working-tree/staged whitespace checks passed; the staged file list
and HEAD-to-working-tree lockfile comparison were empty. Overall scope remains
the four approved tracked modifications and two approved new files. Package,
catalog, decisions, dependencies, production source and excluded infrastructure
were not modified by this correction. Trusted routing, the single-action guard,
Twin-only cwd, filesystem-effect proof, original endpoint checks and independent
cleanup authorities remain unchanged. No S12 or broader suite ran.

Recovery, receipts/reporting, retained capture, scoring, OS sandboxing, full S6
completion and Phase 2/3 completion remain unestablished or deferred. Concurrent
same-user mutation and arbitrary descendants remain outside the proof. Nothing
was staged, unstaged, committed or pushed.

### Final 2.5R-2 verification

Supplied final verification results, recorded separately from all earlier 67-,
91- and 95-test focused runs: the dedicated `test:scenarios:twin-s6` script
completed successfully. Core/scenario builds and scenario test compilation
passed as prerequisites. Focused Vitest passed **1 file, 95 tests**, with a
duration of **13.82 seconds**.

Established final-run accounting remained:

- 77 approved fixture-setup Git launches;
- 5 real `git clean -fdx` actions through Twin;
- 3 synthetic action forwards with no OS children;
- 11 support roots;
- 11 original scenario roots;
- 11 Twin allocations;
- 10 returned sessions;
- all 33 roots removed;
- final scratch inventories and support registries empty.

Strict output validation required exact LF framing, exact removal lines,
BOM-preserving fatal UTF-8 decoding and byte-empty stderr.

The supplied `git diff --check` and `git diff --cached --check` results passed.
`pnpm-lock.yaml` remained unchanged. Before this documentation update,
`git diff --name-only` and the untracked-file check were empty. All six approved
2.5R-2 files were staged before this documentation update; this addition remains
unstaged.

No S12, broader scenario suite, AgentTX, CLI, capture projection, scoring or
arbitrary agent ran. The result proves destructive isolation inside Twin's
disposable copy and original endpoint preservation. It does not establish
recovery, reporting, receipt generation, sandboxing, full S6 completion,
Phase 2 completion or Phase 3 completion. Every earlier verification and
correction entry is preserved.

## 2.5R-3 — Twin S13 ignored-input usability product proof

Implementation and verification: 2026-09-27. Initial HEAD and local origin/main
both matched `7e5606fdb503332a9ddd8f294867750c7d122f71`, and the working tree was
clean. This focused six-file slice adds a separate test-only S13 helper/test and
one root script, plus this log, the current S13 catalog row and decision bookkeeping.
The approved reduced suite contains 28 tests; the earlier 104-test proposal was
not implemented. All earlier verification records remain unchanged.

### Fixed action, targeting and privacy

Pinned module bytes are prepared in memory with ownership material before root
allocation, then written exclusively as
`<registered-support>/actions/read-ignored-inputs.mjs`. The asset stays outside
both compared workspaces. Its regular-file identity, registered support, parent
identity, ownership and exact bytes are checked after creation and immediately
before action forwarding. SHA-256 from the actual verified asset bytes was:

`caf57944d69b0a6e630e98e88964a32cc155f23760d91265b8a8e6ac6ffea413`

The fixed module accepts no arguments or stdin. It attempts only the two literal
relative reads `.env` and `node_modules/lib.txt`, comparing both buffers with the
pinned fake fixture bytes including final LF. It performs no project write,
child launch or network operation. Success emits exactly these ASCII bytes,
including one final LF:

```text
{"action":"twin-s13-inputs-v1","env":true,"dependency":true}
```

A missing, unreadable or changed input produces exit 1, zero stdout bytes and
exactly `TWIN_S13_INPUT_FAILURE\n` on stderr. Both reads are attempted even when
one fails. Actual missing/changed cases exercised this failure path; a separate
permission-specific unreadability experiment was not run. Comparisons and
accounting never publish raw ignored-file bytes, base64 inventories or action
streams. Fake-input handling and a fixed safe output do not prove a production
redaction system.

The guard is installed closed before setup. It admits only the seven existing
ordered fixture Git vectors, replaces semantic `git` with independently trusted
absolute `/usr/bin/git`, and requires the registered original cwd and exact
established isolated Git environment. Git discovery performs no child launch;
its existing ownership/permission rules are unchanged.

Action admission requires the captured absolute `process.execPath`, exactly the
owned module argument, exact canonical returned Twin workspace and captured
identity, `shell:false`, `detached:false`, fixed pipe/ignore stdio, and exactly
LANG=C, LC_ALL=C, TZ=UTC. A returned running session, verified pre-state, private
dispatch and a single action allowance are required. Snapshot values are validated
once and only reconstructed plain arguments/options/environment are forwarded.
Other direct child-process APIs reject. Tests remain serialized using existing
configuration; there is no caller command/path input or generalized adapter.

### Product observations and focused failures

The helper reuses production registered fixture setup/observation/cleanup and
public `@twin-cli/core`. It imports the runner module solely for `observePaths`;
no direct runner is called. Independently pinned seven-path checks establish the
six exact fixture files and absent control path. Complete recursive inventories
include tracked, untracked, ignored and `.git` content and reject symlinks or
unsupported entries. The original and complete Twin pre-state match; every
copied regular file has a different device/inode identity from its original.

The successful real action starts, exits 0 and settles with exact stdout bytes,
zero-byte stderr, complete untruncated streams and no signal/spawn/termination
error. The session proceeds ready → finished → discarded; repeated discard says
already-removed. Independent complete inventories show no action effects in Twin
and an unchanged original after action and after discard. Inventories compare
paths, types and bytes, not access timestamps or all filesystem metadata.

Exactly four real negative controls begin with complete verified Twin copies:
missing `.env`, missing dependency, changed `.env`, and changed dependency. With
the gate closed, each makes one fixed mutation only in Twin and independently
verifies the expected complete negative pre-state. The same module runs through
that returned session, exits 1 with no success output, and causes no additional
filesystem changes. Original endpoint checks and guarded teardown pass. These
controls are not successful usability proofs.

The remaining focused cases cover three forbidden temporary bases, unavailable
trusted Git, token/action preparation failures before allocation, owned action
byte mismatch, real factory copy-read failure without a session, failure after
session return but before action, post-state observation failure, Twin/original
cleanup refusals, and one pure restoration failure. Ten pure guard cases cover
wrong cwd, extra argv/Node flag, alternate executable/asset, changed/extra
environment, a second action and an alternate child API. No synthetic
nonzero/spawn/unsettled child suite or broad accessor/result matrix was added.

Every acquisition is recorded immediately. Cleanup uses only existing registered
authorities; discovered paths are diagnostics. Primary errors remain first and
independent observation/cleanup/accounting/restoration errors are appended.
Known injected preflight refusals are observed/accounted before restoring their
specific cause or collecting a fresh genuine snapshot. Unknown refusal and
partial deletion are not retried or swept. Support removal checks identities,
exact entries and empty scratch, and uses nonrecursive unlink/rmdir operations.
Global restoration attempts every registered restoration and builtin export
synchronization even after another restoration fails.

### Verification and actual accounting

Before Vitest, both new files, their transitive source/compiled imports, action
body, admitted commands and cleanup paths were inspected. The only reachable
real child launches are the seven fixture setup commands and the fixed S13 Node
action through `session.run()`. No S12/S6 action, direct runner, CLI, AgentTX,
arbitrary agent/command, shell, network, capture projection or scorer was called.

- Production scenarios no-emit TypeScript check passed.
- Initial test TypeScript compilation caught an inventory-entry inference error;
  an explicit `Entry | undefined` annotation fixed it before Vitest. Test
  TypeScript compilation then passed.
- `pnpm run test:scenarios:twin-s13` passed its unchanged core/scenarios build and
  scenario test compilation sequence, then **1 file / 28 tests passed**, with
  Vitest duration **2.89 seconds**.
- The focused run used the approved host execution environment because the
  earlier checkpoints documented sandbox Git ownership rejection. No trust rule
  was weakened and no blocked sandbox run was repeated.
- Actual accounting: **70 real Git setup launches, 8 real S13 Node actions,
  0 synthetic child forwards and 1 pure guard forward**. The eight actions are
  the successful proof, four negative input controls, post-observation failure,
  and the two cleanup-refusal cases.
- **11 support roots, 10 original roots, 10 Twin allocations and 9 returned
  sessions** were recorded. The factory copy failure accounts for a Twin
  allocation without a session; action mismatch allocates only support.
- All **31 acquired roots were confirmed removed**, with **0 retained/unknown**
  final dispositions. All before/after temporary-root sets matched and were
  empty; final scratch inventories and support registries were empty.

The dedicated script selects only `twin-s13.test.ts`; existing S12/S6 scripts and
all production/core/tests/configuration outside this slice are unchanged. S13
remains test-only, with no production ScenarioId/direct-runner registration.
Evidence and scoring infrastructure remains frozen. This proves fixed input
usability, not generalized dependency usability, reporting, redaction, scoring,
receipts, recovery, continuous preservation, sandboxing or full S13 completion.
Concurrent same-user mutation, arbitrary descendants and process-crash retention
remain outside this proof. No broader suite or excluded scenario ran.

Final working-tree and staged whitespace checks passed. The HEAD-to-working-tree
lockfile comparison was empty. Exact tracked/untracked inspection showed only
the six approved files; the staged file list was empty. The pending S6 decision
marker now records `7e5606f — test(scenarios): prove Twin S6 destructive isolation`
with its lesson preserved, and the requested first-person S13 lesson is appended
under `pending commit`. Only S13's current catalog status changed, after passing
verification; historical definitions and predictions are preserved. Nothing was
staged, unstaged, committed or pushed.

### Final 2.5R-3 verification

These supplied final results are recorded separately from the earlier
implementation runs above. The dedicated `test:scenarios:twin-s13` script
completed successfully. Core/scenario builds and scenario test compilation
passed as prerequisites. The focused Vitest result was **1 file, 28 tests
passed**, with duration **2.76 seconds**.

The fixed owned S13 action retained SHA-256:

`caf57944d69b0a6e630e98e88964a32cc155f23760d91265b8a8e6ac6ffea413`

Established final accounting remained:

- 70 approved fixture-setup Git launches;
- 8 real harmless S13 Node actions through Twin;
- 0 synthetic child forwards;
- 1 pure in-memory guard forward;
- 11 support roots;
- 10 original scenario roots;
- 10 Twin allocations;
- 9 returned sessions;
- all 31 roots removed;
- no retained or unknown roots;
- final scratch inventories and support registries empty.

The positive proof consumed both pinned ignored inputs. Four real negative
controls covered missing and changed forms of both inputs. Raw input contents
were not emitted by the action or recorded in public-style diagnostics.

The supplied final checks reported that `git diff --check` and
`git diff --cached --check` passed, `pnpm-lock.yaml` remained unchanged, and
`git diff --name-only` and the untracked-file check were empty. All six approved
2.5R-3 files were staged before this documentation update; this addition remains
unstaged.

No S12, S6, `git clean`, broader scenario suite, AgentTX, CLI, capture projection,
scoring or arbitrary agent ran.

This proves fixed ignored-input usability inside Twin. It does not establish
generalized dependency compatibility, production redaction, reporting, scoring,
recovery, receipts, sandboxing, continuous preservation, full S13 completion,
Phase 2 completion or Phase 3 completion.
