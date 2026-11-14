# Hot reads leave out blob columns

Originally decided on 2026-11-09 in #3108 and #3134.

## Context

SQLite reads run synchronously on the main event loop. The workspace's
`initOutput` and `creationMetadata` (with base64 `initialAttachments` until
archive), the agent session's `providerMetadata` and the PR `observation` are
large, and reads that run on every board load, poll or message were loading them
without using them, holding the event loop for every other request.

## Decision

Reads that run on a hot or polled path select or omit columns explicitly so they
never load those blobs, and their return types say so. Code that needs a blob
calls a named finder that reads only it.

Rejected: a client-level default `omit` on the Prisma client.
`Prisma.TransactionClient` does not carry it, so functions that take a
transaction client, the backup export among them, would be typed as returning
columns that were never loaded.

## Consequences

- Each new read on a hot path must narrow itself with `select` or `omit`;
  nothing does it by default.
- Callers that need a blob depend on a named finder, so its cost is visible at
  the call site.
- The integration tests for those reads assert that the blob properties are
  absent, not just unused.
