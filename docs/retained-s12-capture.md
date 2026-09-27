# Offline retained-capture foundation — Step 2.5c-1

This checkpoint implements private record validation, offline persistence, reopening,
and pure projection. It does **not** run an S12 or S6 action, a reference scenario,
an adapter, or a child command. There is no capture CLI, capture guard, preload,
integration configuration, default destination, or user-state storage. Step 2.5c-2
requires separate approval. No automatic scorer is implemented.

The internal modules live under `packages/scenarios/src/capture/`. They have no
public package export. `build:scenarios` compiles production code;
`test:scenarios:capture-foundation` compiles and explicitly runs only the three
foundation test files. The existing `test:scenarios` prerequisite/runner barrier
is unchanged and does not include these new files in this checkpoint.

## Private format version 1

Every envelope carries `privateFormatVersion: 1`, `normalizerVersion: 1`, and a
bounded opaque `artifactId`. Objects are strict and variants/reasons are closed.
There are no extension bags, arbitrary environment records, or artifact-supplied
storage locations. The four files are exactly:

| File | Contents | Maximum UTF-8 JSON bytes |
| --- | --- | ---: |
| `reservation.json` | Reference A identity and reserved S12 request B, or explicit no-attempt reason | 16,384 |
| `capture.json` | Raw reference, explicit oracle context, and B's separately recorded observations when captured | 2,097,152 |
| `outcome.json` | No-attempt or collected-attempt disposition, cleanup evidence, bounded private collection errors | 32,768 |
| `manifest.json` | Closed artifact kind, `completeness: complete`, exact three preceding filenames, sizes, and SHA-256 digests | 4,096 |

Additional fixed limits:

| Resource | Limit |
| --- | ---: |
| Each A raw stdout/stderr string | 65,536 UTF-8 bytes |
| Each B stdout/stderr byte capture | 65,536 decoded bytes; 87,384 base64 characters |
| Incomplete inspection issues | 16, deduplicated in causal order; closed codes and zero or one fixed filename |
| Each error/reason text | 4,096 UTF-8 bytes |
| Each private path-like string, executable, argument, or oracle-context path | 4,096 UTF-8 bytes |
| Private identifiers | 128-byte ceiling; prefix-specific schemas further restrict payloads to 64 ASCII characters |
| Execution events, setup commands, raw issues, outcome errors, argv, stream errors | 64 per array |
| Original/workspace observations, workspace inputs, setup/binding/boundary observations, raw snapshot paths | 128 per array |
| Fingerprints and setup path entries | 7 per array |
| Any nested array or object values in a complete record | 256 |
| Structural traversal | Depth 32; 30,000 visited values; 2,097,152 aggregate string bytes |

Output strings permit empty text, and UTF-8 byte checks include multibyte characters.
B streams use strict `{ encoding: "base64", data, decodedBytes }` records. Canonical
alphabet, padding, pad bits, absolute end, encoded/decoded bounds, and exact decoded
length are checked; empty and arbitrary binary streams round-trip losslessly. Raw
reference A strings are unchanged. Duplicate B fact/capture/segment/observation IDs,
foreign run/request/scenario ownership, and unresolved private references reject
before allocation or projection. Raw A duplicate observations remain oracle evidence.
JSON escaping counts against the file-size limits. Limits are enforced by record
validation and serialization before directory allocation. On reopening, `lstat`
and descriptor metadata reject oversized files before allocating their contents
or parsing JSON. Reads allocate at most the allowed size and check for short reads,
growth, replacement, and metadata changes. Directory inventory enumeration is
incremental and stops on the first extra entry. These are conservative limits for
the fixed S12 fixture, whose expected stdout/stderr is empty. Future formats may
revise limits explicitly; version 1 does not silently accept larger evidence.

The bounded raw-reference schema preserves all `ScenarioRunResult` variants:
S12/S6, nullable action/snapshots/workspace/termination fields, every supported
signal, absent/error/file observations, and removed/refused/failed cleanup. Empty
error/output strings and reversed wall-clock values are retained as evidence;
the existing oracle interprets them. Whole-object reverse TypeScript assignment
is blocked by production readonly arrays versus Zod's mutable arrays. Forward
assignment and reverse union/scalar assertions compile, and runtime cases cover
the raw union alternatives, empty strings, nulls, zero values, and reversed clocks.
The resource bounds are deliberate format limits, not changes to the production
`ScenarioRunResult` contract.

## Immutable publication and reopening

`retainArtifact(parentDirectory, records)` requires a nonempty absolute canonical
existing directory, with no symlink aliases, owned by the current POSIX UID.
Missing UID support refuses this foundation. Directory and file UID ownership is
checked along with restrictive modes, device/inode identity, file type and link count.
It validates/encodes records, allocates a fresh random directory exclusively with
mode `0700`, and writes each file with mode `0600` using exclusive creation. There
is no overwrite, replacement, deletion, or execution option. Complete write loops
reject zero, negative, noninteger, excessive, or nonfinite progress. Each file is
synced. The directory is synced before and after the manifest where directory sync
is supported; only explicit unsupported-directory-sync errors are tolerated.

The manifest is written last and lists exactly `reservation.json`, `capture.json`,
and `outcome.json`. Its `artifactKind` is `reference-only-failure` or
`reference-plus-attempt`, with `completeness: complete`; these must agree with the
capture, outcome and reconstructed complete record. Retention is not successful until strict reopening verifies
the complete inventory, versions, envelope ownership, sizes, and SHA-256 digests.
Missing/invalid manifests mean incomplete/not-retained even if private bytes
remain. There is **no crash-atomic multi-file publication claim**. A failed write
may leave an incomplete private directory for investigation; production code does
not clean it up automatically.

