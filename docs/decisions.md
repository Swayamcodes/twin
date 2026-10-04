# Project decisions and lessons

I capture the main engineering concept learned at each checkpoint while it is
fresh, in my own words. Each entry keeps roughly two or three meaningful lines
about why the lesson matters, rather than repeating a file-by-file changelog.
These backfilled lessons come from Git history, SPEC, ARCHITECTURE, and the
[Phase 2 build log](phase-2-build-log.md); they do not add unrecorded experiences.

## Phase 1 — research and project boundary

Commits: `50fad88` — `docs: define twin scope and architecture`;
`76dc74d` — `docs: normalize line endings and clarify scope`.
Commit dates: 2026-09-24 for both; these are documentation checkpoints, not experiment dates.

I narrowed the goal to ignored/non-Git coverage and honest reporting after the research showed that isolation could protect originals while leaving needed inputs out of the clone.
A filesystem snapshot can reduce recovery risk, but it is not an OS sandbox: absolute paths and outside-project writes can bypass it.

## Phase 2.1 — workspace and scaffold

Commit: `4d09f95` — `scaffold: pnpm workspace, strict tsconfig, AGENTS.md`.
Commit date: 2026-09-24. This scaffold commit precedes the Phase 1 documentation commits above in Git chronology.

I keep core independent of the CLI and scenario suite so that the reusable engine does not inherit either consumer's execution machinery.
Strict TypeScript and explicit package boundaries give later safety checks a smaller, clearer surface to reason about.

## Phase 2.2 — guarded S12/S6 runner

Commit: `b6f2232` — `feat(scenarios): add guarded S12 and S6 fixture runner`.
Commit date: 2026-09-24.

I learned that a destructive benchmark needs stronger controls than an ordinary test: disposable roots, ownership checks, and independent observations are part of the test itself.
The accidental repository cleanup was repaired from active Codex session history, not Twin, so I cannot count that reconstruction as a recovery result.

## Phase 2.3 — destructive-runner regression hardening

Commit: `93a90e5` — `test(scenarios): harden destructive runner regression coverage`.
Commit date: 2026-09-25.

I check command permission and executable provenance separately: an exact argv allowlist is insufficient if an inherited PATH can select a different binary.
Safety prerequisites must finish successfully before destructive runner tests start; passing tests cannot justify an unsafe launch path.

## Phase 2.4 — oracle and score contracts

Commit: `0c51b04` — `feat(scenarios): add versioned oracle and scoring contracts`.
Commit date: 2026-09-25.

I separate raw evidence, scenario validity, and scoring: a valid S6 accident means deletion happened, not that a tool kept anything safe.
Missing setup evidence must stay unknown, while an observed wrong setup can fail; keeping those cases distinct prevents invented conclusions.

## Phase 2.5a — normalized tool evidence

Commit: `8e88677` — `feat(scenarios): add normalized tool evidence contract`.
Commit date: 2026-09-26.

I need provenance and capture completeness before I can say what evidence supports: a partial report can prove a mention, but silence needs complete capture and interpretation.
Matching before/after observations do not prove uninterrupted preservation, and internally coherent evidence is not authenticated evidence.

## Phase 2.5b — tool-attempt protocol

Commit: `5d33be6` — `feat(scenarios): validate tool attempt protocols`.
Commit date: 2026-09-27.

I separate attempt validity from score readiness: a wrong reference attachment must not rewrite an otherwise valid blocked or started attempt, and neither status is a score.
I compare transitive ordering endpoints because an unknown intermediate timestamp must not hide a contradiction between known observations.

## Phase 2.5c-1 — offline retained-capture foundation

Commit: `8b24717` — `feat(scenarios): add retained capture foundation`.
Commit date: 2026-09-27.

I can establish local artifact completeness by writing the manifest last and then reopening bounded files to verify their inventory, sizes, and digests.
That does not authenticate the capture or make publication crash-atomic; I keep private retained bytes separate from public conclusions and keep reference and attempt observations distinct.
I learned that a caller-supplied verification label proves nothing, and redaction must not erase the contradictions that decide acceptance; strict reopening and private validation must come first.

## Documentation checkpoint — product-led evidence scope

Commit: `cb0578d` — `docs: ground evidence planning in real Twin behavior`.
Commit date: 2026-09-27.

I learned that evidence infrastructure should follow real product behavior instead of becoming the product. I should test the smallest working Twin core early, then keep only the evidence machinery that actual runs need.

## Early Phase 3.0 — minimal Twin core

Commit: `7fad455` — `feat(core): add minimal Twin clone-run-discard core`.

I learned to make a complete independent copy the prerequisite for a runnable session, while keeping cleanup authority outside the command workspace. Preserving relative link objects supports dependency trees, but lexical containment and direct-child settlement still do not turn the copy into an OS sandbox.

Phase 3.0 audit correction (`7fad455` — `feat(core): add minimal Twin clone-run-discard core`): I learned that a narrow Git
policy must guard the metadata names and bare-directory inventory before trusting
its config checks. I also separate result delivery from resource disposal: an
unconfirmed child exit still needs a listener after its bounded result returns.

Phase 3.0 input-boundary correction (`7fad455` — `feat(core): add minimal Twin clone-run-discard core`): I learned that reading
options can itself execute caller code. I acquire lifecycle ownership before input
access and validate the captured command rather than rereading mutable inputs.

