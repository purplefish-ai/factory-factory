# Ratchet Merged-PR Session Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop every live Ratchet workflow session before a normal Ratchet check persists a merged pull request as terminal.

**Architecture:** Add a focused cleanup method to `RatchetService` that enumerates workspace sessions through the existing session bridge, filters active Ratchet workflows, and stops their live runtimes. Invoke it immediately after a fresh `MERGED` PR observation and before decision construction, allowing failures to flow through the existing workspace-check error path so later polls retry.

**Tech Stack:** TypeScript, Express backend service capsules, Vitest, Prisma-backed workspace state.

## Global Constraints

- Stop only sessions whose workflow is `ratchet`.
- Consider persisted `RUNNING` and `IDLE` sessions cleanup candidates.
- Ignore candidates whose runtime is no longer running.
- Do not persist Ratchet state `MERGED` unless every required stop succeeds.
- Preserve the existing best-effort behavior for Ratchet-disable cleanup.
- Add no schema, UI, or cross-capsule dependency changes.

---

### Task 1: Clean Up Ratchet Sessions on a Fresh Merged-PR Observation

**Files:**
- Modify: `src/backend/services/ratchet/service/ratchet.service.ts`
- Test: `src/backend/services/ratchet/service/ratchet.service.test.ts`

**Interfaces:**
- Consumes: `RatchetSessionBridge.findSessionsByWorkspaceId(workspaceId)`, `RatchetSessionBridge.isSessionRunning(sessionId)`, and `RatchetSessionBridge.stopSession(sessionId)`.
- Produces: private `RatchetService.stopActiveRatchetSessionsForMergedPr(workspaceId: string, signal: AbortSignal): Promise<void>`.

- [ ] **Step 1: Write the successful-cleanup regression test**

Add a `processWorkspace` test with a workspace whose current Ratchet state is
`CI_FAILED` and whose fetched state is `MERGED`. Return two live Ratchet
sessions, one stopped Ratchet session, and one live manual session:

```typescript
vi.mocked(mockSessionBridge.findSessionsByWorkspaceId).mockResolvedValue([
  { id: 'ratchet-running', workflow: 'ratchet', status: SessionStatus.RUNNING },
  { id: 'ratchet-idle', workflow: 'ratchet', status: SessionStatus.IDLE },
  { id: 'ratchet-stopped', workflow: 'ratchet', status: SessionStatus.STOPPED },
  { id: 'manual-running', workflow: 'default', status: SessionStatus.RUNNING },
] as never);
vi.mocked(mockSessionBridge.isSessionRunning).mockImplementation((sessionId) =>
  ['ratchet-running', 'ratchet-idle', 'manual-running'].includes(sessionId)
);
```

Assert that only `ratchet-running` and `ratchet-idle` are stopped, and that
`workspaceRatchetService.transitionStateIfEnabled` persists
`ratchetState: RatchetState.MERGED`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm vitest run src/backend/services/ratchet/service/ratchet.service.test.ts -t "stops live ratchet sessions before persisting a merged PR"
```

Expected: FAIL because `stopSession` has no calls on the merged path.

- [ ] **Step 3: Write the cleanup-failure regression test**

Use the same merged workspace shape with one live Ratchet session, and reject
its stop:

```typescript
vi.mocked(mockSessionBridge.stopSession).mockRejectedValue(new Error('stop failed'));
```

Assert that the result contains
`{ action: { type: 'ERROR', error: 'stop failed' } }` and that
`workspaceRatchetService.transitionStateIfEnabled` is not called.

- [ ] **Step 4: Run both focused tests and verify RED**

Run:

```bash
pnpm vitest run src/backend/services/ratchet/service/ratchet.service.test.ts -t "merged PR"
```

Expected: both new tests FAIL because merged-PR session cleanup is absent.

- [ ] **Step 5: Implement the merged-PR cleanup method**

Add the private method:

```typescript
private async stopActiveRatchetSessionsForMergedPr(
  workspaceId: string,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted();
  const sessions = await this.session.findSessionsByWorkspaceId(workspaceId);
  signal.throwIfAborted();
  const activeRatchetSessions = sessions.filter(
    (session) =>
      session.workflow === 'ratchet' &&
      (session.status === SessionStatus.RUNNING || session.status === SessionStatus.IDLE)
  );

  for (const session of activeRatchetSessions) {
    signal.throwIfAborted();
    if (!this.session.isSessionRunning(session.id)) {
      continue;
    }
    await this.session.stopSession(session.id);
    signal.throwIfAborted();
  }
}
```

After the fresh PR state has been validated in `processWorkspace`, call it
before `buildRatchetDecisionContext`:

```typescript
if (prStateInfo.prState === 'MERGED') {
  await this.stopActiveRatchetSessionsForMergedPr(workspace.id, signal);
  signal.throwIfAborted();
}
```

- [ ] **Step 6: Run the focused tests and verify GREEN**

Run:

```bash
pnpm vitest run src/backend/services/ratchet/service/ratchet.service.test.ts -t "merged PR"
```

Expected: PASS.

- [ ] **Step 7: Run the complete Ratchet test files**

Run:

```bash
pnpm vitest run src/backend/services/ratchet/service/ratchet.service.test.ts
```

Expected: the complete Ratchet service test file PASS with zero failures.

- [ ] **Step 8: Run repository guardrails**

Run:

```bash
pnpm typecheck
pnpm check
```

Expected: both commands exit zero.

- [ ] **Step 9: Review the mutation coverage**

Confirm that deleting the merged cleanup call makes the success test fail and
that swallowing `stopSession` errors makes the failure test fail. Restore the
implementation and rerun both focused tests successfully.

- [ ] **Step 10: Commit the implementation**

```bash
git add src/backend/services/ratchet/service/ratchet.service.ts \
  src/backend/services/ratchet/service/ratchet.service.test.ts
git commit -m "Stop Ratchet sessions for merged PRs"
```
