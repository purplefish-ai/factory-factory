# Backend Services

Domain code belongs in `services/{name}/`: `index.ts` is the public API,
`service/` owns logic and co-located tests, and `resources/` owns Prisma access.
Root `services/*.ts` is infrastructure only, as declared in `registry.ts`.

## Capsule boundaries

Enforced by dependency-cruiser and ownership checks:

- External callers use capsule barrels, except `orchestration/data-backup.service.ts`
  may import `settings/resources/data-backup.accessor.ts` directly.
  Capsules declare dependencies in `registry.ts`.
- Service logic uses its capsule's accessors. Resources may compose sibling
  accessors but cannot import another capsule's resources or application layers
  (`service/`, `orchestration/`, `routers/`, `trpc/`, `agents/`).
- Assign each Prisma model one writer in `registry.ts`; add new models to
  `prismaModelNames` and assign an owner.
- Services stay transport-neutral: no routers, tRPC, `@trpc/server`, or
  orchestration imports. Throw application errors for the transport to map.
- Cross-capsule coordination belongs in `src/backend/orchestration/`.

## Operational contracts

- Recurring work registers with `jobRunner`, not `setInterval`; read
  [background jobs](../../../docs/architecture/background-jobs.md).
- Application `gh` calls go through `GitHubCLIService` for the shared rate budget.
- Side-table accessors (`WorkspacePR`, `WorkspaceRatchet`, `WorkspaceRunScript`,
  `WorkspaceAutoIteration`) flatten rows onto the workspace on read, preserving
  wire field names. Read [workspace state](../../../docs/architecture/workspace-state.md).
