# Session configuration module

A session's provider configuration: model, reasoning effort, access mode and
planning. The [capsule guide](../../AGENTS.md) covers the capsule, and
`../../modules.ts` describes this module in one line. This guide so far covers
access presets, how settings reach the adapter, live and stopped edits, and
passive reads; startup, launch options and readiness have no guide yet. Bare
file names below are in this directory; paths that start with `src/` are from
the repository root.

## Owns, and does not own

The module owns which native values a session's settings become, applying edits
to a running or stopped session, the accepted configuration snapshot, its
persistence and publication, and what an inactive session shows. It does not
own:

- The adapter connection, and applying the startup model before a runtime is
  returned: `../acp/`.
- The model catalogs: `../providers/`.
- The automatic rejection of a reviewer's permission requests:
  `../events/session.permission.service.ts`.
- The mapping from a saved permission preset to a native access mode:
  `src/shared/session-launch.ts`.
- The chat controls and their pending selections: `src/client/features/chat/`.

## Public surface

The capsule barrel exports `sessionConfigService` (built in
`../composition/session-core-services.ts`) and its class. Its parts are named by
role: `writer` accepts, persists and publishes native configuration, `reader`
projects live or stored configuration, `startup` configures a new runtime, and
`mutations` applies live and stopped edits.

## Invariants

- An adversarial-review session stays read-only: an edit to another access or
  collaboration value is rejected, and its permission requests are rejected
  without prompting. `session-permission-policy.test.ts`,
  `../lifecycle/adversarial-review-startup.test.ts`,
  `../events/session.permission.service.test.ts`.
- An access mode, Claude's planning included, is changed with
  `session/set_mode`; models and other options, Codex collaboration included,
  with `session/set_config_option`. `session.config.service.test.ts`,
  `session.config.service.startup-options.test.ts`,
  `session.config.service.periodic-task.test.ts`.
- Edits to one session run one at a time, each after the previous edit's
  persistence and publication and after the prompt in flight settles, and the
  next prompt waits for them; edits to different sessions never wait for each
  other. `session.config.service.serialization.test.ts`,
  `session-config-mutation-queue.test.ts`.
- Stopping or replacing the runtime rejects the edits still waiting for it.
  `session.config.service.serialization.test.ts`,
  `session.config.service.readiness.test.ts`.
- A newer explicit edit replaces that setting in messages already queued for the
  session, including across a runtime restart, and an older edit never replaces
  a newer queued message's setting.
  `session.config.service.serialization.test.ts`,
  `session-queued-settings.accepted.test.ts`.
- A configuration snapshot is persisted and published only while it is the
  latest accepted one, whether it came from a native observation, an RPC result
  or startup. `session.config.service.authority.test.ts`,
  `session.config.service.authority-startup.test.ts`,
  `session-config-commit-authority.test.ts`.
- Reading an inactive session's configuration never persists anything, and a
  runtime or stopped edit that appears during the read wins.
  `session.config.service.model-selection.test.ts`,
  `session-config-projection.test.ts`.

## Map

- `session.config.service.ts`: the service and its four parts
  (`session-config-writer.ts`, `session-config-projection.ts`,
  `session-startup-configuration.ts`, `session-config-mutations.ts`).
- `session-config-mutation-queue.ts`: the per-session edit queue.
- `session-config-commit-authority.ts`: the accepted-snapshot token that fences
  persistence and publication; `session-config-snapshot-persistence.ts` writes
  through it with compare-and-set retries.
- `session-queued-settings.ts`: explicit edits applied to queued messages.
- `session-inactive-config-options.ts`: edits to a stopped session.
- `session-permission-policy.ts`: required access at startup and the reviewer's
  read-only rules.
- `acp-config-snapshot.ts`: the persisted snapshot's schema.
