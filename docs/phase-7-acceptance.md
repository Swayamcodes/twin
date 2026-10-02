# Phase 7 acceptance review

Reviewed on 2026-10-02 at `060cbf783c0023b282531a7a74012274e43e0a6f`,
starting from a clean working tree. **Decision: PASS — Phase 7 is closed
against the approved functional scope.** The initial core failure is retained
below. Subsequent investigation identified a timeout-fixture readiness race;
after the test synchronization correction, the focused runner suite passed
48/48 and the full core suite passed 172/172. Production escalation and the
`SIGKILL` assertion are unchanged. No other recorded acceptance failure remains.

Website visual polish remains explicitly deferred. This review checked
functionality and evidence, without revisiting design. A local production
export is verified; an actual hosted website deployment is not established
by this review and is not an additional acceptance requirement.

## Approved scope

| Acceptance item | Result | Evidence |
| --- | --- | --- |
| Landing/results functional first pass | PASS | Web lint, strict TypeScript, and production build/export exited 0. Local Chromium checks at 1440 and 390 pixels verified published setup commands, the isolation warning, labelled terminal content, focusable playback controls, and reduced-motion final-frame behavior. Results showed all 39 retained rows; all 195 outcomes, reasons, and evidence-reference lists matched the source JSON. Scenario/tool filtering, reset, and keyboard Tab between filters passed. |
| Results provenance and source links | PASS | The build-time loader uses [retained Phase 6 JSON](phase-6-results-2297bf07/comparison.json), not a duplicate dataset. Recorded source remains `2297bf07` / dirty tree. Historical Phase 2 and later hosted CI observations are identified separately. Seven pinned website source targets were checked against the actual Git objects at `3019b52`; all 13 scenario line links point to their definitions there. |
| Standalone HTML receipts | PASS | The CLI suite passed 79 tests, including the three HTML-renderer cases and export integration cases. Coverage includes complete/incomplete receipts, hostile values and disclosure limits, the 64 KiB bound, overwrite refusal, export failure with cleanup/review, and preserved default JSON/text behavior. HTML is self-contained and script-free, with no external fonts/assets. The recorded registry smoke separately exercised real HTML export. |
| Published npm 0.1.0 packages | PASS | Anonymous registry queries exited 0 for both scoped versions: MIT, Node `>=24.2.0`; CLI maps `twin` to `dist/index.js` and depends on exactly `@twin-cli/core: 0.1.0`. The [release record](npm-release.md) documents the user-reported successful global install, npx help, and registry-installed bare-Node/text/HTML smoke with unchanged original. No new installation, publication, or smoke action was needed here. |
| Scripted demo | PASS | Both timed and static replay of the committed [recording](phase-7-demo/README.md) exited 0 and reproduced its output byte-for-byte. The action was not rerun. Committed verification records ignored input in the copy, `before\n` unchanged through review, `after\n` after apply, exit 0, process settlement, and cleanup. It is an unpaid fixed command, not an AI-agent execution; the older landing playback is separate evidence. |
| Public write-up | PASS | The committed [article](twin-public-write-up.md) links the workflow, published commands, scenario evidence, and replay instructions. Claims were checked against retained rows, the historical hand-test record, release/demo records, and the compatibility matrix. It preserves version/attempt distinctions and unknown scores without rankings. Repository availability is not a claim of external article publication. |
| Core regression suite | PASS | Initial unrestricted execution: 171/172 tests across nine files, exit 1, observing `SIGTERM` instead of expected `SIGKILL`. After correcting fixture readiness synchronization: focused runner 48/48, exit 0; full core 172/172 across nine files, exit 0. Production escalation and the `SIGKILL` assertion are unchanged. Details below. |
| CLI regression suite | PASS | Eight files, 79/79 tests, exit 0 in the unrestricted execution. |
| Full serial scenario regression | PASS | 34 files, 970/970 tests, exit 0. The existing configuration disables file parallelism and uses one worker. This includes comparison parser/rendering tests; it is not a new 39-attempt cross-tool comparison run. |
| Builds and strict TypeScript | PASS | Core, CLI, and scenario builds; core production/test, CLI production, and scenario production/test strict checks all exited 0. Web lint/typecheck/build also exited 0. |
| Retained-result parser/rendering | PASS | Full-suite comparison-entry (12 tests) and comparison-result (5 tests) passed. A direct compiled parser/renderer check reopened both committed JSON files and reproduced each Markdown file byte-for-byte; both contain 39 rows. No scores or evidence were changed. |
| Documentation links and scope | PASS | Before adding this record, 61 local references across root/package READMEs, article, release guide, demo guide, and compatibility matrix resolved, including anchors. This record's local links and the README link were also checked. The initial review had two documentation files in scope; closure checks confirm exactly README.md, this document, and packages/core/test/run.test.ts, with clean whitespace. |

