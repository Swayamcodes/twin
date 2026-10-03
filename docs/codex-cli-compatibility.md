# Codex CLI compatibility checkpoint

This checkpoint tested the unmodified Twin CLI at `4389ab8` with the installed `codex-cli 0.159.3` on Linux x86_64 (WSL2 kernel 6.18.33.2). `codex` was launched as an ordinary absolute executable through `twin run`; no adapter was needed. Codex's installed help and the [official command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli) identify `codex exec` as the noninteractive command and `--skip-git-repo-check` as the way to admit a folder without Git.

## Real agent runs

The following are the exact invocation forms used, with only machine-specific executable and disposable directory paths replaced by placeholders. `<codex-bin>` was the absolute path returned by `command -v codex`; `<twin-cli>` was this checkout's built `packages/cli/dist/index.js`. Each project contained `result.txt` (`baseline=blue`), an ignored `.env` (`TWIN_FIXTURE_COLOR=violet`), and an untracked `note.txt` (`untracked marker`). The Git project tracked `result.txt` and `.gitignore`. These values were invented for the fixture. Codex used the existing ChatGPT login; no credentials were copied into either project.

Captured Git run, with review followed by `apply`:

```sh
cd <owned-git-project>
TMPDIR=<owned-scratch> node <twin-cli> run --review -- <codex-bin> exec --ephemeral --sandbox workspace-write --color never 'Read .env and replace only result.txt with exactly result=violet followed by a newline. Do not change other project files. Reply briefly.'
```

Codex read the ignored file and changed `result.txt` in the copy. Before applying, the original still contained `baseline=blue`; the copy contained `result=violet`, and both copies of the ignored and untracked inputs matched. The JSON receipt reported one tracked modification, confirmed direct-child settlement, and an absent final process group. Review `apply` reported one applied change; the original then contained `result=violet`, and Twin removed this run's copy. Codex also changed the outside-project `.codex/config.toml` during this run, which Twin reported as an observed watch change. Twin does not restore outside-project files.

Inherited-stdio plain-folder run, with review followed by `discard`:

```sh
cd <owned-plain-folder>
TMPDIR=<owned-scratch> node <twin-cli> run --interactive --receipt=text --review -- <codex-bin> exec --ephemeral --sandbox workspace-write --skip-git-repo-check --color never 'Read .env and replace only result.txt with exactly result=violet followed by a newline. Do not change other project files. Reply briefly.'
```

Codex made the specified copy edit after reading `.env`. Its first verification command tried unavailable `python`, then recovered with `python3` and exited zero. The text receipt reported a non-Git `result.txt` modification, complete file coverage, and confirmed process settlement. At review, the original still contained `baseline=blue`; `discard` removed the copy, and the original stayed unchanged. The receipt's dependency-declaration coverage was incomplete because the fixture had no `package.json`.

Live interruption check, with Ctrl-C while Codex's `sleep 30` shell command was active:

```sh
cd <owned-plain-folder>
TMPDIR=<owned-scratch> node <twin-cli> run --interactive --receipt=text -- <codex-bin> exec --ephemeral --sandbox workspace-write --skip-git-repo-check --color never 'Run sleep 30 in the shell, then reply done. Do not edit any files.'
```

Twin exited one and printed a text receipt. It recorded SIGINT sent to the process group, direct-child settlement, and an absent final group; the copy was discarded by the default flow and the original was unchanged. Codex logged an interrupted turn and an internal `UnknownProcessId` error after the signal. The receipt recorded a `.git` addition inside the non-Git copy during this run; that copy was discarded. This check establishes the observed bounded settlement for this process, not the absence of every possible escaped descendant.

The first captured attempt, inside the restricted tool sandbox, reached Codex but failed before the model run with `failed to initialize in-process app-server client: Read-only file system (os error 30)`. Twin reported exit one, no file changes, and confirmed process settlement. That copy was retained for inspection, then removed after process settlement was checked. The successful model-backed runs above used Twin's same launch path outside that sandbox so Codex could initialize using the existing login. All owned fixture roots were removed after the live runs and test workers closed.

## Manual full UI follow-up at e3d1431

