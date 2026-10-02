# Twin

Twin runs a command in a complete copy of the current project, including Git-ignored files and projects without Git. It observes changes in the copy, prints a receipt, and can discard the copy or apply reviewed changes to the original. Git classifies files in the receipt; it does not decide what Twin copies.

Read the [public write-up](docs/twin-public-write-up.md) for the workflow, evidence, limits, and scripted demo.

## Landing and results pages

The Phase 7 web app lives in `packages/web`. From this checkout, run `pnpm install --frozen-lockfile` and `pnpm --filter @twin-cli/web dev` to preview it, or `pnpm --filter @twin-cli/web build` for a static production export in `packages/web/out`. The results page reads the committed [Phase 6 JSON](docs/phase-6-results-2297bf07/comparison.json) at build time. It displays that retained attempt set, not the historical Phase 2 file or a fresh hosted run. The terminal playback is a separate, unpaid fixed-command demonstration with actual text receipt output.

The landing/results checkpoint is functionally complete; visual polish is deferred to a separate checkpoint.

The [final Phase 7 acceptance review](docs/phase-7-acceptance.md) closes the approved functional scope after correcting the timeout-fixture readiness race; full core passed 172/172. Website visual polish remains deferred, and only local web export is verified; hosted deployment is unverified.

**A copy is a snapshot, not an OS sandbox.** The command runs with the caller's permissions. An absolute path to the original, a home-directory file, or another path outside the copy can still be changed. Twin observes only its documented outside-project watch paths and configured global npm prefix; it does not roll back external changes. Its process-group settlement does not prove that a descendant which escapes the group has stopped. See the [architecture and limits](ARCHITECTURE.md#documented-limits-known-from-step-13-findings-and-reasoning).

## Install and run

`@twin-cli/core@0.1.0` and `@twin-cli/cli@0.1.0` are publicly available on npm under the [MIT license](LICENSE). The CLI requires Node.js 24.2 or later:

```sh
npm install --global @twin-cli/cli@0.1.0
twin --help
twin run -- node script.js
# Or use npx without a global install:
npx --package=@twin-cli/cli@0.1.0 twin --help
```

For the reusable engine, install `npm install @twin-cli/core@0.1.0`. The [release record](docs/npm-release.md) documents publication, registry-install verification, and the smoke check's expected incomplete coverage and repeated `prefix-unset` text issue.

## Build and run from this checkout

Use Node 24 and the repository-pinned pnpm 12.6.0. From this repository:

```sh
pnpm install --frozen-lockfile
pnpm run build:core
pnpm exec tsc -p packages/cli/tsconfig.json
```

Then run from the project you want Twin to copy. Replace the two absolute paths with your built checkout and command executable:

```sh
cd /path/to/project
node /path/to/twin/packages/cli/dist/index.js run -- /absolute/path/to/command arg1 arg2
```

The default run captures command output, writes it to the usual streams, prints a framed JSON receipt on stderr, and discards the copy after confirmed settlement. The receipt labels file changes as tracked, untracked, ignored, or unclassified and gives bounded dependency, command, process, and watched-path observations. Incomplete coverage remains explicit. `--receipt=text` selects a bounded human receipt. `--interactive` inherits stdin, stdout and stderr so a headless command can interact with the terminal; command output is then not captured, and Twin does not allocate a PTY:

Add `--receipt-html=/path/to/receipt.html` before `--` to export the same bounded observations as a standalone, script-free HTML file while retaining the selected JSON or text output on stderr. Twin refuses to overwrite an existing destination. A failed export exits nonzero while Twin still handles review or discard. The HTML shares the text receipt's presentation limits; use the JSON receipt for omitted entries.

```sh
node /path/to/twin/packages/cli/dist/index.js run --interactive --receipt=text -- /absolute/path/to/command arg1 arg2
```

To inspect a settled copy before deciding, use review mode:

```sh
node /path/to/twin/packages/cli/dist/index.js run --receipt=text --review -- /absolute/path/to/command arg1 arg2
```

