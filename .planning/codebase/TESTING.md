# Testing Patterns

**Analysis Date:** 2026-04-29

## Test Framework

**Runner:**
- Vitest 4.0.18 from `package.json`.
- Root config: `vitest.config.ts`.
- Package config: `packages/core/vitest.config.ts`.
- Default environment is `node`; DOM tests opt into jsdom per file with `// @vitest-environment jsdom`.
- Global setup file: `src/backend/testing/setup.ts`.

**Assertion Library:**
- Vitest `expect`, including async matchers such as `resolves`, `rejects`, `toMatchObject`, `toHaveBeenCalledWith`, and `toHaveBeenNthCalledWith`.
- Playwright `expect` for e2e mobile screenshots in `e2e/mobile-baseline.spec.ts`.

**Run Commands:**
```bash
pnpm test                    # Run all Vitest tests
pnpm test:watch              # Run Vitest in watch mode
pnpm test:coverage           # Run Vitest with V8 coverage
pnpm test:coverage:backend   # Run backend coverage only
pnpm test:integration        # Run backend *.integration.test.ts files
pnpm test:e2e:mobile         # Run Playwright mobile baseline tests
```

## Test File Organization

**Location:**
- Tests are mostly colocated with implementation files: `src/backend/services/workspace/resources/workspace.accessor.test.ts`, `src/backend/trpc/session.router.test.ts`, `src/components/chat/permission-prompt.test.tsx`.
- Backend service capsule tests live under the same capsule folder they cover: `src/backend/services/ratchet/service/reconciliation.service.test.ts`, `src/backend/services/session/resources/agent-session.accessor.test.ts`.
- Shared library tests live beside shared modules: `src/shared/websocket/chat-message.schema.test.ts`, `src/shared/core/enums.drift.test.ts`.
- E2E tests live in `e2e/`, with snapshots beside the spec under `e2e/mobile-baseline.spec.ts-snapshots/`.

**Naming:**
- Use `.test.ts` for Node, pure helper, backend, and hook tests without JSX.
- Use `.test.tsx` for React component tests and DOM-rendered hook/component tests.
- Use `.integration.test.ts` for tests that exercise a real integration boundary such as SQLite migrations and accessors: `src/backend/services/resources.integration.test.ts`.
- Manual integration tests use `.manual.integration.test.ts` and env gates, such as Codex app-server runtime tests under `src/backend/services/session/service/acp/`.

**Structure:**
```text
src/backend/services/{service}/service/*.test.ts
src/backend/services/{service}/resources/*.test.ts
src/backend/trpc/*.router.test.ts
src/backend/routers/websocket/*.test.ts
src/client/**/*.test.ts
src/client/**/*.test.tsx
src/components/**/*.test.ts
src/components/**/*.test.tsx
src/shared/**/*.test.ts
e2e/*.spec.ts
packages/core/src/**/*.test.ts
```

## Test Structure

**Suite Organization:**
```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('workspaceAccessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('passes ratchetEnabled when provided', async () => {
      mockCreate.mockResolvedValue({ id: 'ws-1' });

      await workspaceAccessor.create({
        projectId: 'project-1',
        name: 'Issue workspace',
        ratchetEnabled: false,
      });

      expect(mockCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ ratchetEnabled: false }),
      });
    });
  });
});
```

**Patterns:**
- Group by public function, endpoint, reducer state, or flow with nested `describe` blocks, as in `src/backend/services/workspace/resources/workspace.accessor.test.ts` and `src/components/chat/chat-reducer.test.ts`.
- Use Arrange/Act/Assert layout without section labels unless the setup is long.
- Use realistic IDs and dates: `ws-1`, `project-1`, `2024-01-15T12:00:00Z`.
- Use `vi.useFakeTimers()` and `vi.setSystemTime()` for time-dependent logic, then restore with `vi.useRealTimers()` in `afterEach`: `src/backend/services/workspace/resources/workspace.accessor.test.ts`, `src/backend/services/ratchet/service/reconciliation.service.test.ts`.
- Use `await expect(promise).resolves...` and `await expect(promise).rejects...` for async behavior rather than manual try/catch.
- Assert side effects on mocks directly, including skipped work with `not.toHaveBeenCalled()`.

## Mocking

**Framework:** Vitest mocks: `vi.fn`, `vi.mock`, `vi.hoisted`, `vi.mocked`, `vi.spyOn`, `vi.importActual`.

**Patterns:**
```typescript
const mockFindMany = vi.fn();

vi.mock('@/backend/db', () => ({
  prisma: {
    workspace: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
    },
  },
}));

import { workspaceAccessor } from './workspace.accessor';
```

```typescript
const mockSessionDataService = vi.hoisted(() => ({
  findAgentSessionsByWorkspaceId: vi.fn(),
  createAgentSession: vi.fn(),
}));

vi.mock('@/backend/services/session', () => ({
  sessionDataService: mockSessionDataService,
}));
```

**What to Mock:**
- Mock Prisma access for unit tests of accessors and services: `src/backend/services/workspace/resources/workspace.accessor.test.ts`.
- Mock service barrels when testing tRPC router behavior: `src/backend/trpc/session.router.test.ts`, `src/backend/trpc/project.router.test.ts`.
- Mock logger services in unit tests when asserting behavior rather than output: `src/backend/services/ratchet/service/reconciliation.service.test.ts`.
- Mock UI primitives and heavy child components in focused DOM tests: `src/client/components/kanban/inline-workspace-form.test.tsx`.
- Mock filesystem, shell, and process boundaries when the test is about command construction or branch behavior: `src/backend/lib/ide-helpers.test.ts`, `src/backend/prompts/ratchet-dispatch.test.ts`.

