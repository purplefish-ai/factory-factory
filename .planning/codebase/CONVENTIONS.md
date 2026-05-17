# Coding Conventions

**Analysis Date:** 2026-05-17

## Naming Patterns

**Files:**
- Use lowercase kebab-case for feature modules, services, routers, hooks, helpers, and tests: `src/backend/services/workspace/service/state/kanban-state.ts`, `src/backend/trpc/project.trpc.ts`, `src/client/routes/projects/workspaces/use-workspace-detail.ts`, `src/lib/session-provider-selection.ts`.
- Use suffixes that identify the module role:
  - Backend tRPC routers: `*.trpc.ts`, e.g. `src/backend/trpc/workspace/init.trpc.ts`.
  - Backend tests: `*.test.ts`, `*.integration.test.ts`, or `*.manual.integration.test.ts`, e.g. `src/backend/routers/websocket/websocket.integration.test.ts`.
  - React component tests: `*.test.tsx`, e.g. `src/components/agent-activity/tool-renderers/tool-result-renderer.test.tsx`.
  - Storybook stories: `*.stories.tsx`, e.g. `src/components/ui/button.stories.tsx`.
- Service capsules use a fixed directory contract: `src/backend/services/{name}/index.ts`, `src/backend/services/{name}/service/`, and `src/backend/services/{name}/resources/`. New service files must follow this layout and export their public API from `src/backend/services/{name}/index.ts`.
- Shared cross-runtime contracts live under `src/shared/`, with explicit domain folders such as `src/shared/core/`, `src/shared/schemas/`, `src/shared/acp-protocol/`, and `src/shared/websocket/`.

**Functions:**
- Use `camelCase` for functions and methods: `computeKanbanColumn` in `src/backend/services/workspace/service/state/kanban-state.ts`, `sanitizeIssueTrackerConfig` in `src/shared/schemas/issue-tracker-config.schema.ts`, `createTrpcClient` in `src/client/lib/trpc.ts`.
- Use `create*` for factories and callers: `createContext` in `src/backend/trpc/trpc.ts`, `createWebSocketTestServer` in `src/backend/testing/websocket-test-utils.ts`, `createIntegrationDatabase` in `src/backend/testing/integration-db.ts`.
- Use `derive*` for pure state derivation helpers: `deriveWorkspaceRuntimeState` in `src/backend/services/workspace/service/state/workspace-runtime-state.ts`, `deriveWorkspaceSidebarStatus` in `src/shared/core/workspace-sidebar-status.ts`.
- Use `get*`, `find*`, `list*`, `update*`, and `delete*` verbs for resource and service methods. Keep data access verbs inside resource accessors such as `src/backend/services/workspace/resources/workspace.accessor.ts`.

**Variables:**
- Use `camelCase` for local variables, object fields, and parameters: `workspaceId`, `projectId`, `cachedKanbanColumn`, `stateComputedAt`.
- Use `PascalCase` for React components and classes: `KanbanCard` in `src/client/components/kanban/kanban-card.tsx`, `WorkspaceAccessor` in `src/backend/services/workspace/resources/workspace.accessor.ts`.
- Use `UPPER_SNAKE_CASE` for true constants and environment flag constants: `STALE_PROVISIONING_THRESHOLD_MS` in `src/backend/services/workspace/resources/workspace.accessor.ts`, `RUN_REAL_CODEX_APP_SERVER_TESTS` in `src/backend/services/session/service/acp/codex-app-server-adapter/codex-app-server-acp-adapter.manual.integration.test.ts`.
- Use explicit mock names in tests: `mockProjectManagementService` in `src/backend/trpc/project.router.test.ts`, `mockFindById` in `src/backend/services/workspace/service/state/kanban-state.test.ts`.

