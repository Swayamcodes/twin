# npm 0.1.0 release

`@twin-cli/core@0.1.0` and `@twin-cli/cli@0.1.0` are publicly available on npm.
Publication and the registry-installed smoke are recorded at checkout
`c7f4bae0e5a0ccad9cbc3f140789fde262e8a0bf`. This documentation checkpoint does
not republish packages or create Git tags.

Preparation began at `d7c20429c9342956bc8785126f050310188e928a`; the rebuild
including CLI PATH support used `6528363a8d8d9d4a757e5aaf9491aa2b6207b200`.
The local packing instructions below remain available for checkout verification.

## Confirmed release decisions

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

## Install the published release

Requires Node.js 24.2 or later. These commands use the public `0.1.0` packages:

```sh
npm install --global @twin-cli/cli@0.1.0
npx --package=@twin-cli/cli@0.1.0 twin --help
npx --package=@twin-cli/cli@0.1.0 twin run -- node script.js
npm install @twin-cli/core@0.1.0
```

## Published-release verification

The user confirmed both public packages, a successful global installation, and
successful npx help. A registry-installed fixed Node run using a bare `node`
name, `--receipt=text`, and `--receipt-html=<new-file>` exited zero, reported
the copy modification, and preserved the original baseline. This is a real
registry-installed run, separate from the earlier local-tarball smoke below.
These execution results are user-reported; no additional smoke run is performed
for this documentation checkpoint. Anonymous read-only registry queries also
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

Core has no runtime dependencies. CLI depends only on core. The unused Commander
dependency was removed. Both packages are ESM, require Node.js `>=24.2.0`, expose
their entry point and TypeScript declarations, and carry repository metadata with
their workspace directory. CLI provides the `twin` executable.

The `files` allowlist includes only top-level `dist/*.js`, `dist/*.d.ts`, the
package README, and the MIT LICENSE. This excludes
`core/dist/test-harness`, source tests, scenarios, web assets, skills, environment
files, and checkout configuration. The repository root remains private.

Use **pnpm pack**: it replaces CLI's checkout `workspace:*` dependency with the
exact core version `0.1.0` in the packed manifest. Do not use `npm pack` directly
on the CLI workspace manifest. See [pnpm's workspace publication behavior](https://pnpm.io/workspaces#publishing-workspace-packages).
Package `prepack` scripts build the necessary packages before packing; published
consumers require neither TypeScript nor pnpm to run Twin.

## Build, check, and pack locally

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
