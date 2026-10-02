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
