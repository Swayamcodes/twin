# Twin core

Twin's reusable engine copies a project, runs a command in the copy, and records
bounded before/after file, dependency, watch, command, and process observations.
It supports reviewed apply and guarded discard. Requires Node.js 24.2 or later.

Licensed under MIT; see [LICENSE](LICENSE).

The following install command will be available only after publication:

```sh
npm install @twin-cli/core@0.1.0
```

This is project-copy isolation, not an OS sandbox. Commands retain the caller's
permissions. Outside-project observations do not provide rollback, and process
group settlement does not establish the absence of escaped descendants.

See the [repository](https://github.com/Swayamcodes/twin) for the public API,
architecture, observation limits, and measured compatibility. Release preparation
is underway; this README does not claim that the package has been published.
