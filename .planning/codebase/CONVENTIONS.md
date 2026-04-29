# Coding Conventions

**Analysis Date:** 2026-04-29

## Naming Patterns

**Files:**
- Use kebab-case or domain-qualified filenames for implementation modules: `src/backend/services/git-ops.service.ts`, `src/backend/trpc/project.trpc.ts`, `src/backend/lib/workspace-derived-state.ts`.
- Use `.service.ts` for backend business services and `.accessor.ts` for Prisma-backed resource access: `src/backend/services/ratchet/service/reconciliation.service.ts`, `src/backend/services/workspace/resources/workspace.accessor.ts`.
- Use `.trpc.ts` for tRPC routers and keep matching tests as `.router.test.ts`: `src/backend/trpc/session.trpc.ts`, `src/backend/trpc/session.router.test.ts`.
- Use `.test.ts` and `.test.tsx` for Vitest files colocated with the subject module: `src/backend/services/workspace/resources/workspace.accessor.test.ts`, `src/components/chat/permission-prompt.test.tsx`.
- Use `.stories.tsx` for Storybook stories beside UI components: `src/components/ui/button.stories.tsx`, `src/client/components/kanban/kanban-board.stories.tsx`.

**Functions:**
- Use `camelCase` for functions and hooks: `createContext` in `src/backend/trpc/trpc.ts`, `resolveExplicitSessionProvider` in `src/client/routes/projects/workspaces/use-workspace-detail.ts`.
- Use `use*` names for React hooks: `useWorkspaceData` and `useSessionManagement` in `src/client/routes/projects/workspaces/use-workspace-detail.ts`.
- Use verb-object names for service methods and helpers: `findByProjectIdWithSessions`, `startPeriodicCleanup`, `validateBranchName`, `execCommand`.
- Prefer small local factory helpers in tests with explicit names: `createCaller` in `src/backend/trpc/session.router.test.ts`, `createProjectFixture` in `src/backend/services/resources.integration.test.ts`.

**Variables:**
- Use `camelCase` for local values and parameters: `workspaceId`, `selectedProvider`, `cleanupPromise`.
- Use `UPPER_SNAKE_CASE` for true constants and env-like values: `STALE_PROVISIONING_THRESHOLD_MS` in `src/backend/services/workspace/resources/workspace.accessor.ts`, `MIGRATIONS_PATH` in `src/backend/testing/integration-db.ts`.
- Use `mock*` prefixes for Vitest mock functions: `mockFindMany` in `src/backend/services/workspace/resources/workspace.accessor.test.ts`, `mockSessionDataService` in `src/backend/trpc/session.router.test.ts`.
- Use `*_SCHEMA`-like exported names sparingly; actual schemas use PascalCase names ending in `Schema`: `ConfigEnvSchema` in `src/backend/services/env-schemas.ts`, `exportDataSchema` in `src/shared/schemas/export-data.schema.ts`.

**Types:**
- Use PascalCase for interfaces, type aliases, enums, and React props: `UseSessionManagementReturn`, `ExecResult`, `Context`.
- Use `Input` suffix for command/query payload types: `CreateWorkspaceInput`, `UpdateWorkspaceInput`, `FindByProjectIdFilters` in `src/backend/services/workspace/resources/workspace.accessor.ts`.
- Use `*With*` names for Prisma payload projections: `WorkspaceWithSessions`, `WorkspaceWithSessionsAndProject` in `src/backend/services/workspace/resources/workspace.accessor.ts`.
- Export public types from service barrels, not from internal paths. Service capsules expose their API through `src/backend/services/{name}/index.ts`.

## Code Style

**Formatting:**
- Use Biome formatting via `pnpm check:fix`; config lives in `biome.json`.
- Use 2-space indentation, 100-character line width, LF endings, UTF-8, final newline, and trimmed trailing whitespace from `.editorconfig` and `biome.json`.
- Use single quotes, semicolons, and trailing commas where valid in ES5 positions from `biome.json`.
- Keep JSX concise and let Biome enforce self-closing fragments/elements where possible.

