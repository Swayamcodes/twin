# Twin CLI review flow

Run a command from the project directory:

```sh
twin run -- <executable> [args...]
```

Twin copies the project, runs the command in that copy, prints a JSON receipt
on stderr, then discards the copy after confirmed settlement. Arguments after
`--` are passed unchanged. `--receipt=text` selects a bounded human receipt;
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
