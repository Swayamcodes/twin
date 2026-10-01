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

## Scope and limits

These are three live Codex executions on one installed version and platform, not ordinary automated tests or a claim about other versions. `--interactive` inherited the caller's terminal descriptors for `codex exec`; Twin did not allocate a PTY, and the full Codex TUI was not tested. Twin observes the top-level command and its process group, while nested commands and escaped descendants remain outside its confirmed coverage. The usual Twin review/apply conflict and partial-failure limits still apply; Phase 5 remains open.
