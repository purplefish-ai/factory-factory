# Provider runtimes update with Factory Factory

Originally decided on 2026-11-04 in #2976.

## Context

Claude and Codex sessions run through ACP adapters that Factory Factory bundles,
and each adapter resolves its own provider runtime package, which can differ
from the application's direct dependency. The update banner shows provider
updates beside the Factory Factory release.

## Decision

A provider update notice compares the runtime version the installed adapter
resolves with the version the latest release publishes in
`factoryFactoryRuntimeVersions`, written by the `prepack` script. Claude and
Codex rows share the Factory Factory update action: a provider runtime is
updated by installing the release that bundles it.

Rejected:

- Updating a global provider CLI, which is unrelated to the runtimes the bundled
  adapters resolve.
- Inferring versions from the release's dependency ranges, which do not
  establish the version that will be installed.

## Consequences

- A provider notice appears only with a newer Factory Factory release that
  publishes a newer runtime version.
- A release without published runtime versions shows no provider notice.