**Types:**
- Use `PascalCase` for interfaces, type aliases, enum-like imports, schemas, and services: `KanbanStateInput`, `WorkspaceWithKanbanState`, `UseSessionManagementReturn`, `IssueTrackerConfigSchema`.
- Export domain input/output types that callers need; keep implementation-only types local to the file. Examples: `WorkspaceWithSessions` is exported from `src/backend/services/workspace/resources/workspace.accessor.ts`, while `FindByProjectIdFilters` stays local.
- Prefer `interface` for object shapes consumed by implementations and `type` for derived Prisma/Zod/helper types: `UseSessionManagementOptions` in `src/client/routes/projects/workspaces/use-workspace-detail.ts`, `ConfigEnv = ReturnType<typeof ConfigEnvSchema.parse>` in `src/backend/services/config.service.ts`.
- Derive validation-backed types from Zod schemas with `z.infer`, as in `src/shared/schemas/issue-tracker-config.schema.ts` and `src/backend/schemas/tool-inputs.schema.ts`.

## Code Style

**Formatting:**
- Use Biome via `pnpm check:fix`; config is `biome.json`.
- Use 2-space indentation, 100-character line width, single quotes, semicolons, trailing commas where valid in ES5, and organized imports.
- Keep JSX self-closing when possible and use fragments where a wrapper element is unnecessary; Biome enforces `useSelfClosingElements` and `useFragmentSyntax` in `biome.json`.
- Use numeric separators for large numeric constants: `10_000` in `src/client/routes/projects/workspaces/use-workspace-detail.ts`, `30_000` in `src/backend/services/env-schemas.ts`.

**Linting:**
- Run `pnpm check` for Biome, environment-access checks, and ownership checks; run `pnpm check:fix` for formatting and fixable lints. Scripts are declared in `package.json`.
- Keep TypeScript strict and no-implicit-any compliant; `tsconfig.json` enables `strict`, `noImplicitAny`, `strictNullChecks`, `noUncheckedIndexedAccess`, and `noImplicitReturns`.
- Do not use `any`; Biome enforces `noExplicitAny` in `biome.json`. Use `unknown`, Zod schemas, domain types, or the test-only `unsafeCoerce` helper in `src/test-utils/unsafe-coerce.ts` when a test intentionally crosses a type boundary.
- Do not use non-null assertions in source. Biome disables `noNonNullAssertion` only for `**/*.test.ts`, `**/*.test.tsx`, and `**/*.stories.tsx` in `biome.json`.
- Do not use `console` in normal source. Use `createLogger` from `src/backend/services/logger.service.ts`; `console` is allowlisted only for selected CLI, script, Electron, debug, and logger files in `biome.json`.
- Do not cast `JSON.parse` results. Validate parsed data with Zod; the custom rule is `biome-rules/no-unsafe-json-parse-cast.grit`.
- Do not use `z.any()`. Use a specific Zod schema or `z.unknown()` with explicit narrowing; the custom rule is `biome-rules/no-zod-any.grit`.

## Import Organization

**Order:**
1. Node built-ins with `node:` protocol: `import { writeFile } from 'node:fs/promises';`.
2. External packages and type imports: `import { TRPCError } from '@trpc/server';`, `import { z } from 'zod';`.
3. Alias imports from `@/`, `@prisma-gen/`, and `@factory-factory/core-types/`.
4. Relative imports limited to same-directory or child modules with `./`.

**Path Aliases:**
- Use `@/*` for `src/*`, configured in `tsconfig.json`, `vite.config.ts`, and `vitest.config.ts`.
- Use `@prisma-gen/*` for `prisma/generated/*`, configured in `tsconfig.json`, `vite.config.ts`, and `vitest.config.ts`.
- Use `@factory-factory/core-types/*` for `packages/core/src/types/*`, configured in `tsconfig.json` and `vitest.config.ts`.