The user reported this manual check in a WSL terminal at checkout
`e3d1431ada98349b716d0b518109c632746678d3`. The terminal advertised
`TERM=xterm-256color`, and the Codex UI reported version `0.156.1`. This is
user-observed evidence from the unreleased built Twin CLI, separate from the
earlier `codex exec` checks above. Plain `codex` was launched with inherited
interactive stdio, a text receipt, review, and an explicit five-minute deadline:

```sh
node /home/lenovo/dev/twin/packages/cli/dist/index.js run --interactive --receipt=text --review --timeout-ms=300000 -- codex
```

The user entered “Reply hello; do not edit files or run commands.” Codex replied
“hello”. The receipt recorded exit 0, no timeout, no project differences, a
settled direct child, and an absent final original process group. Review/discard
completed with shell exit 0, and the user confirmed the displayed Twin scratch
root was removed. The receipt also reported an outside-project
`.codex/config.toml` change; Twin does not restore outside-project files.

Codex printed “Any running work continues.” Background task termination remains
unverified: absence of the original process group does not prove termination of
background work or escaped descendants. This manual check establishes the
observed short full UI conversation and review/discard flow for this version
and terminal. It did not test a project edit/apply or published Twin 0.1.0 with
the new timeout option; published 0.1.0 does not expose that option.

## Manual full UI edit/apply follow-up

The user observed a full interactive edit/apply in a disposable Git fixture
using the built, unreleased checkout CLI:

```sh
node /home/lenovo/dev/twin/packages/cli/dist/index.js run --interactive --receipt=text --review --timeout-ms=300000 -- codex
```

Codex was asked to replace `message.txt` with exactly `after\n` and change no
other file. While review was waiting, the original still contained `before\n`.
The schema-5 receipt reported one tracked modification, `message.txt`, exit 0
without timeout, a settled direct child, and an absent final original process
group. The user chose `apply`; Twin reported `Twin apply applied: 1 changes`.
The original afterward contained `after\n`, and Git diff confirmed the
`before` → `after` change. Full interactive edit/apply is verified for this
manual attempt.

The receipt also reported an outside-project `.codex/config.toml` change;
Twin does not restore outside-project files. Codex printed “Any running work
continues”; actual background-task termination remains unverified. The capture
did not independently display the agent version, so the earlier conversation
test's version is not attributed to this attempt. Scratch removal was not
checked for this attempt. This verifies checkout behavior, not published Twin
0.1.0, which does not expose `--timeout-ms`.

## Automation-terminal full UI attempts

Separate automation-terminal attempts used Codex `0.160.0` with `TERM=dumb`.
Codex warned: `WARNING: TERM is set to "dumb". Codex's interactive TUI may not
work in this terminal.` After continuation, its UI rendered, but no conversation
reply appeared before timeout. Published Twin 0.1.0 attempts reached its
60-second deadline; the unreleased built checkout at `e3d1431` reached the
explicit `--timeout-ms=300000` deadline. On the latter attempt, TERM was recorded
as `dumb` immediately before launch, and stdin/stdout/stderr were all TTYs on
`/dev/pts/3`. Twin's receipt recorded timeout, settled direct child, and an absent
final original process group; review/discard and fixture cleanup completed.

The earlier restricted-sandbox full UI attempt failed at a read-only Codex
daemon lock before a conversation could complete. These environment and timeout
observations remain distinct from the successful manual `0.156.1` check. The
automation failures cannot be attributed conclusively to TERM; UI rendering
alone does not verify a conversation.

## Scope and limits

Background tasks escaping the original process group may continue after the
agent UI exits and are not reliably tracked or terminated by Twin. The
[current S11 test](scenario-catalog.md) verifies termination and receipt
reporting for an identified same-group worker, not escaped descendants.
Further background-task testing is optional follow-up, not a release blocker.

The earlier checkpoint comprises three live `codex exec` executions on one installed version and platform, not ordinary automated tests or a claim about other versions. `--interactive` inherited the caller's terminal descriptors for those headless runs; Twin did not allocate a PTY, and those runs did not test the full Codex TUI. The manual full UI conversation, manual edit/apply, and unsuccessful automation-terminal attempts above are separate observations; the edit/apply capture did not independently display an agent version. Twin observes the top-level command and its original process group, while nested commands, background task termination, and escaped descendants remain outside its confirmed coverage. The usual Twin review/apply conflict and partial-failure limits still apply; see the [Phase 5 acceptance review](phase-5-acceptance.md) for the acceptance decision.
