# Phase 4 receipt acceptance review

Review date: 2026-10-01. This checklist tests the planned receipt checkpoints
against [SPEC.md](../SPEC.md)'s relevant v1 receipt and watch-list requirements.
It assesses current observations, not the later apply or scenario-suite work.

| Checkpoint | Evidence | Decision and limit |
| --- | --- | --- |
| Files and Git labels | `packages/core/src/manifest.ts`, `packages/core/src/receipt.ts`, `packages/core/test/receipt.test.ts`, `packages/core/test/run.test.ts`, `packages/scenarios/test/cli-plain-git-comparison.test.ts` | Supported for before/after file differences with tracked, untracked, ignored and unclassified labels. Partial scans stay partial. Reads and transient changes reverted before the final scan are not recorded. |
| Project dependencies | `packages/core/test/dependencies.test.ts` | Supported for root `package.json` declaration strings and supported whole-lockfile digests, with incomplete/unavailable coverage for bad inputs. Installed packages are separate. |
| Global npm packages | `packages/core/test/global-npm.test.ts`, `packages/cli/test/global-npm.test.ts`, current S10 offline comparison test | Supported for installed package metadata under an established effective prefix, within inventory limits. An unknown prefix or incomplete inventory is not a clean result. Discard does not restore packages. |
| Outside-project watch list | `packages/core/test/receipt.test.ts`, current S9 comparison test | Supported for the fixed watched paths only. Other outside-project effects are unobserved; watch changes are not recovered by discard. |
| Top-level command | `packages/core/test/command-receipt.test.ts`, `packages/cli/test/run.test.ts` | Admission, confirmed start and observed disposition are reported with bounded disclosure. Nested commands are not traced. |
| Process group and Twin intervention | `packages/core/test/run.test.ts`, current S11 comparison test | Direct-child and original-group observations, pipe state and Twin signal attempts are reported. Delivery does not prove termination. Escaped descendants and identities are unobserved; harness cleanup earns no Twin credit. |
| Human and JSON presentation | `packages/cli/test/receipt-text.test.ts`, `packages/cli/test/run.test.ts`, `packages/cli/test/global-npm.test.ts`, public CLI comparison test | Explicit text mode is bounded, escapes control characters and marks incomplete coverage. Default schema-5 JSON framing is unchanged. |

**Acceptance decision: hold Phase 4 closure against the literal v1 receipt
requirement.** SPEC.md says the receipt reports *every file touched*. Current
file observation is a before/after manifest difference. A file that is read
without changing, or changed and restored before the final scan, leaves no
file-change entry. No existing test or observation path establishes a complete
history of accesses or transient writes. The bounded checkpoint above is
implemented and tested, but it does not satisfy that literal requirement.
This decision does not turn unobserved nested commands, escaped processes or
unwatched outside-project changes into additional invented Phase 4 gates.

Verification for this review ran the focused receipt and runner suites, the
full core and CLI suites, the public CLI comparison, and S6/S12 consumer
suites. Strict core, CLI and scenario TypeScript/build checks and whitespace
checks passed. The consumer suites were run separately because their root
accounting uses a shared temporary-directory inventory. Fixture processes
were observed stopped before removal; final owned-root and live-test-process
inventories were empty. The review found no new workload or observation launch
path, schema change, or default-frame change in the presentation slice.

Apply and agent compatibility remain Phase 5; automation and CI remain Phase 6;
web and release remain Phase 7. Copy optimization remains separately outstanding.
