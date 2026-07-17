# Ratchet Dispatch Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Ratchet's 90-second workspace watchdog from aborting a fixer after its ACP session has successfully started.

**Architecture:** Keep the existing watchdog and committed-side-effect mechanism. Correct the `afterStart` lifecycle boundary for `start_empty_and_send`, then wire Ratchet's existing `commitSideEffects` callback to that boundary so the long agent turn is governed by the session prompt timeout.

**Tech Stack:** TypeScript, Vitest, Express backend service capsules, ACP session runtime.

## Global Constraints

- Keep `SERVICE_TIMEOUT_MS.ratchetWorkspaceCheck` at `90_000`.
- Preserve `start_with_prompt` behavior.
- Preserve existing dispatch persistence, cleanup, and retry semantics.
- Import service capsules only through their public barrel APIs.
- Write regression tests before production changes and observe each test fail for the intended reason.

---

### Task 1: Correct the Fixer Session `afterStart` Boundary

**Files:**
- Modify: `src/backend/services/ratchet/service/fixer-session.service.test.ts`
- Modify: `src/backend/services/ratchet/service/fixer-session.service.ts`

**Interfaces:**
- Consumes: `AcquireAndDispatchInput.afterStart(params: { sessionId: string; prompt: string }): void | Promise<void>`
- Produces: For `dispatchMode: 'start_empty_and_send'`, `afterStart` runs after `startSession`/`restartSession` resolves and before `sendSessionMessage` begins.

- [ ] **Step 1: Write the failing callback-order regression test**

Add this test after `creates and starts a new session` in `fixer-session.service.test.ts`:

```ts
it('calls afterStart after startup and before awaiting the agent turn', async () => {
  vi.mocked(workspaceAccessor.findById).mockResolvedValue({ worktreePath: '/tmp/w' } as never);
  vi.mocked(agentSessionAccessor.acquireFixerSession).mockResolvedValue({
    outcome: 'created',
    sessionId: 's-new',
  });
  vi.mocked(configService.getMaxSessionsPerWorkspace).mockReturnValue(5);

  const events: string[] = [];
  let finishTurn!: () => void;
  vi.mocked(mockSessionBridge.startSession).mockImplementation(async () => {
    events.push('started');
  });
  vi.mocked(mockSessionBridge.isSessionRunning).mockReturnValue(true);
  vi.mocked(mockSessionBridge.sendSessionMessage).mockImplementation(async () => {
    events.push('turn-started');
    await new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
  });

  const dispatch = fixerSessionService.acquireAndDispatch({
    workspaceId: 'w1',
    workflow: 'ratchet',
    sessionName: 'Ratchet',
    runningIdleAction: 'restart',
    dispatchMode: 'start_empty_and_send',
    buildPrompt: () => 'prompt',
    afterStart: () => {
      events.push('after-start');
    },
  });

  await vi.waitFor(() => expect(mockSessionBridge.sendSessionMessage).toHaveBeenCalled());
  finishTurn();
  await expect(dispatch).resolves.toEqual({
    status: 'started',
    sessionId: 's-new',
    promptSent: true,
  });
  expect(events).toEqual(['started', 'after-start', 'turn-started']);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm test src/backend/services/ratchet/service/fixer-session.service.test.ts
```

Expected: FAIL because the current order is `started`, `turn-started`, `after-start`.

- [ ] **Step 3: Move the callback to the startup boundary**

Change the `start_empty_and_send` branch in `fixer-session.service.ts` to:

```ts
if (input.dispatchMode === 'start_empty_and_send') {
  await this.startOrRestartSession(acquisitionResult, {
    initialPrompt: '',
    startupModePreset: 'non_interactive',
  });

  await input.afterStart?.({ sessionId: acquisitionResult.sessionId, prompt });

  const promptSent = await this.sendMessageSafely(acquisitionResult.sessionId, prompt);

  return {
    status: 'started',
    sessionId: acquisitionResult.sessionId,
    promptSent,
  };
}
```

