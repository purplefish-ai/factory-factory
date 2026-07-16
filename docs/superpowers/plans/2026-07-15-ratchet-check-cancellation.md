# Ratchet Workspace Check Cancellation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop timed-out ratchet workspace checks before they can dispatch or persist stale state, and cap ratchet batch processing at three concurrent workspaces.

**Architecture:** The workspace-check coordinator owns an `AbortController` for every deduplicated in-flight check and aborts it when the existing 90-second timeout fires. The signal is checked at ratchet side-effect boundaries and passed through the ratchet GitHub bridge into abortable `gh` child processes; a ratchet-local `p-limit(3)` bounds workspace-level concurrency.

**Tech Stack:** TypeScript, Node.js `AbortController`/`AbortSignal`, `child_process.execFile`, `p-limit`, Vitest, Express backend service capsules.

## Global Constraints

- Keep service-to-service imports through capsule barrels and keep bridge wiring in `src/backend/orchestration/`.
- Preserve same-workspace singleflight behavior in `RatchetWorkspaceCheckCoordinator`.
- Preserve non-ratchet GitHub CLI singleflight behavior; signal-bound reads must not share cancellable child processes.
- Preserve the 90-second ratchet workspace timeout and the GitHub CLI global concurrency limit.
- Use a ratchet workspace concurrency limit of exactly `3`.
- Do not change ratchet decision logic, poll cadence, result ordering, or aggregate counts.
- Write each regression test first, run it to observe the expected failure, then add only the implementation needed to pass.

---

## File Map

- `src/backend/services/ratchet/service/ratchet-workspace-check-coordinator.ts`: own each check's abort controller and timeout.
- `src/backend/services/ratchet/service/ratchet-workspace-check-coordinator.test.ts`: coordinator cancellation and dedup regression coverage.
- `src/backend/services/github/service/github-cli.service.ts`: accept optional signals for ratchet PR reads and pass them to `execFile` without cancellable singleflight sharing.
- `src/backend/services/github/service/github-cli.service.test.ts`: child-process signal forwarding and signal-bound singleflight coverage.
- `src/backend/services/ratchet/service/bridges.ts`: expose optional signals on the ratchet GitHub bridge.
- `src/backend/orchestration/domain-bridges.orchestrator.ts`: forward bridge signals to the GitHub CLI service.
- `src/backend/orchestration/domain-bridges.orchestrator.test.ts`: bridge signal delegation coverage.
- `src/backend/services/ratchet/service/ratchet-pr-state.helpers.ts`: forward signals to both PR reads, release fetch claims, and rethrow abort reasons.
- `src/backend/services/ratchet/service/ratchet-pr-state.helpers.test.ts`: helper forwarding and cancellation semantics.
- `src/backend/services/ratchet/service/ratchet.service.ts`: propagate signals, add abort barriers, and limit batch workspace concurrency.
- `src/backend/services/ratchet/service/ratchet.service.test.ts`: prevent post-timeout side effects and verify maximum concurrency.

### Task 1: Make the workspace-check coordinator abort timed-out runners

**Files:**
- Modify: `src/backend/services/ratchet/service/ratchet-workspace-check-coordinator.ts`
- Test: `src/backend/services/ratchet/service/ratchet-workspace-check-coordinator.test.ts`

**Interfaces:**
- Consumes: `WorkspaceWithPR`, `WorkspaceRatchetResult`, configured timeout supplier.
- Produces: `run(workspace, runner: (signal: AbortSignal, commitSideEffects: () => void) => Promise<WorkspaceRatchetResult>, schedule?): Promise<WorkspaceRatchetResult>`.

- [ ] **Step 1: Write a failing coordinator cancellation test**

Add this test beside the existing reused-in-flight timeout test:

```ts
it('aborts the shared runner when a workspace check times out', async () => {
  const coordinator = new RatchetWorkspaceCheckCoordinator(() => 1000);
  const workspace = { id: 'workspace-abort' } as WorkspaceWithPR;
  let receivedSignal: AbortSignal | undefined;
  const runner = vi.fn((signal?: AbortSignal) => {
    receivedSignal = signal;
    return new Promise<WorkspaceRatchetResult>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });

  const firstRun = coordinator.run(workspace, runner);
  const secondRun = coordinator.run(workspace, runner);
  const firstExpectation = expect(firstRun).rejects.toThrow(
    'Workspace check timed out after 1000ms'
  );
  const secondExpectation = expect(secondRun).rejects.toThrow(
    'Workspace check timed out after 1000ms'
  );

  await vi.advanceTimersByTimeAsync(1000);

  await firstExpectation;
  await secondExpectation;
  expect(runner).toHaveBeenCalledTimes(1);
  expect(receivedSignal?.aborted).toBe(true);
  expect(receivedSignal?.reason).toEqual(
    new Error('Workspace check timed out after 1000ms')
  );
});
```

