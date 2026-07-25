# Run Script Proxy Exit Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop returning a stale run-script proxy URL after its cloudflared process exits.

**Architecture:** Keep run-script process status independent from tunnel liveness. Make each stored tunnel own a post-start cloudflared exit listener that removes only that exact tunnel entry and closes its local authentication proxy.

**Tech Stack:** TypeScript, Node.js child processes and events, Vitest

## Global Constraints

- Preserve `RUNNING` status while the run-script process itself remains alive.
- Return `null` from `getTunnelUrl(workspaceId)` after the active cloudflared process exits.
- A delayed exit from an old cloudflared process must not remove a newer tunnel for the same workspace.
- Intentional stop and cleanup paths must not close a replacement tunnel or fail on repeated cleanup.

---

### Task 1: Clean Up Exited Run-Script Proxy Tunnels

**Files:**
- Modify: `src/backend/services/run-script/service/run-script-proxy.service.ts`
- Test: `src/backend/services/run-script/service/run-script-proxy.service.test.ts`

**Interfaces:**
- Consumes: `ChildProcess.once('exit', listener)` and the existing `ActiveTunnel` map entry.
- Produces: Existing `getTunnelUrl(workspaceId: string): string | null` returns `null` once the active tunnel process exits.

- [ ] **Step 1: Make the test child process emit lifecycle events**

Update `createChildProcess` to use an `EventEmitter`-backed fake that still supplies `pid`, `exitCode`, and `kill`.

- [ ] **Step 2: Write the failing stale-URL regression test**

Create a tunnel with a distinct fake child process, emit `exit`, and assert the workspace tunnel URL becomes `null`.

- [ ] **Step 3: Write the failing replacement-ownership regression test**

Create a tunnel, replace it with a second process on another port, emit a delayed `exit` from the first process, and assert the second tunnel URL remains available.

- [ ] **Step 4: Run focused tests to verify RED**

Run:

```bash
pnpm vitest run src/backend/services/run-script/service/run-script-proxy.service.test.ts
```

Expected: the stale-URL regression fails because the map still returns the authenticated URL after `exit`.

- [ ] **Step 5: Implement minimal post-start exit cleanup**

After storing the tunnel, register an `exit` listener that checks whether the stored entry still owns the exiting process. If so, delete that entry and fire-and-forget `current.closeAuthProxy().catch(() => undefined)`.

- [ ] **Step 6: Run focused tests to verify GREEN**

Run:

```bash
pnpm vitest run src/backend/services/run-script/service/run-script-proxy.service.test.ts
```

Expected: all proxy-service tests pass.

- [ ] **Step 7: Commit the focused fix**

Review the two source-file diffs, then commit with:

```bash
git add src/backend/services/run-script/service/run-script-proxy.service.ts \
  src/backend/services/run-script/service/run-script-proxy.service.test.ts
git commit -m "Fix stale run-script proxy URLs (#2000)"
```

### Task 2: Verify and Review the Complete Change

**Files:**
- Review: `docs/superpowers/plans/2026-07-25-run-script-proxy-exit-cleanup.md`
- Review: `src/backend/services/run-script/service/run-script-proxy.service.ts`
- Review: `src/backend/services/run-script/service/run-script-proxy.service.test.ts`

**Interfaces:**
- Consumes: The committed tunnel exit cleanup and regression tests from Task 1.
- Produces: Fresh repository-wide verification evidence and a clean issue-scoped diff.

- [ ] **Step 1: Run required repository verification**

Run:

```bash
pnpm typecheck && pnpm check:fix && pnpm test && pnpm build
```

Expected: every command exits successfully.

- [ ] **Step 2: Review the complete branch diff**

Review `git diff origin/main`, remove unrelated or unnecessary changes, and run `git diff --check`.

- [ ] **Step 3: Commit the implementation plan**

Stage only this plan and commit it with `git commit -m "Document run-script proxy exit fix plan"`.

### Task 3: Publish the Pull Request

**Files:**
- Create temporarily: `/tmp/pr-body.md`

**Interfaces:**
- Consumes: The clean, verified feature branch.
- Produces: A GitHub pull request that closes issue #2000.

- [ ] **Step 1: Publish the pull request**

Push the current feature branch and create a pull request titled `Fix #2000: Clear crashed run-script proxy URLs` with the required summary, validation checklist, `Closes #2000`, and Factory Factory signature.
