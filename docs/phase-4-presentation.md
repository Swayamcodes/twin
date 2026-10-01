# Phase 4 receipt presentation

`twin run --receipt=text -- <executable> [args...]` selects a human-readable
receipt. `--interactive` may appear before or after `--receipt=text`, before
the command separator. The default `twin run -- ...` still emits one exact-byte
`TWIN-RECEIPT/1` JSON frame on stderr. Text mode writes no frame. In captured
mode, Twin writes captured action stdout and stderr first; in interactive mode,
it inherits the action's stdio and prints the receipt after the run. The text
is rendered from the same schema-5 receipt, including the existing no-run and
8 MiB JSON-size fallback observations. No observation or command launch is
added by selecting a presentation.

The text report begins with an overall coverage warning if any file,
dependency, global npm or watch observation is incomplete or unavailable, or
if command/process settlement is uncertain. Every section prints its own
coverage. An empty change list under incomplete coverage says only that no
change was observed. File changes show their tracked, untracked, ignored or
unclassified label; project declaration changes and lockfile digest changes
remain separate from installed global npm metadata. Outside-project watch
changes are observations, without rollback credit. Signal delivery reports
Twin's request outcome, not proof of termination. Discard is clone cleanup,
not recovery of outside-project changes. Nested commands and descendants that
escape the original process group remain unobserved.

The presentation is at most 32 KiB of UTF-8. Each untrusted value is limited
to 128 UTF-8 bytes before an explicit truncation suffix, and each collection
shows at most 12 entries with an omitted count. Terminal control, C1, line
separator, surrogate and bidirectional control code points in displayed values
are escaped as `\uXXXX`. Declaration specifier values, argument values, raw
environment values, action output and executable paths are omitted from the
text report. Only the command receipt's allowlisted executable basename and
bounded argument count are shown. The JSON receipt retains its prior schema,
byte limit and disclosure policy; use it for the complete bounded observations.
Action output itself is separate and is not sanitized by receipt rendering.
