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

The audit on October 18, 2026 found no production advisories. The complete audit
reported one high-severity development-tooling advisory:
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
`tsc-alias` reaches `braces@3.0.3` through both Chokidar and Micromatch. No
upstream fixed release is available at the time of this check.

The repository's existing `patches/braces@3.0.3.patch` limits parsing and
recursive AST traversal to a bounded depth.
`src/backend/testing/dependency-security-patches.test.ts` verifies both
installed dependency paths: normal glob behavior still works, deeply nested
braces and parentheses fail with a controlled `SyntaxError`, and pre-parsed ASTs
cannot bypass the compile, expand or stringify guards. The raw advisory remains
visible because registry scanners identify the upstream version, not the local
patch. No audit ignore rule is configured.

Keep the patch and regressions until an upstream release or dependency change
removes the vulnerable code. Re-run the full audit before removing a mitigation;
check new findings independently of this known, locally patched advisory.
