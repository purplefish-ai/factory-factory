import { describe, expect, it, vi } from 'vitest';
import { AcpNativeSessionTracker } from '@/backend/services/session/service/acp/acp-native-session-tracker';
import { SessionDomainService } from '@/backend/services/session/service/session-domain.service';

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getCurrentProcessEnv: () => ({ ...process.env }),
}));

vi.mock('@/backend/interceptors/registry', () => ({
  interceptorRegistry: {
    notifyToolStart: vi.fn(),
    notifyToolComplete: vi.fn(),
  },
}));

vi.mock('@/backend/services/session/service/logging/acp-trace-logger.service', () => ({
  acpTraceLogger: { log: vi.fn() },
}));

vi.mock('@/backend/services/session/service/logging/session-file-logger.service', () => ({
  sessionFileLogger: { log: vi.fn() },
}));

import type { AcpEventProcessorDependencies } from './acp-event-processor';
import { AcpEventProcessor } from './acp-event-processor';

function makeDeps(): AcpEventProcessorDependencies {
  return {
    runtimeManager: {
      getClient: vi.fn(),
      isSessionWorking: vi.fn().mockReturnValue(true),
    } as unknown as AcpEventProcessorDependencies['runtimeManager'],
    sessionDomainService: {
      getRuntimeSnapshot: vi.fn().mockReturnValue({ phase: 'idle' }),
      setRuntimeSnapshot: vi.fn(),
      emitDelta: vi.fn(),
      appendClaudeEvent: vi.fn(),
      upsertClaudeEvent: vi.fn(),
      allocateOrder: vi.fn(),
    } as unknown as AcpEventProcessorDependencies['sessionDomainService'],
    sessionPermissionService: {
      createPermissionBridge: vi.fn().mockReturnValue({ cancelAll: vi.fn() }),
      handlePermissionRequest: vi.fn(),
    } as unknown as AcpEventProcessorDependencies['sessionPermissionService'],
    sessionConfigService: {
      applyConfigOptionsUpdateDelta: vi.fn(),
    } as unknown as AcpEventProcessorDependencies['sessionConfigService'],
    onToolCallTimeout: vi.fn(),
  };
}