At the prompt, type `apply` to run Twin's three-state conflict checks and apply the copy's changes, or `discard` to remove it. EOF, interruption, or another answer retains the copy for manual inspection. Review and apply are available only during that invocation; a later Twin command cannot resume a retained session. Apply plans all changes before writing, but a later I/O failure can leave earlier paths changed. See the [CLI usage guide](docs/cli-usage.md) and `node packages/cli/dist/index.js run --help` from this checkout.

## Fixed-action comparison

The [retained version-one JSON](docs/phase-6-results-2297bf07/comparison.json) and its [deterministic Markdown](docs/phase-6-results-2297bf07/comparison.md) record 39 S1–S13 attempts through Twin, AgentTX 0.3.0, and plain Git. The earlier [Phase 2 result](docs/phase-2-comparison.json) is separate historical evidence. A [hosted fresh comparison](https://github.com/Swayamcodes/twin/actions/runs/36895684935) at `22985f4` completed all 39 attempts; it did not revise either committed result or its scores.

| Fixed-action evidence | Observed boundary |
| --- | --- |
| S3 and S13 ignored inputs | Twin's copied workspace had the required inputs. AgentTX's workspace lacked them; the fixed actions failed and workspace usability was scored `unusable`. |
| S8 folder without Git | Twin ran the deletion action in its copy. AgentTX refused the non-Git project; whether its fixed action started and whether it blocked before execution remain `unknown`. |
| S9 fake-home write | The external file stayed changed after Twin discard, AgentTX rollback, and plain-Git recovery; none of these attempts reported the effect. Fixture teardown is not tool recovery. |
| S6 AgentTX on the hosted run | The action completed with exit 0, but its observed effect differed from the equivalent deletion condition. Pre-action ignored-input presence was not independently established, so all five fields remain `unknown`. |

Every row reasons independently about **recovered or preserved**, **reported**, **blocked before execution**, **workspace usable**, and **boundary accurately described**. `unknown` is an evidence limit, not a failure or a pass. There is no total, ranking, or inferred winner. Action output is separate from a tool's report; for example, plain Git's S6 removal text earns no reporting credit. The [comparison explanation](docs/measured-comparison.md) and [scenario catalog](docs/scenario-catalog.md) give the conditions and limits behind these observations.

The [Codex/Claude compatibility matrix](docs/compatibility-matrix.md) covers plain-command use. Codex `exec` was verified for the recorded version with an ignored input, a Git apply, a non-Git discard, and an interruption. Claude Code's launch, receipt, settlement, and discard were verified, but insufficient API credit stopped model-backed editing and apply after an edit. The funded Claude rerun is optional and on an indefinite budget hold; those cells remain unverified. Neither check establishes support for a full terminal UI.

## Reproduce and verify

With Node 24, pnpm 12.6.0, `/usr/bin/git`, and AgentTX **exactly 0.3.0**, run from this repository using a new absolute output directory under an existing canonical parent:

```sh
pnpm run compare:fixed-suite --output-dir /absolute/path/to/new-output-directory
```

This command builds the required packages, checks prerequisites before fixed actions, and writes versioned `comparison.json` and deterministically rendered `comparison.md`. An operationally incomplete run exits nonzero and, when publication succeeds, records its completed prefix and failure. The [fixed-suite guide](docs/phase-6-fixed-suite.md) explains fixture ownership, execution digests, cleanup, and reproducibility limits. The suite uses scripted actions and makes no AI or model calls.

[CI](docs/ci.md) runs builds, strict TypeScript checks, core and CLI tests, all scenario tests, and retained-result validation on pull requests and main pushes. To request a hosted fixed suite, open [Full fixed-action comparison](https://github.com/Swayamcodes/twin/actions/workflows/fixed-comparison.yml) in GitHub Actions and select **Run workflow**. That manual workflow installs AgentTX 0.3.0 on an ephemeral Linux runner and uploads the sanitized JSON/Markdown pair, including a published incomplete pair when a comparison attempt fails. See the [Phase 6 acceptance record](docs/phase-6-acceptance.md) for verified hosted runs and remaining limits.
