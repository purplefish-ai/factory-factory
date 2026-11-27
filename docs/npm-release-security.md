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

Approval happens on npm, outside GitHub, so the publish workflow cannot tag. The
scheduled Tag npm releases workflow (`.github/workflows/release-tags.yml`) finds
every stable published version newer than `BACKLOG_CUTOFF` (0.5.14, in
`scripts/tag-npm-releases.ts`) without a `v<version>` tag. Versions from 0.4.7
on carry no `gitHead`, so the script reads the commit and staging run from the
version's npm-hosted SLSA provenance and checks, against these sources:

- npm registry: exactly one provenance statement names the version, built by
  `npm-publish.yml` on `main` of this repository, with one source commit and a
  staging run in this repository. The attestation's Sigstore signature is not
  verified; the response is trusted as HTTPS from the registry.
- This repository: the commit exists, is reachable from current `main`, and its
  `package.json` declares that version.
- GitHub Actions: GitHub's own record of the staging run is `npm-publish.yml`,
  started by `workflow_dispatch` on `main`, concluded `success`, at that commit.
  This is the one check that does not rest on the registry. The job's token has
  no `actions: read`, so the record normally comes from the public API (run
  records of a public repository are public); the script tries the token first.
- npm registry again: `scripts/verify-npm-release.sh` accepts the tarball the
  registry serves. It compares that tarball with the registry's SHA-512
  integrity and the provenance subject, so it shows the registry is consistent
  with itself, not that the bytes match what GitHub built.

The removed manual finalization also compared the registry tarball with the
artifact the staging run uploaded, the bytes GitHub built and tested. That
comparison is not made any more: it needs `actions: read` and only works within
the artifact's 7-day retention, and approval often comes later. This is a known
difference, not equivalent verification. The repository owner accepts it, or
reverses it by granting `actions: read` and adding the comparison for versions
still inside the window.

Only then does it create the tag at that commit and the GitHub Release, oldest
version first, marking the npm `latest` version as the latest release. A version
that fails a check is reported in the job summary and skipped, and the run
fails; resolve the reported reason and run the workflow again. A version tagged
by hand is no longer a candidate, so whoever tags it must make the same checks
and create its release too. The job writes with the workflow token, so the
releases it creates start no other workflow. Outside GitHub Actions the script
refuses to create anything unless given an explicitly named override, because a
personal `gh` login would start `npm-publish.yml` for each Release. These checks
do not establish that the source code is safe. Provenance complements code
review, dependency review, and npm's staged approval.

Versions up to and including 0.5.14 are the backlog: they were published before
tagging was automatic. Every GitHub Release notifies everyone watching the
repository, so the repository owner decides whether and when the backlog is
released. A scheduled run only lists untagged backlog versions and does not fail
for them. To handle them, run the workflow by hand from `main`, first with
`dry_run` to see the plan:

- `backlog: tags` creates only the verified tags, which notify nobody.
- `backlog: releases` creates a Release for every backlog version that has none,
  oldest first, creating the tag when it is missing. That includes old versions
  that were tagged long ago and never had a Release. An existing tag gets its
  Release only when it points at the verified commit; otherwise the version is
  skipped. A `tags` run followed later by a `releases` run is safe. The dry run
  ends with how many Releases and tags it would create.

The same checks apply in every mode, and newer versions are always tagged and
released together.

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
