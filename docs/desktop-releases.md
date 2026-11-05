# Desktop release signing

The Electron workflow has two distinct macOS paths:

- Manual validation (`create_release: false`) builds unsigned artifacts for
  testing. These artifacts are not suitable for public distribution.
- A GitHub release event or `create_release: true` requires a Developer ID
  certificate and Apple notarization credentials. Missing credentials fail the
  build; the workflow never falls back to an unsigned release.

## One-time owner setup

An Apple Developer Program account and an exported **Developer ID Application**
certificate, including its private key, are required. A certificate alone cannot
sign the application. Keep the private key and all credentials out of git.

Create a GitHub Actions environment named `desktop-release`. Restrict it to
approved release refs, require a reviewer, and prevent self-review where your
GitHub plan supports those controls. Store these environment secrets:

- `MACOS_CERTIFICATE`: the base64-encoded password-protected `.p12` export.
- `MACOS_CERTIFICATE_PASSWORD`: the password used for that export.
- `APPLE_ID`: the Apple account used for notarization.
- `APPLE_APP_SPECIFIC_PASSWORD`: that account's app-specific password.
- `APPLE_TEAM_ID`: the Apple Developer team identifier associated with the
  certificate.

The unsigned path uses the separate `desktop-validation` environment and does
not receive signing credentials. Do not copy signing secrets into that
validation environment.

No signing or notarization credentials existed in the repository Actions secret
list when this workflow was introduced. Environment secrets and organization
secrets require separate administrator verification. The repository changes
provide the release path, not the Apple account, certificate or environment
protections. An owner must finish setup before the next desktop release.

## Release source

Before installing dependencies or running repository code, signed builds verify
that the checkout matches the GitHub event commit and is an ancestor of
`origin/main`. Signed manual builds must select the main branch and supply a
`release_tag` matching `v` followed by the manifest version. Release events must
use a tag exactly matching `v` followed by the manifest's stable version. Full
checkout history supplies the ancestry check. Unsigned validation can run on
development branches without these release restrictions.

Environment protection remains necessary to restrict who can approve use of the
credentials. The source guard adds a repository-level check; it does not create
or replace GitHub's environment review policy.

## Release verification

Application compilation, Prisma generation and native-module preparation run
without signing credentials. Only the packaging step receives the credentials.
All packaging commands explicitly disable Electron builder publishing; artifact
attachment is handled only by the workflow's release job. This also prevents CI
detection from attempting a publish during unsigned validation. The release
command forces code signing and hardened runtime, then requests notarization
through the pinned Electron builder. After packaging, the workflow verifies each
macOS app with `codesign --verify --deep --strict`, validates its stapled
notarization ticket with `xcrun stapler validate`, and checks Gatekeeper
acceptance using `spctl --assess`. Failure prevents artifact upload and release
attachment.

First validate with an unsigned manual build. After configuring credentials, run
a signed draft release and verify the downloaded DMG and ZIP on a clean Mac
before public distribution. CI's configuration checks cannot establish that
Apple accepted a certificate or notarization submission.

Windows Authenticode signing needs a separate signing certificate or signing
service. The current Windows workflow does not configure either; it must not be
represented as a signed Windows distribution. Linux package signatures and
repository signing likewise need a separate distribution policy.