- [ ] **Step 2: Run the coordinator test and verify RED**

Run:

```bash
pnpm vitest run src/backend/services/ratchet/service/ratchet-workspace-check-coordinator.test.ts
```

Expected: FAIL because `run` does not pass an `AbortSignal`, so `receivedSignal` is `undefined`.

- [ ] **Step 3: Store a controller with the shared promise and abort it on timeout**

Replace the promise-only map and runner plumbing with:

```ts
interface InFlightWorkspaceCheck {
  controller: AbortController;
  promise: Promise<WorkspaceRatchetResult> | null;
  started: Promise<void>;
  timeoutDisabled: boolean;
}

type WorkspaceCheckScheduler = (
  task: () => Promise<WorkspaceRatchetResult>
) => Promise<WorkspaceRatchetResult>;

const runImmediately: WorkspaceCheckScheduler = (task) => task();

export class RatchetWorkspaceCheckCoordinator {
  private readonly inFlightWorkspaceChecks = new Map<string, InFlightWorkspaceCheck>();

  constructor(private readonly getTimeoutMs: () => number) {}

  run(
    workspace: WorkspaceWithPR,
    runner: (
      signal: AbortSignal,
      commitSideEffects: () => void
    ) => Promise<WorkspaceRatchetResult>,
    schedule: WorkspaceCheckScheduler = runImmediately
  ): Promise<WorkspaceRatchetResult> {
    const existing = this.inFlightWorkspaceChecks.get(workspace.id);
    if (existing) {
      return this.withTimeout(existing);
    }

    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const entry: InFlightWorkspaceCheck = {
      controller,
      promise: null,
      started,
      timeoutDisabled: false,
    };
    const promise = schedule(async () => {
      markStarted();
      controller.signal.throwIfAborted();
      return await runner(controller.signal, () => {
        entry.timeoutDisabled = true;
      });
    }).finally(() => {
      if (this.inFlightWorkspaceChecks.get(workspace.id) === entry) {
        this.inFlightWorkspaceChecks.delete(workspace.id);
      }
    });
    entry.promise = promise;
    this.inFlightWorkspaceChecks.set(workspace.id, entry);
    return this.withTimeout(entry);
  }

  private async withTimeout(
    entry: InFlightWorkspaceCheck
  ): Promise<WorkspaceRatchetResult> {
    await entry.started;
    const promise = entry.promise;
    if (!promise) {
      throw new Error('Workspace check started without a scheduled promise');
    }
    const timeoutMs = this.getTimeoutMs();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (entry.timeoutDisabled) {
          return;
        }
        const timeoutError = new Error(`Workspace check timed out after ${timeoutMs}ms`);
        entry.controller.abort(timeoutError);
        reject(timeoutError);
      }, timeoutMs);
      timeout.unref?.();

      promise.then(resolve, reject).finally(() => {
        clearTimeout(timeout);
      });
    });
  }
}
```

- [ ] **Step 4: Run coordinator tests and verify GREEN**

Run:

```bash
pnpm vitest run src/backend/services/ratchet/service/ratchet-workspace-check-coordinator.test.ts
```

Expected: both coordinator tests PASS with no unhandled rejection.

- [ ] **Step 5: Commit the coordinator contract**

```bash
git add src/backend/services/ratchet/service/ratchet-workspace-check-coordinator.ts src/backend/services/ratchet/service/ratchet-workspace-check-coordinator.test.ts
git commit -m "Abort timed-out ratchet workspace checks"
```

### Task 2: Add abortable GitHub PR reads without cross-caller cancellation

**Files:**
- Modify: `src/backend/services/github/service/github-cli.service.ts`
- Test: `src/backend/services/github/service/github-cli.service.test.ts`
- Modify: `src/backend/services/ratchet/service/bridges.ts`
- Modify: `src/backend/orchestration/domain-bridges.orchestrator.ts`
- Test: `src/backend/orchestration/domain-bridges.orchestrator.test.ts`

**Interfaces:**
- Consumes: optional `AbortSignal` from ratchet.
- Produces: `getPRFullDetails(repo, prNumber, signal?)` and `getReviewComments(repo, prNumber, since?, signal?)`; bridge methods with identical optional signal positions.

- [ ] **Step 1: Write failing GitHub CLI tests for signal forwarding and no signal-bound singleflight**

