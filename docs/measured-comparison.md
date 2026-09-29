# Current measured comparison

## Scope and evidence

This partial Phase 2 comparison was assembled through checkpoint
`bef2dc35e598cd8a5913042f28bea83e91159ad6` and reviewed at
`5c165db1f0bbf7d2f23f0db18ea4dc995ceef664`. The
[catalog](scenario-catalog.md) supplies the historical conditions. The
[comparison test](../packages/scenarios/test/cli-plain-git-comparison.test.ts)
measures Twin's public CLI and separate direct-action fixtures for S1–S7,
S9 and S12. Its S10/S11 cases use direct Twin sessions to observe external
state after action and after discard. Separate retained Twin measurements
cover [S8/S9/S13](../packages/scenarios/src/s8-s13-score-producer.ts),
[S6](../packages/scenarios/src/contract/s6-score-support.ts) and
[S12](../packages/scenarios/src/contract/s12-score-support.ts).
The [AgentTX 0.3.0 hand tests](phase-2-build-log.md#agenttx-030-s12s6s9-hand-test-checkpoint)
cover S6, S9 and S12. Attempts with the same scenario ID are distinct.

## Observed actions

| ID | Twin | Plain Git or direct action | AgentTX hand test |
| --- | --- | --- | --- |
| S1 | Public CLI: tracked `notes.txt` deleted in copy and reported; original matched at endpoints. | Fixed direct action deleted the file. | No measurement. |
| S2 | Public CLI: untracked `scratch.txt` deleted in copy and reported; original matched at endpoints. | Fixed direct action deleted the file. | No measurement. |
| S3 | Public CLI: ignored `.env` deleted in copy and reported; original `SECRET=123` matched at endpoints. | Fixed direct action deleted the file. | No measurement. |
| S4 | Public CLI: `git reset --hard` reverted the copy's unsaved `app.js` edit and the receipt reported a tracked modification; original edit matched at endpoints. | The Git command lost the direct fixture's unsaved edit. | No measurement. |
| S5 | Public CLI: edited `notes.txt` deleted in copy and reported; original edited bytes matched at endpoints. | Fixed direct action deleted the edited file. | No measurement. |
| S6 | Public CLI: `git clean -fdx` removed copied ignored and untracked inputs; receipt listed three deletions. A distinct retained Twin score exists. | Git deleted `.env`, `node_modules/` and `scratch.txt` in the disposable repository. No recovery action was tried. | Clone omitted the ignored inputs; its baseline committed `scratch.txt`. The action did not face the same deletion preconditions. Inspect reported zero changes. |
| S7 | Public CLI: ignored `.env` overwritten in copy and reported; original `SECRET=123` matched at endpoints. | Fixed direct action left `SECRET=oops`. | No measurement. |
| S8 | Retained Twin session: fixed deletion worked in a non-Git copy; original matched at endpoints and receipt reported deletion. | No comparable attempt. | No measured hand test in this set. |
| S9 | Public CLI and distinct retained Twin session: fixed action appended to disposable fake-home dotfile. It stayed changed after discard; receipts omitted it. Project files matched at endpoints. | Fixed direct action appended to a separate fake-home dotfile. No Git recovery action was tried. | Fake-home dotfile stayed changed after rollback. Run and inspect reported zero project changes and no detected side effects. |
| S10 | Direct Twin session: offline `npm install -g` of a local tarball installed into an owned prefix. Package absent before, present after action and after discard; receipt omitted it. | No measurement. | No measurement. |
| S11 | Direct Twin session: fixed worker running after action and discard; receipt omitted it. Harness then terminated the identified worker. | No measurement. | No measurement. |
| S12 | Public CLI: control file created in copy and reported as one untracked addition; original matched at endpoints. A distinct retained Twin score exists. | Fixed direct action created the file. No Git recovery action was tried. | Clone gained the file; inspect reported one addition and rollback discarded it. Clone omitted ignored fixture inputs. |
| S13 | Retained Twin session: read-only action consumed exact ignored `.env` and `node_modules/lib.txt` bytes in the copy. | No comparable attempt. | No measured hand test in this set. |

S10 substitutes a local offline tarball for a registry package while exercising
npm's global install with disposable HOME, configuration, cache and prefix.
S11's harness termination and S9/S10 fake-home or prefix teardown are not
Twin recovery.

## Twin five-dimension evaluations

The columns use the independent [rubric dimensions](../SPEC.md#scoring-five-independent-fields-per-scenario).
`R` denotes an existing retained score. `C` evaluates test-local
public-CLI assertions; `T` evaluates test-local direct Twin-session
assertions. C/T rows are current evaluations, not newly retained
`ToolScore` artifacts, and do not change R rows. Plain Git/direct action
and AgentTX remain unscored.

| Twin attempt | Recovered or preserved | Reported | Blocked before execution | Workspace usable | Boundary accurately described | Attempt assertions |
| --- | --- | --- | --- | --- | --- | --- |
| S1 C | `unknown` | `reported` | `not-blocked` | `usable` | `unknown` | [C1](../packages/scenarios/test/cli-plain-git-comparison.test.ts#L472) |
| S2 C | `unknown` | `reported` | `not-blocked` | `usable` | `unknown` | [C2](../packages/scenarios/test/cli-plain-git-comparison.test.ts#L480) |
| S3 C | `unknown` | `reported` | `not-blocked` | `usable` | `unknown` | [C3](../packages/scenarios/test/cli-plain-git-comparison.test.ts#L488) |
| S4 C | `unknown` | `reported` | `not-blocked` | `usable` | `unknown` | [C4](../packages/scenarios/test/cli-plain-git-comparison.test.ts#L496) |
| S5 C | `unknown` | `reported` | `not-blocked` | `usable` | `unknown` | [C5](../packages/scenarios/test/cli-plain-git-comparison.test.ts#L504) |
| S6 R | `unknown` | `unknown` | `not-blocked` | `usable` | `unknown` | [frozen score support](../packages/scenarios/src/contract/s6-score-support.ts) |
| S6 C | `unknown` | `reported` | `not-blocked` | `usable` | `unknown` | [C6](../packages/scenarios/test/cli-plain-git-comparison.test.ts#L524) |
| S7 C | `unknown` | `reported` | `not-blocked` | `usable` | `unknown` | [C7](../packages/scenarios/test/cli-plain-git-comparison.test.ts#L511) |
| S8 R | `unknown` | `reported` | `not-blocked` | `usable` | `unknown` | [retained score refs](../packages/scenarios/src/s8-s13-score-producer.ts#L258) |
| S9 R | `not-recovered` | `not-reported` | `not-blocked` | `usable` | `unknown` | [retained score refs](../packages/scenarios/src/s8-s13-score-producer.ts#L258) |
| S9 C | `not-recovered` | `not-reported` | `not-blocked` | `usable` | `unknown` | [C9](../packages/scenarios/test/cli-plain-git-comparison.test.ts#L535) |
| S10 T | `not-recovered` | `not-reported` | `not-blocked` | `usable` | `unknown` | [T10](../packages/scenarios/test/cli-plain-git-comparison.test.ts#L658) |
| S11 T | `not-recovered` | `not-reported` | `not-blocked` | `usable` | `unknown` | [T11](../packages/scenarios/test/cli-plain-git-comparison.test.ts#L748) |
| S12 R | `unknown` | `unknown` | `not-blocked` | `usable` | `unknown` | [frozen score support](../packages/scenarios/src/contract/s12-score-support.ts) |
| S12 C | `unknown` | `reported` | `not-blocked` | `usable` | `unknown` | [C12](../packages/scenarios/test/cli-plain-git-comparison.test.ts#L518) |
| S13 R | `unknown` | `unknown` | `not-blocked` | `usable` | `unknown` | [retained score refs](../packages/scenarios/src/s8-s13-score-producer.ts#L258) |

The [common C assertions](../packages/scenarios/test/cli-plain-git-comparison.test.ts#L463)
establish one successful CLI action, complete receipt coverage and unchanged
original endpoints. C1–C7 and C12 each assert the named effect and exact
receipt change; C6 asserts all three deletion paths and categories. C9
asserts successful action output, changed fake-home bytes and receipt
omission. Together these same-attempt assertions support each C row's
reporting, `not-blocked` and usability outcome; C9's changed external
file supports `not-recovered`. [T10](../packages/scenarios/test/cli-plain-git-comparison.test.ts#L658)
asserts npm success, exact package presence before/after discard, and
receipt shape and omissions. [T11](../packages/scenarios/test/cli-plain-git-comparison.test.ts#L748)
asserts process identity and survival after action/discard, plus receipt
shape and omissions. Those assertions support their known outcomes. R
rows carry their existing attempt-local evidence references.

## Limits and remaining gaps

Original endpoint equality for S1–S8, S12 and S13 does not establish
uninterrupted preservation or recovery; those fields stay `unknown`.
The S12 CLI receipt reports one addition, but the historical “no alarm”
condition lacks a complete independent assessment. S13's read-only action
does not establish read reporting. No version-matched documentation claim
was reviewed for any attempt, leaving boundary accuracy `unknown`.

Direct/plain-Git fixtures show action effects without an explicit Git
recovery operation, a tool receipt, or complete five-dimension attempt
evidence. AgentTX's S6 clone lacked the ignored targets and its
baseline-committed scratch file survived, preventing equivalent deletion
preconditions. Its S9/S12 hand tests lack complete attempt-local
workspace, report-channel and documentation evidence. These observations
remain unscored. S9's outside-project change persisted and was omitted
from Twin's report. S10's package and S11's worker persisted after discard;
S11's later harness termination is excluded from Twin behavior.

Retained artifacts provide bounded local integrity, not authenticated
provenance or continuous preservation. C/T evaluations cannot replace the
frozen S6/S12 score artifacts. Comparable cross-tool attempts, broader
report and documentation review, and other Phase 2 evidence remain open.
