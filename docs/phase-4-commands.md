# Phase 4 command report

Receipt schema version 4 adds one `command` object. It describes Twin's single
admitted top-level launch, using the already validated command snapshot and the
runner's existing process-start, exit, timeout, spawn-failure and settlement
observations. `admitted: true` means a command passed Twin's pre-launch checks;
`processStart: confirmed` means the runner received Node's `spawn` event. A
spawn failure is therefore an admitted command without a confirmed start.
An interruption before admission leaves the session ready and produces no core
receipt; the CLI's `no-run` fallback says `not-attempted` only for a ready
session. If a non-ready session has no receipt, admission and execution remain
unknown. A size-limited fallback keeps the existing bounded command report
while marking other receipt observations unavailable.

`disposition` distinguishes normal exit, signal, timeout, spawn failure and
uncertain settlement. A nonzero normal exit remains `exited` with its observed
exit code. Uncertain settlement takes precedence over other dispositions;
`timeoutObserved` and any observed direct-child exit code or signal remain
separate facts. The report does not turn a direct-child exit into proof that
the process group or output pipes settled.

Only an exact allowlisted executable basename is disclosed: `node`, `npm`,
`git`, `python`, `python3`, `bash`, `sh`, `codex`, `claude`, `gemini`, `opencode`,
or `aider`. Other executable names and all directory paths are omitted. Every
argument value is omitted, including flags and source text; only the count is
reported, capped at 256 with a `capped` flag. No raw environment value, output,
spawn error text or termination error text is copied into this section. Twin
passes the unchanged validated executable, argv and environment to the existing
launch path. `coverage: top-level-only` and `nestedCommands: not-observed` are
fixed boundaries: child shells, package scripts and other nested commands are
not traced or counted.

The CLI still emits the exact-byte `TWIN-RECEIPT/1` frame. File, watch,
dependency and global npm observations retain their own coverage and meaning.
Leftover-process reporting, receipt presentation and Phase 4 acceptance remain
separate work. Frozen Phase 2 score results are not revised by this report.
