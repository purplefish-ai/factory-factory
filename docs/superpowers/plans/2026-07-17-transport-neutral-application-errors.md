# Transport-Neutral Application Errors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace tRPC errors below the transport layer with stable application errors and translate them centrally without changing caller-visible status codes.

**Architecture:** A low-level `ApplicationError` carries stable codes, messages, and causes. Shared tRPC middleware converts it with an exhaustive mapping, while a mapper helper covers procedures that intentionally catch individual errors.

**Tech Stack:** TypeScript, tRPC v11, Vitest, Dependency Cruiser, Biome, pnpm

## Global Constraints

- Services and orchestration have no runtime imports from `@trpc/server`.
- Existing tRPC caller codes and useful messages remain equivalent.
- Command stdout and stderr are retained only as internal causes, never public messages.
- Translation is centralized and exhaustively tested.
- Dependency checks prevent `@trpc/server` imports from service and orchestration layers.

---

### Task 1: Application Error Contract and tRPC Mapping

**Files:**
- Create: `src/backend/lib/application-error.ts`
- Create: `src/backend/lib/application-error.test.ts`
- Create: `src/backend/trpc/application-error-mapper.ts`
- Create: `src/backend/trpc/application-error-mapper.test.ts`
- Modify: `src/backend/trpc/trpc.ts`
- Modify: `src/backend/trpc/trpc.test.ts`

**Interfaces:**
- Produces: `ApplicationError`, `ApplicationErrorCode`, `toTRPCError(error: ApplicationError): TRPCError`, and base `publicProcedure` translation.
- Mapping: `INVALID_INPUT -> BAD_REQUEST`, `NOT_FOUND -> NOT_FOUND`, `PRECONDITION_FAILED -> PRECONDITION_FAILED`, `CONFLICT -> CONFLICT`, `INTERNAL_ERROR -> INTERNAL_SERVER_ERROR`.

- [ ] **Step 1: Write failing contract and mapping tests**

Create table-driven tests that construct every application code, assert message/cause retention, assert the exact tRPC code, and use a `publicProcedure` test router to prove downstream application failures are translated.

- [ ] **Step 2: Run tests and verify the missing modules fail**

Run: `env -u NODE_ENV pnpm exec vitest run src/backend/lib/application-error.test.ts src/backend/trpc/application-error-mapper.test.ts src/backend/trpc/trpc.test.ts`

Expected: FAIL because `application-error.ts` and `application-error-mapper.ts` do not exist.

- [ ] **Step 3: Implement the minimal contract, mapper, and middleware**

Define the stable union and `Error` subclass with `cause`, add an exhaustive `Record<ApplicationErrorCode, TRPCError['code']>`, and inspect unsuccessful tRPC v11 middleware results for an `ApplicationError` cause before throwing the mapped transport error.

- [ ] **Step 4: Run the focused tests**

Run: `env -u NODE_ENV pnpm exec vitest run src/backend/lib/application-error.test.ts src/backend/trpc/application-error-mapper.test.ts src/backend/trpc/trpc.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add src/backend/lib/application-error.ts src/backend/lib/application-error.test.ts src/backend/trpc/application-error-mapper.ts src/backend/trpc/application-error-mapper.test.ts src/backend/trpc/trpc.ts src/backend/trpc/trpc.test.ts && git commit -m "Add application error translation (#1961)"`

### Task 2: Transport-Neutral Service and Orchestration Errors

**Files:**
- Modify: `src/backend/services/git-ops.service.ts`
- Modify: `src/backend/services/git-ops.service.test.ts`
- Modify: `src/backend/services/workspace/service/lifecycle/creation.service.ts`
- Modify: `src/backend/services/workspace/service/lifecycle/creation.service.test.ts`
- Modify: `src/backend/orchestration/workspace-archive.orchestrator.ts`
- Modify: `src/backend/orchestration/workspace-archive.orchestrator.test.ts`
- Modify: `src/backend/orchestration/workspace-children.orchestrator.ts`
- Modify: `src/backend/orchestration/workspace-children.orchestrator.test.ts`
- Modify: `src/backend/trpc/workspace.trpc.ts`
- Modify: `src/backend/trpc/workspace.router.test.ts`

**Interfaces:**
- Consumes: `new ApplicationError(code, message, { cause })` and `toTRPCError(error)` from Task 1.
- Produces: service/orchestration failures that transport-neutral callers can inspect without tRPC.

