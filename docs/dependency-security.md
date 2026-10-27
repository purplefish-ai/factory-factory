# Dependency security

Use the pnpm version pinned in `package.json#packageManager`. CI installs that
version through `pnpm/action-setup`; Docker installs the same version with
pinned release checksums. Local commands reject a different pnpm version through
`.pnpmfile.mjs`, including lock-only installs and commands that skip lifecycle
scripts. Custom user-agent values are rejected. Install the pinned version
before updating the lockfile.

## Dependabot coverage

The pnpm 12 package-manager environment can prepend a separate YAML document to
`pnpm-lock.yaml`. GitHub currently reads that document instead of the project
lockfile, hiding the application dependencies from its dependency graph. See
[the upstream parser issue](https://github.com/dependabot/dependabot-core/issues/15904).

`pmOnFail: ignore` prevents that environment document. The pnpm hook
independently enforces the manifest's exact version, so disabling pnpm's
automatic downloader does not permit a different package manager during ordinary
commands. This catches accidental version mismatches; intentional configuration
overrides can bypass repository tooling. In particular, `--ignore-pnpmfile`
bypasses the hook and should not be used for repository maintenance. The Docker
dependency stage copies the hook before installing.

After lockfile changes, confirm it contains one project document. After merging,
check GitHub's dependency graph or SBOM for application packages such as React,
Prisma and Express; a graph showing only pnpm and its platform binaries is
incomplete. The pnpm integration tests exercise version rejection and normal
single-document lockfile generation.

Dependabot checks npm dependencies and GitHub Actions weekly, with five npm and
three Actions PRs allowed at a time. Prisma's three coordinated packages and the
Storybook packages are grouped. CodeQL action steps are also grouped because
`init` and `analyze` require matching versions. Security-update PRs must also be
enabled in repository settings; the configuration file alone does not enable
them. Dependency PRs require normal CI and review. There is no automatic merge
rule.

## Running the audit

```sh
pnpm audit
pnpm audit --prod
```

These commands send dependency names and versions to the npm advisory service.
Inspect each finding and its dependency path. Do not treat an arbitrary nonzero
exit as expected or suppress an advisory solely to obtain a passing audit.

The complete registry audit on October 27, 2026 reported no known advisories.
The repository still carries a local development-tooling mitigation for
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
`tsc-alias` reaches `braces@3.0.3` through both Chokidar and Micromatch. No
upstream fixed release is available at the time of this check.

The repository's existing `patches/braces@3.0.3.patch` limits parsing and
recursive AST traversal to a bounded depth.
`src/backend/testing/dependency-security-patches.test.ts` verifies both
installed dependency paths: normal glob behavior still works, deeply nested
braces and parentheses fail with a controlled `SyntaxError`, and pre-parsed ASTs
cannot bypass the compile, expand or stringify guards. Registry scanners
identify the upstream version, not the local patch, so this advisory may be
reported even when the mitigation is installed. No audit ignore rule is
configured.

Keep the patch and regressions until an upstream release or dependency change
removes the vulnerable code. Re-run the full audit before removing a mitigation;
check new findings independently of this known, locally patched advisory.

## Upgrade compatibility

Keep Prisma, its client, and the SQLite adapter aligned on the latest stable
Prisma 7 release. The Prisma CLI's `latest` registry tag currently points to an
8.0 release candidate; it is not a routine upgrade for this SQLite application.
The TypeScript 6 compatibility API alias is intentional; compilation uses the
TypeScript 7 native compiler.

Prisma 7's SQLite adapter still requests better-sqlite3 12, whose native V8
bindings do not build against Electron 45. Its targeted override uses the same
better-sqlite3 13 driver as the application. Version 13 uses N-API across Node
and Electron. Validate the real Prisma database tests and Electron native
rebuilds together before changing this override. The runtime switcher caches
only ABI-specific modules; it leaves the installed N-API SQLite binary untouched
when switching between Node and Electron.

Undici security overrides follow each consumer's requested major: Node-gyp uses
6, Electron's downloader uses 7, and jsdom uses 8. Keep these selectors separate
when updating patched releases; a global override silently forces tools onto a
different major than they support. Verify native rebuilds, Electron downloads,
and browser-environment tests after changes.

Some maintained parent packages still require older dependency APIs. Storybook's
React doc generator uses Babel 7 and its companion packages. `tsc-alias` uses
Picomatch 2 through its glob/watch dependencies, including the locally patched
Braces paths above. Keep their latest supported releases rather than forcing
unrelated majors. Revisit the parent dependency or a replacement when its
maintenance or security posture warrants the migration; a newer transitive major
alone does not establish that replacing Storybook or the build tool is worth the
compatibility cost.

Electron-builder's CommonJS plist consumers use plist 4 with xmldom 0.9. Plist 3
omits the MIME type required by xmldom 0.9, while plist 5's import-only exports
cannot be resolved by those consumers. Test actual macOS packaging when changing
either parser; a successful application build does not exercise that path.

For transitive major overrides, verify the actual consumer: Ajv's relative
schema references for fast-uri, application and MCP routes for path-to-regexp,
Electron-builder configuration and packaging for js-yaml, and the released ACP
adapter contracts for Anthropic's SDK. Package installation and peer dependency
resolution are necessary checks but do not establish runtime compatibility.
