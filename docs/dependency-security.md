# Dependency security

Use the pnpm version pinned in `package.json#packageManager`. CI installs that
version through `pnpm/action-setup`; Docker installs the same version with
pinned release checksums. Local commands reject a different pnpm version through
`.pnpmfile.mjs`, including lock-only installs and commands that skip lifecycle
scripts. Custom user-agent values are rejected. Install the pinned version
before updating the lockfile.

## Dependency intake

Routine updates wait three days (`minimumReleaseAge: 4320` minutes), including
transitive packages. Resolution fails when no eligible version satisfies the
requested range or the registry cannot provide publication dates. The
`no-downgrade` trust policy rejects a release whose publishing evidence is
weaker than an earlier release's evidence; it does not require every legacy
package to have provenance. Keep these policies enabled in local maintenance and
CI. Frozen installs also verify the lockfile against supply-chain policy;
committing a lockfile generated under weaker policy is not an approved bypass.
See the
[pnpm resolution settings](https://pnpm.io/settings/dependency-resolution).

An urgent security fix may need an exception before the delay expires. Add only
its exact `package@version` to `minimumReleaseAgeExclude` in a reviewed PR.
Record the advisory, dependency path, reason to install immediately,
publisher/source checks, reviewer, and removal date in the PR and a comment
beside the exception. Remove it once the release is three days old. A trust
downgrade needs its own investigation and exact-version `trustPolicyExclude`
entry with the same evidence; an age exception does not waive the trust check.
Do not use organization-wide patterns or turn off either policy to unblock an
update. No release-age exceptions are currently configured.

The initial trust-policy rollout retains three exact-version exceptions, owned
by the dependency maintainers and due for re-review by December 5, 2026:

- `semver@5.7.2` and `semver@6.3.1` are July 10, 2023 legacy-major backports
  published after Semver 7 gained provenance. The registry identifies
  `lukekarrys` as publisher, the official `npm/node-semver` repository and
  corresponding git heads; the upstream `v5.7.2` and `v6.3.1` tags exist.
  Electron-builder's tiny-async-pool requires version 5; Babel and the older
  Electron downloader require version 6. Registry SHA-512 integrity matches both
  existing lockfile entries. Remove each exception when its consumers no longer
  require that major or migrate to a verified release with stronger publishing
  evidence.
- `prisma@7.10.1` was published October 15, 2026 by `prismabot`, without the
  OIDC/provenance evidence present on 7.9.1. The registry identifies the
  official `prisma/orm` CLI package, its SHA-512 integrity matches the existing
  lockfile, and the upstream
  [7.10.1 release](https://github.com/prisma/orm/releases/tag/7.10.1) documents
  the transaction fix and security dependency updates. Retain the aligned Prisma
  7 runtime rather than downgrading to recover provenance. Remove the exception
  when a compatible Prisma release restores its publishing evidence, after
  database and packaging verification.

These checks explain bounded compatibility decisions, not proof that missing
provenance is harmless or that the packages are reproducible from source. No
malicious behavior was established by this trust-evidence comparison. Exceptions
do not cover future versions. Re-review the registry publisher, release source,
integrity, dependency path and removal condition before the due date; do not
extend them without review or add an age-based trust bypass.

Dependency install scripts stay denied unless their exact package version is
listed in `allowBuilds`. Review the script and its downloads whenever updating
an allowed package, then update that version's approval in the same PR. Unused
approvals for Protobuf.js and Sharp have been removed. The independent coverage
toolchain uses the same intake policy and needs no build-script approvals. Avoid
approving new build scripts solely because installation requests it. The
allowlist is a repository installation control; it does not govern customers'
npm installs.

`scripts/dependency-intake.test.ts` uses the pinned pnpm CLI and a local fixture
registry to exercise release-age rejection, exact-version exceptions, missing
publication dates, and trust-downgrade rejection for a frozen lockfile.

## Socket review and baseline

The root `socket.yml` keeps the GitHub app's reports, PR alerts, and check runs
enabled without suppressing findings or excluding dependency manifests. It does
not install the app or create a required GitHub status check. In Socket, enable
the repository and configure the policy to block confirmed malware and
explicitly disallowed behavior. Review newly introduced install scripts,
network/process access, telemetry, native binaries, and publishing-identity
changes against the dependency's purpose. Keep dependency bots covered by the
same review. See
[Socket configuration](https://docs.socket.dev/docs/socket-yml).

On November 5, 2026, the public
[0.5.5 report](https://socket.dev/npm/package/factory-factory/overview/0.5.5)
returned a Cloudflare challenge to the available reader, so its score and alerts
could not be verified. The checkout was already at 0.5.6. Observed main branch
checks did not include Socket, but
[PR #3059](https://github.com/purplefish-ai/factory-factory/pull/3059)
subsequently produced `Socket Security: Project Report` and
`Socket Security: Pull Request Alerts` checks from the Socket app. The report
was generated; PR alerts were skipped because that PR changed no dependencies.
This confirms installation, not a clean baseline or configured blocking policy.
Main's required checks were Build, Test, and Lint/Type Check/Dependencies/Dead
Code; neither Socket check was required. Verify alert-blocking policy in the
Socket dashboard and require the observed PR alert check in branch protection.
Without those settings, this file keeps reports visible but does not establish
an enforced Socket merge gate.

To establish the baseline, export the version-specific alerts and record each
finding's package/version, alert type and severity, direct or transitive path,
and whether it ships in npm, Docker, or desktop artifacts. Assign an owner and
classify it as remediation, investigated expected behavior, or unresolved. For
an exception, preserve the reviewed evidence, bounded scope, expiry, and recheck
condition. Filesystem, network, and process capabilities are expected in parts
of this application, but require a purpose-specific explanation. Do not
interpret a capability flag alone as confirmed malware, or suppress it for every
dependency. Do not report the baseline complete until the actual alerts have
been captured and dispositions reviewed.

## Approved supply-chain delivery plan

The November 5, 2026 hardening work is split into independently reviewed PRs:

1. Establish the Socket alert baseline and dependency intake controls above.
   Acceptance requires reviewed dispositions for high-severity findings and
   demonstrated PR checks; inaccessible report/dashboard evidence remains
   unverified.
2. Make the published npm graph match the reviewed runtime graph. Compare a
   clean tarball install with the production lockfile, preserve applicable
   mitigations outside the pnpm checkout, and verify native/provider runtimes.
   Evaluate a publishable shrinkwrap or selective bundling; direct pins alone do
   not lock transitive dependencies. Minimize the published postinstall hook
   only when cross-platform installation still works.
3. Verify npm artifact identity from tests through staging and publication.
   Compare registry integrity with the tested tarball and verify provenance's
   source/workflow. Verify trusted-publisher stage-only permissions, maintainer
   access, and the npm-publish environment's branch restrictions externally.
4. Pin and verify Docker's external executables and image inputs, then ship a
   tested production dependency tree. Preserve the cloud workspace tools and
   native modules customers need.
5. Configure signed desktop release artifacts and macOS notarization with
   verification. Signing credentials and account configuration must be
   provisioned separately; workflow changes alone do not prove a signed or
   notarized release, so that acceptance remains unverified until exercised.

Each PR requires the repository checks, valid review-comment resolution, and
green CI before merge. Publish no new package or desktop release as part of this
maintenance work. Re-scan the next approved release to compare its actual alerts
and shipped dependency graph with the baseline.

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

The complete registry audit on October 30, 2026 reported no known advisories.
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

The October 30, 2026 dependency refresh updates direct dependencies to their
latest stable registry tags, including Linear SDK 100, ACP SDK 2.1, Claude ACP
0.99.1, Codex ACP 2.5, and Electron 45.1. The Linear major removes Salesforce
settings fields that this application's team and issue integration does not use.
The refresh also updates the pinned `qs` override to 6.17.1. Existing
compatibility pins and the Braces mitigation remain in place.

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