Add under `centralized exec - singleflight dedup`:

```ts
it('passes abort signals to PR detail child processes', async () => {
  const controller = new AbortController();
  mockExecFile.mockResolvedValue({
    stdout: JSON.stringify({
      number: 42,
      title: 'PR',
      url: 'https://github.com/owner/repo/pull/42',
      author: { login: 'author' },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      isDraft: false,
      state: 'OPEN',
      reviewDecision: null,
      statusCheckRollup: [],
      reviews: [],
      comments: [],
      labels: [],
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      headRefName: 'feature',
      baseRefName: 'main',
      mergeStateStatus: 'CLEAN',
    }),
    stderr: '',
  });

  await githubCLIService.getPRFullDetails('owner/repo', 42, controller.signal);

  expect(mockExecFile).toHaveBeenCalledWith(
    'gh',
    expect.any(Array),
    expect.objectContaining({ signal: controller.signal })
  );
});

it('does not singleflight identical signal-bound PR reads', async () => {
  const first = new AbortController();
  const second = new AbortController();
  mockExecFile.mockResolvedValue({
    stdout: JSON.stringify({
      number: 42,
      title: 'PR',
      url: 'https://github.com/owner/repo/pull/42',
      author: { login: 'author' },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      isDraft: false,
      state: 'OPEN',
      reviewDecision: null,
      statusCheckRollup: [],
      reviews: [],
      comments: [],
      labels: [],
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      headRefName: 'feature',
      baseRefName: 'main',
      mergeStateStatus: 'CLEAN',
    }),
    stderr: '',
  });

  await Promise.all([
    githubCLIService.getPRFullDetails('owner/repo', 42, first.signal),
    githubCLIService.getPRFullDetails('owner/repo', 42, second.signal),
  ]);

  expect(mockExecFile).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run the GitHub CLI tests and verify RED**

Run:

```bash
pnpm vitest run src/backend/services/github/service/github-cli.service.test.ts
```

Expected: FAIL because `getPRFullDetails` does not accept or forward a signal and identical reads are deduplicated.

- [ ] **Step 3: Add optional signal support to read execution and public PR methods**

Extend read options and factor the process start so signal-bound calls skip the shared map:

```ts
type ReadExecOptions = {
  timeout?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
};

