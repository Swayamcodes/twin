# Phase 3 execution — core and CLI

`@twin-cli/core` provides a dependency-free copy/run/inspect/apply/discard session.
The execution and cleanup boundary below also applies to the public `twin run`
CLI. The historical Phase 3.0 verification notes are retained below; the current
project-plan checkpoint decision is at the end of this guide. This is not evidence
of scenario scores.

## API and lifecycle

```ts
interface CreateTwinOptions {
  readonly sourceDirectory: string;
  readonly scratchParent: string;
}
interface TwinSession {
  readonly workspacePath: string;
  run(options: RunOptions): Promise<RunResult>;
  inspect(): TwinInspection;
  apply(): Promise<ApplyResult>;
  discard(): Promise<DiscardResult>;
}
function createTwin(options: CreateTwinOptions): Promise<TwinSession>;
```

Both directories must exist. The scratch parent must be current-UID-owned, mode
0700, outside the canonical source. Linux and macOS with POSIX UID support are
accepted; native Windows is unsupported. Final directory components cannot be
symlinks. The factory allocates an exclusive private root and fully copies before
returning. Creation failure rejects, attempts guarded cleanup, and includes the
allocation path and cleanup disposition in its local error; no runnable session
is returned. An allocation whose authority could not be established is retained.

The frozen session exposes its workspace path and four methods. `inspect()`
returns state, path and the receipt when available, without rescanning files.
States are ready, running, finished, applying, child-unsettled, discarding,
discarded and discard-failed. Inspect files directly
while ready or finished. `run()` permits one execution attempt, including a failed
spawn. Invalid input or failed prelaunch authority checks do not consume it.
The ready-to-running lock is acquired before any caller-controlled property,
getter, iterator or value is accessed. Reentrant run/discard calls reject during
input access. Snapshot/validation failures restore ready and preserve the attempt.
Sparse argv arrays are invalid input and are rejected before spawn without consuming
the attempt. Concurrent run/discard operations reject. Explicit discard is allowed before run
or after verified run settlement. There are no finalizers or exit-time cleanup.

## Copy boundary

Filesystem traversal copies all regular files, including dotfiles, ignored and
untracked contents and dependency storage. It does not invoke Git or filter using
ignore rules. Regular files receive independent buffered byte copies, never hard
links, reflinks or CoW. Ordinary permission bits (0777), including executable bits,
are preserved; special permission bits are cleared. Copied subdirectories receive
ordinary source permission bits; allocation/workspace roots remain 0700.
During copying, subdirectories remain 0700 until admitted file workers have all
settled, then ordinary modes are restored in postorder. Serial entry/Git/link
admission feeds at most four independent buffered file-copy workers. Inputs use
`O_NOFOLLOW`, destinations use exclusive creation, and complete byte counts plus
before/opened/post-read/source-path identity, size, mode and time checks reject
detected source changes. Git config uses its bounded validated bytes for copying,
with an EOF check and no second data read. Failure or cancellation stops admissions
and awaits every admitted worker and handle close before guarded creation cleanup.
Ownership, timestamps, ACLs, extended attributes and sparse allocation are not
preserved. Source reads can update access times. A quiescent source is required;
this is not an atomic snapshot or an exhaustive source-mutation proof.

The unreleased checkout preserves accepted relative link bytes and remaps accepted
absolute source targets to relative locations in the disposable copy. Absolute
targets must use the canonical source spelling and component containment, not a
string-prefix test; outside aliases, double-leading slashes and dot components
are refused. Trailing slash directory requirements are preserved. Original source
link text is never changed. Published core 0.1.0 still rejects absolute links and
uses lexical containment for relative targets, without this stricter parent-prefix rule.

