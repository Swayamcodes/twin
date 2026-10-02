# npm release preparation

Prepared from `d7c20429c9342956bc8785126f050310188e928a`, with release wiring
changes in the working tree. Nothing has been published or tagged.
The rebuild after CLI PATH support is based on
`6528363a8d8d9d4a757e5aaf9491aa2b6207b200`.

## Confirmed release decisions

The user confirmed `@twin-cli/core` and `@twin-cli/cli`, version `0.1.0`, with
executable `twin` and the MIT license. The copyright attribution is
`2026 Swayam Shinde`. Identical license text is included at the repository root
and in each package root; both manifests declare `license: MIT`.

The user confirmed npm identity `swayamshinde` and reported that
`npm org ls twin-cli` confirms owner access. This supersedes the earlier local
`ENEEDAUTH` observation. On 2026-10-02, public registry queries returned 404 for
both scoped packages; the unscoped `twin-cli` name is occupied by another project.
Recheck identity, org access, and version availability immediately before any
authorized publication. Packing and local installation do not publish a package.

## Install commands — available only after publication

These commands are intended for the published `0.1.0` packages. They are not
advertised as currently available:

```sh
npm install --global @twin-cli/cli@0.1.0
npx --package=@twin-cli/cli@0.1.0 twin --help
npx --package=@twin-cli/cli@0.1.0 twin run -- /absolute/path/to/command arg1 arg2
npm install @twin-cli/core@0.1.0
```

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

## Publication order — after prerequisites and explicit authorization

The following commands are documented for a future authorized publication; they
were not executed during this checkpoint. Publish the inspected, licensed
tarballs, starting with core:

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
Publication still requires explicit authorization, a current identity/access
check, and confirmation that neither `0.1.0` version has been published since
preparation. No publication, tagging, or credential changes are part of this
checkpoint.
