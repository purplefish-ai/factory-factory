# Project Repository Path Whitespace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure local project creation and live factory-config detection consistently use repository paths without accidental surrounding whitespace.

**Architecture:** Normalize at the two client boundaries that emit the path, then normalize again in the trusted project-creation schema for defense in depth. Keep the existing form, router, and service interfaces unchanged.

**Tech Stack:** React, TypeScript, tRPC, Zod, Vitest

## Global Constraints

- Preserve internal path whitespace while removing only leading and trailing whitespace.
- Keep the existing `Repository path is required` error for whitespace-only create input.
- Do not change unrelated project update or validation routes.
- Follow red-green-refactor and keep each production change covered by a test that failed first.

---

### Task 1: Client path normalization

**Files:**
- Modify: `src/client/routes/projects/new.test.tsx`
- Modify: `src/client/routes/projects/new.tsx`

**Interfaces:**
- Consumes: `ProjectRepoFormProps` callbacks and `trpc.project` hooks already used by `NewProjectPage`.
- Produces: `create.mutate({ repoPath: string, ... })` and
  `checkFactoryConfig.useQuery({ repoPath: string }, ...)` calls with trimmed paths.

- [ ] **Step 1: Write failing component tests**

Add a rendered local-path form test double that forwards `repoPath`, `setRepoPath`, and
`onSubmit`, plus hoisted spies for the create mutation and config query. Add one test that
enters `"  /repos/example  "`, submits the form, and expects the mutation payload's
`repoPath` to equal `"/repos/example"`. Add a second fake-timer test that enters the same
value, advances 500 ms, and expects the latest config-query input to equal
`{ repoPath: "/repos/example" }`.

- [ ] **Step 2: Run client tests to verify RED**

Run:

```bash
pnpm vitest run src/client/routes/projects/new.test.tsx
```

Expected: both new tests fail because the mutation and debounced query receive
`"  /repos/example  "`.

- [ ] **Step 3: Implement minimal client normalization**

In the debounce effect, call:

```typescript
setDebouncedRepoPath(repoPath.trim());
```

In `handleLocalSubmit`, compute and reuse:

```typescript
const trimmedRepoPath = repoPath.trim();
if (!trimmedRepoPath) {
  setError('Repository path is required');
  return;
}
```

Then send `repoPath: trimmedRepoPath` in the create mutation.

- [ ] **Step 4: Run client tests to verify GREEN**

Run:

```bash
pnpm vitest run src/client/routes/projects/new.test.tsx
```

Expected: all tests pass.

- [ ] **Step 5: Commit the client fix**

```bash
git add src/client/routes/projects/new.tsx src/client/routes/projects/new.test.tsx
git commit -m "Trim project paths in creation UI (#2081)"
```

### Task 2: Project creation schema normalization

**Files:**
- Modify: `src/backend/trpc/project.router.test.ts`
- Modify: `src/backend/trpc/project.trpc.ts`

**Interfaces:**
- Consumes: `projectRouter.create({ repoPath: string, ... })`.
- Produces: service calls whose `repoPath` is trimmed and a Zod rejection for
  whitespace-only paths.

- [ ] **Step 1: Write failing router tests**

Add a test that calls create with `"  /good/path  "`, stubs validation and creation as
successful, and expects both `validateRepoPath` and `create` to receive `"/good/path"`.
Add a test that calls create with `"   "`, expects the existing
`Repository path is required` error, and verifies neither validation nor creation runs.

- [ ] **Step 2: Run router tests to verify RED**

Run:

```bash
pnpm vitest run src/backend/trpc/project.router.test.ts
```

Expected: the padded path test observes whitespace at the service boundary and the
whitespace-only call reaches repository validation instead of failing schema validation.

- [ ] **Step 3: Implement minimal schema normalization**

Change the create input field to:

```typescript
repoPath: z.string().trim().min(1, 'Repository path is required'),
```

- [ ] **Step 4: Run router tests to verify GREEN**

Run:

```bash
pnpm vitest run src/backend/trpc/project.router.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit the backend fix**

```bash
git add src/backend/trpc/project.trpc.ts src/backend/trpc/project.router.test.ts
git commit -m "Normalize project paths at create boundary (#2081)"
```

### Task 3: Verification and pull request

**Files:**
- Review: all files changed from `origin/main`
- Create temporarily: `/tmp/pr-body.md`

**Interfaces:**
- Consumes: the two focused commits from Tasks 1 and 2.
- Produces: a clean, pushed branch and a GitHub pull request closing issue #2081.

- [ ] **Step 1: Run full verification**

Run:

```bash
pnpm typecheck && pnpm check:fix && pnpm test && pnpm build
```

Expected: every command exits successfully.

- [ ] **Step 2: Review and commit formatting changes**

Run `git diff origin/main` and `git status --short`. Remove debug artifacts, confirm only
the planned files changed, and commit any intentional formatter edits.

- [ ] **Step 3: Push and create the PR**

Push with `git push -u origin HEAD`, write the required summary, testing checklist,
`Closes #2081`, and Factory Factory signature to `/tmp/pr-body.md`, then run:

```bash
gh pr create --title "Fix #2081: Trim repository paths during project creation" --body-file /tmp/pr-body.md
```

- [ ] **Step 4: Verify the PR**

Run `gh pr view --json url,title,state` and confirm the returned URL, title, and open
state.