Relative parent components are allowed only in an initial prefix that cannot climb
above the root. `../../core` can work; `alias/../outside`, `dir/./../file` and
`../dir/../file` are newly rejected even when lexical normalization looks contained.
This prevents parent traversal after a chained symlink expansion. Accepted chains,
cycles and dangling targets are copied as link objects without target resolution.
Copy and discard never deliberately dereference targets. Canonical containment is
not inferred from lexical resolution: arbitrary caller suffixes, new links and
same-user swaps remain outside the stationary-tree structural guarantee.

Copy and complete link-set discovery cap all visited entries at 100,000, path
component depth at 128, and relative path/target lengths at 4,096 bytes. Both original
and remapped target bytes are checked. Actual absolute-path OS limits can still
fail operations. Non-UTF-8 source entry names are refused; dangling relative target
bytes can be preserved without UTF-8 decoding. Discovery failure never means no
links. Native `readdir` allocation and individual filesystem call time are not
hard-bounded. These rules do not establish universal pnpm compatibility.

Apply permits only verified unchanged creation-time link sets. Raw original and
copy manifests must match their separate private ledger records before unchanged
link keys are excluded from file planning. Relative/absolute original text remains
untouched; physical regular-file changes around unchanged baseline links can be applied. Added,
removed, retargeted, recreated or kind-replaced links refuse the whole plan before
writes. Directory transitions removing baseline links also refuse. Full sets are
checked at creation after baselines, apply preflight, immediately before writes,
and after writes; relevant ordinary ancestors in both trees are checked per file
mutation. Detection after earlier writes reports partial application. Existing
incomplete manifest and same-user race limitations remain.

Devices, sockets, FIFOs and other special entries are rejected explicitly.

## Git boundary

Root `.git` must be absent or an ordinary directory. Root `.git` files/symlinks,
nested `.git` entries, `.gitmodules`, and symlinks within `.git` are refused.
Within root `.git`, the following sentinels are refused: `commondir`, `gitdir`,
`worktrees`, `modules`, `objects/info/alternates`, `objects/info/http-alternates`,
and `config.worktree`.

Before copying source-root entries, a directory inventory containing `HEAD`,
`objects` and `refs` (case-folded) is conservatively refused as a bare Git layout;
`config` need not be present. The same inventory is refused in nested directories,
except the supported root `.git` directory. Outside `.git`, paths ending in
`objects/info/alternates` or `objects/info/http-alternates` are refused independently
of that inventory. Ordinary directories with those signatures can therefore be
refused too; this is not a general Git-layout parser and never invokes Git.

Noncanonical case variants of `.git`, `.gitmodules`, and reserved root-Git paths
(`HEAD`, `config`, `refs`, the sentinel paths and their directory prefixes) are
refused even on case-sensitive filesystems. This is conservative alias protection,
not complete filesystem alias detection. Canonical supported layouts still work.

The config check has a narrow accepted grammar, not general Git compatibility:
ASCII section/key names, optional simple quoted subsection names, and unquoted
single-line `key = value` assignments. Blank lines and whole-line comments work.
Relevant names are case-insensitive. Includes/includeIf, extensions.worktreeConfig,
core.bare other than explicit false, and external core.worktree are refused.
Absolute core.worktree values are also refused because they cannot relocate safely.
Relative core.worktree is interpreted from `.git` and must remain inside the source.
Its parent components also must precede every named component, so
`../alias/../outside` is refused while `..` remains supported.
Continuations, escapes, quoted values, inline comments, malformed/ambiguous syntax,
invalid UTF-8 and config files over 64 KiB are refused. Metadata is never rewritten.
Hooks, filters, aliases and repository programs are not certified safe.

## Execution, output and timeout