Leave the existing `afterStart` call after `startOrRestartSession` in the `start_with_prompt` branch unchanged.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm test src/backend/services/ratchet/service/fixer-session.service.test.ts
```

Expected: all tests in the file pass.

- [ ] **Step 5: Commit the lifecycle correction**

```bash
git add src/backend/services/ratchet/service/fixer-session.service.ts src/backend/services/ratchet/service/fixer-session.service.test.ts
git commit -m "Fix fixer session after-start timing"
```

---

### Task 2: Commit Ratchet Dispatches When the Session Starts

**Files:**
- Modify: `src/backend/services/ratchet/service/ratchet.service.test.ts`
- Modify: `src/backend/services/ratchet/service/ratchet-fixer-dispatch.helpers.ts`

**Interfaces:**
- Consumes: `AcquireAndDispatchInput.afterStart` from Task 1 and `commitSideEffects(): void` from `RatchetWorkspaceCheckCoordinator`.
- Produces: Ratchet marks the workspace check committed immediately after fixer session startup and again idempotently when the dispatch record is persisted.

- [ ] **Step 1: Write the failing Ratchet wiring test**

Add this test at the start of the `triggerFixer error handling` describe block in `ratchet.service.test.ts`:

```ts
it('commits the workspace check as soon as the fixer session starts', async () => {
  const commitSideEffects = vi.fn();
  vi.mocked(fixerSessionService.acquireAndDispatch).mockImplementation(async (input) => {
    await input.afterStart?.({ sessionId: 'started-session', prompt: 'prompt' });
    return {
      status: 'started',
      sessionId: 'started-session',
      promptSent: true,
    };
  });

  const result = await unsafeCoerce<{
    triggerFixer: (
      w: unknown,
      prStateInfo: unknown,
      retryCount: number,
      signal: AbortSignal,
      commitSideEffects: () => void
    ) => Promise<unknown>;
  }>(ratchetService).triggerFixer(
    {
      id: 'ws-started-dispatch',
      prUrl: 'https://github.com/example/repo/pull/20',
    },
    {
      ciStatus: CIStatus.FAILURE,
      snapshotKey: 'failed:20',
      prNumber: 20,
      reviewComments: [],
      hasMergeConflict: false,
    },
    0,
    new AbortController().signal,
    commitSideEffects
  );

  expect(result).toMatchObject({
    type: 'TRIGGERED_FIXER',
    sessionId: 'started-session',
  });
  expect(commitSideEffects).toHaveBeenCalledTimes(2);
});
```

The two calls are intentional: one at session startup and one at dispatch-record persistence. The coordinator marker is idempotent.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm test src/backend/services/ratchet/service/ratchet.service.test.ts
```

Expected: FAIL because `input.afterStart` is undefined and `commitSideEffects` is called only once.

- [ ] **Step 3: Wire Ratchet to the startup callback**

Add this callback beside `beforeStart` in `triggerRatchetFixer`:

```ts
afterStart: () => {
  signal?.throwIfAborted();
  commitSideEffects();
},
```

The existing `commitSideEffects()` call in `handleStartedFixerResult` remains unchanged.

- [ ] **Step 4: Run the focused Ratchet tests and verify GREEN**

Run:

```bash
pnpm test src/backend/services/ratchet/service/fixer-session.service.test.ts src/backend/services/ratchet/service/ratchet.service.test.ts src/backend/services/ratchet/service/ratchet-workspace-check-coordinator.test.ts
```

Expected: all focused Ratchet tests pass.

- [ ] **Step 5: Commit the Ratchet wiring**

```bash
git add src/backend/services/ratchet/service/ratchet-fixer-dispatch.helpers.ts src/backend/services/ratchet/service/ratchet.service.test.ts
git commit -m "Preserve started Ratchet fixer turns"
```

---

### Task 3: Verify and Publish

**Files:**
- Verify: all modified production, test, spec, and plan files.

**Interfaces:**
- Consumes: completed changes from Tasks 1 and 2.
- Produces: a verified branch and draft pull request.

- [ ] **Step 1: Run formatting and lint fixes**

Run:

```bash
pnpm check:fix
```

Expected: exit 0; inspect any formatting changes before committing them.

- [ ] **Step 2: Run the complete test suite**

Run:

```bash
pnpm test
```

Expected: exit 0 with no failed tests.

- [ ] **Step 3: Run type and repository checks**

Run:

```bash
pnpm typecheck
pnpm check
```

Expected: both commands exit 0. Existing documented warnings may remain, but no errors or new violations are allowed.

- [ ] **Step 4: Inspect the final diff**

Run:

```bash
git status --short
git diff --check
git diff origin/main...HEAD
```

Expected: only the approved Ratchet fix, regression tests, spec, and plan are present; `git diff --check` emits no output.

- [ ] **Step 5: Commit any formatter-only changes**

If `pnpm check:fix` changed tracked files, run:

```bash
git add src/backend/services/ratchet/service/fixer-session.service.ts src/backend/services/ratchet/service/fixer-session.service.test.ts src/backend/services/ratchet/service/ratchet-fixer-dispatch.helpers.ts src/backend/services/ratchet/service/ratchet.service.test.ts
git commit -m "Format Ratchet timeout fix"
```

If it changed nothing, skip this commit.

- [ ] **Step 6: Rebase or merge the latest `origin/main`, then re-run focused tests**

Fetch and integrate the latest main branch using a non-destructive merge:

```bash
git fetch origin main
git merge --no-edit origin/main
```

Resolve only conflicts within the files in this plan, then run:

```bash
pnpm test src/backend/services/ratchet/service/fixer-session.service.test.ts src/backend/services/ratchet/service/ratchet.service.test.ts src/backend/services/ratchet/service/ratchet-workspace-check-coordinator.test.ts
```

Expected: integration succeeds and all focused tests pass.

- [ ] **Step 7: Push and open a draft PR**

Push the current feature branch, then open a draft PR targeting `main` with a concise summary of the timeout root cause, the lifecycle-boundary fix, and verification commands run.