## Commands and execution conditions

Node was `v24.21.0`; installed pnpm was `12.6.0`. Commands below used the
existing dependency installation. Direct Node entry points are equivalent
to the repository's pnpm/CI invocations; no dependencies were installed or
changed. Strict settings come from the existing tsconfig files.

From the repository root, each build/type check exited **0**:

```sh
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --types node
node node_modules/typescript/bin/tsc -p packages/cli/tsconfig.json
node node_modules/typescript/bin/tsc -p packages/scenarios/tsconfig.json
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --types node --noEmit
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.test.json
node node_modules/typescript/bin/tsc -p packages/cli/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p packages/scenarios/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p packages/scenarios/tsconfig.test.json
```

The suite commands, run sequentially:

```sh
node node_modules/vitest/vitest.mjs run --config packages/core/vitest.config.ts
node node_modules/vitest/vitest.mjs run --config packages/cli/vitest.config.ts --no-file-parallelism --maxWorkers=1
node node_modules/vitest/vitest.mjs run --config vitest.config.ts
```

The first execution was inside the tool sandbox. Git launch and Unix socket
creation returned `EPERM`; some child-output/signal checks also failed.
Tool instructions require retrying sandbox-blocked commands outside that
restriction. Accordingly, the three suites received **one unrestricted
retry**, with unchanged commands/tests and a new owned TMPDIR. This was an
environmental retry, not an omitted failure or a repeated acceptance loop.

| Suite | Initial restricted execution | Initial unrestricted retry |
| --- | --- | --- |
| Core | Exit 1; 140 passed / 32 failed, nine files | Exit 1; 171 passed / 1 failed, nine files |
| CLI | Exit 1; 69 passed / 10 failed, eight files | Exit 0; 79 passed, eight files |
| Scenarios | Exit 1; 870 passed / 82 failed, 34 files; collection failures left 952 tests enumerated | Exit 0; all 970 passed, 34 files |

Checks used an owned fake home, controlled PATH, separate empty npm
configuration files, an owned prefix/cache, and an owned TMPDIR shared with
children. stdin was EOF. Captured stdout/stderr, argv, environment, exits,
and timings remain in the review's external audit directory; no credentials
or real home contents were captured.

From `packages/web`, all exited **0**:

```sh
node node_modules/eslint/bin/eslint.js src
node ../../node_modules/typescript/bin/tsc --noEmit
node node_modules/next/dist/bin/next build --webpack
```

The build exported `/`, `/results`, and the not-found page under
`packages/web/out`. Next's generated `next-env.d.ts` change was restored to
its captured pre-check bytes so the tracked scope remained documentation
only. A temporary localhost server served that export for the browser
checks. The first browser probe checked before hydration finished; a longer
wait resolved the probe without changing website code. No visual iteration
or deployment occurred.

Anonymous registry commands both exited **0**:

```sh
npm view @twin-cli/core@0.1.0 name version bin dependencies license engines --json --registry=https://registry.npmjs.org
npm view @twin-cli/cli@0.1.0 name version bin dependencies license engines --json --registry=https://registry.npmjs.org
```

Committed demo replay, each exit **0**, with stdout byte-identical to the
recording and empty stderr:

```sh
python3 docs/phase-7-demo/demo.py --replay docs/phase-7-demo/demo.cast
python3 docs/phase-7-demo/demo.py --replay docs/phase-7-demo/demo.cast --static
```

## Initial core failure and readiness correction

In [run.test.ts](../packages/core/test/run.test.ts), the case
`direct execution > times out and settles direct child: stubborn` failed at
line 622 during the initial unrestricted suite (171/172, exit 1):

```text
AssertionError: expected 'SIGTERM' to be 'SIGKILL'
Expected: "SIGKILL"
Received: "SIGTERM"
```

