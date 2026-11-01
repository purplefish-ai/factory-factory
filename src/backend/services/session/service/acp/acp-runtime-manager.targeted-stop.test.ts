import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagerTestHarness, setupSuccessfulSpawn } from './acp-runtime-manager.test-harness';
import { createTestClient, exitChildAfterSigterm } from './acp-runtime-manager.test-helpers';

function send(
  tracker: NonNullable<Awaited<ReturnType<typeof createTestClient>>['nativeSessionTracker']>,
  update: Record<string, unknown>
) {
  tracker.onRawMessage({ method: 'session/update', params: { sessionId: 'root', update } });
}

describe('runtime targeted stopping', () => {
  beforeEach(() => vi.useRealTimers());

  async function setup() {
    const { manager } = createManagerTestHarness();
    const process = setupSuccessfulSpawn();
    const handle = await createTestClient(manager);
    const tracker = handle.nativeSessionTracker!;
    tracker.setRootSessionId('root');
    const extMethod = vi.spyOn(handle.connection, 'extMethod').mockResolvedValue({ stopped: true });
    const cancel = vi.spyOn(handle.connection, 'cancel').mockResolvedValue(undefined);
    return { manager, process, handle, tracker, extMethod, cancel };
  }

  it('stops exactly the selected task through the current handle without cancelling its parent', async () => {
    const h = await setup();
    send(h.tracker, {
      sessionUpdate: 'async_task_spawned',
      asyncTaskId: 'selected',
      canStop: true,
    });
    send(h.tracker, { sessionUpdate: 'async_task_spawned', asyncTaskId: 'sibling', canStop: true });
    const selected = h.tracker.getBackgroundWork().backgroundTasks[0]!;
    await h.manager.stopTarget('session-1', {
      kind: 'task',
      id: selected.id,
      ...selected.stopControl!,
    });
    expect(h.extMethod).toHaveBeenCalledExactlyOnceWith('_session/async_task/stop', {
      sessionId: 'root',
      asyncTaskId: 'selected',
    });
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.process.kill).not.toHaveBeenCalled();
    expect(h.tracker.getBackgroundWork().backgroundTasks).toHaveLength(2);
  });

  it('cancels exactly the native child, preserving parent and sibling status until provider events', async () => {
    const h = await setup();
    for (const id of ['selected', 'sibling']) {
      send(h.tracker, {
        sessionUpdate: 'subagent_spawned',
        subagentSessionId: id,
        name: id,
        capabilities: { cancel: {} },
      });
    }
    const selected = h.tracker.list({ limit: 10 }).subagents[0]!;
    await h.manager.stopTarget('session-1', {
      kind: 'subagent',
      id: selected.id,
      ...selected.stopControl!,
    });
    expect(h.cancel).toHaveBeenCalledExactlyOnceWith({ sessionId: 'selected' });
    expect(h.extMethod).not.toHaveBeenCalled();
    expect(h.process.kill).not.toHaveBeenCalled();
    expect(h.tracker.list({ limit: 10 }).subagents.map((row) => row.status)).toEqual([
      'running',
      'running',
    ]);
  });

  it('rejects stale, forged and dead-runtime controls before dispatch and never starts a runtime', async () => {
    const h = await setup();
    send(h.tracker, {
      sessionUpdate: 'async_task_spawned',
      asyncTaskId: 'selected',
      canStop: true,
    });
    const selected = h.tracker.getBackgroundWork().backgroundTasks[0]!;
    const target = { kind: 'task' as const, id: selected.id, ...selected.stopControl! };
    await expect(h.manager.stopTarget('missing', target)).rejects.toThrow();
    await expect(
      h.manager.stopTarget('session-1', { ...target, controlId: 'forged' })
    ).rejects.toThrow();
    exitChildAfterSigterm(h.process);
    await h.manager.stopClient('session-1');
    setupSuccessfulSpawn();
    await createTestClient(h.manager);
    await expect(h.manager.stopTarget('session-1', target)).rejects.toThrow();
    expect(h.extMethod).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('normalizes provider failures without exposing raw transport errors', async () => {
    const h = await setup();
    send(h.tracker, {
      sessionUpdate: 'async_task_spawned',
      asyncTaskId: 'selected',
      canStop: true,
    });
    const selected = h.tracker.getBackgroundWork().backgroundTasks[0]!;
    const cause = new Error('raw provider transport details');
    h.extMethod.mockRejectedValueOnce(cause);
    await expect(
      h.manager.stopTarget('session-1', { kind: 'task', id: selected.id, ...selected.stopControl! })
    ).rejects.toMatchObject({
      name: 'AcpSubagentBrowseError',
      code: 'INTERNAL_ERROR',
      message: 'Unable to stop this item. Refresh and try again.',
      cause,
    });
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.process.kill).not.toHaveBeenCalled();
  });

  it('normalizes unacknowledged stop deadlines without cancelling the parent', async () => {
    const h = await setup();
    send(h.tracker, {
      sessionUpdate: 'subagent_spawned',
      subagentSessionId: 'selected',
      name: 'Selected',
      capabilities: { cancel: {} },
    });
    const selected = h.tracker.list({ limit: 10 }).subagents[0]!;
    vi.useFakeTimers();
    h.cancel.mockReturnValueOnce(
      new Promise<void>(() => {
        /* Provider never acknowledges. */
      })
    );
    const result = h.manager
      .stopTarget('session-1', { kind: 'subagent', id: selected.id, ...selected.stopControl! })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toMatchObject({
      name: 'AcpSubagentBrowseError',
      code: 'PRECONDITION_FAILED',
      message: 'The provider did not acknowledge the stop request. Refresh and try again.',
    });
    expect(h.process.kill).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('surfaces provider rejection and allows a retry without inventing completion', async () => {
    const h = await setup();
    send(h.tracker, {
      sessionUpdate: 'async_task_spawned',
      asyncTaskId: 'selected',
      canStop: true,
    });
    const selected = h.tracker.getBackgroundWork().backgroundTasks[0]!;
    const target = { kind: 'task' as const, id: selected.id, ...selected.stopControl! };
    h.extMethod.mockResolvedValueOnce({ stopped: false });
    await expect(h.manager.stopTarget('session-1', target)).rejects.toThrow();
    await expect(h.manager.stopTarget('session-1', target)).resolves.toBeUndefined();
    expect(h.tracker.getBackgroundWork().backgroundTasks).toHaveLength(1);
  });
});

it('rejects a browse-only runtime even when live-looking provider events advertise control', async () => {
  const { manager } = createManagerTestHarness();
  setupSuccessfulSpawn({ loadSession: true });
  const handle = await createTestClient(manager, {
    options: {
      provider: 'CODEX',
      workingDir: process.cwd(),
      sessionId: 'session-1',
      purpose: 'browse',
      resumeProviderSessionId: 'provider-session-existing',
    },
  });
  const tracker = handle.nativeSessionTracker!;
  tracker.setRootSessionId('root');
  send(tracker, { sessionUpdate: 'async_task_spawned', asyncTaskId: 'selected', canStop: true });
  const selected = tracker.getBackgroundWork().backgroundTasks[0]!;
  const extMethod = vi.spyOn(handle.connection, 'extMethod');
  await expect(
    manager.stopTarget('session-1', { kind: 'task', id: selected.id, ...selected.stopControl! })
  ).rejects.toThrow();
  expect(extMethod).not.toHaveBeenCalled();
  tracker.setCapabilities({ sessionCapabilities: { subagents: {} } });
  send(tracker, {
    sessionUpdate: 'subagent_spawned',
    subagentSessionId: 'child',
    name: 'Child',
    capabilities: { cancel: {} },
  });
  expect(
    (await manager.listSubagents('session-1', { limit: 10 })).subagents[0]?.stopControl
  ).toBeUndefined();
});