Each descriptor scope attempts its close even after failure. Primary write/read/sync
errors and secondary close failures are aggregated internally in causal order;
public diagnostics contain only bounded, deduplicated codes and fixed filenames.
Directory-close failures are not swallowed. A prerequisite failure stops later files
and the manifest; manifest write/sync/close failure cannot return retained success.

Reopening refuses symlinks, non-regular or multiply linked files, substituted or
duplicate inventory names, absolute/traversal names, extra entries, unsupported
versions, and permissive modes. The filesystem implementation targets POSIX
semantics (`O_NOFOLLOW`, `O_DIRECTORY`, private mode bits) and fails closed when
it cannot establish these checks. Canonical parent and UID checks do not eliminate
same-user ancestor replacement/TOCTOU races; this is not a sandbox. Checks
detect observed replacement/modification, not continuous tamper-proof custody.

The writer's `directory` return field is a **private locator** for the caller.
Its separate `inspection` field, and `inspectArtifact(directory)` itself, contain
only the path-free public projection or sanitized failure codes. Do not expose the
private writer result wholesale. Diagnostics contain closed codes and at most one
fixed filename, never arbitrary exceptions, rejected values, or unknown keys.

## A reference and B attempt remain distinct

A complete reference-only artifact has a retained raw reference and an explicit
attempt-not-started reason. Reopening reevaluates the reference with the existing
oracle and returns its public oracle result plus that disposition. There is no
normalized attempt, ToolAttemptBundle, or invented observation.

A reference-plus-attempt artifact retains B's semantic request, version availability,
execution events, point observations, boundary/setup/binding observations, stream
capture records, and cleanup disposition. These are typed recorded components,
not an authoritative `NormalizedToolEvidence` or `ToolAttemptBundle` envelope.
Private fingerprints are bounded audit material; they never substitute for an
independent observation. The projection generates neither IDs nor timestamps nor
observations. Required missing evidence remains missing, and an invalid protocol
may be returned as invalid without rewriting its history.

`projectCapture(records)` is pure and retention-neutral: no filesystem, process,
clock, random source, environment, registry, or mutation. It accepts no verification
object and returns only `retention: unverified` on successful projection, with
unknown artifact disposition. Only strict `inspectArtifact` reopening reaches a
non-exported retention finalizer. Verification binds the exact reopened four files,
their bytes, identities, sizes and digests, including a manifest reread; copying an
artifact ID or retaining an earlier result cannot verify different records.

Projection reevaluates A's oracle, derives B's normalized evidence and protocol
bundle, and runs the existing normalized and attempt validators. A's `sourceRunId`
remains its oracle identity; B's `toolRunId` and request identity come only from B.
Their clocks are never compared. A's snapshots never fill gaps in B's coverage.
Reference eligibility still gates readiness rather than rewriting intrinsic attempt
validity. A malformed artifact or unsuccessful projection returns no successful
public projection. Retention derives from manifest verification, not a stored
boolean. No retention claim is accepted from an outcome record.

## Privacy and limits of evidence

Artifacts are **sensitive, local, unauthenticated evidence**. They can contain
concrete executable/argument paths, private output, errors, and content digests.
Private modes and integrity digests do not authenticate the collector. A malicious
producer can fabricate records or encode secrets in an otherwise valid opaque ID.

Public projection excludes storage/artifact paths, executable paths, argv,
environment values, raw stdout/stderr, private error strings, fingerprint entries,
and file/manifest integrity digests. The actual private normalized evidence and
attempt bundle are validated before sanitization. Version 1 conservatively refuses
any unexpected known B observation hash with closed `private-content` failure and
no normalized attempt or bundle. It never erases a decisive mismatch or conflicting
hashes into unknown evidence. Only pinned fake fixture hashes remain public.
Oracle reasons are replaced with closed
status labels, and issue-message digest references become whole-reference-run
references. The oracle `sourceRunId` is retained for required cross-bundle identity;
it is not a private artifact-file digest or authenticity assertion.

Stream capture availability is projected independently from interpretation. No
report interpretation is invented from retained text. Point observations do not
prove uninterrupted preservation, recovery, usability, or safety. Automatic scoring
remains gated on the Step 2.6 score-support reference contract.

## Foundation verification safety

Records and projection tests use frozen synthetic inputs only. Only
`capture-artifact.test.ts` mutates a filesystem. It exclusively allocates
one owned test parent beneath a single canonical temporary base, then
`twin-test-capture-*` roots below that parent. Before any allocation it rejects bases
inside the repository or either complete Twin state tree: the default
`$HOME/.local/state/twin` and configured `$XDG_STATE_HOME/twin`, including all
descendants of both trees. This exclusion introduces no production storage default.
Allocation, registration, discovery and cleanup reuse that authority. It registers exact paths/device/inode identities and an
ownership marker, and verifies them before deleting only its owned roots. Discovery
is used only to compare exact `twin-test-*`/`twin-scenario-*` root sets before and
after; discovered roots are never cleanup targets. Body/persistence, cleanup, and
leak-accounting failures are aggregated. Tests do not write in the repository or
user-state directory and do not launch child actions.
