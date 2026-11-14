# Session lifecycle module

Starts, stops, retries and tears down session runtimes. The
[capsule guide](../../AGENTS.md) covers the capsule, and `../../modules.ts`
describes this module in one line. This guide so far covers a stored provider
conversation that cannot be resumed. Bare file names below are in this
directory; paths that start with `src/` are from the repository root.

## Owns, and does not own

For a failed resume, the module owns reconciling the replacement conversation:
archiving the transcript seen so far, writing the new provider identity with its
audit, and resetting provider history. It does not own:

- Loading the stored conversation and deciding whether a new one may replace it:
  `../acp/acp-client-factory.ts`. Buffering startup events, keeping the
  candidate runtime hidden and calling back through
  `onProviderIdentityRollover`: `../acp/acp-runtime-supervisor.ts`.
- The compare-and-set write itself: `rolloverProviderIdentity` in
  `../data/session.repository.ts`, over
  `../../resources/agent-session.accessor.ts`.
- The closed-session archive: `../archive/`.
- Dropping replayed history the transcript already holds: `../events/`.

## Invariants

- A replacement conversation is started only when an active Claude start cannot
  load its stored conversation, and is reported as `resume_fallback` with
  `load_failed` or `load_unsupported`; a Codex session, a start that requires
  the existing conversation (background delivery) and browsing fail instead, and
  a Codex conversation another client holds fails with advice to release it.
  `../acp/acp-client-factory.test.ts`,
  `../acp/acp-runtime-manager.browsing.test.ts`.
- A replacement runtime stays hidden from runtime lookup until its identity is
  reconciled; a failed archive or identity write, a stop, a shutdown or an
  external kill during reconciliation terminates it, keeping the old transcript
  and identity unless the identity write had already committed, in which case
  the new identity stays for the next start.
  `../acp/acp-runtime-supervisor.creation.test.ts`,
  `session-provider-identity.service.test.ts`.
- Reconciliation archives the transcript seen so far as a closed session (none
  when it is empty) before clearing it, then writes the new identity, its
  configuration snapshot and a `providerIdentityRollovers` audit entry
  (incarnation, reason, both identities, archived message count) in one
  compare-and-set against the identity, metadata and update time it read.
  `session-provider-identity.service.test.ts`,
  `../../resources/provider-identity-rollover.integration.test.ts`.
- After a rollover, a history read begun under the old identity is discarded and
  the history retry cooldown starts afresh.
  `session-provider-identity.service.test.ts`.
- Startup buffers provider events only up to a fixed bound; overflow cancels the
  start and terminates the candidate instead of installing a runtime with a
  truncated transcript, and a later start may retry.
  `../acp/acp-runtime-supervisor.creation.test.ts`.

## Hazards

Two backends that share `BASE_DIR` or `DATABASE_PATH` share session ownership,
so a development backend run beside the main one needs its own.

## Map

- `session-runtime-exit.coordinator.ts`: the runtime event handlers, including
  `onProviderIdentityRollover`, which writes buffered output before reconciling.
- `session-provider-identity.service.ts`: reconciliation.
