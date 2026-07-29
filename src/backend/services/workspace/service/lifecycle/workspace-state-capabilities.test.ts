import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';
import { workspaceRatchetAccessor } from '@/backend/services/workspace/resources/workspace-ratchet.accessor';
import {
  AUTO_ITERATION_STATUS_CHANGED,
  type AutoIterationStatusChangedEvent,
  workspaceAutoIterationService,
} from './workspace-auto-iteration.service';
import { workspaceRatchetService } from './workspace-ratchet.service';
import { workspaceRunScriptService } from './workspace-run-script.service';

vi.mock('@/backend/services/workspace/resources/workspace.accessor', () => ({
  workspaceAccessor: {
    findAutoIterationExecutionContext: vi.fn(),
    setAutoIterationStatus: vi.fn(),
    findRunScriptExecutionState: vi.fn(),
    findRunScriptExecutionStateOrThrow: vi.fn(),
    finishAutoIterationIfSessionMatches: vi.fn(),
    casRunScriptStatusUpdate: vi.fn(),
    registerInitializedWorktree: vi.fn(),
    setRunScriptCommands: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('@/backend/services/workspace/resources/workspace-ratchet.accessor', () => ({
  workspaceRatchetAccessor: {
    recordDispatchIfEnabled: vi.fn(),
  },
}));

describe('workspace state capabilities', () => {
  beforeEach(() => vi.clearAllMocks());

  // The service is a module singleton, so a listener a failing test never got to
  // remove would keep pushing into that test's array for the rest of the file.
  afterEach(() => workspaceAutoIterationService.removeAllListeners(AUTO_ITERATION_STATUS_CHANGED));

  it('announces a status change so the live snapshot stream does not wait for reconciliation', async () => {
    // `mode` and `autoIterationStatus` are derivation inputs on the snapshot
    // wire. Without this event the store learned about a transition only from
    // the reconciliation sweep, so a running loop could read as waiting between
    // iterations for up to one sweep interval.
    vi.mocked(workspaceAccessor.setAutoIterationStatus).mockResolvedValue({
      mode: 'AUTO_ITERATION',
      status: 'RUNNING',
    });
    const events: AutoIterationStatusChangedEvent[] = [];
    workspaceAutoIterationService.on(
      AUTO_ITERATION_STATUS_CHANGED,
      (event: AutoIterationStatusChangedEvent) => events.push(event)
    );

    await workspaceAutoIterationService.setStatus('ws-1', 'RUNNING');

    expect(events).toEqual([{ workspaceId: 'ws-1', mode: 'AUTO_ITERATION', status: 'RUNNING' }]);
  });

  it('announces the settled status when a matching session finishes the loop', async () => {
    vi.mocked(workspaceAccessor.finishAutoIterationIfSessionMatches).mockResolvedValue({
      settled: true,
      mode: 'AUTO_ITERATION',
    });
    const events: AutoIterationStatusChangedEvent[] = [];
    workspaceAutoIterationService.on(
      AUTO_ITERATION_STATUS_CHANGED,
      (event: AutoIterationStatusChangedEvent) => events.push(event)
    );

    await workspaceAutoIterationService.finishSessionIfMatching('ws-1', 'session-1', 'COMPLETED');

    expect(events).toEqual([{ workspaceId: 'ws-1', mode: 'AUTO_ITERATION', status: 'COMPLETED' }]);
  });

  it('announces nothing when the compare-and-swap settles no loop', async () => {
    vi.mocked(workspaceAccessor.finishAutoIterationIfSessionMatches).mockResolvedValue({
      settled: false,
      mode: null,
    });
    const events: AutoIterationStatusChangedEvent[] = [];
    workspaceAutoIterationService.on(
      AUTO_ITERATION_STATUS_CHANGED,
      (event: AutoIterationStatusChangedEvent) => events.push(event)
    );

    await workspaceAutoIterationService.finishSessionIfMatching('ws-1', 'stale-session', 'FAILED');

    expect(events).toEqual([]);
  });

  it('finishes auto-iteration only when the active session still matches', async () => {
    vi.mocked(workspaceAccessor.finishAutoIterationIfSessionMatches).mockResolvedValue({
      settled: true,
      mode: 'AUTO_ITERATION',
    });

    await expect(
      workspaceAutoIterationService.finishSessionIfMatching('ws-1', 'session-1', 'COMPLETED')
    ).resolves.toBe(true);
    expect(workspaceAccessor.finishAutoIterationIfSessionMatches).toHaveBeenCalledWith(
      'ws-1',
      'session-1',
      'COMPLETED'
    );
  });

  it('reads only the auto-iteration execution context', async () => {
    vi.mocked(workspaceAccessor.findAutoIterationExecutionContext).mockResolvedValue({
      worktreePath: '/tmp/worktree',
      autoIterationSessionId: 'session-1',
    });

    await expect(workspaceAutoIterationService.getExecutionContext('ws-1')).resolves.toEqual({
      worktreePath: '/tmp/worktree',
      autoIterationSessionId: 'session-1',
    });
    expect(workspaceAccessor.findAutoIterationExecutionContext).toHaveBeenCalledWith('ws-1');
  });

  it('reads only run-script execution state', async () => {
    vi.mocked(workspaceAccessor.findRunScriptExecutionState).mockResolvedValue({
      runScriptStatus: 'RUNNING',
      runScriptPid: 123,
      runScriptPort: 3000,
      runScriptStartedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await expect(workspaceRunScriptService.findExecutionState('ws-1')).resolves.toMatchObject({
      runScriptStatus: 'RUNNING',
      runScriptPid: 123,
    });
    expect(workspaceAccessor.findRunScriptExecutionState).toHaveBeenCalledWith('ws-1');
  });

  it('transitions run-script state with compare-and-swap', async () => {
    vi.mocked(workspaceAccessor.casRunScriptStatusUpdate).mockResolvedValue({ count: 1 });

    await expect(
      workspaceRunScriptService.transitionStatusIfCurrent('ws-1', 'IDLE', {
        runScriptStatus: 'STARTING',
      })
    ).resolves.toEqual({ count: 1 });
  });

  it('limits run-script transitions to run-script state fields', async () => {
    vi.mocked(workspaceAccessor.casRunScriptStatusUpdate).mockResolvedValue({ count: 1 });

    await workspaceRunScriptService.transitionStatusIfCurrent('ws-1', 'IDLE', {
      runScriptStatus: 'STARTING',
      runScriptPid: 123,
      name: 'must-not-cross-the-boundary',
    } as never);

    expect(workspaceAccessor.casRunScriptStatusUpdate).toHaveBeenCalledWith('ws-1', 'IDLE', {
      runScriptStatus: 'STARTING',
      runScriptPid: 123,
      runScriptPort: undefined,
      runScriptStartedAt: undefined,
    });
  });

  it('records ratchet dispatch only while ratcheting remains enabled', async () => {
    vi.mocked(workspaceRatchetAccessor.recordDispatchIfEnabled).mockResolvedValue(true);

    await expect(
      workspaceRatchetService.recordDispatchIfEnabled('ws-1', {
        sessionId: 'session-1',
        snapshotKey: 'snapshot-1',
        retryCount: 2,
      })
    ).resolves.toBe(true);
  });

  it('registers an initialized worktree and its run-script commands atomically', async () => {
    vi.mocked(workspaceAccessor.registerInitializedWorktree).mockResolvedValue();

    await workspaceRunScriptService.registerInitializedWorktree('ws-1', {
      worktreePath: '/tmp/worktree',
      branchName: 'feature/task',
      isAutoGeneratedBranch: true,
      runScriptCommand: 'pnpm dev',
      runScriptPostRunCommand: null,
      runScriptCleanupCommand: 'pnpm cleanup',
    });

    // The two halves live in different tables now, so the accessor takes them as
    // separate payloads and writes them in one transaction. The service still
    // takes the flat shape its caller assembles from factory-factory.json.
    expect(workspaceAccessor.registerInitializedWorktree).toHaveBeenCalledWith(
      'ws-1',
      {
        worktreePath: '/tmp/worktree',
        branchName: 'feature/task',
        isAutoGeneratedBranch: true,
      },
      {
        runScriptCommand: 'pnpm dev',
        runScriptPostRunCommand: null,
        runScriptCleanupCommand: 'pnpm cleanup',
      }
    );
    expect(workspaceAccessor.update).not.toHaveBeenCalled();
  });

  it('refreshes the cached commands without touching the workspace row', async () => {
    vi.mocked(workspaceAccessor.setRunScriptCommands).mockResolvedValue();

    await workspaceRunScriptService.setCommands('ws-1', {
      runScriptCommand: 'pnpm dev',
      runScriptPostRunCommand: 'pnpm smoke',
      runScriptCleanupCommand: null,
    });

    expect(workspaceAccessor.setRunScriptCommands).toHaveBeenCalledWith('ws-1', {
      runScriptCommand: 'pnpm dev',
      runScriptPostRunCommand: 'pnpm smoke',
      runScriptCleanupCommand: null,
    });
    expect(workspaceAccessor.update).not.toHaveBeenCalled();
  });
});
