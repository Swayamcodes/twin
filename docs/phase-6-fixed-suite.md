# Fixed-action comparison command

From the repository root, with Node 24, pnpm, `/usr/bin/git`, and AgentTX
0.3.0 installed, run:

```sh
pnpm run compare:fixed-suite --output-dir /absolute/path/to/new-output-directory
```

The command builds core and scenarios, checks Git and AgentTX before launching
any fixed action, then runs S1–S13 once each through Twin, AgentTX, and plain
Git. The output directory must be a new absolute directory under an existing
canonical parent. It receives `comparison.json` and `comparison.md` with
private file modes. Both files are reopened: JSON goes through the comparison
parser, and Markdown must match the exact deterministic renderer. The command
returns nonzero for an incomplete run or publication failure. An incomplete
JSON result retains completed rows, identifies the next scenario/tool pair,
and records a closed failure stage and root disposition. It makes no
complete-suite claim. The parser requires completed rows to be the ordered
suite prefix, the failed pair to be next, and root disposition to match
allocation/removal counts.

Every action uses a separate owned disposable root with fake home, AgentTX
store, npm cache and global prefix. The only Git recovery recipe is the
documented `git restore --source=HEAD --worktree -- .` inside its fixture.
The comparison excludes harness cleanup from recovery credit and never
publishes private paths, raw process output, environment values, or fixture
secrets. S11 worker settlement is checked before its root is removed; an
uncertain worker or child settlement retains the root for inspection. A
prerequisite version probe with uncertain settlement also retains its root
and records that decision in an incomplete artifact. A complete run
allocates and removes one prerequisite root plus 39 attempt
roots. It does not make claims about escaped descendants or same-user
mutation races.

The committed [Phase 2 JSON](phase-2-comparison.json) and
[Markdown](phase-2-comparison.md) are historical evidence. This command
publishes to the requested directory and does not overwrite them. A fresh
run measures the current Twin implementation, so changed observations are
new attempts rather than corrections to that history or to frozen retained
score contracts. The suite uses fixed scripts and makes no AI or model calls.

## Execution identity

Fresh results include version-one execution metadata: the full source commit,
clean or dirty working-tree state and a digest of its Git status, Node/Git/
AgentTX versions, executable and entry-file digests, aggregate JavaScript
build digests for Twin core, scenarios and AgentTX, and digests for every fixed
action. Command actions use normalized recipes and fixed input bytes. The
S11 worker has its own digest. File-system paths, raw status, command output,
environment values and fixture contents are not published. The built-code
digests bind the Twin result to compiled files inspected before the attempts;
the commit alone does not identify those files.

These identities support local reproduction. They do not authenticate the
source or executables, prove that files could not change after inspection, or
guarantee identical outcomes across runs. Historical Phase 2 artifacts have
no execution metadata and retain their original Markdown rendering.

The retained fresh result for this checkpoint is [JSON](phase-6-results-2297bf07/comparison.json)
with its [deterministic Markdown](phase-6-results-2297bf07/comparison.md).