RunOptions requires an absolute executable, exact string argv, and an explicit
complete string environment map; timeoutMs and interruptSignal are optional. Each
top-level option is
read once. Argv is materialized into an independent array and environment entries
are captured before value validation; only that validated snapshot reaches spawn.
Getter/iterator exceptions reject as snapshot failures, preserving their cause.
Snapshotting is sequential, not atomic against code running inside accessors; the
values captured are validated, and caller-owned objects are neither frozen nor
mutated. Later changes to caller input do not change the admitted command.
No environment is inherited
implicitly and core performs no selected-executable PATH search. The CLI resolves
bare names using the command environment before calling this absolute-path API;
see [CLI usage](cli-usage.md). Spawn uses shell:false,
workspace cwd and detached:true on supported macOS/Linux platforms, placing
the direct child in a new process group. The default captured mode ignores stdin and
pipes stdout/stderr into the bounded result. `stdio: "inherit"` explicitly passes
the caller's stdin, stdout and stderr descriptors to the direct child. This lets
an interactive command read input and emit output immediately; `RunResult` then
contains empty, incomplete stdout/stderr captures. The CLI selects this mode with
`twin run --interactive -- <absolute-executable> [args...]`; ordinary `twin run --`
keeps captured mode and prints its bounded output after completion. The receipt
is still generated after the command and framed on CLI stderr. Inherited stdio
does not allocate a PTY or establish terminal compatibility; terminal-only agents
may still require a separate PTY implementation and verification. Callers remain
responsible for executable trust, environment and command policy.

RunResult schemaVersion 1 reports exited/spawn-failed/timed-out, actual launch,
exit code, signal, spawn error, termination error, direct-child settlement and an
optional lifecycle issue when group or pipe settlement is unconfirmed.
Each output retains at most 65,536 raw bytes while excess bytes continue draining.
Truncation, stream errors or missing stream end make capture incomplete. An empty
stream from a command that never started is not complete output. Results are local
and may contain secrets; they are not receipts or sanitized publication artifacts.

The default timeout is 60 seconds, configurable from 1 ms through one hour.
Timeout and caller interruption signal the new process group with SIGTERM or
SIGINT, then SIGKILL after one second if members remain. A direct child that exits
while its group remains active starts the same SIGTERM/SIGKILL shutdown. After
SIGKILL, settlement is bounded by five seconds. Captured pipes drain for at most
one second after the group is absent. Run completion is verified only when direct
child exit, group absence, and captured pipe closure are observed. Otherwise the
result names a lifecycle issue, the receipt uses unavailable post-run evidence,
and discard is refused. A later observed exit or pipe/group closure may permit
discard; signal delivery alone does not. The 65,536-byte capture bound remains.

The CLI listens for SIGINT and SIGTERM from before copy creation through receipt
and cleanup. A signal before command launch prevents the run; the CLI waits for
copy creation to finish, then discards through the ordinary session rules. During
execution, the first signal is sent to the command's process group. Repeated caller
signals are ignored while settlement proceeds. If group members remain after one
second, the existing termination path sends SIGKILL and waits up to five more
seconds for observed exit. A previously started timeout keeps its own termination
sequence. Signal listeners are removed after CLI cleanup. The CLI returns nonzero
for an interrupted or timed-out run even if the child handles the signal and
exits zero. A lifecycle issue or reported termination error is also nonzero.
Receipt creation and discard use the same lifecycle checks as an ordinary run.
Group signaling reaches ordinary descendants that stay in the group, including
writers holding captured pipes open. A descendant can escape with `setsid` or
similar calls; group absence cannot prove such a process stopped. An escaped
process retaining a captured pipe makes capture incomplete and cleanup refuse,
but one that closes its pipes may remain unseen. Process-group ID reuse and
concurrent process mutation remain limits of a process-group check. This is not
OS containment; broader descendant discovery remains a documented limitation
of this execution checkpoint.

Result finalization clears bounded timers and removes handlers after verified
settlement. Unsettled runs retain the necessary late exit/close handlers and an
unrefed group probe until settlement becomes observable. Open captured streams
continue bounded draining with their parent read handles unrefed; destroying those
read handles would make a later close event unreliable as proof of writer exit.
Stream data/end handlers are
removed at disposal; an error handler remains through pipe close to handle queued
destruction errors, then all capture handlers are removed.