private exec(args: string[], options?: ReadExecOptions): Promise<ExecResult> {
  if (this.rateLimitedUntil !== null && Date.now() < this.rateLimitedUntil) {
    return Promise.reject(new Error('GitHub API rate limit exceeded, backing off'));
  }

  const execute = () =>
    this.execLimit(() =>
      execFileAsync('gh', args, {
        timeout: options?.timeout ?? GH_TIMEOUT_MS.default,
        ...(options?.maxBuffer ? { maxBuffer: options.maxBuffer } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      })
    ).then(
      (result) => result,
      (err: unknown) => {
        const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
        if (isRateLimitMessage(msg)) {
          this.rateLimitedUntil = Date.now() + RATE_LIMIT_FAST_FAIL_MS;
        }
        throw err;
      }
    );

  if (options?.signal) {
    return execute();
  }

  const key = args.join('\0');
  const existing = this.inflight.get(key);
  if (existing) {
    return existing;
  }
  const promise = execute().finally(() => this.inflight.delete(key));
  this.inflight.set(key, promise);
  return promise;
}
```

Update the `getPRFullDetails` signature and replace its `this.exec` call with the following call. Insert `signal?.throwIfAborted()` as the first statement of its current catch block; no response-mapping lines change.

```ts
async getPRFullDetails(
  repo: string,
  prNumber: number,
  signal?: AbortSignal
): Promise<PRWithFullDetails> {
  const { stdout } = await this.exec(
    ['pr', 'view', String(prNumber), '--repo', repo, '--json', fields],
    { timeout: GH_TIMEOUT_MS.default, signal }
  );
} catch (error) {
  signal?.throwIfAborted();
  const errorType = classifyError(error);
  const errorMessage = error instanceof Error ? error.message : String(error);
  logger.error('Failed to fetch PR details via gh CLI', {
    repo,
    prNumber,
    errorType,
    error: errorMessage,
  });
  throw new Error(`Failed to fetch PR details: ${errorMessage}`);
}

```

Update the `getReviewComments` signature as follows:

```ts
async getReviewComments(
  repo: string,
  prNumber: number,
  since?: Date,
  signal?: AbortSignal
): Promise<Array<{
  id: number;
  author: { login: string };
  body: string;
  path: string;
  line: number | null;
  createdAt: string;
  updatedAt: string;
  url: string;
}>> {
```

Add the first abort check at the top of its page loop, add `signal` to the existing `this.exec` options, and add the second abort check immediately after that await:

```ts
  for (let page = 1; page <= MAX_PAGES; page++) {
    signal?.throwIfAborted();
    const sinceParam = since ? `&since=${since.toISOString()}` : '';
    const path = `repos/${repo}/pulls/${prNumber}/comments?per_page=${PAGE_SIZE}&page=${page}${sinceParam}`;
    const { stdout } = await this.exec(['api', path], {
      timeout: GH_TIMEOUT_MS.default,
      maxBuffer: GH_MAX_BUFFER_BYTES.reviewComments,
      signal,
    });
    signal?.throwIfAborted();
  }
```

Insert `signal?.throwIfAborted()` as the first statement of the method's current catch block:

```ts
} catch (error) {
  signal?.throwIfAborted();
  const errorType = classifyError(error);
  const errorMessage = error instanceof Error ? error.message : String(error);
  logger.error('Failed to fetch PR review comments via gh CLI', {
    repo,
    prNumber,
    errorType,
    error: errorMessage,
  });
  throw new Error(`Failed to fetch PR review comments: ${errorMessage}`);
}
```

- [ ] **Step 4: Write a failing bridge signal-delegation test**

Add under `ratchet bridge delegation`:

```ts
it('github bridge forwards abort signals to PR reads', async () => {
  const controller = new AbortController();
  configureDomainBridges();
  const bridge = getBridge(ratchetService.configure);

  await bridge.github.getPRFullDetails('owner/repo', 42, controller.signal);
  await bridge.github.getReviewComments('owner/repo', 42, undefined, controller.signal);

  expect(githubCLIService.getPRFullDetails).toHaveBeenCalledWith(
    'owner/repo',
    42,
    controller.signal
  );
  expect(githubCLIService.getReviewComments).toHaveBeenCalledWith(
    'owner/repo',
    42,
    undefined,
    controller.signal
  );
});
```

- [ ] **Step 5: Run the bridge test and verify RED**

Run:

```bash
pnpm vitest run src/backend/orchestration/domain-bridges.orchestrator.test.ts
```

Expected: FAIL because bridge methods currently discard the signal.

- [ ] **Step 6: Extend and wire the ratchet GitHub bridge**

Change the bridge interface to:

```ts
getPRFullDetails(
  repo: string,
  prNumber: number,
  signal?: AbortSignal
): Promise<RatchetPRFullDetails>;
getReviewComments(
  repo: string,
  prNumber: number,
  since?: Date,
  signal?: AbortSignal
): Promise<RatchetReviewComment[]>;
```

Change orchestration delegation to:

```ts
getPRFullDetails: (repo, pr, signal) => githubCLIService.getPRFullDetails(repo, pr, signal),
getReviewComments: (repo, pr, since, signal) =>
  githubCLIService.getReviewComments(repo, pr, since, signal),
```

- [ ] **Step 7: Run GitHub and bridge tests and verify GREEN**

Run:

```bash
pnpm vitest run src/backend/services/github/service/github-cli.service.test.ts src/backend/orchestration/domain-bridges.orchestrator.test.ts
```

Expected: both files PASS, including the pre-existing non-signal singleflight test.

- [ ] **Step 8: Commit the abortable GitHub transport**

```bash
git add src/backend/services/github/service/github-cli.service.ts src/backend/services/github/service/github-cli.service.test.ts src/backend/services/ratchet/service/bridges.ts src/backend/orchestration/domain-bridges.orchestrator.ts src/backend/orchestration/domain-bridges.orchestrator.test.ts
git commit -m "Forward ratchet cancellation to GitHub reads"
```

### Task 3: Propagate cancellation through ratchet and block late side effects

**Files:**
- Modify: `src/backend/services/ratchet/service/ratchet-pr-state.helpers.ts`
- Test: `src/backend/services/ratchet/service/ratchet-pr-state.helpers.test.ts`
- Modify: `src/backend/services/ratchet/service/ratchet.service.ts`
- Test: `src/backend/services/ratchet/service/ratchet.service.test.ts`

**Interfaces:**
- Consumes: coordinator runner signal and signal-aware ratchet GitHub bridge from Tasks 1–2.
- Produces: a `fetchPRState` parameter object with required `signal: AbortSignal`, `processWorkspace(workspace, signal)`, and cancellation-safe service behavior.

- [ ] **Step 1: Write a failing PR-state helper cancellation test**

Add to the first `fetchPRState` describe block:

```ts
it('forwards cancellation, releases the fetch claim, and skips backoff', async () => {
  const controller = new AbortController();
  const timeoutError = new Error('Workspace check timed out after 1000ms');
  const github = makeGitHub({
    getPRFullDetails: vi.fn(async (_repo, _pr, signal) => {
      controller.abort(timeoutError);
      signal?.throwIfAborted();
      throw new Error('unreachable');
    }),
    getReviewComments: vi.fn(() => new Promise(() => {})),
  });

  await expect(
    fetchPRState({
      workspace: makeWorkspace(),
      authenticatedUsername: null,
      github,
      backoff,
      logger,
      signal: controller.signal,
    })
  ).rejects.toBe(timeoutError);

  expect(github.getPRFullDetails).toHaveBeenCalledWith(
    'example/repo',
    123,
    controller.signal
  );
  expect(github.getReviewComments).toHaveBeenCalledWith(
    'example/repo',
    123,
    undefined,
    controller.signal
  );
  expect(github.cancelFetch).toHaveBeenCalledWith('ws-1');
  expect(backoff.handleError).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the helper test and verify RED**

Run:

```bash
pnpm vitest run src/backend/services/ratchet/service/ratchet-pr-state.helpers.test.ts
```

Expected: FAIL because `fetchPRState` has no signal input and does not forward or rethrow cancellation.

- [ ] **Step 3: Add helper signal forwarding and abort-specific catch behavior**

Add `signal: AbortSignal` to the parameter type and implement these boundaries:

```ts
signal.throwIfAborted();
github.startFetch(workspace.id);

const [prDetails, reviewComments] = await Promise.all([
  github.getPRFullDetails(prContext.repo, prContext.prNumber, signal),
  github.getReviewComments(prContext.repo, prContext.prNumber, undefined, signal),
]);
signal.throwIfAborted();

const statusCheckRollup =
  prDetails.statusCheckRollup?.map((check) => ({
    name: check.name,
    workflowName: check.workflowName,
    status: check.status,
    conclusion: check.conclusion ?? undefined,
    detailsUrl: check.detailsUrl,
    startedAt: check.startedAt,
    completedAt: check.completedAt,
  })) ?? null;
const reducedStatusCheckRollup = reduceCheckRollupToLatestRunAttempts(statusCheckRollup);
const ciStatus = github.computeCIStatus(reducedStatusCheckRollup);
const hasChangesRequested = prDetails.reviewDecision === 'CHANGES_REQUESTED';
const hasMergeConflict = prDetails.mergeStateStatus === 'DIRTY';
const latestReviewActivityAtMs = computeLatestReviewActivityAtMsFn(
  prDetails,
  reviewComments,
  authenticatedUsername
);
const snapshotKey = computeDispatchSnapshotKeyFn(
  ciStatus,
  hasChangesRequested,
  latestReviewActivityAtMs,
  reducedStatusCheckRollup,
  hasMergeConflict
);
signal.throwIfAborted();
github.registerFetch(workspace.id);
```

Use this catch ordering:

```ts
} catch (error) {
  github.cancelFetch(workspace.id);
  signal.throwIfAborted();
  backoff.handleError(
    error,
    logger,
    'Ratchet',
    { workspaceId: workspace.id, prUrl: workspace.prUrl },
    SERVICE_INTERVAL_MS.ratchetPoll
  );
  return null;
}
```

Update all existing direct helper calls in tests to pass `signal: new AbortController().signal`.

- [ ] **Step 4: Write a failing service regression test for post-timeout effects**

Add under `checkAllWorkspaces`:

```ts
it('does not continue to side effects after a timed-out await completes', async () => {
  unsafeCoerce<{ workspaceCheckTimeoutMs: number }>(ratchetService).workspaceCheckTimeoutMs = 5;
  const workspace = {
    id: 'ws-zombie',
    prUrl: 'https://github.com/example/repo/pull/1',
    prNumber: 1,
    prState: 'OPEN',
    prCiStatus: CIStatus.FAILURE,
    defaultSessionProvider: 'WORKSPACE_DEFAULT',
    ratchetSessionProvider: 'WORKSPACE_DEFAULT',
    ratchetEnabled: true,
    ratchetState: RatchetState.IDLE,
    ratchetActiveSessionId: null,
    ratchetLastCiRunId: null,
    prReviewLastCheckedAt: null,
    ratchetDispatchOutcome: null,
    ratchetDispatchRetryCount: 0,
  };
  vi.mocked(workspaceAccessor.findWithPRsForRatchet).mockResolvedValue([workspace] as never);
  let releaseFetch!: () => void;
  const fetchBarrier = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  const finishSpy = vi.spyOn(
    unsafeCoerce<{ finishRatchetCheck: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
    'finishRatchetCheck'
  );
  vi.spyOn(
    unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
    'fetchPRState'
  ).mockImplementation(async () => {
    await fetchBarrier;
    return {
      ciStatus: CIStatus.FAILURE,
      snapshotKey: 'failed:1',
      hasChangesRequested: false,
      hasMergeConflict: false,
      latestReviewActivityAtMs: null,
      statusCheckRollup: [],
      prState: 'OPEN',
      prNumber: 1,
      reviewComments: [],
    };
  });

  const result = await ratchetService.checkAllWorkspaces();
  expect(result.results[0]?.action.type).toBe('ERROR');
  releaseFetch();
  await Promise.resolve();
  await Promise.resolve();

  expect(finishSpy).not.toHaveBeenCalled();
  expect(workspaceAccessor.updateRatchetCheckIfEnabled).not.toHaveBeenCalled();
});
```

- [ ] **Step 5: Run the service test and verify RED**

Run:

```bash
pnpm vitest run src/backend/services/ratchet/service/ratchet.service.test.ts
```

Expected: FAIL because the coordinator does not currently provide a signal to `processWorkspace`, and the released check continues past the timeout.

- [ ] **Step 6: Thread the signal and add abort barriers**

Update coordinator invocation:

```ts
return await this.checkCoordinator.run(workspace, (signal) =>
  this.processWorkspace(workspace, signal)
);
```

Update the method signature and add the initial abort check:

```ts
private async processWorkspace(
  workspace: WorkspaceWithPR,
  signal: AbortSignal
): Promise<WorkspaceRatchetResult> {
  signal.throwIfAborted();
```

In the disabled branch, wrap its update await with these exact checks; no other disabled-branch statements change:

```ts
signal.throwIfAborted();
await workspaceAccessor.update(workspace.id, {
  ratchetState: newState,
  ratchetLastCheckedAt: new Date(),
});
signal.throwIfAborted();
```

In the enabled branch, add abort checks after the username and PR-state awaits, retain the two early-return cases, and then use the following decision sequence:

```ts
  try {
    const authenticatedUsername = await this.getAuthenticatedUsernameCached(signal);
    signal.throwIfAborted();
    const prStateResult = await this.fetchPRState(workspace, authenticatedUsername, signal);
    signal.throwIfAborted();

    if (isPRStateFetchSkipped(prStateResult)) {
      const action: RatchetAction = { type: 'WAITING', reason: prStateResult.reason };
      this.logWorkspaceRatchetingDecision(
        workspace,
        workspace.ratchetState,
        workspace.ratchetState,
        action,
        null
      );
      return {
        workspaceId: workspace.id,
        previousState: workspace.ratchetState,
        newState: workspace.ratchetState,
        action,
      };
    }

    if (!prStateResult) {
      const action: RatchetAction = { type: 'ERROR', error: 'Failed to fetch PR state' };
      this.logWorkspaceRatchetingDecision(
        workspace,
        workspace.ratchetState,
        workspace.ratchetState,
        action,
        null
      );
      return {
        workspaceId: workspace.id,
        previousState: workspace.ratchetState,
        newState: workspace.ratchetState,
        action,
      };
    }

    const decisionContext = await this.buildRatchetDecisionContext(
      workspace,
      prStateResult,
      signal
    );
    signal.throwIfAborted();
    const decision = await this.decideRatchetAction(decisionContext, signal);
    signal.throwIfAborted();
    const action = await this.applyRatchetDecision(decisionContext, decision, signal);
    signal.throwIfAborted();
    return await this.finishRatchetCheck(
      workspace,
      prStateResult,
      action,
      decisionContext,
      signal
    );
  } catch (error) {
    signal.throwIfAborted();
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Error processing workspace in ratchet', toError(error), {
      workspaceId: workspace.id,
    });
    const action: RatchetAction = { type: 'ERROR', error: errorMessage };
    this.logWorkspaceRatchetingDecision(
      workspace,
      workspace.ratchetState,
      workspace.ratchetState,
      action,
      null
    );
    return {
      workspaceId: workspace.id,
      previousState: workspace.ratchetState,
      newState: workspace.ratchetState,
      action,
    };
  }
}
```

Update the service wrapper:

```ts
private async fetchPRState(
  workspace: WorkspaceWithPR,
  authenticatedUsername: string | null,
  signal: AbortSignal
): Promise<PRStateFetchResult> {
  return await fetchPRStateHelper({
    workspace,
    authenticatedUsername,
    signal,
    github: this.github,
    backoff: this.backoff,
    logger,
    computeLatestReviewActivityAtMs: (prDetails, reviewComments, authenticatedUsernameArg) =>
      this.computeLatestReviewActivityAtMs(
        prDetails,
        reviewComments,
        authenticatedUsernameArg
      ),
    computeDispatchSnapshotKey: (
      ciStatus,
      hasChangesRequested,
      latestReviewActivityAtMs,
      statusChecks,
      hasMergeConflict
    ) =>
      this.computeDispatchSnapshotKey(
        ciStatus,
        hasChangesRequested,
        latestReviewActivityAtMs,
        statusChecks,
        hasMergeConflict
      ),
  });
}
```

Add `signal.throwIfAborted()` immediately before `triggerRatchetFixer`, `updateRatchetCheckIfEnabled`, `recordReviewCheck`, and `recordCIObservation`. Pass the signal into the private methods that own those boundaries (`applyRatchetDecision`, `triggerFixer`, `finishRatchetCheck`, and `updateWorkspaceAfterCheck`) so no side effect can begin after timeout.

Update direct private-method tests to supply a fresh non-aborted signal where their signatures change:

```ts
const signal = new AbortController().signal;
```

- [ ] **Step 7: Run ratchet cancellation tests and verify GREEN**

Run:

```bash
pnpm vitest run src/backend/services/ratchet/service/ratchet-workspace-check-coordinator.test.ts src/backend/services/ratchet/service/ratchet-pr-state.helpers.test.ts src/backend/services/ratchet/service/ratchet.service.test.ts
```

Expected: all three files PASS with no unhandled rejection and the timeout still returns an `ERROR` action.

- [ ] **Step 8: Commit ratchet signal propagation**

```bash
git add src/backend/services/ratchet/service/ratchet-pr-state.helpers.ts src/backend/services/ratchet/service/ratchet-pr-state.helpers.test.ts src/backend/services/ratchet/service/ratchet.service.ts src/backend/services/ratchet/service/ratchet.service.test.ts
git commit -m "Stop ratchet side effects after timeout"
```

### Task 4: Cap ratchet batch concurrency at three workspaces

**Files:**
- Modify: `src/backend/services/ratchet/service/ratchet.service.ts`
- Test: `src/backend/services/ratchet/service/ratchet.service.test.ts`

**Interfaces:**
- Consumes: existing `runWorkspaceCheckSafely(workspace)`.
- Produces: unchanged `checkAllWorkspaces(): Promise<RatchetCheckResult>` with at most three active workspace checks.

- [ ] **Step 1: Write a failing maximum-concurrency test**

Add under `checkAllWorkspaces`:

```ts
it('runs at most three workspace checks concurrently', async () => {
  const workspaces = Array.from({ length: 7 }, (_, index) => ({
    id: `ws-${index}`,
    prUrl: `https://github.com/example/repo/pull/${index + 1}`,
    prNumber: index + 1,
    prState: 'OPEN',
    prCiStatus: CIStatus.UNKNOWN,
    defaultSessionProvider: 'WORKSPACE_DEFAULT',
    ratchetSessionProvider: 'WORKSPACE_DEFAULT',
    ratchetEnabled: true,
    ratchetState: RatchetState.IDLE,
    ratchetActiveSessionId: null,
    ratchetLastCiRunId: null,
    prReviewLastCheckedAt: null,
    ratchetDispatchOutcome: null,
    ratchetDispatchRetryCount: 0,
  }));
  vi.mocked(workspaceAccessor.findWithPRsForRatchet).mockResolvedValue(workspaces as never);
  let active = 0;
  let maximumActive = 0;
  let releaseChecks!: () => void;
  const checkBarrier = new Promise<void>((resolve) => {
    releaseChecks = resolve;
  });
  vi.spyOn(
    unsafeCoerce<{ processWorkspace: (workspace: (typeof workspaces)[number], signal: AbortSignal) => Promise<unknown> }>(ratchetService),
    'processWorkspace'
  ).mockImplementation(async (workspace) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await checkBarrier;
    active -= 1;
    return {
      workspaceId: workspace.id,
      previousState: RatchetState.IDLE,
      newState: RatchetState.IDLE,
      action: { type: 'WAITING', reason: 'noop' },
    };
  });

  const resultPromise = ratchetService.checkAllWorkspaces();
  await vi.waitFor(() => expect(active).toBe(3));
  expect(maximumActive).toBe(3);
  releaseChecks();
  const result = await resultPromise;

  expect(maximumActive).toBe(3);
  expect(result.checked).toBe(7);
  expect(result.results).toHaveLength(7);
});
```

- [ ] **Step 2: Run the service test and verify RED**

Run:

```bash
pnpm vitest run src/backend/services/ratchet/service/ratchet.service.test.ts
```

Expected: FAIL because all seven `processWorkspace` calls start immediately.

- [ ] **Step 3: Add a ratchet-local limiter**

At module scope:

```ts
import pLimit from 'p-limit';

