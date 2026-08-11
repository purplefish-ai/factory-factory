# Backend Services

Domain logic lives in **service capsules** under `src/backend/services/{name}/`.
Current capsules: `auto-iteration`, `decision-log`, `github`, `linear`,
`periodic-task`, `ratchet`, `run-script`, `session`, `settings`, `terminal`,
`workspace`.

Root-level `services/*.ts` files are cross-cutting infrastructure only — config,
crypto, logger, job runner, rate limiting, and similar. That list is declared in
`registry.ts` and is meant to stay small: anything domain-shaped belongs in a
capsule.

## Capsule anatomy

```
services/{name}/
├── index.ts        # the ONLY public API
├── service/        # business logic, co-located *.test.ts
└── resources/      # Prisma accessors — the only place that touches the DB
```

## Rules (enforced by `pnpm check`)

Each of these maps to a named dependency-cruiser rule or a `scripts/check-*`
guardrail, so a violation fails the build rather than review.

- **Import other capsules through the barrel.** `@/backend/services/session`,
  never `@/backend/services/session/service/...`. Applies to capsule→capsule,
  tRPC→capsule, and orchestration→capsule alike.
  (`no-cross-service-internal-imports`, `no-deep-service-imports`,
  `no-trpc-importing-service-internals`,
  `no-orchestration-importing-service-internals`)
- **Declare the dependency.** A capsule may only import capsules listed in its
  `dependsOn` in `registry.ts`.
- **Only `resources/` imports `db.ts`.** Service logic goes through accessors,
  and never reaches into another capsule's `resources/`.
  (`only-service-resources-import-db`,
  `only-service-layers-import-service-resources`,
  `no-cross-service-resource-imports`)
- **`resources/` stays pure data access** — no importing `service/`,
  `orchestration/`, `routers/`, `trpc/`, or `agents/`.
  (`no-service-resources-importing-app-layers`)
- **One writer per Prisma model.** Ownership is declared in `registry.ts` and
  checked by `scripts/check-service-registry.ts` and
  `scripts/check-single-writer.ts`. Adding a model means adding it to
  `prismaModelNames` and assigning an owner.
- **Services are transport-neutral.** No importing `routers/` or `trpc/`, and no
  `@trpc/server` — throw application errors and let the transport layer map
  them. (`no-services-importing-transport-layers`,
  `no-trpc-server-in-services-or-orchestration`)
- **Services do not import `orchestration/`.** Coordination flows the other way.

Cross-capsule workflows belong in `src/backend/orchestration/`.

## Conventions

- Tests are co-located: `foo.service.ts` → `foo.service.test.ts`. The slower set
  is `*.integration.test.ts`.
- Read config through `configService`, never `process.env`.
- Recurring work registers with `jobRunner` rather than calling `setInterval` —
  see `docs/architecture/background-jobs.md`.
- All `gh` invocations go through `GitHubCLIService`, which owns the shared rate
  budget. Do not spawn `gh` yourself.
- Side-table accessors (`WorkspacePR`, `WorkspaceRatchet`, `WorkspaceRunScript`,
  `WorkspaceAutoIteration`) flatten their row back onto the workspace on read,
  preserving the original field names on the wire. Keep that contract when you
  add fields — see `docs/architecture/workspace-state.md`.