describe('AcpEventProcessor sub-agent invalidations', () => {
  it.each([true, false])(
    'preserves a terminal prompt error when task activity changes to %s',
    (active) => {
      const deps = makeDeps();
      vi.mocked(deps.sessionDomainService.getRuntimeSnapshot).mockReturnValue({
        phase: 'error',
        processState: 'alive',
        activity: 'IDLE',
        errorMessage: 'Selected model is at capacity.',
        updatedAt: '2026-10-28T14:26:26.000Z',
      });
      const markRunning = vi.fn();
      const markIdle = vi.fn();
      Object.assign(deps.sessionDomainService, { markRunning, markIdle });
      const { onAcpEvent } = new AcpEventProcessor(deps).createRuntimeEventHandler('db-session-1');

      onAcpEvent?.('db-session-1', { type: 'acp_task_status_changed', active });

      expect(markRunning).not.toHaveBeenCalled();
      expect(markIdle).not.toHaveBeenCalled();
    }
  );
  it.each([false, true])(
    'refreshes background work after task completion with a failed turn: %s',
    (failed) => {
      const deps = makeDeps();
      const domain = new SessionDomainService();
      deps.sessionDomainService = domain;
      const processor = new AcpEventProcessor(deps);
      const { onAcpEvent } = processor.createRuntimeEventHandler('db-session-1');
      const tracker = new AcpNativeSessionTracker({
        onTaskStatusChanged: (active) => {
          vi.mocked(deps.runtimeManager.isSessionWorking).mockReturnValue(active);
          onAcpEvent?.('db-session-1', { type: 'acp_task_status_changed', active });
        },
      });
      vi.mocked(deps.runtimeManager.getClient).mockReturnValue({
        isPromptInFlight: false,
        nativeSessionTracker: tracker,
      } as never);
      const taskUpdate = (update: Record<string, unknown>) =>
        tracker.onRawMessage({
          method: 'session/update',
          params: { sessionId: 'root', update },
        });
      taskUpdate({
        sessionUpdate: 'async_task_spawned',
        asyncTaskId: 'preview',
        name: 'pnpm storybook',
        taskType: 'shell',
      });
      const work = {
        promptInFlight: false,
        backgroundTasks: [{ id: '["root","preview"]', name: 'pnpm storybook', kind: 'shell' }],
        runningSubagents: 0,
        activeGoals: 0,
      };
      expect(domain.getRuntimeSnapshot('db-session-1').work).toEqual(work);
      const reloaded = domain.prepareLoad(
        'db-session-1',
        domain.getRuntimeSnapshot('db-session-1')
      );
      expect(reloaded.sessionRuntime.work).toEqual(work);
      expect(reloaded.replayEvents).toContainEqual(
        expect.objectContaining({
          type: 'session_runtime_snapshot',
          sessionRuntime: expect.objectContaining({ work }),
        })
      );
      if (failed) {
        domain.setRuntimeSnapshot('db-session-1', {
          ...domain.getRuntimeSnapshot('db-session-1'),
          phase: 'error',
          activity: 'IDLE',
          errorMessage: 'Selected model is at capacity.',
        });
      }
      taskUpdate({
        sessionUpdate: 'async_task_state_update',
        asyncTaskId: 'preview',
        state: 'completed',
      });
      expect(domain.getRuntimeSnapshot('db-session-1')).toMatchObject({ activity: 'IDLE' });
      if (failed) {
        expect(domain.getRuntimeSnapshot('db-session-1')).toMatchObject({
          phase: 'error',
          errorMessage: 'Selected model is at capacity.',
          work: { backgroundTasks: [], promptInFlight: false },
        });
      } else {
        expect(domain.getRuntimeSnapshot('db-session-1').work).toBeUndefined();
      }
    }
  );

  it('publishes runtime changes when task activity starts and stops', () => {
    const deps = makeDeps();
    const isSessionWorking = deps.runtimeManager.isSessionWorking as ReturnType<typeof vi.fn>;
    isSessionWorking.mockReturnValue(false);
    const markRunning = vi.fn();
    const markIdle = vi.fn();
    Object.assign(deps.sessionDomainService, { markRunning, markIdle });
    const processor = new AcpEventProcessor(deps);
    const { onAcpEvent } = processor.createRuntimeEventHandler('db-session-1');
    if (!onAcpEvent) {
      throw new Error('Expected an ACP runtime event handler');
    }

    onAcpEvent('db-session-1', { type: 'acp_task_status_changed', active: true });
    onAcpEvent('db-session-1', { type: 'acp_task_status_changed', active: false });

    expect(markRunning).toHaveBeenCalledWith('db-session-1');
    expect(markIdle).toHaveBeenCalledWith('db-session-1', 'alive');
  });

  it('keeps a session running when a task stops during an in-flight prompt', () => {
    const deps = makeDeps();
    vi.mocked(deps.runtimeManager.isSessionWorking).mockReturnValue(true);
    const markRunning = vi.fn();
    const markIdle = vi.fn();
    Object.assign(deps.sessionDomainService, { markRunning, markIdle });
    const processor = new AcpEventProcessor(deps);
    const { onAcpEvent } = processor.createRuntimeEventHandler('db-session-1');
    if (!onAcpEvent) {
      throw new Error('Expected an ACP runtime event handler');
    }

    onAcpEvent('db-session-1', { type: 'acp_task_status_changed', active: false });

    expect(markRunning).toHaveBeenCalledWith('db-session-1');
    expect(markIdle).not.toHaveBeenCalled();
  });

  it('marks an active task running before the runtime handle is installed', () => {
    const deps = makeDeps();
    vi.mocked(deps.runtimeManager.isSessionWorking).mockReturnValue(false);
    const markRunning = vi.fn();
    const markIdle = vi.fn();
    Object.assign(deps.sessionDomainService, { markRunning, markIdle });
    const processor = new AcpEventProcessor(deps);
    const { onAcpEvent } = processor.createRuntimeEventHandler('db-session-1');
    if (!onAcpEvent) {
      throw new Error('Expected an ACP runtime event handler');
    }

    onAcpEvent('db-session-1', { type: 'acp_task_status_changed', active: true });

    expect(markRunning).toHaveBeenCalledWith('db-session-1');
    expect(markIdle).not.toHaveBeenCalled();
  });

  it('publishes one ephemeral session delta without creating transcript state', () => {
    const deps = makeDeps();
    const processor = new AcpEventProcessor(deps);
    const { onAcpEvent } = processor.createRuntimeEventHandler('db-session-1');
    if (!onAcpEvent) {
      throw new Error('Expected an ACP runtime event handler');
    }

    onAcpEvent('db-session-1', {
      type: 'acp_subagents_changed',
      subagentId: 'child-1',
      change: 'completed',
    });

    expect(deps.sessionDomainService.emitDelta).toHaveBeenCalledOnce();
    expect(deps.sessionDomainService.emitDelta).toHaveBeenCalledWith('db-session-1', {
      type: 'subagents_changed',
      sessionId: 'db-session-1',
      subagentId: 'child-1',
      change: 'completed',
    });
    expect(deps.sessionDomainService.appendClaudeEvent).not.toHaveBeenCalled();
    expect(deps.sessionDomainService.upsertClaudeEvent).not.toHaveBeenCalled();
  });
});
