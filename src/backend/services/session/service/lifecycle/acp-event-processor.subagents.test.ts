import { describe, expect, it, vi } from 'vitest';

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
