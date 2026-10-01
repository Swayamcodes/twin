# CI checks

Pull requests and pushes to `main` use Node 24 and pnpm 12.6.0 with a frozen
lockfile. The CI job builds core, CLI and scenarios, checks strict TypeScript,
then runs core, CLI and the full scenario Vitest configuration sequentially.
The scenario run includes the retained comparison tests, which reopen the
historical and fresh JSON/Markdown pairs and check exact rendering. The
scenario configuration disables file-level parallelism to keep temporary-root
accounting serial; the CLI command does the same.

At this checkpoint, the six corrected scenario consumer suites pass separately.
The exact scenario CI command passes locally with 34 files and 970 tests; its
disposable roots and test processes are fully cleaned up. Hosted GitHub Actions
execution remains unverified.

The separate **Full fixed-action comparison** workflow runs only by manual
dispatch. It installs AgentTX exactly 0.3.0 on an ephemeral Ubuntu runner,
then uses the [existing fixed-suite command](phase-6-fixed-suite.md) for all
39 attempts. The runner checks AgentTX identity and version before launching
actions. The workflow uploads only `comparison.json` and `comparison.md` from
the explicit output directory, including an incomplete pair if an attempt
fails. An incomplete command remains a failed job; unknown scenario scores
remain valid evidence. Setup or publication failures may leave no pair to
upload.

Both workflows use read-only repository permission, pinned action commits,
and bounded job durations. Neither workflow uses paid agents, repository
credentials in scenario fixtures, or the developer's real home. Hosted runs
must be checked in GitHub Actions after the workflows are pushed.
