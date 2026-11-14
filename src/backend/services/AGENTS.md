# Backend Services

Domain code belongs in `services/{name}/`: `index.ts` is the public API,
`service/` owns logic and co-located tests, and `resources/` owns Prisma access.
Root `services/*.ts` is infrastructure only, as declared in `registry.ts`.
`index.ts` lists every public name explicitly; `pnpm check:service-registry`
rejects `export *` there.

## Capsule boundaries

Enforced by dependency-cruiser and ownership checks:

- External callers use capsule barrels, except
  `src/backend/orchestration/data-backup/data-backup.service.ts` may import
  `src/backend/services/settings/resources/data-backup.accessor.ts` directly.
- Capsules declare each dependency once in `registry.ts`, by how they reach it:
  `dependsOn` for barrel imports (acyclic, each must be imported by non-test
  code); `bridgedDependsOn` for capabilities that orchestration passes in
  through `configure*()`/`setHandler()`; `dataDependsOn` with a reason for
  dependencies the checker cannot see, such as raw SQL. Bridges are checked
  against the wiring in production files outside `services/`. Bridged
  dependencies can form cycles, as workspace ⇄ session does, and callbacks into
  orchestration functions are not counted. Cross-capsule Prisma reads are not
  modelled yet.
- Service logic uses its capsule's accessors. Resources may compose sibling
  accessors but cannot import another capsule's resources or application layers
  (`service/`, `orchestration/`, `routers/`, `trpc/`, `agents/`).
- Assign each Prisma model one writer in `registry.ts`; add new models to
  `prismaModelNames` and assign an owner.
- Services stay transport-neutral: no routers, tRPC, `@trpc/server`, or
  orchestration imports. Throw application errors for the transport to map.
- Cross-capsule coordination belongs in `src/backend/orchestration/`.
- Inside `session`, `session/modules.ts` maps which `service/` modules import
  which; record a new import between them there. The graph minus the imports in
  `sessionModuleCycles` must stay acyclic, and that list may lose entries
  relative to `main` but never gain one.

## Operational contracts

- Health routes receive `settingsHealthService` through `AppContext.services`;
  database connectivity belongs to settings and needs no orchestration wrapper.

- Recurring work registers with `jobRunner`, not `setInterval`; read
  [background jobs](../../../docs/architecture/background-jobs.md).
- Application `gh` calls go through the [GitHub capsule](github/AGENTS.md) for
  the shared process budget.
- Reads on hot and polled paths leave out `initOutput`, `creationMetadata`,
  session `providerMetadata` and the PR `observation`; narrow any new one with
  `select` or `omit`, since the Prisma client sets no default. Pinned by
  `src/backend/services/workspace/resources/workspace-hot-reads.accessor.integration.test.ts`,
  `src/backend/services/workspace/resources/workspace-polled-reads.accessor.integration.test.ts`
  and
  `src/backend/services/session/resources/session-blob-reads.integration.test.ts`
  ([why](../../../docs/decisions/2026-11-13-hot-reads-leave-out-blob-columns.md)).
- Side-table accessors own Prisma writes. `WorkspacePR` exposes a collection;
  `WorkspacePRMonitoring` owns the recipient binding, `WorkspacePREvent` the
  durable fact ledger, `WorkspacePRDelivery` frozen delivery effects and
  membership, and `WorkspacePRDiscovery` the discovery schedule. Other side
  tables flatten their rows onto workspace reads. Read the
  [workspace capsule guide](workspace/AGENTS.md); PR monitoring that coordinates
  these tables is in the
  [pull request guide](../orchestration/pull-requests/AGENTS.md).
