# npm release record

`@twin-cli/cli@0.1.1` and unchanged `@twin-cli/core@0.1.0` are published on npm.
This documentation update records user-confirmed publication and a registry smoke;
it performs no installation, workload execution or publication.

## Confirmed CLI 0.1.1 publication

The user confirmed registry version `0.1.1`, executable mapping
`twin -> dist/index.js`, and exact dependencies `@twin-cli/core: 0.1.0` and
`@inquirer/select: 5.2.5`. The confirmed registry integrity matches the verified
candidate tarball exactly:

```text
sha512-9jvWjX/KIr0eNkO9wGqRBAXRn7aH98yEFRxjWSweLB7jVmsvH2pK2ZkR5aY4ONuZd3tJ0N0Rb7BXjlmraChikw==
```

The user installed CLI 0.1.1 globally **from npm** and ran `twin --help`
successfully. In the published fixed-Node text/review smoke, the original still
contained `before` at review. Apply reported success, the invocation exited 0,
and the original then contained `after`. The receipt reported direct-child
settlement and an absent final process group. The user removed the smoke fixture.
These are user-observed registry results, distinct from the earlier local-tarball
installation and PTY tests recorded below; this update does not rerun them or
extend their claims to other agents, modes or workloads.

**Expected incomplete coverage:** the registry smoke fixture had no
`package.json` and no explicit npm prefix. Declaration coverage was incomplete; global npm coverage was unavailable
with `prefix-unset`. These warnings remain expected, not command failures. Successful
execution and apply do not establish complete observation or safety. Outside-project
rollback and escaped-descendant observation remain unsupported; Claude's
funded conversation verification remains on indefinite budget hold. The historical
0.1.0 repeated `prefix-unset` text issue remains recorded below.

## Install the current published release

Requires Node.js 24.2 or later:

```sh
npm install --global @twin-cli/cli@0.1.1
twin --help
npx --package=@twin-cli/cli@0.1.1 twin --help
npx --package=@twin-cli/cli@0.1.1 twin run -- node script.js
npm install @twin-cli/core@0.1.0
```

## Historical 0.1.0 publication context

Core and CLI 0.1.0 publication and the registry-installed smoke were recorded at
checkout `c7f4bae0e5a0ccad9cbc3f140789fde262e8a0bf`.
Preparation began at `d7c20429c9342956bc8785126f050310188e928a`; the rebuild
including CLI PATH support used `6528363a8d8d9d4a757e5aaf9491aa2b6207b200`.
The historical records and local packing instructions are preserved below.

## Historical CLI 0.1.1 preparation — before publication

Prepared from HEAD `1ace058d625a69050803aaf6b378cab11443b42a` on 2026-10-04.
At preparation time, CLI 0.1.1 was unpublished and anonymous npm metadata
listed only CLI 0.1.0. Local packing/install checks did not establish publication;
the later user-confirmed registry evidence above supersedes that release status.
Core stays at published 0.1.0, with unchanged code and version. The checkout
uses `workspace:0.1.0`; pnpm packs the exact dependency `0.1.0`.

The candidate includes the committed CLI timeout defaults/options and config
`timeoutMs`, exclusive `twin init`, config-backed bare/commandless runs, aliases,
positive/negative overrides, and Tier C orchid/plum terminal presentation.
It preserves the existing execution, validation, settlement, apply, cleanup,
JSON framing, plain fallback, observation boundaries and HTML escaping paths.
Init defaults to Text; explicit runs retain JSON defaults. Claude's funded
conversation verification remains on indefinite budget hold; fixed Node checks
are not agent compatibility or safety evidence.

### Earlier local-tarball artifact and installed-package evidence

The fresh checkout artifact is:

```text
/tmp/twin-cli-release-ui6ltvdh/twin-cli-cli-0.1.1.tgz
SHA-256: 9819768e0181bdb46c576cf0c07f875bc190eeb74f1dfe46b5054e177548e53c
SHA-1: e7dbf667a51e9601c6fc31f51b8265f4b8e42658
Integrity: sha512-9jvWjX/KIr0eNkO9wGqRBAXRn7aH98yEFRxjWSweLB7jVmsvH2pK2ZkR5aY4ONuZd3tJ0N0Rb7BXjlmraChikw==
```