## Cleanup authority

A private in-memory registration holds root/workspace/parent identities and an
unpredictable exclusively created marker outside workspace. Cleanup accepts no
caller path and adopts no abandoned roots. It verifies canonical containment,
identities, UID, private root/parent modes and marker type, identity, mode and bytes.
Unexpected root siblings or replaced/missing authority cause refusal.

An lstat preflight accepts owned regular files, directories and symlinks on the
root device. Deletion rechecks identities, unlinks files/links without following
targets, removes directories bottom-up and removes the marker last. A symlink
created by the command may point outside; discard removes only that link. There
is no recursive forced fallback. Failure after deletion begins reports possible
partial deletion and prevents blind retry. Repeated confirmed discard returns
already-removed. Concurrent same-user replacement/mount manipulation is unsupported;
these are checks at particular times, not an OS sandbox.

## Focused verification history

On 2026-09-27, production no-emit checking, production compilation and core test
TypeScript compilation passed. The final focused run passed 56 tests in four files
(4.50 seconds). Exact accounting: 56 fixture roots, 23 returned session roots;
every fixture's before/after root sets were `[]`, remaining Twin allocations were
`[]`, and the fixture registry was `[]` after teardown. Refused creations also
left empty scratch parents. No scenario, adapter or workspace-wide suite ran.

The initial sandboxed test run had socket EPERM and empty child-output captures;
its test spy also needed Node's configurable export. After correcting the spy,
the approved unsandboxed run passed all 53 then-existing tests. The final run
included the marker pre-open type guard, a root-Git socket case, and simulated
unsettled-child/open-pipe cases (no OS descendants). Successful-test accounting
was made visible. pnpm's initial automatic dependency verification needed an
approved network retry; the production scripts explicitly select Node types for
TypeScript 6 without changing the shared configuration.

Only the four core test files were executed. Tests use registered private fixtures, fixed Node behaviors
and process.execPath; repository and default/configured Twin state locations are
excluded from allocation. Each fixture reports exact before/after root sets, known
session roots and remaining allocations. Unexpected retained Twin roots are never
swept by test teardown. Git fixtures contain representative metadata; Git itself
is not invoked. These checks do not implement or claim S8/S13 coverage.

Audit-correction verification on 2026-09-27: production no-emit checking,
production build and test TypeScript compilation passed. The sandboxed run
passed 75/80 tests; two fixture sockets failed with EPERM and three output
assertions received empty child captures. The approved unsandboxed rerun passed
all 80 tests in four files (6.33 seconds). Accounting showed 80 fixture roots and
28 returned session roots; every before/after root set, remaining-allocation list
and final fixture registry was empty. The added cases isolate bare inventories,
alternates, reserved-name case variants, sparse argv and listener/timer disposal
(including late exit). Empty-directory copying and root-identity refusal now have
direct assertions. Test imports and fixed command bodies were inspected before
Vitest; no scenario runner, adapter, CLI or shell harness was imported or run.

Command-input correction verification on 2026-09-27: production no-emit checking,
production build and test TypeScript compilation passed. The approved unsandboxed
focused run passed 99 tests in four files (7.75 seconds), including 19 new cases
for single-read snapshots, changing/throwing accessors and iterators, input
mutation, and reentrant run/discard attempts. Accounting showed 99 fixture roots
and 47 returned session roots; all before/after root sets, remaining-allocation
lists and final fixture registries were empty. Affected tests and shared command
helpers were inspected before Vitest; only the focused core suite ran. Earlier
verification counts above remain historical records.

## Historical Phase 3.0 deferrals

No diff, receipt, apply/merge, reflink/CoW, outside-project monitoring/recovery,
dependency analysis, cancellation API, complete descendant discovery and acceptance,
AgentTX integration, CLI integration, scoring, normalized evidence, attempt
protocol, retention/archive or A/B readiness integration. Crashes can leave roots;
automatic scavenging is deferred. Absolute paths and command behavior can modify
originals or other external state: a copy is not an OS sandbox.

