import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoIterationStatus, SessionStatus } from '@/shared/core';
import {
  type AutoIterationSessionPorts,
  createAutoIterationSessionBridge,
} from './auto-iteration-session.orchestrator';

const sessionDataService = {
  createAgentSession:
    vi.fn<AutoIterationSessionPorts['sessionDataService']['createAgentSession']>(),
  deleteAgentSession:
    vi.fn<AutoIterationSessionPorts['sessionDataService']['deleteAgentSession']>(),
  updateAgentSession:
    vi.fn<AutoIterationSessionPorts['sessionDataService']['updateAgentSession']>(),
};
const sessionLifecycleService = {
  startSession: vi.fn<AutoIterationSessionPorts['sessionLifecycleService']['startSession']>(),
  stopSession: vi.fn<AutoIterationSessionPorts['sessionLifecycleService']['stopSession']>(),
};
const sessionDomainService = {
  clearSession: vi.fn<AutoIterationSessionPorts['sessionDomainService']['clearSession']>(),
  getTranscriptSnapshot:
    vi.fn<AutoIterationSessionPorts['sessionDomainService']['getTranscriptSnapshot']>(),
};
const sessionService = {
  sendAcpMessage: vi.fn<AutoIterationSessionPorts['sessionService']['sendAcpMessage']>(),
};
const workspaceAutoIterationService = {
  getExecutionContext:
    vi.fn<AutoIterationSessionPorts['workspaceAutoIterationService']['getExecutionContext']>(),
  setSession: vi.fn<AutoIterationSessionPorts['workspaceAutoIterationService']['setSession']>(),
  finishSessionIfMatching:
    vi.fn<AutoIterationSessionPorts['workspaceAutoIterationService']['finishSessionIfMatching']>(),
};
const ports = {
  sessionDataService,
  sessionLifecycleService,
  sessionDomainService,
  sessionService,
  workspaceAutoIterationService,
} satisfies AutoIterationSessionPorts;

beforeEach(() => {
  vi.resetAllMocks();
});