**Import Boundaries:**
- Do not use parent-relative imports such as `../foo` inside `src/`; `scripts/check-ambiguous-relative-imports.mjs` rejects parent-relative specifiers and ambiguous file/directory imports.
- Cross-service imports must target service capsule barrels only: `@/backend/services/workspace`, not `@/backend/services/workspace/service/...`. The registry check is `scripts/check-service-registry.ts`, and dependency rules are in `.dependency-cruiser.cjs`.
- tRPC routers and orchestration code must import service barrels, not service internals. Examples of valid imports are `projectManagementService` from `@/backend/services/workspace` in `src/backend/trpc/project.trpc.ts` and workspace services from `@/backend/services/workspace` in `src/backend/trpc/workspace/init.trpc.ts`.
- Resource accessors are data-layer internals. Normal backend callers should use service APIs instead of `src/backend/services/{name}/resources/*`; dependency-cruiser enforces this in `.dependency-cruiser.cjs`.
- Frontend code must not import backend implementation modules. The one frontend exception is `src/client/lib/trpc.ts`, which imports only the backend tRPC type `AppRouter` from `src/backend/trpc`.
- Shared code in `src/shared/` must not import backend, client, or component layers. Put framework-neutral contracts, enums, and schemas there.

## Error Handling

**Patterns:**
- Throw `TRPCError` for API-level status semantics in tRPC procedures, as in `src/backend/trpc/workspace/init.trpc.ts` for `NOT_FOUND`, `BAD_REQUEST`, and `TOO_MANY_REQUESTS`.
- Throw regular `Error` for internal domain and invariant failures, as in `src/backend/services/workspace/resources/workspace.accessor.ts` and `src/backend/trpc/project.trpc.ts`.
- Convert `unknown` catch values with `toError` from `src/backend/lib/error-utils.ts` before passing errors to the logger.
- Background async work must catch and log errors instead of leaving floating promises. `initializeWorkspaceWorktree(...).catch(...)` in `src/backend/trpc/workspace/init.trpc.ts` is the standard pattern.
- Prefer `safeParse` at trust boundaries and return sanitized public shapes. `sanitizeIssueTrackerConfig` in `src/shared/schemas/issue-tracker-config.schema.ts` strips the Linear API key and exposes `hasApiKey`.
- State transitions that can race should use compare-and-swap helpers in resource accessors, such as `transitionWithCas` and `casRunScriptStatusUpdate` in `src/backend/services/workspace/resources/workspace.accessor.ts`.

## Logging

**Framework:** `createLogger` from `src/backend/services/logger.service.ts`.

**Patterns:**
- Create a component logger near module scope: `const logger = createLogger('kanban-state');` in `src/backend/services/workspace/service/state/kanban-state.ts`.
- Log structured context objects rather than interpolated blobs: `logger.warn('Cannot update cached kanban column: workspace not found', { workspaceId })`.
- Pass normalized `Error` instances to `logger.error` when logging caught exceptions, as in `src/backend/trpc/workspace/init.trpc.ts`.
- Keep logs free of secrets. Public config sanitization lives in `src/shared/schemas/issue-tracker-config.schema.ts`, and env parsing is centralized in `src/backend/services/env-schemas.ts`.
- Use `console` only in allowlisted CLI/script/runtime files in `biome.json`, such as `src/cli/**/*.ts`, `scripts/**/*.ts`, and `electron/**/*.ts`.

## Comments

**When to Comment:**
- Add comments for architectural constraints, state-machine rules, race prevention, and non-obvious API behavior. Good examples are the Kanban derivation comments in `src/backend/services/workspace/service/state/kanban-state.ts`, config path comments in `vite.config.ts`, and test DB cache reset notes in `src/backend/testing/integration-db.ts`.
- Avoid comments that restate simple assignments. Prefer names that explain local intent.
- Use section banners sparingly for long files with distinct areas, as in `src/backend/schemas/tool-inputs.schema.ts` and `src/client/routes/projects/workspaces/use-workspace-detail.ts`.

