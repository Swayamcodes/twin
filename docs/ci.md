# CI checks

Pull requests and pushes to `main` use Node 24 and pnpm 12.6.0 with a frozen
lockfile. The CI job builds core, CLI and scenarios, checks strict TypeScript,
then runs core, CLI and the full scenario Vitest configuration sequentially.
The scenario run includes the retained comparison tests, which reopen the
historical and fresh JSON/Markdown pairs and check exact rendering. The
scenario configuration disables file-level parallelism to keep temporary-root
accounting serial; the CLI command does the same.

At the consumer-correction checkpoint, the six affected scenario suites passed
separately. The exact scenario CI command passed locally with 34 files and 970
tests; its disposable roots and test processes were cleaned up. [Hosted CI run
36895279632](https://github.com/Swayamcodes/twin/actions/runs/36895279632)
subsequently completed successfully at `22985f4d7d124f3ca37bda91dd030b5de8e4569a`.

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
credentials in scenario fixtures, or the developer's real home. [Manual run
36895684935](https://github.com/Swayamcodes/twin/actions/runs/36895684935)
completed successfully at the same commit. Its downloaded pair reopens as a
complete 39-attempt result with exact Markdown, a clean source-tree identity,
and 40 allocated and removed roots with none retained. This verifies those
specific hosted runs; later runs need their own checks. See the [Phase 6
acceptance review](phase-6-acceptance.md).
