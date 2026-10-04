# Twin CLI

Twin runs a command in a full copy of the current project, including ignored files
and folders without Git. It prints a receipt and discards the copy after confirmed
settlement. Requires Node.js 24.2 or later.
This checkout prepares `@twin-cli/cli@0.1.1`, **unpublished** until registry publication is confirmed. It requires exact `@twin-cli/core@0.1.0` and `@inquirer/select@5.2.5`. Published CLI 0.1.0 remains available.

Licensed under MIT; see [LICENSE](LICENSE).

Install the currently published version globally or use npx:

```sh
npm install --global @twin-cli/cli@0.1.0
npx --package=@twin-cli/cli@0.1.0 twin --help
npx --package=@twin-cli/cli@0.1.0 twin run -- /absolute/path/to/command arg1 arg2
```

```sh
twin --help
twin run -- node script.js
twin run -- /absolute/path/to/command arg1 arg2
twin run --receipt=text --review -- /absolute/path/to/command arg1 arg2
twin run --receipt-html=/absolute/path/to/new-receipt.html -- /absolute/path/to/command arg1 arg2
```

JSON receipts are framed on stderr by default. Text and standalone HTML receipts
are bounded presentations of the same observations. HTML export refuses an
existing destination. Export failure exits nonzero while review and cleanup
continue. Review accepts `apply` or `discard` in the same invocation; other input,
EOF, or interruption retains the copy for manual inspection.

This is project-copy isolation, not an OS sandbox. Commands retain your permissions.
Outside-project changes are not rolled back. Escaped descendants are unobserved.
See the [CLI guide](https://github.com/Swayamcodes/twin/blob/main/docs/cli-usage.md)
for stdio behavior, apply limits, compatibility, and receipt disclosure limits.

To build from a checkout, use the [root README](https://github.com/Swayamcodes/twin#build-and-run-from-this-checkout).
The [release record](https://github.com/Swayamcodes/twin/blob/main/docs/npm-release.md)
notes the registry smoke's expected incomplete coverage and repeated `prefix-unset`
text issue, which remains deferred.

## Project shortcuts (0.1.1 candidate, unpublished)

`twin init` creates project-root `twin.config.json` without launching an agent
or making network calls. It writes a private sibling file, closes it, and
publishes exclusively without overwriting existing config; an interrupted write
cannot expose a partial config. It explicitly
asks **interactive chat or one-shot execution**, then asks separately for the
one-shot task, additional arguments as a JSON string array, review and receipts.
Codex commands are `["codex"]` or `["codex", "exec", "task"]`; Claude commands
are `["claude"]` or `["claude", "-p", "task"]`. Additional arguments such as
Codex's `--skip-git-repo-check` remain separate array elements. Task spaces are
preserved; empty or whitespace-only tasks are rejected. A saved one-shot task
repeats unless explicitly overridden. TTY choices use arrow-key menus, with typed task text and JSON argv; non-TTY
prompts are typed. Custom commands require
manually authored config or an explicit command after `--`.

Use bare `twin` or commandless `twin run` from that directory. Explicit CLI
options override config, then existing defaults apply. `-i`, `-r`, and `-t text`
alias `--interactive`, `--review`, and `--receipt=text`. `--no-interactive` and
`--no-review` override saved true values. Conflicting positive/negative flags
and repeated options are rejected. An explicit command
after `--` replaces the entire saved command; all its arguments pass unchanged.
Overrides are never saved. Optional config `timeoutMs` accepts an integer from
1 through 3,600,000. Invalid config is rejected before execution; without config,
use `twin init` or `twin run -- <executable> [args...]`.

These conveniences are not in published 0.1.0. Claude's funded conversation
verification remains on budget hold. See the CLI guide for example configs
and the unchanged execution and safety limits.


## Terminal presentation (0.1.1 candidate, unpublished)

TTY text runs use the approved orchid/plum static wordmark, stationary
“Preparing project copy…” feedback, and compact receipts with command outcome,
observed changes and attention first. Brand colors remain separate from outcome
colors; successful command completion does not establish safety. No copying,
execution, cancellation timing or cleanup policy changes accompany the display.

TTY init defaults its receipt menu to Text. Existing configs and explicit-run
JSON defaults are preserved. TTY review offers Apply changes, Discard copy, and
**Cancel and retain copy** (default); non-TTY review keeps typed `apply`,
`discard` or `cancel`. Esc, EOF and interruption retain the copy. Menus release
terminal input before workload handoff. `NO_COLOR=1` keeps the TTY layout in
monochrome; `TERM=dumb` uses plain output/typed fallback.

JSON runs have no decorative startup/preparation output on stderr; the existing
exact-byte frame is unchanged. Explicit review still prompts after that frame.
The existing plain/HTML receipts retain bounds, escaping and disclosures; HTML
never receives terminal colors. No agent verification is inferred from this
presentation checkpoint; Claude's funded conversation rerun remains on hold.

## Install the unpublished candidate locally

After packing this checkout with pnpm, install the inspected tarball:

```sh
npm install --global /absolute/path/to/twin-cli-cli-0.1.1.tgz
twin --help
```

The install fetches published core 0.1.0 and the menu dependency from npm. Do not use a registry `@twin-cli/cli@0.1.1` install until publication is confirmed. Captured runs default to 60,000 ms; interactive runs default to 3,600,000 ms. `--timeout-ms=<integer>` overrides config `timeoutMs` and accepts 1–3,600,000 ms. Deadlines cover command runtime, not preparation or review.
