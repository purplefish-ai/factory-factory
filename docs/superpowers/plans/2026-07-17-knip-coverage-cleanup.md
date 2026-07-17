# Knip Coverage Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten Knip dead-code coverage across backend service and orchestration layers while removing unused tRPC request scope and migration residue.

**Architecture:** Treat root services and orchestration modules as ordinary project files reached through the production import graph. Keep tRPC context limited to request trust and app services, remove the client/CORS plumbing for ambient scope headers, and retain only exact unused generated shadcn primitives as documented Knip file exclusions.

**Tech Stack:** TypeScript, Express, tRPC, Vitest, Knip, Biome, pnpm

## Global Constraints

- Knip must emit no configuration hints.
- Orchestration and root service files must participate in dead-code analysis.
- Remaining file ignores must be narrow and documented.
- Preserve request trust enforcement and explicit project IDs in procedure inputs.
- `pnpm knip`, `pnpm check`, `pnpm typecheck`, `pnpm test`, and `pnpm build` must pass before publishing.

---

### Task 1: Remove ambient tRPC request scope

**Files:**
- Modify: `src/backend/trpc/trpc.test.ts`
- Modify: `src/backend/trpc/trpc.ts`
- Modify: `src/backend/trpc/index.ts`
- Modify: `src/backend/middleware/middleware.test.ts`
- Modify: `src/backend/middleware/cors.middleware.ts`
- Modify: `src/client/lib/trpc.ts`
- Modify: `src/client/lib/providers.tsx`
- Modify: `src/client/layouts/project-layout.tsx`
- Modify: `src/client/hooks/use-app-navigation-data.ts`
- Delete: `src/backend/trpc/procedures/project-scoped.ts`
- Delete: `src/backend/trpc/procedures/project-scoped.test.ts`
- Delete: `src/backend/trpc/procedures/index.ts`

**Interfaces:**
- Consumes: Express `Request` headers and the existing `createContext(appContext)` factory.
- Produces: `Context` containing only `requestTrust?: RequestTrustInfo` and `appContext: AppContext`; a tRPC client with no context getter or scope headers; CORS without scope headers; `appRouter`, `AppRouter`, `createContext`, and `publicProcedure` remain exported.

- [ ] **Step 1: Write the failing request-context regression test**

```ts
it('does not add unused request-scope headers to context', () => {
  const contextFactory = createContext({} as never);
  const ctx = contextFactory({
    req: {
      headers: {
        'x-project-id': 'project-1',
        'x-top-level-task-id': 'task-1',
      },
      socket: {},
    } as Request,
  });

  expect(ctx).not.toHaveProperty('projectId');
  expect(ctx).not.toHaveProperty('topLevelTaskId');
});
```

- [ ] **Step 2: Run the regression test and verify RED**

Run: `pnpm exec vitest run src/backend/trpc/trpc.test.ts`

Expected: FAIL because `createContext` currently returns `projectId` and `topLevelTaskId`.

- [ ] **Step 3: Change the existing CORS expectation and verify RED**

Change the allowed-header expectation in `src/backend/middleware/middleware.test.ts` to:

```ts
expect(mockRes.headers['Access-Control-Allow-Headers']).toBe(
  'Origin, X-Requested-With, Content-Type, Accept, Authorization'
);
```

Run: `pnpm exec vitest run src/backend/middleware/middleware.test.ts`

Expected: FAIL because CORS still includes `X-Project-Id` and `X-Top-Level-Task-Id`.

- [ ] **Step 4: Remove request scope and unused procedure code**

Change `Context` and `createContext` to:

```ts
export type Context = {
  requestTrust?: RequestTrustInfo;
  appContext: AppContext;
};

export const createContext =
  (appContext: AppContext) =>
  ({ req }: { req: Request }): Context => ({
    requestTrust: buildRequestTrust(req),
    appContext,
  });
```

Remove the `projectScopedProcedure` re-export from `src/backend/trpc/index.ts` and delete its implementation, barrel, and dedicated tests.

Change `createTrpcClient` to take no context getter and configure `httpBatchLink` without a `headers` callback. Simplify `TRPCProvider` to create that client directly, remove `ProjectContext` and `useProjectContext`, and remove the two client effects/imports that only called `setProjectContext`. Remove both scope headers from `Access-Control-Allow-Headers`.

- [ ] **Step 5: Run the targeted tests and verify GREEN**

Run: `pnpm exec vitest run src/backend/trpc/trpc.test.ts src/backend/middleware/middleware.test.ts`

Expected: PASS with request trust, no request scope, and the reduced CORS allow-list green.

