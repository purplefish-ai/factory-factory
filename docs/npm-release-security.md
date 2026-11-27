# npm release security

The npm release workflow builds and tests with the pinned pnpm version. Its npm
CLI commands cover registry publishing, artifact packing, installing the pinned
npm CLI, and customer-install compatibility checks. Use pnpm for repository
dependency maintenance.

Before dependencies execute, the verification job checks that the release commit
belongs to `main`. Manual staging runs must use `main`; release events must use
the tag matching the manifest version. Credential-free dry runs may use feature
branches, because they cannot stage or publish artifacts. The separate staging
job has OIDC permission and stages the tested tarball without checking out or
installing application code.

After a maintainer approves the staged package on npm, finalization downloads
the original staging artifact and checks:

- Exactly one tarball exists, containing the expected package name and a stable
  semantic version.
- The npm registry reports the same version and SHA-512 integrity as those
  bytes.
- npm-hosted SLSA provenance identifies the same package digest, repository,
  `main` workflow, commit, and staging run.
- The version matches the checked-out staging commit, which must still belong to
  current `main` history. Existing release tags must resolve to that same
  commit.

Missing or mismatched metadata fails finalization before tags or releases are
created. These checks authenticate registry responses through HTTPS and compare
provenance identity; they do not independently validate Sigstore signatures or
establish that the source code is safe. Provenance complements code review,
dependency review, and npm's staged approval.

## After a release is published

Pin the upgrade check to the version that just shipped. The check
(`src/backend/upgrade-from-last-release.integration.test.ts`, run by the Test
shards whenever CI selects application tests, which is every pull request that
is not documentation-only) builds a database the way that release left it, loads
a seed with a row in every table and every enum value in use, then runs the
current migrations and application over it. Once npm serves the new version, run
the following with that version in place of `0.5.14`:

```sh
node scripts/update-last-release-migrations.mjs 0.5.14
```

The command downloads the published tarball (a read-only registry request) and
rewrites `src/backend/testing/fixtures/upgrade/last-release.json` with its
migration list, the SHA-256 of each migration's SQL, and its Prisma enums. It
refuses a checkout whose `prisma/migrations` lacks a shipped migration or holds
one whose SQL differs from the published bytes. It then regenerates
`last-release-seed.sql` from the rows in `src/backend/testing/upgrade/`, which
fails if they no longer cover every table and every enum value (string-typed
columns with a closed set of values are listed in `string-enum-columns.json`),
and records the seed's digest in `last-release.json`. Commit both files and any
changes to the seed rows in `src/backend/testing/upgrade/` or to
`string-enum-columns.json` that the run needed. CI never runs the command; a
stale pin only makes the check start from an older release.

A failing upgrade check means the code broke upgrades from the pinned release:
fix the code. The seed is the baseline an upgrade must cope with, so it changes
only through this command, when re-pinning or adding rows for a new table or
value, and the check refuses a seed whose digest the pin does not record.

## Account controls

Workflow YAML alone cannot enforce account controls. Verify on npm that the
trusted publisher is bound to this repository, workflow filename
`npm-publish.yml` (stored at `.github/workflows/npm-publish.yml`), and the
`npm-publish` environment, with stage-only permission. Require maintainer 2FA,
review all publisher identities, and remove unused publishing tokens only after
checking their consumers.

On GitHub, restrict `npm-publish` to intended branches or tags and require an
independent reviewer. Check repository rules protect the release workflow and
`main`. Environment names alone do not enforce approval. On November 5, 2026,
the environment had no protection rules or deployment branch policy; this file
does not claim those external settings have been changed.

## Dependency graph limitation

The checkout lockfile, pnpm overrides, and local patches do not automatically
constrain a customer's npm install. The published manifest still declares ranges
and does not carry a portable consumer lockfile. The integrity and provenance
checks above protect the top-level artifact, not future transitive resolution. A
graph-preserving packaging change needs cross-platform native-module and
agent-runtime verification before that limitation can be considered resolved.
