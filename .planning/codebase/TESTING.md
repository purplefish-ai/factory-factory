# Testing Patterns

**Analysis Date:** 2026-05-17

## Test Framework

**Runner:**
- Vitest 4.0.18 for unit and integration tests.
- Root config: `vitest.config.ts`.
- Core package config: `packages/core/package.json` uses Vitest scripts for `packages/core/src/**/*.test.ts`.
- Playwright 1.58.2 for mobile visual baseline tests.
- Playwright config: `playwright.mobile.config.ts`.

**Assertion Library:**
- Vitest `expect` for unit, integration, jsdom, and backend tests.
- Playwright `expect` for browser and screenshot assertions in `e2e/mobile-baseline.spec.ts`.
- Supertest is available and used for Express route tests such as `src/backend/routers/health.router.test.ts` and `src/backend/server.upgrade.test.ts`.

**Run Commands:**
```bash
pnpm test                         # Run root Vitest suite for src/**/*.test.* and electron/**/*.test.ts
pnpm test:watch                   # Run Vitest in watch mode
pnpm test:coverage                # Run Vitest with v8 coverage
pnpm test:coverage:backend        # Run backend coverage only
pnpm check:coverage:critical      # Enforce critical backend coverage groups
pnpm test:integration             # Run src/backend/**/*.integration.test.ts
pnpm test:e2e:mobile              # Run Playwright mobile baseline screenshots
pnpm --filter @factory-factory/core test # Run package-local core tests
```

## Test File Organization

**Location:**
- Co-locate tests next to the module they cover. Examples: `src/backend/services/workspace/service/state/kanban-state.test.ts`, `src/lib/formatters.test.ts`, `src/client/components/kanban/issue-card.test.tsx`.
- Keep backend service tests inside the relevant service capsule: `src/backend/services/session/service/lifecycle/session.service.test.ts`, `src/backend/services/workspace/resources/workspace.accessor.test.ts`.
- Keep reusable test infrastructure in `src/backend/testing/` and `src/test-utils/`.
- Keep Playwright specs under `e2e/`; mobile snapshots live beside the spec in `e2e/mobile-baseline.spec.ts-snapshots/`.
- Keep Storybook stories beside UI components as `*.stories.tsx`, e.g. `src/components/chat/chat-input.stories.tsx`.

**Naming:**
- Use `*.test.ts` for node/unit tests and pure helpers.
- Use `*.test.tsx` for React/component/jsdom tests.
- Use `*.integration.test.ts` for integration suites that use real database, WebSocket, or multi-module runtime behavior.
- Use `*.manual.integration.test.ts` for opt-in tests that require a real external runtime, such as `src/backend/services/session/service/acp/codex-app-server-adapter/codex-app-server-acp-adapter.manual.integration.test.ts`.
- Use `*.spec.ts` for Playwright specs, e.g. `e2e/mobile-baseline.spec.ts`.

**Structure:**
```text
src/backend/services/{service}/service/**/*.test.ts
src/backend/services/{service}/resources/**/*.test.ts
src/backend/trpc/**/*.router.test.ts
src/backend/routers/websocket/*.handler.test.ts
src/client/**/*.test.tsx
src/components/**/*.test.tsx
src/shared/**/*.test.ts
electron/**/*.test.ts
e2e/*.spec.ts
packages/core/src/**/*.test.ts
```

## Test Structure

**Suite Organization:**
```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('computeKanbanColumn', () => {
  it('maps initializing or active work to WORKING', () => {
    expect(
      computeKanbanColumn({
        lifecycle: 'NEW',
        isWorking: false,
        prState: 'NONE',
        ratchetState: 'IDLE',
        hasHadSessions: false,
      })
    ).toBe('WORKING');
  });
});
```

**Patterns:**
- Group by exported function or service behavior with `describe`, then write behavior-oriented `it` names. Use examples from `src/backend/services/workspace/service/state/kanban-state.test.ts`.
- Test pure functions with direct input/output assertions before service integration behavior. `src/backend/services/workspace/service/state/kanban-state.test.ts` tests `computeKanbanColumn` separately from `kanbanStateService`.
- For tRPC routers, create a caller helper with `router.createCaller(...)`, mock service dependencies, and assert resolved data plus thrown errors. See `src/backend/trpc/project.router.test.ts` and `src/backend/trpc/linear.router.test.ts`.
- For React/jsdom tests, opt into jsdom with `// @vitest-environment jsdom`, create a DOM container, render with `createRoot`, wrap rendering in `flushSync`, and clean `document.body.innerHTML` in `afterEach`. See `src/client/routes/reviews.test.tsx` and `src/components/agent-activity/tool-renderers/tool-result-renderer.test.tsx`.
- For server-rendered presentational components, use `renderToStaticMarkup` when DOM interactivity is not required. Examples: `src/client/components/workspace-status-icon.test.tsx`, `src/client/components/pr-status-badges.test.tsx`.
- For WebSocket behavior, use helpers from `src/backend/testing/websocket-test-utils.ts` and close sockets/servers in `afterEach`.
- For database integration, use helpers from `src/backend/testing/integration-db.ts`, create fixtures in the test file, clear database rows in `afterEach`, and destroy the DB in `afterAll`.