Inventory: **15 files**, `package/package.json`, `package/README.md`,
`package/LICENSE`, and `.js`/`.d.ts` pairs under `package/dist/` for `config`,
`executable`, `index`, `receipt-html`, `receipt-text`, and `terminal-ui`.
The full inventory, sizes, modes and per-file SHA-256 hashes are retained in
`/tmp/twin-cli-release-ui6ltvdh/pack-inventory.json`.
No source, tests, source maps, checkout config, web assets or recorded demo
output are packed. All relative runtime imports and manifest entry targets
resolve inside the tarball. The only external runtime imports are Node built-ins,
exact core 0.1.0 and pinned `@inquirer/select@5.2.5`. The packed MIT license
matches the root license, and the hashbang bin has executable mode `0755`.
Both packages require Node `>=24.2.0`. pnpm removes the checkout-only
`prepack` script from the packed manifest; consumer installation needs no build.

The menu package's registry metadata declares Node
`>=23.5.0 || ^22.13.0 || ^20.17.0`, dependencies `@inquirer/ansi ^2.0.8`,
`@inquirer/core ^12.0.3`, `@inquirer/type 4.1.1`, and
`@inquirer/figures ^2.0.9`, and no deprecated status. Its transitive ranges are
not consumer lock pins; the observed installed tree is retained in
`/tmp/twin-cli-release-ui6ltvdh/installed-dependencies.json`.

Installed the **CLI tarball alone** into an owned disposable prefix with
`--ignore-scripts --no-audit --no-fund`, fetching published core 0.1.0 from
npm rather than installing a checkout core tarball. Installed CLI files match
the packed bytes; all 27 installed core files match the registry tarball whose
integrity is `sha512-7SeHCZLwvXQEuDzZ9iBomDLQcXnYn/ywhQZQb2lzRs8HA05FtdhLB+carEiEpV3EyTEltceP4Uqo0NbVg52loQ==`.
`published-core-provenance.json` records that comparison.

Installed non-TTY checks passed: help; interactive and one-shot init (no workload
launch), task/argv bytes, default Text and refusal to overwrite; config-backed
bare and commandless runs; false overrides and one-off precedence; complete
command replacement; arguments containing spaces, quotes, an empty string and
option-like tokens; text and schema-5 byte-counted JSON receipts; valid explicit
and configured deadlines, malformed/out-of-range/duplicate timeout rejection,
and an actual timed-out fixed Node command; text review apply and JSON review
discard; standalone HTML export with matching file observations and no ANSI.

Before each review decision, checks established unchanged originals, changed
copies, absent direct child/process groups and observed settlement. Apply produced
the expected original changes; discard preserved the original. Both copies and
owned scratch roots disappeared. Independent installed PTY checks passed for
init's arrow-key menus/Text default, compact colored text/preparation output,
JSON without startup decoration and with interactive review, default Cancel and
retain, apply/discard navigation, and readable monochrome presentation. PTY
transcripts are separate from the non-TTY exact JSON byte check; terminal newline
translation is not a change to the frame protocol. Visual acceptance remains a
user decision. No AI agents or comparison scenarios were run.

All 213 CLI tests in 10 files passed; strict source and test TypeScript checks,
CLI build, whitespace and exact seven-file release scope checks passed.
Disposable fixtures were removed only after ownership, settlement and outcome
checks; artifact evidence is retained outside the repository. The existing web
style edit, personal config, core, historical evidence and stash are preserved.

### Reproduce local packing and tarball installation

From this checkout with Node 24 and pnpm 12.6.0, use a new owned release directory:

```sh
release_dir="$(mktemp -d /tmp/twin-cli-011-XXXXXX)"
pnpm --filter @twin-cli/cli pack --pack-destination "$release_dir"
npm install --global --prefix "$release_dir/prefix" \
  --cache "$release_dir/npm-cache" --ignore-scripts --no-audit --no-fund \
  "$release_dir/twin-cli-cli-0.1.1.tgz"
"$release_dir/prefix/bin/twin" --help
npm ls --global --prefix "$release_dir/prefix" --all
```

Run smoke workloads only from owned disposable projects. Keep originals and
copies available until the review decision, check settlement before cleanup,
and retain allocations when settlement or ownership is uncertain.