The runner arms the timeout immediately after spawn, before the child's
JavaScript necessarily executes. The fixed stubborn child installs an empty
SIGTERM handler, prints `ready`, and stays alive. The original test did not
wait for readiness before its 500 ms deadline. A spawn event alone does not
establish handler registration.

Controlled fixed-Node diagnostics through unchanged core separated the two
states. Delaying handler registration beyond the deadline reproduced the
failure shape; a ready handler exercised the expected escalation:

| Handler state at timeout | Captured stdout | Observed termination | Elapsed |
| --- | --- | --- | --- |
| Not ready; no handler marker | Empty | `SIGTERM` only; child exited with `SIGTERM` | 587 ms |
| Ready; handler marker present | `ready` | `SIGTERM`, then `SIGKILL`; child exited with `SIGKILL` | 1527 ms |

This supports a fixture readiness race. Production correctly waits its
one-second grace period and escalates when the ready child ignores SIGTERM;
it does not need to escalate after an unready child already exits on SIGTERM.

The correction is confined to the existing timeout test in
`packages/core/test/run.test.ts`. The stubborn fixture writes
`timeout-ready.pid` after handler registration and readiness output. The
test holds its timeout clock until that marker is observed, then advances
the original 500 ms deadline and 1000 ms escalation grace period. It still
requires `SIGKILL` and exact `ready` output. It verifies child PID and group
absence before fixture removal; failure cleanup requests interruption and
waits for settlement. Production code and the cooperative timeout case's
signal expectation are unchanged.

The authorized correction checks, in this order, each exited **0**:

```sh
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.test.json
node node_modules/vitest/vitest.mjs run --config packages/core/vitest.config.ts packages/core/test/run.test.ts
node node_modules/vitest/vitest.mjs run --config packages/core/vitest.config.ts
```

Strict test TypeScript passed; the focused suite passed **48/48 in one
file**, followed by the full core suite passing **172/172 across nine
files**. The focused and full suites each ran once after the correction.
No already-passing unrelated suite was rerun. The initial failure and
restricted-execution results above remain part of the record.

## Preserved limits and cleanup

- Project-copy isolation is not an OS sandbox. Commands retain caller
  permissions and can write outside the copy, including to the original.
- Receipts observe bounded before/after state, not reads or transient
  changes reverted within a run. Incomplete coverage is not a clean result.
- Outside-project changes are not recovered. Watches cover only documented
  paths; global npm observations require an explicit prefix. The published
  smoke's missing manifest/unset prefix and repeated `prefix-unset` text
  remain documented, unchanged limits/deferred issues.
- Observed process-group settlement does not establish escaped-descendant
  containment. Historical S11 outcomes remain historical; newer unknowns
  are not rewritten as recovery successes.
- Apply retains its conflict, unsupported-path, complete-inventory,
  same-user race, and non-atomic multi-path limits. A failed apply may have
  changed earlier paths. Retained sessions cannot resume in a later CLI call.
- AgentTX observations remain version/attempt-specific. S6 preconditions,
  all five independent scores, unknowns, and historical evidence are
  unchanged; local execution digests do not authenticate provenance.
- [Claude's model-backed verification](compatibility-matrix.md) remains
  unverified under the optional indefinite budget hold. Full terminal UIs
  and deferred agents remain outside the verified compatibility scope.

The restricted execution left 21 entries in its owned scratch directory;
the unrestricted run left three Vitest temporary entries. Before removing
either tree, a same-UID `/proc` check found no process references through
cwd, executable, open descriptors, or fixture argv, with no unreadable raced
processes. These observations do not claim escaped-descendant containment.
Both scratch trees, browser scratch/profile, fake home, prefix, and npm cache
were removed. The local HTTP server and browser closed. Audit captures and
ignored build/export outputs remain available for inspection; no demo action,
paid agent, standalone 39-attempt comparison, publication, or deployment was run.

The correction's 48 focused and 174 full-core fixture-accounting records
balanced, with no remaining Twin roots. Test runners/groups were absent,
and no processes referenced the owned investigation directories before its
temporary home/scratch were removed. Diagnostic child/group settlement was
also checked before removal. Captures remain outside the repository.

Final scope is `README.md`, `docs/phase-7-acceptance.md`, and
`packages/core/test/run.test.ts`. Closure updated only the documentation and
preserved the tested correction exactly. All tracked paths outside that
scope, HEAD, staged diff, and stash reference match the captured snapshots.
Nothing was staged, committed, pushed, or published.