## Mocking

**Framework:** Vitest `vi`.

**Patterns:**
```typescript
const mockFindById = vi.hoisted(() => vi.fn());

vi.mock('@/backend/services/workspace/resources/workspace.accessor', () => ({
  workspaceAccessor: {
    findById: (...args: unknown[]) => mockFindById(...args),
  },
}));
```

```typescript
const actual = await vi.importActual<typeof import('./image-utils')>('./image-utils');
return {
  ...actual,
  isImageFile: vi.fn(),
};
```

**What to Mock:**
- Mock service barrels and infrastructure boundaries in unit tests: `@/backend/services/workspace`, `@/backend/lib/shell`, `@/backend/services/crypto.service`, `@/client/lib/trpc`.
- Use `vi.hoisted` for mock functions referenced by `vi.mock` factories, as in `src/backend/trpc/project.router.test.ts` and `src/backend/services/workspace/service/state/kanban-state.test.ts`.
- Mock React Router, Sonner toasts, tRPC hooks, and heavy UI primitives in jsdom component tests. See `src/client/routes/reviews.test.tsx` and `src/client/components/kanban/inline-workspace-form.test.tsx`.
- Use small fake classes for eventful collaborators when behavior matters, such as `FakeTerminalService` and `FakeRunScriptService` in `src/backend/routers/websocket/websocket.integration.test.ts`.
- Use `vi.importActual` after test DB setup when integration tests need real service modules bound to a fresh module cache. See `src/backend/services/resources.integration.test.ts`.

**What NOT to Mock:**
- Do not mock pure functions under test; call them directly.
- Do not mock Prisma in integration tests that verify resource accessors. Use `createIntegrationDatabase` from `src/backend/testing/integration-db.ts`.
- Do not mock service capsule public exports in domain-export boundary tests such as `src/backend/services/workspace/service/workspace-domain-exports.test.ts` and `src/backend/services/ratchet/service/ratchet-domain-exports.test.ts`.
- Do not use real external Codex app-server behavior in normal CI paths. Keep it behind `RUN_REAL_CODEX_APP_SERVER_TESTS=1` in manual integration tests.

## Fixtures and Factories

**Test Data:**
```typescript
async function createProjectFixture(overrides: Partial<Prisma.ProjectUncheckedCreateInput> = {}) {
  const slug = (overrides.slug as string | undefined) ?? nextId('project');
  return await prisma.project.create({
    data: {
      name: `Project ${slug}`,
      slug,
      repoPath: `/tmp/${slug}`,
      worktreeBasePath: `/tmp/worktrees/${slug}`,
      defaultBranch: 'main',
      ...overrides,
    },
  });
}
```

**Location:**
- Keep narrow fixtures local to the test file, as in `src/backend/services/resources.integration.test.ts` and `src/backend/routers/websocket/websocket.integration.test.ts`.
- Put reusable infrastructure fixtures in `src/backend/testing/integration-db.ts` and `src/backend/testing/websocket-test-utils.ts`.
- Put type-boundary helpers in `src/test-utils/unsafe-coerce.ts`.
- Use temp directories from `mkdtempSync(join(tmpdir(), ...))` and clean with `rmSync(..., { recursive: true, force: true })`. Examples: `src/backend/trpc/project.router.test.ts`, `src/backend/services/resources.integration.test.ts`.

## Coverage

**Requirements:** Root Vitest coverage uses V8 and reports `text`, `json`, `json-summary`, and `html`; config is `vitest.config.ts`.

**View Coverage:**
```bash
pnpm test:coverage
pnpm test:coverage:backend
pnpm check:coverage:critical
```

