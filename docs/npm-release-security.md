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
every stable published version without a `v<version>` tag. Published versions
carry no `gitHead`, so `scripts/tag-npm-releases.ts` reads the commit and
staging run from the version's npm-hosted SLSA provenance and checks:

- Exactly one provenance statement names the version, built by `npm-publish.yml`
  on `main` of this repository, with one source commit and a staging run in this
  repository.
- The commit exists in this repository, is reachable from current `main`, and
  its `package.json` declares that version.
- `scripts/verify-npm-release.sh` accepts the published tarball: the registry
  reports its SHA-512 integrity, and the provenance names the same package
  digest, repository, `main` workflow, commit and staging run.

Only then does it create the tag at that commit and the GitHub Release, oldest
version first, marking the npm `latest` version as the latest release. A version
that fails a check is reported in the job summary and skipped, and the run
fails; resolve the reported reason and run the workflow again. A version tagged
by hand is no longer a candidate, so whoever tags it must make the same checks
and create its release too. The job writes with the workflow token, so the
releases it creates start no other workflow. These checks authenticate registry
responses through HTTPS and compare provenance identity; they do not
independently validate Sigstore signatures or establish that the source code is
safe. Provenance complements code review, dependency review, and npm's staged
approval.

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
