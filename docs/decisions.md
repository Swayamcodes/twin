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

Status: `pending commit`.

I can establish local artifact completeness by writing the manifest last and then reopening bounded files to verify their inventory, sizes, and digests.
That does not authenticate the capture or make publication crash-atomic; I keep private retained bytes separate from public conclusions and keep reference and attempt observations distinct.
I learned that a caller-supplied verification label proves nothing, and redaction must not erase the contradictions that decide acceptance; strict reopening and private validation must come first.
