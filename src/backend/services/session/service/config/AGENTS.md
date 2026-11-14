# Session configuration module

A session's provider configuration: model, reasoning effort, access mode and
planning. The [capsule guide](../../AGENTS.md) covers the capsule, and
`../../modules.ts` describes this module in one line. Bare file names below are
in this directory; paths that start with `src/` are from the repository root.

## Owns, and does not own

The module owns which native values a session's settings become, configuring a
new runtime until its readiness opens, applying edits to a running or stopped
session, the accepted snapshot, its persistence and publication, what an
inactive session shows, and the launch options cache. It does not own:

- The adapter connection, applying the startup model before a runtime is
  returned, the readiness barrier and the launch options probe: `../acp/`.
- The model catalogs: `../providers/`.
- Stopping a runtime whose startup configuration failed, and the write that
  compares launch intent: `../lifecycle/session-startup-config-failure.ts`,
  `../data/session.repository.ts`.
- The automatic rejection of a reviewer's permission requests:
  `../events/session.permission.service.ts`.
- The mapping from a saved permission preset to a native access mode:
  `src/shared/session-launch.ts`.
- The chat controls and their pending selections: `src/client/features/chat/`.
  The launcher: `src/client/features/session-selection/`.

## Public surface

The capsule barrel exports `sessionConfigService` (built in
`../composition/session-core-services.ts`) and its class. Its parts are named by
role: `writer` accepts, persists and publishes native configuration, `reader`
projects live or stored configuration, `startup` configures a new runtime, and
`mutations` applies live and stopped edits. `getLaunchOptions` serves the
launcher and launch validation; `warmLaunchOptions()` runs after server startup
and `stopLaunchOptions()` at shutdown.

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
- Edits to one session wait for the runtime's configuration readiness and run
  one at a time, each after the previous edit's persistence and publication and
  after the prompt in flight settles, and the next prompt waits for them; edits
  to different sessions never wait for each other.
  `session.config.service.serialization.test.ts`,
  `session-config-mutation-queue.test.ts`,
  `session.config.service.readiness.test.ts`.
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
- Startup opens readiness only after its final snapshot is persisted while still
  the accepted one, the stored launch intent still matches, and the required
  access is unchanged; otherwise it recaptures, reapplies the new intent or
  fails. `../lifecycle/session-startup.config-authority.test.ts`,
  `../lifecycle/session-startup.current-intent.test.ts`.
- Launch intent is marked applied only by that final write, while the stored
  intent equals what startup applied (a differing per-start override leaves it
  pending); otherwise only a stopped session's edits change it.
  `../lifecycle/session-startup.current-intent.test.ts`,
  `session-snapshot-durability.test.ts`, `session-pending-launch-edits.test.ts`.
- Explicit launch access, Plan and thinking fail the start unless the provider
  confirms them, Claude Plan replaces the launch access, and turning Claude Plan
  off applies the configured preset. `session-startup-launch.test.ts`,
  `session-startup-configuration.plan.test.ts`,
  `../lifecycle/session-startup.launch-authority.test.ts`.
- A saved snapshot that is invalid, belongs to another conversation or names an
  unavailable mode fails the start, as does applied launch intent without one;
  only a session with no snapshot falls back to the configured preset.
  `session.config.service.saved-access.test.ts`,
  `session-startup-launch.test.ts`.
- Launch options are cached per provider, model and Codex account, 128 at most,
  by at most eight discoveries, each holding its slot until its child drains
  (`stopLaunchOptions()` waits seven seconds at most); a result over five
  minutes old is returned at once with one background refresh, and a failed
  refresh keeps it and is not retried for 30 s.
  `session-launch-options.service.test.ts`,
  `session-launch-options-cache.test.ts`,
  `session-launch-options-drain.test.ts`.

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
- `session-saved-native-modes.ts`, `session-startup-access.ts`: saved and launch
  access; `session-startup-configuration-finalizer.ts` opens readiness.
- `session-launch-options.service.ts`: the launch options cache, saved by
  `session-launch-options-store.ts`.
