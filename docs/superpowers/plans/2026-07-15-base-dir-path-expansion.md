# BASE_DIR-Dependent Path Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve `BASE_DIR` before expanding every supported path that depends on it.

**Architecture:** Keep `expandEnvVars` single-pass. Each path-resolution boundary first calculates `baseDir`, then creates an environment overlay with `BASE_DIR: baseDir` and passes that overlay to dependent expansions.

**Tech Stack:** TypeScript, Node.js path utilities, Vitest, pnpm

## Global Constraints

- Preserve the existing one-pass behavior of `expandEnvVars`.
- Do not mutate `process.env` or caller-provided environment objects.
- Preserve existing configuration and CLI precedence rules.
- Limit expansion changes to paths already processed by `expandEnvVars` plus the equivalent CLI database-path consumer.

---

### Task 1: Resolve Config and Shared Database Paths Through Expanded BASE_DIR

**Files:**
- Modify: `src/backend/services/config.service.ts`
- Test: `src/backend/services/config.service.test.ts`
- Modify: `src/backend/lib/env.ts`
- Test: `src/backend/lib/env.test.ts`

**Interfaces:**
- Consumes: `expandEnvVars(value, env)` and `getDefaultBaseDir()`.
- Produces: unchanged `configService` getters and unchanged `getDatabasePath(): string` with corrected nested expansion.

- [ ] **Step 1: Write failing config-service and shared-helper tests**

Add a config-service test that sets `USER=testuser`, `BASE_DIR=/Users/$USER/factory-factory`, and the four dependent path variables to `$BASE_DIR/...`, reloads the service, and expects fully expanded paths. Add an `env.test.ts` case that imports `getDatabasePath`, sets the same nested `BASE_DIR` and `DATABASE_PATH=$BASE_DIR/data.db`, and expects `/Users/testuser/factory-factory/data.db`.

- [ ] **Step 2: Run tests to verify RED**

Run: `pnpm vitest run src/backend/services/config.service.test.ts src/backend/lib/env.test.ts`

Expected: the new assertions fail because the returned values still contain `$USER`.

- [ ] **Step 3: Implement staged BASE_DIR expansion**

In both production files, resolve `baseDir`, then construct:

```ts
const expandedEnv = { ...process.env, BASE_DIR: baseDir };
```

Pass `expandedEnv` to every dependent `expandEnvVars` call in `loadSystemConfig`, and use it when expanding an explicit `DATABASE_PATH` in `getDatabasePath`.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `pnpm vitest run src/backend/services/config.service.test.ts src/backend/lib/env.test.ts`

Expected: both files pass, including the existing non-recursive helper test.

- [ ] **Step 5: Commit**

```bash
git add src/backend/services/config.service.ts src/backend/services/config.service.test.ts src/backend/lib/env.ts src/backend/lib/env.test.ts
git commit -m "Fix nested config path expansion (#1808)"
```

### Task 2: Resolve CLI Database Path Through Expanded BASE_DIR

**Files:**
- Modify: `src/cli/database-path.ts`
- Test: `src/cli/database-path.test.ts`

**Interfaces:**
- Consumes: caller-provided `env: Record<string, string | undefined>`.
- Produces: unchanged `resolveDatabasePath(options?): string` with corrected nested expansion.

- [ ] **Step 1: Write the failing CLI regression test**

Add a test that calls `resolveDatabasePath` with `USER=testuser`, `BASE_DIR=/Users/$USER/factory-factory`, and `DATABASE_PATH=$BASE_DIR/data.db`, then expects `/Users/testuser/factory-factory/data.db`.

- [ ] **Step 2: Run the test to verify RED**

Run: `pnpm vitest run src/cli/database-path.test.ts`

Expected: the new assertion fails because the result still contains `$USER`.

- [ ] **Step 3: Implement the CLI environment overlay**

Resolve `baseDir` once, create an overlay without mutating the supplied environment, and use it for `DATABASE_PATH` expansion while preserving explicit-option precedence:

```ts
const baseDir = getBaseDir(env);
const expandedEnv = { ...env, BASE_DIR: baseDir };
```

- [ ] **Step 4: Run the test to verify GREEN**

Run: `pnpm vitest run src/cli/database-path.test.ts`

Expected: all CLI database-path tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/database-path.ts src/cli/database-path.test.ts
git commit -m "Fix nested CLI database path expansion (#1808)"
```

### Task 3: Verify, Review, and Publish

**Files:**
- Review: all files changed from `origin/main`

**Interfaces:**
- Consumes: completed Tasks 1 and 2.
- Produces: a clean, pushed branch and pull request closing issue #1808.

- [ ] **Step 1: Run repository verification**

Run: `pnpm typecheck && pnpm check:fix && pnpm test && pnpm build`

Expected: every command exits successfully.

- [ ] **Step 2: Review the final diff**

Run: `git diff origin/main` and `git status -sb`.

Expected: only the design, plan, regression tests, and staged expansion changes are present; no debug code or unrelated edits remain.

- [ ] **Step 3: Commit any formatting-only changes**

Stage only intended files and use a short imperative commit message if `pnpm check:fix` changed tracked files.

- [ ] **Step 4: Push and create the pull request**

Push the current branch with tracking, create a PR titled `Fix #1808: Resolve nested config path variables`, include the required summary/testing checklist and Factory Factory signature, and verify the PR URL with `gh pr view`.