**Linting:**
- Use `pnpm check` for Biome, environment access checks, and ownership checks as defined in `package.json`.
- Biome recommended rules are enabled in `biome.json`; notable enforced rules include no unused imports/variables, exhaustive hook deps, top-level hooks, `useImportType`, no explicit `any`, no non-null assertions, no console, no floating promises, no misused promises, no dangerous HTML, and no accumulating spread.
- Test and story files may use non-null assertions under the override in `biome.json`: `**/*.test.ts`, `**/*.test.tsx`, `**/*.stories.tsx`.
- Console usage is restricted to explicit infrastructure allowlists in `biome.json`: `src/backend/services/logger.service.ts`, `src/lib/debug.ts`, `src/cli/**/*.ts`, `scripts/**/*.ts`, `electron/**/*.ts`.
- Cognitive complexity exceptions are file-specific in `biome.json`; avoid adding new exceptions unless the local code path genuinely cannot be simplified.
- Custom Biome Grit rules live in `biome-rules/` and enforce local constraints such as no native dialogs, no Next directives, no `z.any`, no unsafe JSON parse casts, and no unsafe resolver casts.

## Import Organization

**Order:**
1. Node built-ins with `node:` protocol, usually first: `import path from 'node:path';` in `scripts/check-service-registry.ts`.
2. External packages and generated clients: `@trpc/server`, `@prisma-gen/client`, `react`, `vitest`.
3. Absolute project aliases: `@/backend/...`, `@/client/...`, `@/shared/...`, `@/lib/...`.
4. Local same-directory imports with `./...` only: `./workspace.accessor`, `./trpc`, `./reconciliation.service`.

**Path Aliases:**
- Use `@/*` for `src/*`, configured in `tsconfig.json`, `vitest.config.ts`, and Vite.
- Use `@prisma-gen/*` for `prisma/generated/*`.
- Use `@factory-factory/core-types/*` for `packages/core/src/types/*`.
- Parent-relative imports (`../`) are disallowed by `scripts/check-ambiguous-relative-imports.mjs`; use aliases for non-local modules.
- Relative imports are allowed for same-directory modules and explicit local barrels, as seen in `src/backend/trpc/session.trpc.ts` importing `./trpc`.

**Boundary Rules:**
- Frontend files in `src/client/`, `src/components/`, and legacy `src/frontend/` must not import backend modules, except `src/client/lib/trpc.ts` may import backend tRPC types. This is enforced in `.dependency-cruiser.cjs`.
- Backend files must not import UI layers from `src/client/`, `src/components/`, or `src/frontend/`.
- `src/shared/` must stay framework/domain neutral and must not import backend, client, frontend, or component layers.
- tRPC and orchestration consumers must import service capsule barrels such as `@/backend/services/session`, not service internals. This is enforced in `.dependency-cruiser.cjs` and `scripts/check-service-registry.ts`.
- Service-to-service imports must go through barrels and match `dependsOn` in `src/backend/services/registry.ts`.
- Database access belongs in service resource layers under `src/backend/services/{name}/resources/`; direct `@/backend/db` imports are otherwise restricted by `.dependency-cruiser.cjs`.

## Error Handling

**Patterns:**
- Use `TRPCError` for client-facing tRPC failures with explicit codes, such as `PRECONDITION_FAILED` in `src/backend/trpc/session.trpc.ts` and `BAD_REQUEST` in `src/backend/trpc/procedures/project-scoped.ts`.
- Use plain `Error` for internal invariants and missing state: `Session not found` in `src/backend/trpc/session.trpc.ts`, bridge configuration checks in `src/backend/services/ratchet/service/reconciliation.service.ts`.
- Convert unknown caught values with `toError` before structured logging: `src/backend/lib/error-utils.ts` and `src/backend/services/ratchet/service/reconciliation.service.ts`.
- Catch and log non-fatal background work so service loops continue running: `reconcileWorkspaces` and `startPeriodicCleanup` in `src/backend/services/ratchet/service/reconciliation.service.ts`.
- Use Zod for validation and normalization at API, env, and shared-data boundaries: `src/backend/services/env-schemas.ts`, `src/shared/schemas/export-data.schema.ts`, `src/shared/websocket/chat-message.schema.ts`.
- Avoid raw typecasts in production paths. When a cast is unavoidable in tests, keep it in test utilities such as `src/test-utils/unsafe-coerce.ts`.
- For shell execution, use `execCommand(command, args)` and typed validators from `src/backend/lib/shell.ts`; use shell strings only through `execShell` when shell features are required.