**What NOT to Mock:**
- Do not mock pure helpers, reducers, schemas, or parser functions under test; call them directly as in `src/components/chat/chat-reducer.test.ts`, `src/shared/websocket/chat-message.schema.test.ts`, and `src/lib/diff/parse.test.ts`.
- Do not mock Prisma in integration accessor suites; use `src/backend/testing/integration-db.ts` and import actual service barrels after database setup.
- Do not mock tRPC middleware when the behavior under test is middleware context enforcement; create a small test router as in `src/backend/trpc/procedures/project-scoped.test.ts`.
- Do not mock real browser layout in Playwright e2e tests; use the Vite route and screenshot assertions in `e2e/mobile-baseline.spec.ts`.

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
- Keep one-off factories inside the test file when they are specific to that suite: `src/backend/services/resources.integration.test.ts`, `src/backend/routers/websocket/chat.handler.test.ts`.
- Put reusable integration database helpers in `src/backend/testing/integration-db.ts`.
- Put reusable WebSocket server helpers in `src/backend/testing/websocket-test-utils.ts`.
- Use `src/test-utils/unsafe-coerce.ts` only for test-only type coercion when constructing partial protocol fixtures.
- Store Playwright snapshots under the generated `e2e/*.spec.ts-snapshots/` directory.

## Coverage

**Requirements:** No numeric thresholds are enforced in `vitest.config.ts`. Coverage is configured for backend source only and excludes tests, backend entrypoint, testing helpers, index barrels, types, bridges, and constants.

**View Coverage:**
```bash
pnpm test:coverage
pnpm test:coverage:backend
pnpm check:coverage:critical
```

**Coverage Scope:**
- Provider: V8 via `@vitest/coverage-v8`.
- Reporters: text, JSON, JSON summary, and HTML from `vitest.config.ts`.
- Backend include: `src/backend/**/*.ts`.
- Focused stable backend coverage command excludes known unstable integration-style backend tests via `test:coverage:backend:stable` in `package.json`.

## Test Types

**Unit Tests:**
- Use mocked dependencies and direct function calls for services, helpers, reducers, schemas, hooks, and routers.
- Examples: `src/backend/services/ratchet/service/ratchet-pr-state.helpers.test.ts`, `src/lib/formatters.test.ts`, `src/components/chat/chat-reducer.test.ts`.

**Integration Tests:**
- Use temporary SQLite databases with real migrations through `src/backend/testing/integration-db.ts`.
- Import actual service barrels after `createIntegrationDatabase()` clears the cached Prisma module: `src/backend/services/resources.integration.test.ts`.
- Use real WebSocket client/server flows for router integration where needed: `src/backend/routers/websocket/websocket.integration.test.ts`.

**E2E Tests:**
- Playwright is used for mobile baseline layout and screenshots: `playwright.mobile.config.ts`, `e2e/mobile-baseline.spec.ts`.
- The Playwright web server starts Vite with `VITE_ENABLE_MOBILE_BASELINE=1` and visits `/__mobile-baseline`.
- Screenshot comparisons disable animations and allow a small pixel diff ratio in `playwright.mobile.config.ts`.

**Router Tests:**
- Build callers with `router.createCaller` and pass a minimal typed context cast as `never` when the test only needs a subset of `AppContext`: `src/backend/trpc/session.router.test.ts`, `src/backend/trpc/procedures/project-scoped.test.ts`.
- Assert tRPC errors by message or code depending on what the caller sees: `rejects.toThrow('Maximum sessions per workspace')`, `rejects.toMatchObject({ code: 'BAD_REQUEST' })`.

**React DOM Tests:**
- Add `// @vitest-environment jsdom` at the top of DOM tests.
- Render with `createRoot` and `flushSync` rather than Testing Library: `src/components/chat/permission-prompt.test.tsx`, `src/client/components/kanban/inline-workspace-form.test.tsx`.
- Clean up with `root.unmount()`, `container.remove()`, or `document.body.innerHTML = ''` in `afterEach`.
- Use DOM queries and event dispatches directly: `container.querySelector`, `button.click()`, `textarea.dispatchEvent(new Event('input', { bubbles: true }))`.

## Common Patterns

**Async Testing:**
```typescript
await expect(workspaceAccessor.findByIds([])).resolves.toEqual([]);

await expect(
  caller.createSession({ workspaceId: 'w1', workflow: 'user' })
).rejects.toThrow('Maximum sessions per workspace (2) reached');
```

**Error Testing:**
```typescript
expect(() =>
  workspaceAccessor.findByProjectIdWithSessions('project-1', {
    status: 'READY',
    excludeStatuses: ['FAILED'],
  })
).toThrow('Cannot specify both status and excludeStatuses filters');
```

**Timer Testing:**
```typescript
vi.useFakeTimers();
vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
await vi.advanceTimersToNextTimerAsync();
vi.useRealTimers();
```

**DOM Testing:**
```typescript
const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);

flushSync(() => {
  root.render(createElement(PermissionPrompt, { permission, onApprove }));
});

expect(container.textContent).toContain('Review Plan');
root.unmount();
```

**Integration Database Testing:**
```typescript
db = await createIntegrationDatabase();
prisma = db.prisma;
({ workspaceAccessor } = await vi.importActual<typeof import('@/backend/services/workspace')>(
  '@/backend/services/workspace'
));
```

**Environment Testing:**
- Save and restore `process.env` around config tests: `src/backend/services/config.service.test.ts`.
- Call `configService.reload()` after env changes.
- Use `Reflect.deleteProperty(process.env, 'KEY')` when testing absent optional env vars.

---

*Testing analysis: 2026-04-29*