### Historical publication prerequisites

Preparation required review of the inspected tarball, separate publication
authorization, current npm identity/org access, any required OTP or publishing
token, and a check that CLI 0.1.1 was unused. The instruction was to publish only
the inspected CLI artifact and never republish core 0.1.0. Registry metadata,
artifact integrity and a registry-install smoke were required before describing
0.1.1 as published or updating website install guidance. The user confirmation
above now establishes those reported publication results. No publication command
was executed by the preparation work or this documentation update.

## Confirmed 0.1.0 release decisions

The user confirmed `@twin-cli/core` and `@twin-cli/cli`, version `0.1.0`, with
executable `twin` and the MIT license. The copyright attribution is
`2026 Swayam Shinde`. Identical license text is included at the repository root
and in each package root; both manifests declare `license: MIT`.

The user confirmed npm identity `swayamshinde` and reported that
`npm org ls twin-cli` confirms owner access. This supersedes the earlier local
`ENEEDAUTH` observation. During preparation, public registry queries on
2026-10-02 returned 404 for both scoped packages; the unscoped `twin-cli` name
was occupied by another project. Those observations predate the completed scoped
publication. Packing and local installation alone do not publish a package.

## Historical 0.1.0 install instructions

Requires Node.js 24.2 or later. These commands use the public `0.1.0` packages:

```sh
npm install --global @twin-cli/cli@0.1.0
npx --package=@twin-cli/cli@0.1.0 twin --help
npx --package=@twin-cli/cli@0.1.0 twin run -- node script.js
npm install @twin-cli/core@0.1.0
```

## Historical 0.1.0 published-release verification

The user confirmed both public packages, a successful global installation, and
successful npx help. A registry-installed fixed Node run using a bare `node`
name, `--receipt=text`, and `--receipt-html=<new-file>` exited zero, reported
the copy modification, and preserved the original baseline. This is a real
registry-installed run, separate from the earlier local-tarball smoke below.
These 0.1.0 execution results are user-reported; that documentation checkpoint
performed no additional smoke run. Anonymous read-only registry queries also
confirm the two versions, MIT licenses, CLI executable and exact core dependency.

**Expected incomplete coverage:** the registry smoke fixture had no `package.json`
and no explicit npm prefix. Dependency declaration coverage was therefore
incomplete; global npm coverage was unavailable with `prefix-unset`. Exit zero
and the reported file modification do not imply complete observation coverage.

**Deferred text issue:** `prefix-unset` appeared repeatedly in the smoke's text
receipt. This repetition is recorded for follow-up and is not fixed here.
Neither the missing manifest nor the unset prefix is evidence of a failed command
or a recovered global-package change. Existing outside-project, process-group,
apply, and compatibility limits remain unchanged, including Claude's budget hold.

## Package arrangement

Core has no runtime dependencies. CLI 0.1.1 depends on exact core 0.1.0 and `@inquirer/select@5.2.5`. The unused Commander
dependency was removed. Both packages are ESM, require Node.js `>=24.2.0`, expose
their entry point and TypeScript declarations, and carry repository metadata with
their workspace directory. CLI provides the `twin` executable.

The `files` allowlist includes only top-level `dist/*.js`, `dist/*.d.ts`, the
package README, and the MIT LICENSE. This excludes
`core/dist/test-harness`, source tests, scenarios, web assets, skills, environment
files, and checkout configuration. The repository root remains private.