## Logging

**Framework:** Custom structured logger from `src/backend/services/logger.service.ts`.

**Patterns:**
- Create component loggers with `createLogger('component-name')`, as in `src/backend/services/ratchet/service/reconciliation.service.ts`.
- Log structured context objects rather than interpolating operational data into messages: `logger.warn('Marked stale provisioning workspace as failed', { workspaceId, initStartedAt })`.
- Pass real `Error` objects to `logger.error(message, error, context)` after converting unknown catches with `toError`.
- Do not use `console.*` in application code outside the allowlisted logger, CLI, Electron, scripts, and debug files declared in `biome.json`.
- Production logger output writes JSON to `~/factory-factory/logs/server.log` via `src/backend/services/logger.service.ts`; development output is pretty-printed and also written to the file.

## Comments

**When to Comment:**
- Use comments for behavior that prevents incorrect future edits, such as stale workspace thresholds in `src/backend/services/workspace/resources/workspace.accessor.ts`.
- Use comments around non-obvious lifecycle or concurrency decisions, such as avoiding overlapping cleanup runs in `src/backend/services/ratchet/service/reconciliation.service.ts`.
- Prefer comments that explain constraints or intent, not line-by-line restatements.

**JSDoc/TSDoc:**
- Public utilities and services often include JSDoc blocks for usage and safety contracts: `execCommand`, `escapeShellArg`, and `validateBranchName` in `src/backend/lib/shell.ts`.
- Types exposed across module boundaries include concise field comments when context matters: `Context` in `src/backend/trpc/trpc.ts`, `UseSessionManagementReturn` in `src/client/routes/projects/workspaces/use-workspace-detail.ts`.
- Test helper comments are acceptable when a helper encodes a fixture shape or setup constraint, as in `src/components/chat/chat-reducer.test.ts`.

## Function Design

**Size:** Keep pure helpers compact and extract repeated logic when behavior repeats. Larger services are class-based when they hold lifecycle state, for example `ReconciliationService` in `src/backend/services/ratchet/service/reconciliation.service.ts`.

**Parameters:** Use object parameters for multi-field commands and React hooks: `useWorkspaceData({ workspaceId })`, `workspaceAccessor.create({ projectId, name, ... })`. Use positional parameters for simple, stable helper APIs such as `validateBranchName(name)` and `gitCommand(args, cwd)`.

**Return Values:** Return typed promises from async services and accessors. Use explicit return interfaces for hooks that expose complex values to avoid leaking internal tRPC types, as in `UseSessionManagementReturn`.

**Async Work:** Await promises or intentionally discard with `void` when a fire-and-forget client invalidation/navigation is expected, as in `src/client/routes/projects/workspaces/use-workspace-detail.ts`.

**Stateful Services:** Encapsulate mutable runtime state as private class fields, expose a singleton instance, and keep configuration explicit through methods such as `configure` in `src/backend/services/ratchet/service/reconciliation.service.ts`.

## Module Design

**Exports:** Export named values and singleton instances. Avoid default exports except where framework conventions use them, such as route components and config files (`vitest.config.ts`, `playwright.mobile.config.ts`).

**Barrel Files:** Service capsules must expose public API through `src/backend/services/{name}/index.ts`; consumers import `@/backend/services/workspace`, not `@/backend/services/workspace/resources/workspace.accessor`.

**Layering:** Keep resource access in `resources/`, business logic in `service/`, cross-service coordination in `src/backend/orchestration/`, transport in `src/backend/trpc/` and `src/backend/routers/`, client route state in `src/client/`, and shared UI in `src/components/`.

**Validation:** Put reusable browser-safe schemas under `src/shared/schemas/` or `src/shared/websocket/`; put backend-specific env schemas in `src/backend/services/env-schemas.ts`.

**Configuration Access:** Backend production code should read environment variables through `configService` and Zod schemas. `scripts/check-no-direct-process-env.mjs` enforces this, with a narrow allowlist for config, logger, terminal/runtime adapters, and similar infrastructure.

---

*Convention analysis: 2026-04-29*
