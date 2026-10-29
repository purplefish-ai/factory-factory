import { describe, expect, it, vi } from 'vitest';
import type { PeriodicTaskTimerEvent } from '@/backend/services/periodic-task';
import type { PRDeliveryRequest } from '@/shared/pr-monitoring';
import {
  dispatchBackgroundAction,
  type ExistingSessionDispatchPorts,
} from './background-action-dispatch.orchestrator';

const request: PRDeliveryRequest = { workspaceId: 'workspace', prId: 'pr-1', bindingRevision: 2 };
const event: PeriodicTaskTimerEvent = {
  kind: 'timer_due',
  executionId: 'execution-1',
  periodicTaskId: 'task-1',
  projectId: 'project-1',
  name: 'Scheduled task',
  prompt: 'Check the repository',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sessionPorts(): ExistingSessionDispatchPorts {
  return {
    enqueue: vi.fn(() => ({ queued: true })),
    wakeSession: vi.fn(async () => undefined),
    logger: { warn: vi.fn() },
  };
}

describe('dispatchBackgroundAction', () => {
  it('enqueues the entire batch before waking each unique recipient once', async () => {
    const operations: string[] = [];
    const ports = sessionPorts();
    ports.enqueue = (sessionId, queuedRequest) => {
      operations.push(`enqueue:${sessionId}:${queuedRequest.prId}`);
      return { queued: true };
    };
    ports.wakeSession = (sessionId) => {
      operations.push(`wake:${sessionId}`);
      return Promise.resolve();
    };

    await expect(
      dispatchBackgroundAction(
        {
          target: 'existing_sessions',
          deliveries: [
            { sessionId: 'main', request },
            { sessionId: 'dedicated', request },
            { sessionId: 'main', request: { ...request, prId: 'pr-2' } },
          ],
        },
        ports
      )
    ).resolves.toEqual({ status: 'queued', queuedCount: 3 });
    expect(operations).toEqual([
      'enqueue:main:pr-1',
      'enqueue:dedicated:pr-1',
      'enqueue:main:pr-2',
      'wake:main',
      'wake:dedicated',
    ]);
  });

  it('returns queue admission while wakes remain pending and logs a later rejection', async () => {
    const wake = deferred<void>();
    const ports = sessionPorts();
    ports.wakeSession = () => wake.promise;
    await expect(
      dispatchBackgroundAction(
        { target: 'existing_sessions', deliveries: [{ sessionId: 'main', request }] },
        ports
      )
    ).resolves.toEqual({ status: 'queued', queuedCount: 1 });

    const error = new Error('Dispatch unavailable');
    wake.reject(error);
    await Promise.resolve();
    expect(ports.logger.warn).toHaveBeenCalledWith('Background queue dispatch deferred', {
      sessionId: 'main',
      error,
    });
  });

  it('counts only admitted queue requests while preserving the recipient wake', async () => {
    const ports = sessionPorts();
    ports.enqueue = () => ({ queued: false, reason: 'Session is unavailable' });
    await expect(
      dispatchBackgroundAction(
        { target: 'existing_sessions', deliveries: [{ sessionId: 'main', request }] },
        ports
      )
    ).resolves.toEqual({ status: 'queued', queuedCount: 0 });
    expect(ports.wakeSession).toHaveBeenCalledExactlyOnceWith('main');
  });

  it('does not wake any recipient for an empty batch', async () => {
    const ports = sessionPorts();
    await expect(
      dispatchBackgroundAction({ target: 'existing_sessions', deliveries: [] }, ports)
    ).resolves.toEqual({ status: 'queued', queuedCount: 0 });
    expect(ports.wakeSession).not.toHaveBeenCalled();
  });

  it('awaits PERIODIC_TASK launch and returns the launched workspace ID', async () => {
    const launch = deferred<{ workspace: { id: string } }>();
    const launchWorkspace = vi.fn(() => launch.promise);
    let settled = false;
    const dispatched = dispatchBackgroundAction(
      { target: 'new_workspace', event },
      { launchWorkspace }
    );
    void dispatched.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    expect(launchWorkspace).toHaveBeenCalledExactlyOnceWith({
      type: 'PERIODIC_TASK',
      projectId: 'project-1',
      name: 'Scheduled task',
      periodicTaskId: 'task-1',
      initialPrompt: 'Check the repository',
      ratchetEnabled: true,
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    launch.resolve({ workspace: { id: 'workspace-1' } });
    await expect(dispatched).resolves.toEqual({ status: 'launched', workspaceId: 'workspace-1' });
  });

  it('propagates launch failure to the timer reservation owner', async () => {
    const error = new Error('Launch failed');
    await expect(
      dispatchBackgroundAction(
        { target: 'new_workspace', event },
        {
          launchWorkspace: () => Promise.reject(error),
        }
      )
    ).rejects.toBe(error);
  });
});
