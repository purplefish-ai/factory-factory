# Ratchet Provider-Mismatch Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop provider-mismatched Ratchet fixer sessions after an in-flight
settlement observes cancellation.

**Architecture:** Preserve cancellation barriers for normal Ratchet work, but
treat session stopping as mandatory best-effort cleanup. Run provider-mismatch
cleanup from settlement's `finally` path so the original result or error is
preserved after the stop attempt.

**Tech Stack:** TypeScript, Vitest, Express service capsules, pnpm, Biome

## Global Constraints

- Keep the change inside the Ratchet service capsule.
- Preserve settlement-before-stop ordering.
- Preserve the original cancellation reason.
- Keep stop failures warning-only.
- Do not change UI behavior.

---

### Task 1: Reproduce the orphaned-session race

**Files:**
- Test: `src/backend/services/ratchet/service/ratchet.service.test.ts`

**Interfaces:**
- Consumes: `RatchetService.checkActiveFixerSession(workspace, signal)`
- Produces: a regression test proving the mismatched session stop is attempted
  after post-write cancellation

- [ ] **Step 1: Add the failing regression test**

Add a test under `checkActiveFixerSession edge cases` that returns a running
`CODEX` session while the resolved workspace Ratchet provider is `CLAUDE`.
Abort the supplied controller inside `mockWorkspaceBridge.recordSessionEnd`
before resolving `true`.

Assert these literal outcomes:

```typescript
await expect(check).rejects.toBe(timeoutError);
expect(mockWorkspaceBridge.recordSessionEnd).toHaveBeenCalledWith(
  'ws-provider-mismatch-cancelled-after-settlement',
  'codex-session',
  'DIED'
);
expect(mockSessionBridge.stopSession).toHaveBeenCalledWith('codex-session');
```

- [ ] **Step 2: Verify the test fails for the reported reason**

Run:

```bash
pnpm test src/backend/services/ratchet/service/ratchet.service.test.ts
```

Expected: the new test fails because `stopSession` has zero calls, while the
check rejects with `timeoutError` and settlement records `DIED`.

### Task 2: Guarantee abort-insensitive mismatch cleanup

**Files:**
- Modify:
  `src/backend/services/ratchet/service/ratchet-active-session.helpers.ts`
- Test: `src/backend/services/ratchet/service/ratchet.service.test.ts`

**Interfaces:**
- Consumes: `RatchetSessionBridge.stopSession(sessionId): Promise<void>`
- Produces: best-effort cleanup that never throws and a provider-mismatch branch
  that attempts cleanup after either settlement success or settlement failure

- [ ] **Step 1: Make `safeStopSession` abort-insensitive**

Remove its `signal` parameter and all abort checks. Keep the existing
`try`/`catch`, warning message, warning context, and error-string conversion.
Remove signal plumbing from `stopCompletedRatchetSession`,
`stopSessionForProviderMismatch`, and their call sites.

- [ ] **Step 2: Run provider-mismatch cleanup in `finally`**

Replace the sequential mismatch settlement and stop with this control-flow
shape:

```typescript
try {
  return await settle(
    'DIED',
    `provider mismatch: expected ${resolvedRatchetProvider}, got ${session.provider}`
  );
} finally {
  await stopSessionForProviderMismatch({
    workspaceId: workspace.id,
    sessionId: session.id,
    expectedProvider: resolvedRatchetProvider,
    actualProvider: session.provider,
    sessionBridge,
  });
}
```

- [ ] **Step 3: Verify focused behavior**

Run:

```bash
pnpm test src/backend/services/ratchet/service/ratchet.service.test.ts
```

Expected: all Ratchet service tests pass, including the new regression test.

### Task 3: Verify, review, and publish

**Files:**
- Review:
  `src/backend/services/ratchet/service/ratchet-active-session.helpers.ts`
- Review: `src/backend/services/ratchet/service/ratchet.service.test.ts`
- Review:
  `docs/superpowers/specs/2026-07-25-ratchet-provider-mismatch-cleanup-design.md`
- Review:
  `docs/superpowers/plans/2026-07-25-ratchet-provider-mismatch-cleanup.md`

**Interfaces:**
- Consumes: repository pnpm scripts and GitHub CLI authentication
- Produces: committed branch and pull request closing issue `#1983`

- [ ] **Step 1: Run the required verification chain**

```bash
pnpm typecheck && pnpm check:fix && pnpm test && pnpm build
```

Expected: every command exits zero.

- [ ] **Step 2: Review the complete branch diff**

```bash
git diff origin/main
git status -sb
```

Confirm there are no debug logs, commented-out code, unrelated edits, or UI
changes.

- [ ] **Step 3: Commit the focused change**

```bash
git add \
  docs/superpowers/specs/2026-07-25-ratchet-provider-mismatch-cleanup-design.md \
  docs/superpowers/plans/2026-07-25-ratchet-provider-mismatch-cleanup.md \
  src/backend/services/ratchet/service/ratchet-active-session.helpers.ts \
  src/backend/services/ratchet/service/ratchet.service.test.ts
git commit -m "Fix Ratchet mismatch cleanup after abort (#1983)"
```

- [ ] **Step 4: Push and create the pull request**

Push the current branch with upstream tracking. Create a PR titled
`Fix #1983: Stop mismatched Ratchet sessions after abort` whose body explains
the root cause, implementation, full verification, `Closes #1983`, and ends
with the required Factory Factory signature.