The list above records what was absent at the original Phase 3.0 checkpoint.
The current minimal receipt, watch observations and CLI are described above;
remaining gaps are identified below.

## Final Phase 3.0 verification

Supplied final results: production core typecheck and build passed; the focused
core suite passed all 99 tests in four files in 5.44 seconds, after all
command-input, Git-policy and listener-lifecycle corrections. All 18 approved
Phase 3.0 files were staged before this documentation update. Both
`git diff --check` and `git diff --cached --check` passed; `git diff --name-only`
and `git ls-files --others --exclude-standard` were empty.

No scenario suite, adapter, evidence pipeline, CLI integration or scoring
execution occurred. The core remains an early Phase 3.0 clone/run/inspect/discard
slice, not an OS sandbox or completion of Phase 3. Existing verification history
and limitations above remain applicable. These results are supplied history;
no tests were rerun for this documentation update.

## Planned Phase 3 core/CLI execution checkpoint — 2026-09-30

This is the project-plan boundary for core/CLI execution, not a Phase 3
acceptance checklist quoted from `SPEC.md`. The specification lists overall v1
features without assigning them to Phase 3. The checks below cover the planned
clone/run/inspect/discard and CLI execution work, including its documented
stdio, signal, lifecycle, receipt-timing and cleanup boundaries.

| Requirement | Implementation and test evidence | Result |
| --- | --- | --- |
| Clone a full ordinary directory, including ignored files, and support non-Git input | `createTwin` copies independent file bytes; core copy and session tests exercise Git and non-Git fixtures, mode preservation, rejection and source integrity. | Passed |
| Run one admitted command in the copy and inspect before discard | Core snapshot/validation, launch and session tests cover argv, cwd, explicit environment, startup errors, one-attempt locking and synchronous `inspect`. CLI tests cover the public `run --` admission boundary. | Passed |
| Capture bounded stdout/stderr and direct-child disposition | Core runner tests cover complete, truncated, binary, spawn-failed and timed-out results. CLI captured mode replays bounded bytes before its receipt. | Passed |
| Deliver stdin and live output in interactive mode | `run --interactive --` inherits all three descriptors. The live CLI test observes output before exit and delivers stdin; a bounded Linux PTY-backed terminal smoke observed terminal input, live output and a receipt. Twin itself does not allocate a PTY. | Passed for inherited descriptors |
| Forward SIGINT/SIGTERM, including startup and repeated signals | Core and live CLI tests cover both signals in captured and inherited modes, startup interruption, an uncooperative child, listener removal and nonzero interrupted exit. | Passed |
| Bound timeout, escalation, ordinary descendants and inherited pipes | Core runner tests cover direct-child timeout, SIGKILL escalation, surviving ordinary descendants, open captured pipes and bounded shutdown. Group absence plus direct exit and pipe closure gate settlement. CLI now returns nonzero for a timed-out child even if that child exits zero. | Passed within the process-group boundary |
| Generate the receipt after settlement observations and before cleanup | Core receipt tests cover post-run file/watch observations and unavailable evidence. CLI tests check stderr frame bytes and ordering before discard. | Passed for the minimal receipt |
| Refuse cleanup without verified settlement or root authority | Core tests cover group/pipe uncertainty, late settlement and guarded discard; CLI tests cover refused discard. Live test actions are checked stopped before fixture removal. | Passed within the documented authority checks |
| State supported-platform and process limits accurately | POSIX UID and private root checks reject native Windows. `detached:true` and negative-PID signaling are used for ordinary process groups. Tests ran on Linux; macOS was not exercised here. Escaped descendants and process-group ID reuse remain limits. | Passed as a documented boundary |

