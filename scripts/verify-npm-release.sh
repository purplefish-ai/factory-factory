#!/usr/bin/env bash
# Compare registry metadata and provenance identity with the staged artifact.
# Registry responses are authenticated by HTTPS; this does not verify Sigstore signatures.
set -euo pipefail

ARTIFACT_DIRECTORY=${1:?artifact directory required}
EXPECTED_COMMIT=${2:?staged commit required}
STAGING_RUN_ID=${3:?staging run ID required}
REPOSITORY=${4:?repository required}
[[ "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]]
[[ "$STAGING_RUN_ID" =~ ^[0-9]+$ ]]
[[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]
shopt -s nullglob
TARBALLS=("$ARTIFACT_DIRECTORY"/factory-factory-*.tgz)
if [ "${#TARBALLS[@]}" -ne 1 ]; then
  echo 'Expected exactly one staged npm tarball' >&2
  exit 1
fi
TARBALL=${TARBALLS[0]}
VERSION=$(tar -xOf "$TARBALL" package/package.json | jq -er '
  select(.name == "factory-factory") | .version |
  select(type == "string" and test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"))')
EXPECTED_INTEGRITY="sha512-$(openssl dgst -sha512 -binary "$TARBALL" | openssl base64 -A)"
EXPECTED_DIGEST=$(openssl dgst -sha512 -binary "$TARBALL" | od -An -v -tx1 | tr -d ' \n')
METADATA=$(curl --fail --silent --show-error --proto '=https' --tlsv1.2 "https://registry.npmjs.org/factory-factory/$VERSION")
jq -e --arg version "$VERSION" --arg integrity "$EXPECTED_INTEGRITY" '
  .name == "factory-factory" and .version == $version and .dist.integrity == $integrity
' <<< "$METADATA" >/dev/null || {
  echo 'Published npm package differs from the staged tarball' >&2
  exit 1
}
ATTESTATIONS=$(curl --fail --silent --show-error --proto '=https' --tlsv1.2 "https://registry.npmjs.org/-/npm/v1/attestations/factory-factory@$VERSION")
jq -e --arg version "$VERSION" --arg digest "$EXPECTED_DIGEST" \
  --arg commit "$EXPECTED_COMMIT" --arg repository "$REPOSITORY" --arg run "$STAGING_RUN_ID" '
  [.attestations[] | select(.predicateType == "https://slsa.dev/provenance/v1") |
    .bundle.dsseEnvelope.payload | @base64d | fromjson |
    select(._type == "https://in-toto.io/Statement/v1" and .predicateType == "https://slsa.dev/provenance/v1") |
    select(any(.subject[]; .name == ("pkg:npm/factory-factory@" + $version) and .digest.sha512 == $digest)) |
    select(.predicate.buildDefinition.externalParameters.workflow.repository == ("https://github.com/" + $repository)) |
    select(.predicate.buildDefinition.externalParameters.workflow.path == ".github/workflows/npm-publish.yml") |
    select(.predicate.buildDefinition.externalParameters.workflow.ref == "refs/heads/main") |
    select(any(.predicate.buildDefinition.resolvedDependencies[];
      .uri == ("git+https://github.com/" + $repository + "@refs/heads/main") and .digest.gitCommit == $commit)) |
    select(.predicate.runDetails.metadata.invocationId | startswith("https://github.com/" + $repository + "/actions/runs/" + $run + "/attempts/"))
  ] | length == 1
' <<< "$ATTESTATIONS" >/dev/null || {
  echo 'Published npm provenance does not match the staged commit, workflow, run and bytes' >&2
  exit 1
}
printf '%s\n' "$VERSION"
