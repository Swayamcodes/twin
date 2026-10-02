# Phase 7 scripted demonstration

This is an unpaid fixed Node command, **not an AI-agent execution**. The
recording uses the published `@twin-cli/cli@0.1.0` and its exact
`@twin-cli/core@0.1.0` dependency. It is separate from scenario results and
compatibility evidence. The existing landing playback remains unchanged.

## Inspect the recording

From the repository root (Python 3; no recording dependencies):

```sh
python3 docs/phase-7-demo/demo.py --replay docs/phase-7-demo/demo.cast
```

Ctrl-C stops playback. For reduced motion, instant inspection, or a screen
reader, add `--static` or read [transcript.txt](transcript.txt). The recording
is also a standard asciinema v2 file. It combines actual PTY stdout/stderr,
records the supplied `apply\n` input, and includes its terminal echo.
Shell-style command labels and verification lines are printed by the recorder;
the receipt and apply response come directly from Twin. No paths or output
were redacted. [verification.json](verification.json) records the byte and
settlement checks.

## Reproduce

Requires Linux (`/proc` is used to verify the child process group), Python 3,
Node, npm, Git, and registry access. Choose a **new** output directory:

```sh
python3 docs/phase-7-demo/demo.py --record /tmp/twin-demo-reproduction
```

The recorder installs only the published CLI into an owned temporary prefix
using separate empty npm configuration files and a fake home. It initializes
a disposable Git project with:

- tracked `message.txt` containing exactly `before\n`;
- `.gitignore` excluding `ignored-input.txt`, whose bytes are `demo-only\n`;
- a minimal private `package.json` and tracked `demo.cjs` (the exact fixed
  action is the `ACTION` string in [demo.py](demo.py)).

The action reads and checks the ignored input, writes `after\n` to
`message.txt` in the copy, and prints those observations. It also writes a
process-identity marker in the owned disposable support directory for the
recorder's settlement checks; that outside-project write is not covered by
the receipt's fixed watch list. The invocation is:

```sh
twin run --receipt=text --review -- node demo.cjs
```

After the actual review prompt, the recorder checks that the original is
still `before\n`, the copy has `after\n` and the ignored input, and the child
and its observed process group are absent. It then supplies `apply` followed
by Enter. It checks exit zero, original `after\n`, CLI settlement, and Twin's
copy cleanup before removing the owned project, home, prefix, and cache.
Failures retain the temporary fixture for inspection; an existing output
directory is never overwritten.

## Limits

This demonstrates one conflict-free tracked-file apply and ignored-input
availability. Reads are shown by the fixed action, not detected by the
receipt. No claim of general recovery or agent compatibility follows.
Twin provides project-copy isolation, not an OS sandbox. Group absence does
not establish escaped-descendant absence; outside-project observations do
not provide rollback. The complete receipt retains these limits, including
its dependency/global-package observation qualifications. No real home,
credentials, paid agent, or historical benchmark was used.
