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