**Decision:** the planned Phase 3 core/CLI execution checkpoint is **ready to
close** on the verified evidence above. This does not complete all v1 features.
Expanded receipt work belongs to Phase 4; apply and agent compatibility belong
to Phase 5. Copy optimization remains future v1 work without a Phase 3
assignment in `SPEC.md`. This checkpoint does not claim a process containment
layer, termination of descendants that escape the group, Twin-allocated PTY
support, or macOS test coverage.

Verification for this checkpoint: core execution/copy/discard/session suite
111/111; standalone receipt suite 32/32; CLI suite 24/24, including live
stdin/output and signal cases. Strict production and test TypeScript checks and
core/CLI builds passed. The bounded real-terminal smoke passed on Linux. All
core fixture reports showed empty before/after root sets, empty remaining Twin
allocations and empty fixture registries; live CLI tests verified their action
PIDs stopped before fixture removal. No retained root was reported.

## Interim scanner reliability checkpoint (unreleased)

The 30-second default remains. Core `scanTimeoutMs` and CLI
`--scan-timeout-ms=N` accept integer milliseconds from 1 to 3,600,000; flag
precedence is flag, saved configuration, default. Configuration initialization
adds no prompt and existing personal configuration is not rewritten.

Every preparation, receipt and apply inventory receives a fresh deadline,
including apply parent checks. This is not a whole-run budget: longer budgets
can multiply total waiting time. Command timeout remains separate. Timeout and
cancellation report their own reasons; unfinished stable reads do not claim a
metadata mutation or emit a partial hash. Actual detected changes still report
`entry-changed-during-scan`, including when termination also occurs.

Partial preparation baselines still prevent apply. Cancellation may wait for
copying or pending native operations; started observations settle before
guarded cleanup. Apply cancellation before mutation refuses, while cancellation
after any original mutation attempt reports possible partial application and
retains the copy. Existing symlink, `.git`, coverage and cleanup guards remain.

No large Prizzle verification was run for this checkpoint. The DrvFS inventory
timeout is a separate unresolved performance issue, and this work does not
establish acceptable performance across real repositories.

## Bounded startup checkpoint (unreleased)

A private coordinator caps active copy/manifest/link jobs at four, queued jobs at
eight, and each operation's admitted but uncommitted result window at twelve.
There is at most one admission waiter per operation; results commit in discovery
order and workers never await another permit or their descendants. A session
shares the coordinator; standalone observers use a local one. Independently timed
Git/watch/dependency work is outside this job cap. These bounds do not limit every
syscall, native enumeration allocation, or elapsed filesystem-call duration.

Creation settles Git/watch/dependency observations, freshly scans the original
apply baseline, then scans the copy once for both baseline views. Receipt file
observation moves to that later copy boundary. After settled execution, one fresh
full copy scan supplies both receipt-after and apply-settled views alongside other
observers. Raw scans retain all directories and 07777 modes. Receipt views retain
non-directories and Git directories; apply views retain all directories with
0777 modes. Coverage and issues remain identical in both projections. Later apply
inventories and path checks remain independent fresh reads, and complete raw link
reconciliation remains separate; original state is never inferred from copied
bytes. Distinct observation intervals do not form an atomic snapshot.

Hash-byte reservations precede worker admission in discovery order and account for
outstanding work before later hash-limit decisions. Successful complete hashes
commit bytes; failed, changed or incomplete work releases the reservation without
a digest. Committed plus reserved allowance stays within 2 GiB, which is not a
promise to cap all failed-read I/O. Existing entry/depth/path/target caps, fresh
hashes, Git restrictions and unchanged-link apply rules remain.

Each inventory still has its own 30-second default deadline including queue waits.
Copying and preparation link reconciliation receive cooperative cancellation,
without a whole-copy time budget. Started operations drain before returning or
cleanup, so pending native calls can delay cancellation. No native copy/reflink,
writable hard link, source exclusion, stale hash, coverage promotion or stronger
same-user race guarantee is introduced. No large Prizzle run verifies this
checkpoint's startup performance.
