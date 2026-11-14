# Application update capsule

Release checks for the running installation, and the map of the backend's part
of an application update: draining agent work and handing over to the CLI
supervisor, which installs. The [services guide](../AGENTS.md) covers capsule
layout and boundaries. Bare file names below are in `service/`; paths that start
with `src/` or `scripts/` are from the repository root.

## Owns, and does not own

This capsule owns `ApplicationReleaseService`: finding the running
`factory-factory` package and the provider runtime versions its ACP adapters
resolve, reading the registry's latest release, and caching it. It owns no
Prisma model. It does not own:

- The admission gate an update closes:
  `src/backend/services/application-update-admission.service.ts`, root
  infrastructure that the session capsule and orchestration import.
- The update job, its IPC with the CLI supervisor and the status it reports:
  `src/backend/orchestration/application-update.service.ts`, composed in
  `src/backend/app-context.ts`, which also defines the work that holds an update
  back.
- Installing, recovering and restarting: the
  [CLI guide](../../../cli/AGENTS.md).
- The IPC messages and update status schema:
  `src/shared/application-updates.ts`.
- The procedures `checkUpdates`, `requestUpdate` and `cancelUpdate`, and the
  legacy `checkFactoryUpdate` with its own checker
  (`src/backend/lib/factory-update.ts`): `src/backend/trpc/admin.trpc.ts`.
- Publishing `factoryFactoryRuntimeVersions` in the package manifest:
  `scripts/prepare-runtime-metadata.mjs`, run by `prepack`.
- The banner: `src/client/components/factory-update-banner.tsx`.

## Public surface

`index.ts`: `applicationReleaseService` (`check`, `getPackageRoot`).

The gate is `applicationUpdateAdmission`. `run` rejects while it is closed and
otherwise counts the operation as active until it settles; `assertOpen` and
`isClosed` only check. Session creation, initial and queued messages, dispatch,
ACP runtime creation and prompts, workspace initialization and launch, and the
agent runtime's background launches go through it.

## Invariants

- A provider notice appears only beside a newer Factory Factory release, and
  only when the installed runtime version and its published
  `factoryFactoryRuntimeVersions` entry are both known and the published one is
  newer; dependency ranges are not read. `application-release.service.test.ts`.
- A failed or stalled registry read never fails `check`: it keeps the last
  confirmed release and is retried after five minutes.
  `application-release.service.test.ts`.
- The update job closes the gate, and sends `update-ready` once, only when the
  supervisor reports `waiting`, no admitted operation is running and `hasWork`
  is false. `src/backend/orchestration/application-update.service.test.ts`.
- Once `update-ready` is sent, only an `idle` or `failed` status (from the
  supervisor, or a failed send to it) reopens the gate; cancelling and backend
  shutdown leave it closed.
  `src/backend/orchestration/application-update.service.test.ts`.
- The job asks the supervisor to install only the advertised Factory Factory
  release or the target of a failed update, and concurrent requests for one
  version send one request.
  `src/backend/orchestration/application-update.service.test.ts`.
- `requestUpdate` and `cancelUpdate` require a trusted local client.
  `src/backend/trpc/admin.router.test.ts`.
- A supervisor message that fails `updateSupervisorMessageSchema`, including an
  active phase without a target version, is ignored.
  `src/backend/orchestration/application-update.service.test.ts`,
  `src/shared/application-updates.test.ts`.

## Map

- `application-release.service.ts`: `readInstalledApplication`, version
  comparison, and `ApplicationReleaseService` with its one-hour cache per
  registry URL and five-second request bound.
- `src/backend/orchestration/application-update.service.ts`:
  `ApplicationUpdateService` (the `application-update-idle` job) and
  `createProcessUpdateSupervisor`, the IPC port to the CLI parent, which reports
  a disconnect as a failed status with automatic updates off.

## Decisions

- [Update admission reopens only on the supervisor's word](../../../../docs/decisions/2026-11-13-update-admission-reopens-on-the-supervisor.md)
- [Provider runtimes update with Factory Factory](../../../../docs/decisions/2026-11-13-provider-runtimes-update-with-factory-factory.md)
