# Twin CLI review flow

Run a command from the project directory:

```sh
twin run -- node script.js
twin run -- /absolute/path/to/node script.js
```

Use a bare executable name or an absolute executable path. The CLI resolves bare
names by checking PATH entries in order for an executable regular file, using
filesystem APIs without a resolver subprocess. It uses the same environment map
that it passes to the command. Empty and relative PATH entries are relative to
the copy's working directory; symbolic links to executable regular files are
followed, and the absolute candidate path is passed to core. Missing PATH has no
candidates; a failed search exits nonzero without starting the action. Relative
executable paths containing `/` are not accepted. Absolute paths pass unchanged
to the existing core admission and launch path. This check does not pin the file
against replacement between resolution and launch.

Twin copies the project, runs the command in that copy, prints a JSON receipt
on stderr, then discards the copy after confirmed settlement. Arguments after
`--` are passed unchanged. `--receipt=text` selects a bounded human receipt;
`--receipt-html=/path/to/receipt.html` also writes a standalone HTML receipt
without changing the JSON or text stderr output. The destination's parent must
exist; an existing destination is never overwritten. Export failure exits
nonzero but does not skip review or copy cleanup. The HTML contains no scripts,
network assets, or external fonts and uses the same bounded observations and
disclosure limits as the text receipt. Use the JSON receipt for entries omitted
by presentation limits.
`--interactive` inherits stdin, stdout, and stderr and does not capture command
output. Twin does not allocate a PTY. `twin --help` and `twin run --help` show
the CLI options.

In this unreleased checkout, captured commands default to a 60,000 ms deadline
and `--interactive` commands default to 3,600,000 ms (one hour). Set an explicit
deadline before `--` to override either default:

```sh
twin run --timeout-ms=120000 -- node script.js
twin run --interactive --timeout-ms=1800000 --receipt=text --review -- codex
```

`--timeout-ms=<integer>` accepts decimal digits representing 1–3,600,000 ms.
Malformed, duplicate, or out-of-range options are rejected before a project
copy or command is started. Tokens after `--` remain command arguments,
including tokens named `--timeout-ms`. Published Twin 0.1.0 has no CLI timeout
option and uses a 60,000 ms deadline in both modes.

The deadline counts elapsed command runtime, including idle time; input does
not reset it. Copy preparation precedes the deadline, and receipt/review follow
the run. On timeout Twin uses its existing SIGTERM, SIGKILL escalation, and
settlement checks; a timed-out CLI run exits nonzero even if the child handles
SIGTERM and exits zero. Cleanup still requires confirmed settlement. Automated
interactive tests should select short explicit deadlines.

Twin forwards `TERM` unchanged and inherits the caller's streams in interactive
mode. A TTY can still advertise `TERM=dumb`; terminal configuration belongs to
the caller. These timeout changes do not establish Codex conversation
compatibility, which remains unverified. Claude's funded conversation rerun
remains on budget hold.

For a settled command, `twin run --review -- <executable> [args...]` prints the
receipt and then reads one line from stdin. Enter `apply` to run the three-state
apply checks, or `discard` to remove the copy. EOF, interruption, or any other
answer retains the copy and exits nonzero. A conflict refuses the complete plan
before writing to the original and retains the copy. An I/O failure during
apply may leave earlier paths changed; inspect the original and retained copy.
Twin prints the copy path when it cannot discard. A failed discard may have
removed part of the copy, so its message says cleanup is uncertain.

Review and apply work only in that CLI invocation. The printed retained path is
for manual inspection; a later CLI invocation cannot apply or discard that
session. A new `--review` run creates a new copy. The [apply boundary](../ARCHITECTURE.md#phase-5-apply-boundary)
describes conflict checks and the remaining same-user check/write race and
non-atomic multi-path limit.

## Project convenience setup (unreleased)

These conveniences are available in this checkout, not published Twin 0.1.0.
From the project root, run `twin init`. Setup asks for Codex or Claude, then
explicitly asks **interactive chat versus one-shot execution**. It asks for
one-shot task text separately (one nonblank line, with exact task bytes preserved as one argument),
additional arguments as a JSON string array, review preference, and JSON or text
receipt preference. It writes a private sibling temporary file, closes it, then publishes
`twin.config.json` via an exclusive hard link, refusing to overwrite an existing
file even if one appears during setup. Interrupted writes cannot expose a partial
config. SIGINT/SIGTERM and EOF while answers are pending cancel setup. A signal
racing with publication may leave a complete config; abrupt termination may
leave the private temporary file. Setup does not launch agents or make network calls.

For Codex interactive mode, no additional arguments, review enabled and text
receipts, init produces:

```json
{
  "command": ["codex"],
  "interactive": true,
  "review": true,
  "receipt": "text"
}
```

For Codex one-shot mode with task `Fix the tests`, the additional argument
array `["--skip-git-repo-check"]`, review enabled and text receipts:

```json
{
  "command": ["codex", "exec", "Fix the tests", "--skip-git-repo-check"],
  "interactive": false,
  "review": true,
  "receipt": "text"
}
```

Claude interactive mode saves `["claude"]`; Claude one-shot mode saves
`["claude", "-p", "Fix the tests"]` before any additional arguments.
A saved one-shot task repeats on every config-backed run unless explicitly
overridden. No shell splitting or command evaluation is used: each JSON array
element is one argument, including empty strings and strings containing spaces.
Claude's funded conversation verification remains on budget hold; setup support
does not establish verified model work or interactive conversation compatibility.

Run `twin` or commandless `twin run` from the same project root to use the file.
Config lookup uses only the current directory, without searching ancestors.
The file requires a nonempty `command` string array; optional `interactive`
and `review` are booleans, `receipt` is `json` or `text`, and `timeoutMs` is
an integer from 1 through 3,600,000 using the same timeout validation as the CLI.
Unknown fields and malformed values are rejected before copying or executing,
even with an explicit command. Missing config gives short setup/explicit-run
guidance; an explicit command works without config.

Init uses typed prompts, with Codex and Claude as its only agent choices. Custom
commands require manually authored config or an explicit command after `--`.
Empty or whitespace-only one-shot tasks are rejected; nonempty tasks are saved
without trimming. Invalid answers stop setup without retrying.

Explicit CLI options take precedence over config, then existing defaults apply.
`-i` aliases `--interactive`, `-r` aliases `--review`, and `-t text` aliases
`--receipt=text`. `--receipt=json` can override saved text output. Aliases and
long options share duplicate validation. `--no-interactive` and `--no-review`
override saved true values. Positive and negative forms share an option key: any
repeat or conflict is rejected, rather than selecting the last value. These invocations use saved options:

```sh
twin
twin run
twin -i -r -t text
twin run --timeout-ms=120000 -- node script.js
```

A command after `--` replaces the entire saved command, including saved task
and additional arguments; other config preferences still apply. Tokens after
`--` are passed unchanged and never interpreted as Twin options. One-off
options never modify the config. Execution continues through the existing
resolution, core validation, environment forwarding, launch, signal,
settlement, receipt, review and cleanup lifecycle.