- [ ] **Step 6: Commit the request-scope cleanup**

```bash
git add src/backend/trpc src/backend/middleware src/client/lib/trpc.ts src/client/lib/providers.tsx src/client/layouts/project-layout.tsx src/client/hooks/use-app-navigation-data.ts
git commit -m "Remove unused tRPC request scope (#1963)"
```

### Task 2: Tighten Knip configuration and remove exposed residue

**Files:**
- Modify: `knip.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `docs/knip.md`
- Delete: `src/backend/clients/index.ts`

**Interfaces:**
- Consumes: Vite, Vitest, and Storybook automatic entry discovery plus runtime imports from the explicit backend, CLI, migration, and Electron entry points.
- Produces: Knip coverage for `src/backend/services/*.service.ts` and `src/backend/orchestration/*.ts`, with only 19 exact unused generated UI primitive paths ignored and explained.

- [ ] **Step 1: Confirm the stricter configuration fails for the expected reasons**

Run the current configuration with stale backend ignores and `src/client/main.tsx` removed in a temporary config.

Expected: PASS with no backend findings. A separate all-ignores-removed diagnostic reports only unused `src/backend/clients/index.ts` and 19 unused generated UI primitives.

- [ ] **Step 2: Apply the minimal Knip cleanup**

Remove `src/client/main.tsx` from `workspaces["."].entry`. Replace the broad `ignore` list with the 19 exact generated primitive paths:

```json
"ignore": [
  "src/components/ui/accordion.tsx",
  "src/components/ui/aspect-ratio.tsx",
  "src/components/ui/avatar.tsx",
  "src/components/ui/breadcrumb.tsx",
  "src/components/ui/button-group.tsx",
  "src/components/ui/carousel.tsx",
  "src/components/ui/chart.tsx",
  "src/components/ui/drawer.tsx",
  "src/components/ui/empty.tsx",
  "src/components/ui/field.tsx",
  "src/components/ui/form.tsx",
  "src/components/ui/hover-card.tsx",
  "src/components/ui/input-otp.tsx",
  "src/components/ui/item.tsx",
  "src/components/ui/menubar.tsx",
  "src/components/ui/navigation-menu.tsx",
  "src/components/ui/pagination.tsx",
  "src/components/ui/slider.tsx",
  "src/components/ui/toggle-group.tsx"
]
```

Create `docs/knip.md` explaining that these exact paths are generated shadcn catalog primitives that do not require current consumers, while exact matching keeps new UI and all non-UI source files analyzed by default.

Delete `src/backend/clients/index.ts` rather than declaring it an entry or excluding it. Remove the `autoprefixer`, `@hookform/resolvers`, and `geist` dependency ignores, confirm Knip reports those packages unused, then remove them from `package.json` and `pnpm-lock.yaml` with `pnpm remove`.

- [ ] **Step 3: Verify Knip is green and hint-free**

Run: `pnpm knip && pnpm exec knip --include files,dependencies,unlisted --treat-config-hints-as-errors`

Expected: both commands exit 0 with no unused files and no configuration hints.

- [ ] **Step 4: Commit the dead-code coverage cleanup**

```bash
git add knip.json package.json pnpm-lock.yaml docs/knip.md src/backend/clients/index.ts docs/superpowers
git commit -m "Tighten Knip backend coverage (#1963)"
```

### Task 3: Full verification and publication

**Files:**
- Review: all changes relative to `origin/main`
- Create temporarily: `/tmp/pr-body.md`

**Interfaces:**
- Consumes: repository scripts, authenticated GitHub CLI, and the current feature branch.
- Produces: a clean branch pushed to `origin` and a pull request closing issue #1963.

- [ ] **Step 1: Run the required validation chain**

Run: `pnpm typecheck && pnpm check:fix && pnpm test && pnpm build`

Expected: exit 0. Review any Biome rewrites before staging.

- [ ] **Step 2: Run the remaining acceptance check**

Run: `pnpm check`

Expected: exit 0.

- [ ] **Step 3: Review the complete diff and status**

Run: `git diff origin/main && git status -sb`

Expected: only issue-scoped files differ and there are no unstaged or untracked files after the final commit.

- [ ] **Step 4: Push and create the pull request**

Push with `git push -u origin HEAD`, write the required summary/testing/signature body to `/tmp/pr-body.md`, and run:

```bash
gh pr create --title "Fix #1963: Tighten Knip backend coverage" --body-file /tmp/pr-body.md
```

- [ ] **Step 5: Verify the pull request URL**

Run: `gh pr view --json url --jq .url`

Expected: a GitHub pull request URL for the current branch.