## 2.5R-1 — Twin S12 clone/run/discard product proof

Commit: `48e316c` — `test(scenarios): prove Twin S12 clone-run-discard behavior`.

I learned to prove Twin by running the existing control action through its real session and comparing the complete clone with the disposable original.
I keep action targeting, endpoint observations and separate cleanup authorities explicit; an archive or a harness diff cannot substitute for product behavior or a receipt.

## 2.5R-2 — Twin S6 destructive-action product proof

Commit: `7e5606f` — `test(scenarios): prove Twin S6 destructive isolation`.

I learned to prove destructive isolation by checking that the clone contains the inputs before deletion and that the original still matches afterward. I keep command admission and each cleanup authority separate so a failed proof cannot broaden deletion.

## 2.5R-3 — Twin S13 ignored-input usability proof

Commit: `b326e66` — `test(scenarios): prove Twin S13 ignored-input usability`.

I learned that copying ignored files is only a precondition for usability. I need a fixed action to consume their verified bytes inside Twin, with independent unchanged inventories and separate cleanup accounting.

## 2.5R-4 — Twin S8 non-Git destructive-isolation proof

Commit: `9d0a5d5` — `test(scenarios): prove Twin S8 non-Git isolation`.

I learned that proving non-Git support requires removing Git from fixture setup as well as execution. I verify exact clone damage and unchanged original inventories while keeping each cleanup authority independent.

## 2.5R-5 — Twin S9 fake-home boundary proof

Commit: `c5c7d32` — `test(scenarios): expose Twin S9 fake-home boundary`.

I learned that copying a project does not isolate paths supplied outside that copy. I use a disposable fake home to demonstrate the boundary safely, observe the mutation honestly, and keep teardown separate from recovery.

## 2.6R-1 — first retained Twin S12 score

Status: `pending commit`.

I learned that a real Twin proof becomes a benchmark result only when the actual attempt and its reference are retained and each scored outcome resolves to observations from that attempt. Unknown fields preserve the boundary between observed behavior and claims we have not yet measured.

- pending commit — The CLI can preserve command arguments and dispose of a copied project by using the core session lifecycle as its only execution authority.

## Public CLI and plain-Git comparison — S12, S6, S9

Status: `pending commit`.

I learned that public CLI measurement should test only observable CLI behavior. Existing internal proofs can support the interpretation, but they must not be presented as a fresh independent observation of a Twin workspace that the CLI already discarded.

## 2.6R-2 — retained Twin S6 score

Status: `pending commit`.

I learned that scoring a destructive action needs an independent retained reference and attempt, with process admission updated when the product adds receipt work. Exact output and endpoint states support the observed action and usability; they do not prove continuous preservation, Twin reporting, or recovery by discard.

## 2.6R-3 — combined retained score JSON

Status: `pending commit`.

I learned that a combined result can preserve the two measured scores and their public retention links by strictly validating saved producer outputs before projecting them. Keeping execution outside the combiner makes its boundary reproducible and leaves provenance authentication as an explicit limit.

## 2.6R-4 — current Twin S12/S6 Markdown report

Status: `pending commit`.

I learned that a human-readable report needs a stricter claim boundary than its JSON carrier: fixed ordering and closed outcome/reason pairs keep unreviewed fields from becoming prose. A read-only renderer can show current Twin evidence while explicitly leaving the wider tool comparison unfinished.

## Phase 2 — retained Twin S8/S13 measurements

Status: `pending commit`.

I learned that non-Git deletion and ignored-input work need separate fixed attempts and evidence from their actual copied workspaces. A complete endpoint inventory and a successful action support narrow claims, while process descendants, continuous preservation and unreviewed reporting stay explicit unknowns.

The A1–A3 review showed that a live ownership marker cannot establish the
cleanup authority of an earlier attempt. I now require a synced attempt-local
record of allocation, identity, action settlement and disposition before
cleanup; absent or changed evidence leaves the root for manual review.

## CLI timeout selection — unreleased checkpoint

Status: `pending commit`.

I learned that a useful interactive deadline belongs in CLI policy, while core keeps the same bounded termination and settlement authority. Explicit short deadlines let automated tests stay bounded without limiting every human session to one minute; terminal capability still comes from the caller's environment.

## CLI project convenience — unreleased checkpoint

Status: `pending commit`.

I learned that saving an argument array requires an explicit choice between interactive chat and a repeating one-shot task. Config and one-off options can normalize into the existing run path without adding execution authority; preserving argument boundaries and refusing overwrite keeps setup predictable.

## CLI convenience correction — exclusive publication and false overrides

Status: `pending commit`.

I learned that refusing overwrite is separate from keeping partial writes invisible: a closed private sibling and an exclusive hard link provide both. Explicit false options also need the same duplicate key as their positive forms so saved preferences cannot silently win or depend on flag order.


## Tier C terminal presentation — unreleased checkpoint

Status: `pending commit`.

I learned that terminal ownership and observation authority are separate: menus can release raw input and a static identity can explain the existing startup wait without changing the runner. A successful command deserves a clear outcome, while incomplete coverage and outside-project limits must remain prominent; JSON and HTML keep their independent output contracts.