const RATCHET_WORKSPACE_CONCURRENCY = 3;
const ratchetWorkspaceLimit = pLimit(RATCHET_WORKSPACE_CONCURRENCY);
```

Leave the batch mapping unchanged so the coordinator claims the workspace before queueing:

```ts
const results = await Promise.all(
  workspaces.map((workspace) => this.runWorkspaceCheckSafely(workspace))
);
```

Pass the limiter to the coordinator as its scheduler. This preserves
same-workspace singleflight, starts the timeout only after a limiter slot is
granted, and keeps that slot occupied until an aborted runner has actually
finished cleanup:

```ts
return await this.checkCoordinator.run(
  workspace,
  (signal, commitSideEffects) => {
    signal.throwIfAborted();
    return this.processWorkspace(workspace, opts, signal, commitSideEffects);
  },
  (task) => ratchetWorkspaceLimit(task)
);
```

Thread `commitSideEffects` through the decision/dispatch path. The fixer
dispatch helper calls it synchronously after its last abort check and
immediately before persisting or adopting a session. Once that commit boundary
is crossed, the coordinator no longer aborts the check, allowing dispatch,
workspace state, and snapshot writes to finish consistently.

- [ ] **Step 4: Run service and full targeted tests and verify GREEN**

Run:

```bash
pnpm vitest run src/backend/services/ratchet/service/ratchet-workspace-check-coordinator.test.ts src/backend/services/ratchet/service/ratchet-pr-state.helpers.test.ts src/backend/services/ratchet/service/ratchet.service.test.ts src/backend/services/github/service/github-cli.service.test.ts src/backend/orchestration/domain-bridges.orchestrator.test.ts
```

Expected: all targeted tests PASS and the existing same-workspace deduplication test remains green.

- [ ] **Step 5: Commit bounded batch concurrency**

```bash
git add src/backend/services/ratchet/service/ratchet.service.ts src/backend/services/ratchet/service/ratchet.service.test.ts
git commit -m "Limit concurrent ratchet workspace checks"
```

### Task 5: Repository verification and issue handoff

**Files:**
- Verify all modified files.
- Update docs only if implementation behavior differs from the approved design.

**Interfaces:**
- Consumes: completed Tasks 1–4.
- Produces: a verified branch ready for review or publication.

- [ ] **Step 1: Format and lint modified files**

Run:

```bash
pnpm check:fix
```

Expected: exits `0`; inspect any formatter changes before continuing.

- [ ] **Step 2: Run targeted tests again after formatting**

Run:

```bash
pnpm vitest run src/backend/services/ratchet/service/ratchet-workspace-check-coordinator.test.ts src/backend/services/ratchet/service/ratchet-pr-state.helpers.test.ts src/backend/services/ratchet/service/ratchet.service.test.ts src/backend/services/github/service/github-cli.service.test.ts src/backend/orchestration/domain-bridges.orchestrator.test.ts
```

Expected: all targeted tests PASS.

- [ ] **Step 3: Run repository tests and static guardrails**

Run:

```bash
pnpm test
pnpm typecheck
pnpm check
```

Expected: all commands exit `0`. Record any pre-existing unrelated failure with its exact command and output instead of modifying unrelated code.

- [ ] **Step 4: Inspect the final diff and commit formatting changes if needed**

Run:

```bash
git status --short
git diff --check
git diff origin/main...HEAD --stat
git diff origin/main...HEAD
```

Expected: only issue #1862 implementation, tests, spec, and plan are present; `git diff --check` is clean.

If formatting produced tracked changes, commit them:

```bash
git add src/backend/services/ratchet src/backend/services/github/service/github-cli.service.ts src/backend/services/github/service/github-cli.service.test.ts src/backend/orchestration/domain-bridges.orchestrator.ts src/backend/orchestration/domain-bridges.orchestrator.test.ts
git commit -m "Format ratchet cancellation changes"
```

- [ ] **Step 5: Prepare the handoff**

Report:

```text
Issue #1862 addressed on branch fix/1862-ratchet-check-cancellation.
Behavior: timed-out checks abort before late dispatch/persistence; batch concurrency is capped at 3.
Verification: pnpm test, pnpm typecheck, pnpm check, pnpm check:fix.
```
