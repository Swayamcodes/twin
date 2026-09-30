# Phase 4 global npm observation

Receipt schema version 3 adds `globalNpm` alongside `dependencies`. Project
`package.json` declarations and lockfile digests remain under `dependencies`;
`globalNpm` compares installed package metadata (`name`, `version`) at two
settled observation points. The version 2 `dependencies.installed` placeholder
is removed; consumers must read `globalNpm` in version 3. The CLI still frames JSON as `TWIN-RECEIPT/1` with
an exact UTF-8 byte length. Discard does not restore packages outside the copy.

The selected root is `<prefix>/lib/node_modules` on POSIX, where `prefix` is
the admitted command environment's absolute, normalized `NPM_CONFIG_PREFIX`
or `npm_config_prefix`. Both spellings must agree if supplied. A direct command
argument `--prefix` or `--prefix=...` must agree. npm gives environment prefix
configuration precedence over user and global npmrc files, so an explicit
environment prefix selects the inventory even when those files exist. Callers
should use an owned prefix plus fake `HOME`, cache, userconfig and globalconfig
for an isolated run. Twin does not invoke npm to discover configuration. An
unset, relative, conflicting or visibly overridden prefix gives unavailable
coverage with a reason. A nested command can change its own environment or
pass a different prefix; Twin cannot prove that an arbitrary child used the
selected location. Such changes outside the selected root remain invisible.

The prefix itself must exist. Missing `lib` or `node_modules` is an empty
inventory; a missing prefix is unavailable. Symlinked ancestors, roots,
packages and scoped package entries are refused. Each package must be an
ordinary directory with a bounded regular no-follow `package.json` whose name
matches its directory and whose version has npm's ordinary numeric triplet
shape. `.bin` and root `.package-lock.json` are npm bookkeeping entries and
are excluded. The inventory accepts at most 256 entries and 4 MiB of package
metadata per observation, with a 1 MiB cap per file. Root and package identities
are checked again after reading. Malformed metadata, unreadable entries,
replacements and limits produce incomplete coverage and issues; changes are
emitted only when both inventories are complete. Same-user mutation races
between checks remain possible. No package contents or executable effects are
compared, and no network or helper command is used for observation.

Historical Phase 2 S10 and other scored results keep their original outcome.
Current S10-style offline tests exercise the newer receipt separately. Package
installation that remains after Twin discard or harness teardown receives no
recovery credit.
