# Phase 4 process report

Receipt schema version 5 adds `process` beside `command`. The report uses the
single existing runner launch and its lifecycle events. It does not launch a
probe helper. `directChild.start` means Node emitted `spawn`; `settlement`
means Twin observed the direct child's `exit` event. A spawn failure has no
started child and settlement is not applicable. If the runner finishes before
an exit event, settlement is unconfirmed. A missing receipt after a non-ready
session yields unknown facts rather than a presumed no-run result.

`groupAfterDirectExit` is the first process-group check after the direct child
exits. `finalGroup` is the check when the runner resolves. Checks use the
original command's process group; `present` gives no descendant count or
identity. `absent` does not prove all descendants stopped: a child can escape
that group with `setsid` or equivalent. A failed or unreadable check is
`unknown`. `not-observed` means no post-exit group check was made before the
report; `not-applicable` means no process start was confirmed.

`termination` records only Twin's signal delivery attempts. `sent` means the
OS accepted the signal request or Node's child kill returned success; it does
not mean the target stopped. `failed` means the request threw or returned
failure. Entries identify the signal and whether Twin addressed the process
group or direct child. The existing termination path bounds this list to the
initial signal and one KILL escalation. Test-harness cleanup signals are not
part of the report. `capturedPipes: open` means captured stdio had not closed
when the runner resolved; `not-captured` marks interactive inherited stdio.

The report omits PIDs, process names, descendant counts and identities. It
does not trace nested commands or escaped descendants. The CLI's
`TWIN-RECEIPT/1` byte framing and 8 MiB receipt limit remain unchanged; a
size fallback preserves the bounded `command` and `process` facts. The
report is observation only and makes no rollback or teardown claim.