**Scope:**
- Coverage includes `src/backend/**/*.ts`.
- Coverage excludes backend tests, `src/backend/index.ts`, `src/backend/testing/**`, service and route barrels, type files, bridge files, and constants. See `vitest.config.ts`.
- Aggregate coverage thresholds are enforced in `vitest.config.ts` and fail `pnpm test:coverage` when any minimum drops.
- Critical coverage thresholds are enforced by `scripts/check-critical-coverage.mjs` across WebSocket, resource accessor, run-script, workspace runtime, workspace tRPC, and specific backend files.

## Test Types

**Unit Tests:**
- Scope pure helpers, state derivation, reducers, schemas, CLI helpers, frontend cache helpers, and service methods with mocked dependencies.
- Examples: `src/backend/lib/error-utils.test.ts`, `src/shared/session-runtime.test.ts`, `src/components/chat/chat-reducer.test.ts`, `src/client/lib/snapshot-to-kanban.test.ts`.
- Prefer direct `expect(...).toEqual(...)`, `toMatchObject`, `arrayContaining`, and explicit rejected error assertions.

**Integration Tests:**
- Use real temporary SQLite databases for resource accessors and persistence behavior via `src/backend/testing/integration-db.ts`.
- Use real WebSocket server/client flows through `src/backend/testing/websocket-test-utils.ts`.
- Keep external runtime integrations opt-in with environment variables. Manual Codex adapter tests live in `src/backend/services/session/service/acp/codex-app-server-adapter/*.manual.integration.test.ts` and `src/backend/services/session/service/acp/acp-runtime-manager.manual.integration.test.ts`.
- Use `pnpm test:integration` for `src/backend/**/*.integration.test.ts`.

**E2E Tests:**
- Use Playwright for the mobile baseline only. Config is `playwright.mobile.config.ts`; spec is `e2e/mobile-baseline.spec.ts`.
- The mobile baseline starts Vite with `VITE_ENABLE_MOBILE_BASELINE=1`, navigates to `/__mobile-baseline`, validates interactions and overflow, and captures screenshots for iPhone SE, iPhone 14, and Pixel 7 sizes.

**Storybook:**
- Storybook is configured in `.storybook/main.ts` and `.storybook/preview.ts`.
- Stories live under `src/components/**/*.stories.tsx`, `src/client/**/*.stories.tsx`, and `src/frontend/components/**/*.stories.tsx`.
- Storybook decorators provide `MemoryRouter`, `TRPCProvider`, and `TooltipProvider` in `.storybook/preview.ts`.

## Common Patterns

**Async Testing:**
```typescript
await expect(caller.getById({ id: 'missing' })).rejects.toThrow('Project not found: missing');
await expect(kanbanStateService.getWorkspaceKanbanState('missing')).resolves.toBeNull();
```

**Error Testing:**
```typescript
mockGitCommandC.mockResolvedValueOnce({
  code: 1,
  stdout: '',
  stderr: 'failed',
});

await expect(caller.listBranches({ projectId: 'p1' })).rejects.toThrow(
  'Failed to list branches: failed'
);
```

**React DOM Testing:**
```typescript
// @vitest-environment jsdom
const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);

flushSync(() => {
  root.render(createElement(ReviewsPage));
});

expect(container.querySelector('a[href="/projects/alpha/workspaces"]')).not.toBeNull();
root.unmount();
```

**Lifecycle Cleanup:**
- Root `vitest.config.ts` loads `src/backend/testing/setup.ts`, which calls `vi.clearAllMocks()` before each test and `vi.restoreAllMocks()` after each test.
- Tests that allocate DOM, files, sockets, servers, or DBs must still clean those resources locally. Examples: `src/client/routes/reviews.test.tsx`, `src/backend/trpc/project.router.test.ts`, `src/backend/routers/websocket/websocket.integration.test.ts`, `src/backend/services/resources.integration.test.ts`.

**Type Coercion in Tests:**
- Use `unsafeCoerce<T>(value)` from `src/test-utils/unsafe-coerce.ts` for intentionally incomplete test doubles. Keep it in tests and fixtures only.
- Prefer `as never` only for compact mocks where a full domain object is irrelevant, as seen in `src/backend/services/workspace/service/state/kanban-state.test.ts`.

**Environment in Tests:**
- Direct `process.env` access is allowed in tests and explicit env/config modules. Production backend modules should route environment access through `src/backend/services/config.service.ts`, `src/backend/lib/env.ts`, and `src/backend/services/env-schemas.ts`.
- Tests that alter process-level state must reset module caches or restore globals. `src/backend/testing/integration-db.ts` uses `vi.resetModules()` and resets `globalThis.prismaGlobal`.

---

*Testing analysis: 2026-05-17*
