# Current measured comparison

## Scope and evidence

This is a partial Phase 2 comparison at HEAD `271c0427adf4ad42abf7f0a31e1c88e4522c6b21`. It combines the committed retained Twin measurements, the public Twin CLI versus direct plain-Git fixture observations, and the AgentTX 0.3.0 hand tests. The runs used separate disposable projects and, for S9, disposable fake homes. They are observations of these fixed actions, not a completed cross-tool benchmark.

Evidence: [retained Twin S12/S6 results and S8/S13/S9 measurements](phase-2-build-log.md), [CLI/plain-Git comparison test](../packages/scenarios/test/cli-plain-git-comparison.test.ts), [AgentTX hand-test record](phase-2-build-log.md#agenttx-030-s12s6s9-hand-test-checkpoint), and [scenario conditions](scenario-catalog.md). The Twin five-dimension outcomes below come from the retained score results; CLI receipt assertions and the AgentTX hand tests are separate observations.

## S12, S6 and S9 observations

| Scenario | Twin | Plain Git/direct action | AgentTX 0.3.0 hand test |
| --- | --- | --- | --- |
| S12 — create `control-created.txt` | The action created the file in Twin's copy. The original was unchanged at observed endpoints; the CLI receipt listed one added untracked file. | The fixed Node action created the file directly in the disposable repository. This control did not exercise a Git recovery operation. | The clone gained the file and the original remained unchanged. Inspect reported one added file; rollback discarded that change and removed the clone. The clone omitted ignored fixture inputs. |
| S6 — `git clean -fdx` | The copy contained `.env`, `node_modules/lib.txt` and untracked `scratch.txt`; the action deleted them there. The original was unchanged at observed endpoints. The CLI receipt listed the three file deletions with ignored or untracked categories. | The command deleted `.env`, `node_modules/` and `scratch.txt` in the disposable repository. The comparison observed their absence after the action; it did not perform a Git recovery operation. | AgentTX's clone omitted the ignored `.env` and `node_modules/lib.txt`, while its baseline commit included `scratch.txt`. The command removed none of those inputs in its clone: they did not have the same deletion preconditions as Twin and plain Git. The original retained them. Inspect reported zero file changes and rollback discarded zero changes. |
| S9 — append outside the project | The fixed action appended one line to `.s9-note` in a separate fake home. That outside-project change remained after Twin discard. The CLI and retained Twin receipts omitted `.s9-note`; the project file inventory stayed unchanged. | The same action appended the line to the disposable fake-home dotfile while the direct project's files stayed unchanged. The comparison did not perform a Git recovery operation. | The action reported success and appended the line to the fake-home `.s9-note`. It remained changed after rollback; project files stayed unchanged. Run and inspect reported zero file changes and no detected side effects; rollback discarded zero changes and removed the clone. |

AgentTX's S6 result shows preservation of its original project during this run, but its clone did not present the ignored inputs or an untracked `scratch.txt` to the deletion action. Its zero-change report cannot establish what it would do under the Twin/plain-Git S6 deletion preconditions. For S9, the changed fake-home file was observed before harness cleanup; that cleanup was not tool recovery.

## Twin S8 and S13 usability measurements

- **S8, non-Git directory:** Twin copied `delete-me.txt` into a usable workspace. The fixed action deleted it in the copy, the original matched at observed endpoints, and the retained receipt reported the deletion. This measures the fixed non-Git action, not continuous preservation or general non-Git coverage.
- **S13, ignored inputs:** Twin's returned copy contained the verified `.env` and `node_modules/lib.txt` bytes. The read-only action consumed both and completed in the copy. It made no file change, so no read-reporting claim follows from the receipt. This measures those fixed ignored inputs, not generalized dependency usability.

## Retained Twin outcomes only

The columns follow the five independent dimensions in [SPEC.md](../SPEC.md). These are existing **Twin** outcomes. The plain-Git and AgentTX observations above have **no five-dimension scores** in this evidence set.

| Twin scenario | Recovered or preserved | Reported | Blocked before execution | Workspace usable | Boundary accurately described |
| --- | --- | --- | --- | --- | --- |
| S12 | `unknown` | `unknown` | `not-blocked` | `usable` | `unknown` |
| S6 | `unknown` | `unknown` | `not-blocked` | `usable` | `unknown` |
| S9 | `not-recovered` | `not-reported` | `not-blocked` | `usable` | `unknown` |
| S8 | `unknown` | `reported` | `not-blocked` | `usable` | `unknown` |
| S13 | `unknown` | `unknown` | `not-blocked` | `usable` | `unknown` |

The retained S12/S6 score path does not retain the CLI receipt as reporting evidence; Git stdout is action output. Their `reported` fields therefore remain `unknown` despite the separate CLI receipt observations. Matching original endpoints alone do not prove uninterrupted preservation or recovery. S9's historical identical-file condition fails because the external dotfile remained changed.

## Limits and remaining gaps

The CLI/plain-Git comparison is direct execution on independent disposable fixtures, without a plain-Git recovery recipe or five-dimension scoring. The AgentTX results are hand tests of version 0.3.0; its S6 clone inputs differ from Twin's and the direct Git fixture's. AgentTX's baseline trees were inspected after execution, not through a separate live pre-action snapshot. Neither the plain-Git observations nor AgentTX's output should be converted into inferred scores.

Twin's retained artifacts provide bounded local evidence, not authenticated provenance, crash-atomic publication or continuous preservation. S8 and S13 cover fixed actions and inputs. S9's current receipt does not report the outside-project mutation; watch-list coverage for this dotfile and broader reporting remain gaps. Cross-tool scoring under comparable preconditions, broader scenario coverage, and the remaining Phase 2 evidence work are still open.
