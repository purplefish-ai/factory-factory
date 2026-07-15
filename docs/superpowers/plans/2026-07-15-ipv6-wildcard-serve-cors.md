# IPv6 Wildcard Serve CORS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a valid localhost CORS origin for CLI serve commands bound to IPv4 or IPv6 all-interfaces hosts.

**Architecture:** Keep bind-address behavior unchanged and normalize only recognized wildcard hosts at the point where `buildServeEnv` constructs a browser origin. Exercise the behavior through the existing colocated unit test so the regression is reproduced without involving a live server.

**Tech Stack:** TypeScript, Node.js process environments, Vitest, pnpm

## Global Constraints

- Preserve explicit `CORS_ALLOWED_ORIGINS` values from `baseEnv`.
- Preserve the requested value in `BACKEND_HOST`.
- Treat `0.0.0.0`, `::`, `::0`, and `0:0:0:0:0:0:0:0` as all-interfaces bind hosts.
- Do not change UI behavior or downstream CORS matching.

---

### Task 1: Add IPv6 wildcard regression coverage and fix origin construction

**Files:**
- Modify: `src/cli/serve-env.test.ts`
- Modify: `src/cli/serve-env.ts`

**Interfaces:**
- Consumes: `buildServeEnv(options: ServeEnvOptions, databasePath: string, frontendPort: number, backendPort: number, baseEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv`
- Produces: `buildServeEnv` behavior that emits `http://localhost:<port>` for recognized wildcard bind hosts while preserving `BACKEND_HOST`

- [ ] **Step 1: Write failing production regression tests**

Add table-driven cases to `src/cli/serve-env.test.ts`:

```typescript
it.each(['::', '::0', '0:0:0:0:0:0:0:0'])(
  'uses localhost for the default CORS origin when binding production to IPv6 all-interfaces host %s',
  (host) => {
    const env = buildServeEnv({ host }, '/tmp/factory.db', 3000, 7001, {});

    expect(env.BACKEND_HOST).toBe(host);
    expect(env.CORS_ALLOWED_ORIGINS).toBe('http://localhost:7001');
  }
);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run src/cli/serve-env.test.ts`

Expected: the new cases fail because the current implementation emits malformed/raw IPv6-host origins instead of `http://localhost:7001`.

- [ ] **Step 3: Add a failing development regression test**

Add this case to `src/cli/serve-env.test.ts`:

```typescript
it('uses localhost for the default CORS origin when binding dev mode to IPv6 all interfaces', () => {
  const env = buildServeEnv({ dev: true, host: '::' }, '/tmp/factory.db', 5173, 7001, {});

  expect(env.BACKEND_HOST).toBe('::');
  expect(env.CORS_ALLOWED_ORIGINS).toBe('http://localhost:5173');
});
```

- [ ] **Step 4: Implement minimal wildcard normalization**

Update `src/cli/serve-env.ts`:

```typescript
const ALL_INTERFACES_HOSTS = new Set(['0.0.0.0', '::', '::0', '0:0:0:0:0:0:0:0']);

// Inside buildServeEnv:
const corsHost = ALL_INTERFACES_HOSTS.has(options.host) ? 'localhost' : options.host;
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm vitest run src/cli/serve-env.test.ts`

Expected: all tests in `src/cli/serve-env.test.ts` pass with no warnings or failures.

- [ ] **Step 6: Commit the focused fix**

```bash
git add docs/superpowers/specs/2026-07-15-ipv6-wildcard-serve-cors-design.md docs/superpowers/plans/2026-07-15-ipv6-wildcard-serve-cors.md src/cli/serve-env.ts src/cli/serve-env.test.ts
git commit -m "Fix IPv6 wildcard serve CORS origin (#1842)"
```

### Task 2: Verify and publish

**Files:**
- Review: all changes relative to `origin/main`
- Create outside repository: `/tmp/pr-body.md`

**Interfaces:**
- Consumes: committed Task 1 changes and repository scripts
- Produces: a pushed branch and GitHub pull request closing issue #1842

- [ ] **Step 1: Run full repository verification**

Run: `pnpm typecheck && pnpm check:fix && pnpm test && pnpm build`

Expected: all four commands exit successfully. If `check:fix` changes intended files, review and commit those changes before continuing.

- [ ] **Step 2: Review the complete diff**

Run: `git diff origin/main && git status -sb`

Expected: only the issue-specific implementation, tests, and planning documents differ; no debug output or unrelated changes are present.

- [ ] **Step 3: Commit verification formatting changes if present**

```bash
git add src/cli/serve-env.ts src/cli/serve-env.test.ts docs/superpowers/specs/2026-07-15-ipv6-wildcard-serve-cors-design.md docs/superpowers/plans/2026-07-15-ipv6-wildcard-serve-cors.md
git commit -m "Format IPv6 wildcard CORS fix (#1842)"
```

Skip this commit when `pnpm check:fix` leaves the worktree clean.

- [ ] **Step 4: Push the branch**

Run: `git push -u origin HEAD`

Expected: the current branch is pushed and configured to track its remote branch.

- [ ] **Step 5: Create and verify the pull request**

Write the required summary, changes, testing checklist, `Closes #1842`, horizontal rule, and Factory Factory signature to `/tmp/pr-body.md`. Then run:

```bash
gh pr create --title "Fix #1842: Handle IPv6 wildcard serve CORS origins" --body-file /tmp/pr-body.md
gh pr view --json url,title,state
```

Expected: GitHub returns the created pull request URL and an open state.