Use **pnpm pack**: it replaces CLI's checkout `workspace:0.1.0` dependency with the
exact core version `0.1.0` in the packed manifest. Do not use `npm pack` directly
on the CLI workspace manifest. See [pnpm's workspace publication behavior](https://pnpm.io/workspaces#publishing-workspace-packages).
Package `prepack` scripts build the necessary packages before packing; published
consumers require neither TypeScript nor pnpm to run Twin.

## Historical 0.1.0 build, check, and pack

The commands and inventory below describe the then-current 0.1.0 checkout.
For current registry installation or local packing, use the 0.1.1 instructions above.

From the repository, using Node 24 and pnpm 12.6.0:

```sh
pnpm install --frozen-lockfile
release_dir="$(mktemp -d /tmp/twin-release-XXXXXX)"
pnpm --filter @twin-cli/core pack --pack-destination "$release_dir"
pnpm --filter @twin-cli/cli pack --pack-destination "$release_dir"
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --types node --noEmit
node node_modules/typescript/bin/tsc -p packages/cli/tsconfig.json --noEmit
pnpm exec vitest run --config packages/cli/vitest.config.ts
tar -tzf "$release_dir/twin-cli-core-0.1.0.tgz"
tar -tzf "$release_dir/twin-cli-cli-0.1.0.tgz"
tar -xOzf "$release_dir/twin-cli-cli-0.1.0.tgz" package/package.json
```

The final core tarball contains 27 files: `package.json`, `README.md`, `LICENSE`,
and JavaScript/declaration pairs for `apply`, `copy`, `dependencies`,
`git-classification`, `global-npm`, `index`, `manifest`, `receipt`, `run`, `safety`,
`twin`, and `watch`. CLI contains 11 files: `package.json`, `README.md`, `LICENSE`, and
JavaScript/declaration pairs for `executable`, `index`, `receipt-html`, and `receipt-text`.
Confirm each packed LICENSE matches the root MIT license. Confirm every relative
runtime import resolves within its tarball, all manifest entry targets exist,
and CLI's packed dependency is exactly `@twin-cli/core: 0.1.0`.

Install both tarballs in a disposable prefix outside the checkout, without
registry dependencies or lifecycle scripts:

```sh
npm install --global --prefix "$release_dir/prefix" \
  --cache "$release_dir/npm-cache" --offline --ignore-scripts --no-audit --no-fund \
  "$release_dir/twin-cli-core-0.1.0.tgz" "$release_dir/twin-cli-cli-0.1.0.tgz"
npm ls --global --prefix "$release_dir/prefix" --offline --all
"$release_dir/prefix/bin/twin" --help
```

Run the installed executable from an owned disposable project containing a
minimal `package.json`, with Node available on a controlled PATH and a new HTML
path. Both bare names and absolute executable paths are supported; the CLI
resolves bare names using the command environment before calling core. Empty
and relative PATH entries use the copy's working directory; executable file
symlinks are followed. For an owned fixture containing `script.js`:

```sh
node_executable="$(command -v node)"
mkdir "$release_dir/command-bin"
ln -s "$node_executable" "$release_dir/command-bin/node"
cat > script.js <<'JS'
require("node:fs").writeFileSync("smoke.txt", "fixed command\n");
console.log("settlement-pid:" + process.pid);
JS
PATH="$release_dir/command-bin" "$release_dir/prefix/bin/twin" run \
  --receipt-html="$release_dir/new-receipt.html" -- node script.js
```

This is an unpaid fixed command. Capture stdout and stderr separately. Verify the
schema-5 JSON frame length, added `smoke.txt`, command exit zero, direct-child
settlement observed, final process group absent, captured pipes closed, and HTML
export containing the same observation. Verify the printed child PID is absent,
the original project is unchanged, and Twin removed its scratch copy. Remove the
owned fixture only after those checks; retain it if settlement is uncertain.

## Historical 0.1.0 publication procedure

The 0.1.0 release is complete. Preparation documented core-before-CLI order;
the commands below are retained as that checkpoint's procedure, not instructions
to republish 0.1.0 or a claim that these exact commands were used. Future releases
require newly authorized versions and inspected tarballs. No publication commands
are executed by this documentation checkpoint:

```sh
npm whoami --registry=https://registry.npmjs.org
npm org ls twin-cli --json --registry=https://registry.npmjs.org
npm publish "$release_dir/twin-cli-core-0.1.0.tgz" --access public --registry=https://registry.npmjs.org
npm view @twin-cli/core@0.1.0 version --registry=https://registry.npmjs.org
npm publish "$release_dir/twin-cli-cli-0.1.0.tgz" --access public --registry=https://registry.npmjs.org
npm view @twin-cli/cli@0.1.0 version bin dependencies --json --registry=https://registry.npmjs.org
```

Account policy may require an interactive OTP or an approved publishing token.
Supply credentials through npm's normal authentication flow, not tracked files.
Any future publication requires explicit authorization, a current identity/access
check, and confirmation that its target versions are not already published.
The existing 0.1.0 versions must not be republished. No publication, tagging,
or credential changes are part of this documentation checkpoint.
