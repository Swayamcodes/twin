# Twin CLI

Twin runs a command in a full copy of the current project, including ignored files
and folders without Git. It prints a receipt and discards the copy after confirmed
settlement. Requires Node.js 24.2 or later.
`@twin-cli/cli@0.1.0` is publicly available on npm.

Licensed under MIT; see [LICENSE](LICENSE).

Install globally or use npx:

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

## Project shortcuts (unreleased checkout)

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
repeats unless explicitly overridden. Prompts are typed; custom commands require
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