describe('createAutoIterationSessionBridge', () => {
  it('rolls back a created session when initial runtime startup fails', async () => {
    const startupError = new Error('runtime failed to start');
    vi.mocked(sessionDataService.createAgentSession).mockResolvedValue({
      id: 'new-session',
    } as Awaited<ReturnType<typeof sessionDataService.createAgentSession>>);
    vi.mocked(sessionLifecycleService.startSession).mockRejectedValueOnce(startupError);

    const sessionBridge = createAutoIterationSessionBridge(ports);

    await expect(
      sessionBridge.startSession('ws-1', {
        initialPrompt: 'start prompt',
        startupModePreset: 'non_interactive',
      })
    ).rejects.toThrow(startupError);

    expect(sessionLifecycleService.stopSession).toHaveBeenCalledWith('new-session', {
      recordLifecycleEvent: false,
    });
    expect(sessionDomainService.clearSession).toHaveBeenCalledWith('new-session');
    expect(sessionDataService.deleteAgentSession).toHaveBeenCalledWith('new-session');
  });

  it('retires the stopped predecessor after a successful recycle', async () => {
    vi.mocked(workspaceAutoIterationService.getExecutionContext).mockResolvedValue({
      autoIterationSessionId: 'old-session',
    } as Awaited<ReturnType<typeof workspaceAutoIterationService.getExecutionContext>>);
    vi.mocked(sessionDataService.createAgentSession).mockResolvedValue({
      id: 'new-session',
    } as Awaited<ReturnType<typeof sessionDataService.createAgentSession>>);

    const sessionBridge = createAutoIterationSessionBridge(ports);

    await expect(sessionBridge.recycleSession('ws-1', 'handoff prompt')).resolves.toBe(
      'new-session'
    );

    expect(sessionDataService.updateAgentSession).toHaveBeenCalledWith('old-session', {
      status: SessionStatus.COMPLETED,
      providerProcessPid: null,
    });
    expect(vi.mocked(sessionService.sendAcpMessage).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sessionDataService.updateAgentSession).mock.invocationCallOrder[0]!
    );
    expect(workspaceAutoIterationService.finishSessionIfMatching).not.toHaveBeenCalled();
  });

  it('keeps the replacement active when predecessor retirement fails after handoff', async () => {
    vi.mocked(workspaceAutoIterationService.getExecutionContext).mockResolvedValue({
      autoIterationSessionId: 'old-session',
    } as Awaited<ReturnType<typeof workspaceAutoIterationService.getExecutionContext>>);
    vi.mocked(sessionDataService.createAgentSession).mockResolvedValue({
      id: 'new-session',
    } as Awaited<ReturnType<typeof sessionDataService.createAgentSession>>);
    vi.mocked(sessionDataService.updateAgentSession).mockRejectedValueOnce(
      new Error('predecessor retirement failed')
    );

    const sessionBridge = createAutoIterationSessionBridge(ports);

    await expect(sessionBridge.recycleSession('ws-1', 'handoff prompt')).resolves.toBe(
      'new-session'
    );

    expect(sessionService.sendAcpMessage).toHaveBeenCalledWith('new-session', [
      { type: 'text', text: 'handoff prompt' },
    ]);
    expect(sessionLifecycleService.stopSession).not.toHaveBeenCalledWith('new-session');
    expect(sessionDomainService.clearSession).not.toHaveBeenCalledWith('new-session');
    expect(sessionDataService.deleteAgentSession).not.toHaveBeenCalledWith('new-session');
    expect(workspaceAutoIterationService.finishSessionIfMatching).not.toHaveBeenCalled();
  });

  it('rolls back a recycled session when replacement startup fails', async () => {
    const startupError = new Error('runtime failed to start');
    vi.mocked(workspaceAutoIterationService.getExecutionContext).mockResolvedValue({
      autoIterationSessionId: 'old-session',
    } as Awaited<ReturnType<typeof workspaceAutoIterationService.getExecutionContext>>);
    vi.mocked(workspaceAutoIterationService.finishSessionIfMatching)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    vi.mocked(sessionDataService.createAgentSession).mockResolvedValue({
      id: 'new-session',
    } as Awaited<ReturnType<typeof sessionDataService.createAgentSession>>);
    vi.mocked(sessionLifecycleService.startSession).mockRejectedValueOnce(startupError);

    const sessionBridge = createAutoIterationSessionBridge(ports);

    await expect(sessionBridge.recycleSession('ws-1', 'handoff prompt')).rejects.toThrow(
      startupError
    );

    expect(sessionLifecycleService.stopSession).toHaveBeenCalledWith('old-session');
    expect(sessionLifecycleService.stopSession).toHaveBeenCalledWith('new-session', {
      recordLifecycleEvent: false,
    });
    expect(sessionDomainService.clearSession).toHaveBeenCalledWith('new-session');
    expect(sessionDataService.deleteAgentSession).toHaveBeenCalledWith('new-session');
    expect(sessionDataService.updateAgentSession).toHaveBeenCalledWith('old-session', {
      status: SessionStatus.COMPLETED,
      providerProcessPid: null,
    });
    expect(workspaceAutoIterationService.finishSessionIfMatching).toHaveBeenCalledWith(
      'ws-1',
      'new-session',
      AutoIterationStatus.FAILED
    );
    expect(workspaceAutoIterationService.finishSessionIfMatching).toHaveBeenCalledWith(
      'ws-1',
      'old-session',
      AutoIterationStatus.FAILED
    );
    expect(workspaceAutoIterationService.setSession).not.toHaveBeenCalled();
    expect(sessionService.sendAcpMessage).not.toHaveBeenCalled();
  });

  it('retires the stopped predecessor when replacement creation fails', async () => {
    const creationError = new Error('session row creation failed');
    vi.mocked(workspaceAutoIterationService.getExecutionContext).mockResolvedValue({
      autoIterationSessionId: 'old-session',
    } as Awaited<ReturnType<typeof workspaceAutoIterationService.getExecutionContext>>);
    vi.mocked(workspaceAutoIterationService.finishSessionIfMatching).mockResolvedValueOnce(true);
    vi.mocked(sessionDataService.createAgentSession).mockRejectedValueOnce(creationError);

    const sessionBridge = createAutoIterationSessionBridge(ports);

    await expect(sessionBridge.recycleSession('ws-1', 'handoff prompt')).rejects.toThrow(
      creationError
    );

    expect(sessionLifecycleService.stopSession).toHaveBeenCalledWith('old-session');
    expect(sessionDataService.updateAgentSession).toHaveBeenCalledWith('old-session', {
      status: SessionStatus.COMPLETED,
      providerProcessPid: null,
    });
    expect(workspaceAutoIterationService.finishSessionIfMatching).toHaveBeenCalledWith(
      'ws-1',
      'old-session',
      AutoIterationStatus.FAILED
    );
    expect(sessionLifecycleService.startSession).not.toHaveBeenCalled();
    expect(sessionDataService.deleteAgentSession).not.toHaveBeenCalled();
  });

  it('clears the stopped predecessor when replacement pointer persistence fails', async () => {
    const persistenceError = new Error('pointer update failed');
    vi.mocked(workspaceAutoIterationService.getExecutionContext).mockResolvedValue({
      autoIterationSessionId: 'old-session',
    } as Awaited<ReturnType<typeof workspaceAutoIterationService.getExecutionContext>>);
    vi.mocked(workspaceAutoIterationService.finishSessionIfMatching)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    vi.mocked(workspaceAutoIterationService.setSession).mockRejectedValueOnce(persistenceError);
    vi.mocked(sessionDataService.createAgentSession).mockResolvedValue({
      id: 'new-session',
    } as Awaited<ReturnType<typeof sessionDataService.createAgentSession>>);

    const sessionBridge = createAutoIterationSessionBridge(ports);

    await expect(sessionBridge.recycleSession('ws-1', 'handoff prompt')).rejects.toThrow(
      persistenceError
    );

    expect(sessionDomainService.clearSession).toHaveBeenCalledWith('new-session');
    expect(sessionDataService.deleteAgentSession).toHaveBeenCalledWith('new-session');
    expect(sessionDataService.updateAgentSession).toHaveBeenCalledWith('old-session', {
      status: SessionStatus.COMPLETED,
      providerProcessPid: null,
    });
    expect(workspaceAutoIterationService.finishSessionIfMatching).toHaveBeenCalledWith(
      'ws-1',
      'new-session',
      AutoIterationStatus.FAILED
    );
    expect(workspaceAutoIterationService.finishSessionIfMatching).toHaveBeenCalledWith(
      'ws-1',
      'old-session',
      AutoIterationStatus.FAILED
    );
    expect(sessionService.sendAcpMessage).not.toHaveBeenCalled();
  });

  it('cleans up a recycled session when handoff send fails', async () => {
    const sendError = new Error('prompt failed');
    vi.mocked(workspaceAutoIterationService.getExecutionContext).mockResolvedValue({
      autoIterationSessionId: 'old-session',
    } as Awaited<ReturnType<typeof workspaceAutoIterationService.getExecutionContext>>);
    vi.mocked(workspaceAutoIterationService.finishSessionIfMatching).mockResolvedValueOnce(true);
    vi.mocked(sessionDataService.createAgentSession).mockResolvedValue({
      id: 'new-session',
    } as Awaited<ReturnType<typeof sessionDataService.createAgentSession>>);
    vi.mocked(sessionService.sendAcpMessage).mockRejectedValue(sendError);

    const sessionBridge = createAutoIterationSessionBridge(ports);

    await expect(sessionBridge.recycleSession('ws-1', 'handoff prompt')).rejects.toThrow(sendError);

    expect(sessionLifecycleService.stopSession).toHaveBeenCalledWith('old-session');
    expect(sessionLifecycleService.startSession).toHaveBeenCalledWith('new-session', {
      startupModePreset: 'non_interactive',
    });
    expect(workspaceAutoIterationService.setSession).toHaveBeenCalledWith('ws-1', 'new-session');
    expect(sessionService.sendAcpMessage).toHaveBeenCalledWith('new-session', [
      { type: 'text', text: 'handoff prompt' },
    ]);
    expect(sessionLifecycleService.stopSession).toHaveBeenCalledWith('new-session', {
      recordLifecycleEvent: false,
    });
    expect(sessionDomainService.clearSession).toHaveBeenCalledWith('new-session');
    expect(sessionDataService.deleteAgentSession).toHaveBeenCalledWith('new-session');
    expect(sessionDataService.updateAgentSession).toHaveBeenCalledWith('old-session', {
      status: SessionStatus.COMPLETED,
      providerProcessPid: null,
    });
    expect(workspaceAutoIterationService.finishSessionIfMatching).toHaveBeenCalledWith(
      'ws-1',
      'new-session',
      AutoIterationStatus.FAILED
    );
    expect(workspaceAutoIterationService.finishSessionIfMatching).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(workspaceAutoIterationService.finishSessionIfMatching).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(sessionDataService.deleteAgentSession).mock.invocationCallOrder[0]!);
    expect(
      vi.mocked(workspaceAutoIterationService.setSession).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(sessionService.sendAcpMessage).mock.invocationCallOrder[0]!);
  });

  it('does not clear a newer auto-iteration session after recycle cleanup', async () => {
    let currentSessionId: string | null = 'old-session';
    vi.mocked(workspaceAutoIterationService.getExecutionContext).mockResolvedValue({
      autoIterationSessionId: 'old-session',
    } as Awaited<ReturnType<typeof workspaceAutoIterationService.getExecutionContext>>);
    vi.mocked(workspaceAutoIterationService.setSession).mockImplementation(
      (_workspaceId, sessionId) => {
        currentSessionId = sessionId;
        return Promise.resolve();
      }
    );
    vi.mocked(workspaceAutoIterationService.finishSessionIfMatching).mockImplementation(
      (_workspaceId, expectedSessionId) => {
        if (currentSessionId !== expectedSessionId) {
          return Promise.resolve(false);
        }
        currentSessionId = null;
        return Promise.resolve(true);
      }
    );
    vi.mocked(sessionDataService.createAgentSession).mockResolvedValue({
      id: 'new-session',
    } as Awaited<ReturnType<typeof sessionDataService.createAgentSession>>);
    vi.mocked(sessionService.sendAcpMessage).mockImplementation(() => {
      // Another loop takes ownership while this handoff is in flight.
      currentSessionId = 'newer-session';
      return Promise.reject(new Error('prompt failed'));
    });

    const sessionBridge = createAutoIterationSessionBridge(ports);

    await expect(sessionBridge.recycleSession('ws-1', 'handoff prompt')).rejects.toThrow(
      'prompt failed'
    );

    expect(sessionLifecycleService.stopSession).toHaveBeenCalledWith('new-session', {
      recordLifecycleEvent: false,
    });
    expect(currentSessionId).toBe('newer-session');
    expect(sessionDomainService.clearSession).toHaveBeenCalledWith('new-session');
    expect(sessionDomainService.clearSession).not.toHaveBeenCalledWith('newer-session');
    expect(sessionDataService.deleteAgentSession).toHaveBeenCalledWith('new-session');
    expect(workspaceAutoIterationService.setSession).toHaveBeenCalledTimes(1);
    expect(workspaceAutoIterationService.finishSessionIfMatching).toHaveBeenCalledWith(
      'ws-1',
      'new-session',
      AutoIterationStatus.FAILED
    );
    expect(workspaceAutoIterationService.finishSessionIfMatching).toHaveBeenCalledWith(
      'ws-1',
      'old-session',
      AutoIterationStatus.FAILED
    );
  });

  it('marks a created session failed when recycle rollback deletion fails', async () => {
    const sendError = new Error('prompt failed');
    vi.mocked(workspaceAutoIterationService.getExecutionContext).mockResolvedValue({
      autoIterationSessionId: 'old-session',
    } as Awaited<ReturnType<typeof workspaceAutoIterationService.getExecutionContext>>);
    vi.mocked(sessionDataService.createAgentSession).mockResolvedValue({
      id: 'new-session',
    } as Awaited<ReturnType<typeof sessionDataService.createAgentSession>>);
    vi.mocked(sessionDataService.deleteAgentSession).mockRejectedValueOnce(
      new Error('delete failed')
    );
    vi.mocked(sessionService.sendAcpMessage).mockRejectedValueOnce(sendError);

    const sessionBridge = createAutoIterationSessionBridge(ports);

    await expect(sessionBridge.recycleSession('ws-1', 'handoff prompt')).rejects.toThrow(sendError);

    expect(sessionDataService.updateAgentSession).toHaveBeenCalledWith('new-session', {
      status: SessionStatus.FAILED,
      providerProcessPid: null,
      providerMetadata: {
        rollbackReason: 'auto_iteration_recycle_failed_after_create',
      },
    });
  });

  it('preserves the handoff error when recycle rollback repair fails', async () => {
    const sendError = new Error('prompt failed');
    vi.mocked(workspaceAutoIterationService.getExecutionContext).mockResolvedValue({
      autoIterationSessionId: 'old-session',
    } as Awaited<ReturnType<typeof workspaceAutoIterationService.getExecutionContext>>);
    vi.mocked(sessionDataService.createAgentSession).mockResolvedValue({
      id: 'new-session',
    } as Awaited<ReturnType<typeof sessionDataService.createAgentSession>>);
    vi.mocked(sessionDataService.deleteAgentSession).mockRejectedValueOnce(
      new Error('delete failed')
    );
    vi.mocked(sessionDataService.updateAgentSession).mockRejectedValueOnce(
      new Error('repair failed')
    );
    vi.mocked(sessionService.sendAcpMessage).mockRejectedValueOnce(sendError);

    const sessionBridge = createAutoIterationSessionBridge(ports);

    await expect(sessionBridge.recycleSession('ws-1', 'handoff prompt')).rejects.toThrow(sendError);

    expect(sessionDataService.updateAgentSession).toHaveBeenCalledWith('new-session', {
      status: SessionStatus.FAILED,
      providerProcessPid: null,
      providerMetadata: {
        rollbackReason: 'auto_iteration_recycle_failed_after_create',
      },
    });
  });

  it('preserves initial startup inputs without writing the loop pointer', async () => {
    sessionDataService.createAgentSession.mockResolvedValue({ id: 'new-session' } as Awaited<
      ReturnType<typeof sessionDataService.createAgentSession>
    >);
    const bridge = createAutoIterationSessionBridge(ports);
    await expect(
      bridge.startSession('ws-1', {
        initialPrompt: 'initial',
        startupModePreset: 'non_interactive',
      })
    ).resolves.toBe('new-session');
    expect(sessionDataService.createAgentSession).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      name: 'Auto-iteration',
      workflow: 'auto-iteration',
    });
    expect(sessionLifecycleService.startSession).toHaveBeenCalledWith('new-session', {
      initialPrompt: 'initial',
      startupModePreset: 'non_interactive',
    });
    expect(workspaceAutoIterationService.setSession).not.toHaveBeenCalled();
    expect(workspaceAutoIterationService.finishSessionIfMatching).not.toHaveBeenCalled();
  });

  it('propagates initial creation failure without attempting runtime cleanup', async () => {
    const error = new Error('cannot create');
    sessionDataService.createAgentSession.mockRejectedValue(error);
    await expect(createAutoIterationSessionBridge(ports).startSession('ws-1', {})).rejects.toBe(
      error
    );
    expect(sessionLifecycleService.startSession).not.toHaveBeenCalled();
    expect(sessionLifecycleService.stopSession).not.toHaveBeenCalled();
    expect(sessionDataService.deleteAgentSession).not.toHaveBeenCalled();
  });

  it('aborts before creating a replacement when stopping the predecessor fails', async () => {
    const error = new Error('provider stop failed');
    workspaceAutoIterationService.getExecutionContext.mockResolvedValue({
      autoIterationSessionId: 'old-session',
    } as Awaited<ReturnType<typeof workspaceAutoIterationService.getExecutionContext>>);
    sessionLifecycleService.stopSession.mockRejectedValue(error);
    await expect(
      createAutoIterationSessionBridge(ports).recycleSession('ws-1', 'handoff')
    ).rejects.toBe(error);
    expect(sessionDataService.createAgentSession).not.toHaveBeenCalled();
    expect(workspaceAutoIterationService.setSession).not.toHaveBeenCalled();
    expect(workspaceAutoIterationService.finishSessionIfMatching).not.toHaveBeenCalled();
    expect(sessionDataService.updateAgentSession).not.toHaveBeenCalled();
  });

  it.each(['already stopped', 'Session not found'])(
    'continues recycling after an ignorable predecessor stop: %s',
    async (message) => {
      workspaceAutoIterationService.getExecutionContext.mockResolvedValue({
        autoIterationSessionId: 'old-session',
      } as Awaited<ReturnType<typeof workspaceAutoIterationService.getExecutionContext>>);
      sessionLifecycleService.stopSession.mockRejectedValueOnce(new Error(message));
      sessionDataService.createAgentSession.mockResolvedValue({ id: 'new-session' } as Awaited<
        ReturnType<typeof sessionDataService.createAgentSession>
      >);
      await expect(
        createAutoIterationSessionBridge(ports).recycleSession('ws-1', 'handoff')
      ).resolves.toBe('new-session');
      expect(workspaceAutoIterationService.setSession).toHaveBeenCalledWith('ws-1', 'new-session');
      expect(workspaceAutoIterationService.finishSessionIfMatching).not.toHaveBeenCalled();
    }
  );

  it('starts a replacement without predecessor cleanup when the execution context is missing', async () => {
    workspaceAutoIterationService.getExecutionContext.mockResolvedValue(null);
    sessionDataService.createAgentSession.mockResolvedValue({ id: 'new-session' } as Awaited<
      ReturnType<typeof sessionDataService.createAgentSession>
    >);
    await expect(
      createAutoIterationSessionBridge(ports).recycleSession('ws-1', 'handoff')
    ).resolves.toBe('new-session');
    expect(sessionLifecycleService.stopSession).not.toHaveBeenCalled();
    expect(sessionDataService.updateAgentSession).not.toHaveBeenCalled();
    expect(workspaceAutoIterationService.setSession).toHaveBeenCalledTimes(1);
  });

  it('preserves the original startup error when every rollback step fails', async () => {
    const original = new Error('startup');
    sessionDataService.createAgentSession.mockResolvedValue({ id: 'new-session' } as Awaited<
      ReturnType<typeof sessionDataService.createAgentSession>
    >);
    sessionLifecycleService.startSession.mockRejectedValue(original);
    sessionLifecycleService.stopSession.mockRejectedValue(new Error('cleanup stop'));
    sessionDomainService.clearSession.mockImplementation(() => {
      throw new Error('clear');
    });
    sessionDataService.deleteAgentSession.mockRejectedValue(new Error('delete'));
    sessionDataService.updateAgentSession.mockRejectedValue(new Error('repair'));
    await expect(createAutoIterationSessionBridge(ports).startSession('ws-1', {})).rejects.toBe(
      original
    );
    expect(sessionDataService.updateAgentSession).toHaveBeenCalledWith('new-session', {
      status: SessionStatus.FAILED,
      providerProcessPid: null,
      providerMetadata: { rollbackReason: 'auto_iteration_startup_failed_after_create' },
    });
  });

  it('preserves the handoff error when both matching-session settlement attempts fail', async () => {
    const original = new Error('handoff');
    workspaceAutoIterationService.getExecutionContext.mockResolvedValue({
      autoIterationSessionId: 'old-session',
    } as Awaited<ReturnType<typeof workspaceAutoIterationService.getExecutionContext>>);
    sessionDataService.createAgentSession.mockResolvedValue({ id: 'new-session' } as Awaited<
      ReturnType<typeof sessionDataService.createAgentSession>
    >);
    sessionService.sendAcpMessage.mockRejectedValue(original);
    workspaceAutoIterationService.finishSessionIfMatching.mockRejectedValue(
      new Error('settlement')
    );
    await expect(
      createAutoIterationSessionBridge(ports).recycleSession('ws-1', 'handoff')
    ).rejects.toBe(original);
    expect(workspaceAutoIterationService.finishSessionIfMatching.mock.calls).toEqual([
      ['ws-1', 'new-session', AutoIterationStatus.FAILED],
      ['ws-1', 'old-session', AutoIterationStatus.FAILED],
    ]);
    expect(sessionDataService.deleteAgentSession).toHaveBeenCalledWith('new-session');
  });

  it('forwards the configured turn timeout and waits for the send to finish', async () => {
    let finish!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      finish = resolve;
    });
    sessionService.sendAcpMessage.mockReturnValue(pending);
    const bridge = createAutoIterationSessionBridge(ports);
    let completed = false;
    const send = bridge.sendPrompt('session', 'prompt', 456).then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(sessionService.sendAcpMessage).toHaveBeenCalledWith(
      'session',
      [{ type: 'text', text: 'prompt' }],
      456,
      { timeoutKind: 'configured' }
    );
    finish('completed');
    await send;
    await bridge.waitForIdle('session');
    expect(completed).toBe(true);
    expect(sessionService.sendAcpMessage).toHaveBeenCalledTimes(1);
  });

  it('returns the most recent assistant text from the transcript', async () => {
    sessionDomainService.getTranscriptSnapshot.mockReturnValue([
      {
        id: 'first',
        source: 'agent',
        timestamp: '2026-10-27T00:00:00Z',
        order: 0,
        message: { type: 'assistant', message: { role: 'assistant', content: 'earlier' } },
      },
      {
        id: 'second',
        source: 'agent',
        timestamp: '2026-10-27T00:00:01Z',
        order: 1,
        message: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'latest ' },
              { type: 'text', text: 'answer' },
            ],
          },
        },
      },
      {
        id: 'third',
        source: 'agent',
        timestamp: '2026-10-27T00:00:02Z',
        order: 2,
        message: { type: 'user', message: { role: 'user', content: 'question' } },
      },
    ]);
    const bridge = createAutoIterationSessionBridge(ports);
    await expect(bridge.getLastAssistantMessage('session')).resolves.toBe('latest answer');
    expect(sessionDomainService.getTranscriptSnapshot).toHaveBeenCalledWith('session');
    sessionDomainService.getTranscriptSnapshot.mockReturnValue([
      {
        id: 'first',
        source: 'agent',
        timestamp: '2026-10-27T00:00:00Z',
        order: 0,
        message: { type: 'assistant', message: { role: 'assistant', content: 'earlier' } },
      },
    ]);
    await expect(bridge.getLastAssistantMessage('session')).resolves.toBe('earlier');
    sessionDomainService.getTranscriptSnapshot.mockReturnValue([]);
    await expect(bridge.getLastAssistantMessage('session')).resolves.toBe('');
  });
});