- [ ] **Step 1: Update tests to require application codes and sanitized messages**

Change the git, creation, archive, child-workspace, and bulk-archive tests so fixtures reject with `ApplicationError`; assert the stable application codes; and assert a secret stderr token is absent from the public git message but present in `cause`.

- [ ] **Step 2: Run focused tests and verify current TRPCError implementations fail**

Run: `env -u NODE_ENV pnpm exec vitest run src/backend/services/git-ops.service.test.ts src/backend/services/workspace/service/lifecycle/creation.service.test.ts src/backend/orchestration/workspace-archive.orchestrator.test.ts src/backend/orchestration/workspace-children.orchestrator.test.ts src/backend/trpc/workspace.router.test.ts`

Expected: FAIL because the affected code still throws or recognizes `TRPCError`.

- [ ] **Step 3: Replace transport errors and sanitize command failures**

Import `ApplicationError` from `@/backend/lib/application-error`; preserve each current transport code through the mapping; use concise git operation messages; retain command results and cleanup failures only in causes; and use the mapper for bulk-archive result codes.

- [ ] **Step 4: Run focused tests**

Run: `env -u NODE_ENV pnpm exec vitest run src/backend/services/git-ops.service.test.ts src/backend/services/workspace/service/lifecycle/creation.service.test.ts src/backend/orchestration/workspace-archive.orchestrator.test.ts src/backend/orchestration/workspace-children.orchestrator.test.ts src/backend/trpc/workspace.router.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add src/backend/services src/backend/orchestration src/backend/trpc/workspace.trpc.ts src/backend/trpc/workspace.router.test.ts && git commit -m "Remove tRPC errors from application layers (#1961)"`

### Task 3: Dependency Enforcement and Full Verification

**Files:**
- Modify: `.dependency-cruiser.cjs`

**Interfaces:**
- Consumes: production code with no `@trpc/server` imports under services or orchestration.
- Produces: an error-level dependency rule covering npm and pnpm resolved paths.

- [ ] **Step 1: Add the dependency rule before removing the last known imports in a temporary diff state**

Use `from.path: '^src/backend/(services|orchestration)/'` and `to.path: '^node_modules/(?:\\.pnpm/[^/]+/node_modules/)?@trpc/server(?:/|$)'`. Confirm Dependency Cruiser reports the known imports before the Task 2 implementation, or validate the expression against the captured resolved path if Task 2 is already complete.

- [ ] **Step 2: Run boundary and source scans**

Run: `pnpm deps:check`

Expected: PASS with zero violations.

Run: `rg -n "@trpc/server|TRPCError" src/backend/services src/backend/orchestration --glob '!*.test.ts'`

Expected: no output.

- [ ] **Step 3: Run required verification**

Run: `pnpm typecheck && pnpm check:fix && env -u NODE_ENV pnpm test && pnpm build`

Expected: all commands exit 0. Review formatter changes before committing.

- [ ] **Step 4: Review the complete diff**

Run: `git diff origin/main` and `git status --short`.

Expected: only issue-related code, tests, dependency rule, design, and plan files are present; no debug code remains.

- [ ] **Step 5: Commit**

Run: `git add .dependency-cruiser.cjs docs/superpowers && git commit -m "Enforce transport-neutral backend boundaries (#1961)"`

### Task 4: Publish Pull Request

**Files:**
- Create outside repository: `/tmp/pr-body.md`

**Interfaces:**
- Consumes: a clean feature branch with all verification passing.
- Produces: a pushed branch and draft-free GitHub pull request closing issue #1961.

- [ ] **Step 1: Confirm clean pre-flight state and commit history**

Run: `git status --short --branch && git log --oneline origin/main..HEAD`.

Expected: clean working tree and descriptive issue-scoped commits.

- [ ] **Step 2: Push the feature branch**

Run: `git push -u origin HEAD`.

Expected: the current branch tracks its remote counterpart.

- [ ] **Step 3: Create the required PR body and PR**

Write `/tmp/pr-body.md` with Summary, Changes, Testing, `Closes #1961`, and the required Factory Factory signature, then run `gh pr create --title "Fix #1961: Remove tRPC errors from application layers" --body-file /tmp/pr-body.md`.

Expected: GitHub returns the new PR URL.

- [ ] **Step 4: Verify the PR**

Run: `gh pr view --json url,title,state`.

Expected: the URL, requested title, and `OPEN` state are returned.
