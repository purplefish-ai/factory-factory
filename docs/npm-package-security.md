# npm package security

The browser UI is compiled into `dist/client` by Vite. Its source dependencies
belong in `devDependencies`; npm users consume the built assets. Keep packages
needed by backend, CLI, shared runtime modules, or Electron in `dependencies`.
Do not move a package solely because a source scan misses a dynamic import.

The November 5, 2026 cleanup moves 45 client-only direct dependencies out of the
consumer runtime set. The installed macOS arm64 production graph drops from 70
to 25 direct packages and from 634 to 328 distinct package/version pairs. These
counts describe the locked checkout graph on that platform, not every possible
npm consumer resolution. Prisma still brings some browser-related dependencies
transitively through its CLI.

The npm release workflow runs the tarball through `npm exec` from a temporary
directory with its own npm cache, then exercises CLI startup, database
migration, SQLite queries and a real PTY spawn. These npm commands validate
customer compatibility; repository dependency maintenance continues to use the
pinned pnpm version.

## Installation hook

Published installs use the compiled Prisma client and never execute Prisma
client generation. Source checkouts still generate it locally.

The remaining native-helper repair is necessary: node-pty 1.1.0's registry
archive ships Darwin `spawn-helper` files with mode 0644, and its lifecycle
scripts do not repair that permission. Removing the hook breaks macOS terminal
creation. The hook resolves the actual dependency and only repairs the current
platform's helper. It skips symlinks and paths outside that dependency instead
of scanning ancestor directories or modifying helpers for other platforms.

## Remaining graph portability limitation

A pnpm lockfile, overrides, build-script policy and local patches apply to the
checkout; npm does not inherit them when this package is installed as a
dependency. Removing client-only packages reduces the exposed graph but does not
freeze the remaining transitives. Direct version pins alone would not solve it.

Portable graph preservation still needs a packaging design validated against
native binaries, platform-optional agent runtimes and peer dependencies.
Bundling only the Linux CI installation would omit other platforms. A custom
conversion of pnpm snapshots to npm shrinkwrap must not be adopted without clean
npm installation tests covering overrides, aliases, peers, optional dependencies
and local patches. Prefer supported tooling or upstream fixes that remove
overrides before introducing a new lockfile translator.
