# v1 Codex and Claude Code compatibility matrix

This matrix summarizes the committed [Codex CLI checkpoint](codex-cli-compatibility.md) and [Claude Code checkpoint](claude-code-compatibility.md). It reports only observed behavior for the tested commands and platform. Twin launched each executable as a plain command in an owned disposable project copy; neither checkpoint added an adapter. A receipt for a failed agent command establishes Twin's observations, not completion of the agent's requested task.

**Claude Code status:** Launch/receipt/settlement/discard verified; model-backed edit unverified (insufficient API credit).

**Codex full UI follow-up:** The user observed a successful short conversation
with Codex `0.156.1` in a manual WSL terminal (`TERM=xterm-256color`) through the
unreleased built Twin checkout at `e3d1431`. Separate Codex `0.160.0`
automation-terminal attempts with `TERM=dumb` timed out; TERM is not a proven
cause. See the [manual evidence and limits](codex-cli-compatibility.md#manual-full-ui-follow-up-at-e3d1431).

| Check | Codex CLI | Claude Code |
| --- | --- | --- |
| Tested version and platform | [Earlier headless checkpoint: `codex-cli 0.159.3`, Linux x86_64 on WSL2, kernel 6.18.33.2. Full UI follow-up: `0.156.1`, manual WSL terminal; separate automation attempts: `0.160.0`](codex-cli-compatibility.md) | [`2.1.286`; Linux x86_64 on WSL2, kernel 6.18.33.2](claude-code-compatibility.md) |
| Captured stdio and Git project | [Verified: `codex exec` completed the fixture edit; JSON receipt reported one tracked modification and settled process](codex-cli-compatibility.md) | [Verified command admission, captured JSON receipt, and settled exit 1; billing stopped model work and the receipt had no file changes](claude-code-compatibility.md) |
| Inherited stdio and non-Git folder | [Verified: headless `codex exec --skip-git-repo-check` completed the edit; text receipt reported a non-Git modification](codex-cli-compatibility.md) | [Verified non-Git command admission and inherited stdio for headless `claude -p`; text receipt reported settled exit 1. Model-backed non-Git work is unverified](claude-code-compatibility.md) |
| Ignored input | [Verified: the ignored `.env` was copied and read by Codex in both task runs](codex-cli-compatibility.md) | [Verified byte-identical `.env` in each copy at review; consumption by Claude is unverified](claude-code-compatibility.md) |
| Specified project edit | [Verified: `result.txt` became `result=violet` plus LF in each task copy](codex-cli-compatibility.md) | [Unverified: both task attempts exited at `Credit balance is too low`, with no copy edit observed](claude-code-compatibility.md) |
| Review and apply | [Verified: Git original stayed at baseline through review, then apply reported one change and updated it](codex-cli-compatibility.md) | [Unverified after an agent edit: neither billing-blocked run produced a change to apply](claude-code-compatibility.md) |
| Review and discard | [Verified: non-Git copy was discarded and its original stayed at baseline](codex-cli-compatibility.md) | [Verified for failed commands: review/discard removed both copies and left both originals at baseline](claude-code-compatibility.md) |
| Live interruption | [Verified for the tested `codex exec` run: SIGINT during `sleep 30`, direct-child settlement, absent final group, and default copy discard](codex-cli-compatibility.md) | [Unverified during model work: billing stopped each run before an interruptible agent action](claude-code-compatibility.md) |
| Full terminal UI | [User-observed at unreleased `e3d1431`: plain Codex `0.156.1` replied “hello”; receipt recorded exit 0, no timeout, no project differences, settled child, and absent final original group. Review/discard and shell exit 0; scratch removal confirmed. Background task termination and full UI edit/apply remain unverified](codex-cli-compatibility.md#manual-full-ui-follow-up-at-e3d1431) | [Untested in the recorded headless checkpoint; Twin inherited stdio for `claude -p` and allocated no PTY](claude-code-compatibility.md) |
| Outside-project observations | [A `.codex/config.toml` change was reported in the earlier successful Git run and in the manual full UI follow-up; Twin did not restore outside-project files](codex-cli-compatibility.md) | [Watched files were unchanged in the authenticated rerun; Claude made an owned `TMPDIR` scratch directory that was removed after settlement](claude-code-compatibility.md) |

The earlier Codex findings apply to the tested `codex exec` commands and version.
The manual full UI follow-up used plain `codex`, inherited stdio, text receipt,
review, and `--timeout-ms=300000`; it did not test an edit/apply or published
Twin 0.1.0 with that timeout option. Codex printed “Any running work continues.”
Background task termination remains unverified, and original process-group
absence does not prove it. The [automation-terminal attempts](codex-cli-compatibility.md#automation-terminal-full-ui-attempts)
remain unsuccessful conversation checks, separate from the manual result.
Claude authentication succeeded on the later rerun, but insufficient API credit
prevented model-backed editing, apply after an edit, and interruption during
model work. The earlier unauthenticated attempt remains recorded in the
[Claude checkpoint](claude-code-compatibility.md).

**Acceptance decision:** The funded Claude rerun is on indefinite hold for budget reasons. It is optional follow-up and is not a Phase 5 prerequisite. This decision does not turn the unverified Claude model-backed cells into verified results. OpenCode, Aider, Gemini CLI, and Cursor CLI remain deferred outside v1 Phase 5 acceptance, as described in [SPEC.md](../SPEC.md) and [ARCHITECTURE.md](../ARCHITECTURE.md). The [Phase 5 acceptance review](phase-5-acceptance.md) records the final v1 decision.