**JSDoc/TSDoc:**
- Use JSDoc for exported helpers, public service methods, complex inputs, and behavior that future callers rely on. Examples: `createTrpcClient` in `src/client/lib/trpc.ts`, `safeParseToolInput` in `src/backend/schemas/tool-inputs.schema.ts`, and `findByProjectIdWithSessions` in `src/backend/services/workspace/resources/workspace.accessor.ts`.
- Keep inline comments short and tied to a concrete invariant or tradeoff.

## Function Design

**Size:** Keep pure logic small and directly testable. Extract derivation helpers such as `computeKanbanColumn` in `src/backend/services/workspace/service/state/kanban-state.ts` and `formatRelativeTime` in `src/lib/utils.ts`.

**Parameters:** Use object parameters for hooks, service entry points, and operations with more than two fields. Examples: `useWorkspaceData({ workspaceId })` in `src/client/routes/projects/workspaces/use-workspace-detail.ts`, `initializeWorkspaceWorktree(workspace.id, { branchName, useExistingBranch })` in `src/backend/trpc/workspace/init.trpc.ts`.

**Return Values:** Return explicit domain objects and nullable values at lookup boundaries. Use `Promise<T | null>` for missing resources (`findById` in `src/backend/services/workspace/resources/workspace.accessor.ts`) and throw when absence is exceptional (`findRawByIdOrThrow`).

**Async:** Await promises or explicitly discard with `void` when a promise is intentionally fire-and-forget in UI callbacks. Biome enforces `noFloatingPromises`.

**React Hooks:** Keep hooks named `use*`, keep hook calls at the top level, and return named objects for multi-value hooks. Examples are `useWorkspaceData` and `useSessionManagement` in `src/client/routes/projects/workspaces/use-workspace-detail.ts`.

## Module Design

**Exports:**
- Service capsules expose public APIs through `src/backend/services/{name}/index.ts` and nested service barrels such as `src/backend/services/workspace/service/index.ts`. Consumers outside the capsule must import from the barrel.
- Shared contracts export types, schemas, and pure helpers from stable index modules such as `src/shared/core/index.ts`.
- tRPC routers export a named router, e.g. `projectRouter` in `src/backend/trpc/project.trpc.ts`, and are composed into `appRouter` in `src/backend/trpc/index.ts`.
- UI modules export component functions and colocated prop types when callers need them. Example: `WorkspaceWithKanban` and `KanbanCardProps` patterns in `src/client/components/kanban/kanban-card.tsx`.

**Barrel Files:**
- Use service capsule barrels as the sole public API for backend services: `src/backend/services/workspace/index.ts`, `src/backend/services/session/index.ts`, `src/backend/services/terminal/index.ts`.
- Do not import broad backend barrels that dependency rules forbid, such as `src/backend/services/index.ts`, `src/backend/orchestration/index.ts`, or `src/backend/constants/index.ts`.
- Use component barrels where they already exist, such as `src/client/components/kanban/index.ts`, `src/components/shared/index.ts`, and `src/components/workspace/index.ts`.

**Backend Service Capsule Rules:**
- Put business logic under `src/backend/services/{name}/service/`.
- Put Prisma/resource access under `src/backend/services/{name}/resources/`.
- Register model ownership and allowed dependencies in `src/backend/services/registry.ts`.
- Use `src/backend/orchestration/` for cross-service workflows instead of adding service-to-service shortcuts.
- Run `pnpm check:service-registry` and `pnpm deps:check` when changing service boundaries.

**Validation and Configuration:**
- Define Zod schemas at external boundaries and infer types from schemas: `src/backend/services/env-schemas.ts`, `src/shared/schemas/factory-config.schema.ts`, `src/shared/websocket/chat-message.schema.ts`.
- Route backend environment reads through allowlisted config/env modules. `scripts/check-no-direct-process-env.mjs` rejects direct `process.env` access outside allowlisted files and tests.
- Keep secrets out of client-facing return values. Use sanitizers such as `sanitizeIssueTrackerConfig` in `src/shared/schemas/issue-tracker-config.schema.ts`.

---

*Convention analysis: 2026-05-17*
