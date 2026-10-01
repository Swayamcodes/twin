# Claude Code compatibility checkpoint

This checkpoint used Twin at `5df7c0c` on Linux x86_64 (WSL2 kernel 6.18.33.2). No `claude` executable was present on `PATH` or in the global npm installation. The official [Claude Code setup guide](https://code.claude.com/docs/en/setup) documents the npm package, which was installed only in an owned disposable `/tmp` directory. Its executable reported `2.1.286 (Claude Code)` and displayed headless `-p` and tool-permission options in `--help`. No repository code or global package installation changed.

## Attempted real-agent run

Claude Code's `auth status` exited one both inside and outside the restricted tool sandbox. No Anthropic API key or alternate provider setting was present in the process environment. The following is the exact attempted invocation form, with only machine-specific executable and disposable directory paths replaced by placeholders. `<claude-bin>` was the absolute path of the disposable npm installation; `<twin-cli>` was this checkout's built `packages/cli/dist/index.js`.

```sh
cd <owned-git-project>
TMPDIR=<owned-scratch> node <twin-cli> run --review -- <claude-bin> -p --no-session-persistence --permission-mode dontAsk --tools Read,Edit --allowedTools Read,Edit --max-turns 3 'Read .env and replace only result.txt with exactly result=amber followed by a newline. Do not change other project files. Reply briefly.'
```

The Git fixture tracked `result.txt` (`result=blue`) and `.gitignore`. It also held an ignored `.env` (`TWIN_FIXTURE_COLOR=amber`) and an untracked `note.txt` (`untracked marker`). A separate non-Git fixture had the same invented files. Neither fixture contained credentials. The [official CLI reference](https://code.claude.com/docs/en/cli-reference) documents `-p`, `--tools`, `--allowedTools`, `--permission-mode`, `--max-turns`, and `--no-session-persistence`. The attempted run limited the available built-in tools to `Read` and `Edit`, pre-approved those two, set `dontAsk` for other permission requests, and did not enable permission bypass. `--tools` does not restrict configured MCP tools; none ran before the authentication failure.

Claude Code printed `Not logged in · Please run /login` and exited one before any model-backed work. Twin admitted the plain `claude` executable, confirmed direct-child settlement and an absent final process group, and emitted its normal JSON receipt with complete file coverage and no changes. At the review prompt, the original and copy had matching `result.txt`, `.env`, and `note.txt` bytes. Choosing `discard` removed the copy; the original remained `result=blue`. The receipt reported `.claude/settings.json` unchanged and no other watched-file change. Claude Code created a temporary `claude-1000` directory under the owned `TMPDIR`; no broader outside-project state comparison was made. After confirming process settlement, the owned `/tmp` root containing the local installation, both projects, and scratch files was removed.

The initial disposable npm install failed in the restricted tool sandbox with `EAI_AGAIN` resolving `registry.npmjs.org`. Repeating the same install outside that network restriction succeeded. Authentication remained the blocker outside the sandbox. No login, billing request, or model response was observed.

## Unverified behavior and limits

The ignored input was present in the copy, but Claude Code did not read it or edit the specified file. Real-agent editing, non-Git execution, inherited-stdio headless execution, review/apply after an edit, and live interruption are unverified because authentication stopped the first task. Help output and the failed launch do not establish those behaviors. The full terminal UI was not tested, and Twin does not allocate a PTY. This checkpoint establishes only plain-command admission, a failed authenticated launch, receipt production, and discard after confirmed settlement for Claude Code 2.1.286 on this platform. Phase 5 remains open.
