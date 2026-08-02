import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createVoiceSoftStopHandler } from './voice-soft-stop.handler';

function createDeps() {
  return {
    acpRuntimeManager: { cancelPrompt: vi.fn().mockResolvedValue(true) },
    sessionDataService: { findAgentSessionById: vi.fn() },
    sessionLifecycleEventService: { record: vi.fn().mockResolvedValue(null) },
    logger: { info: vi.fn() },
  };
}

describe('createVoiceSoftStopHandler', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('cancels the in-flight prompt via cancelPrompt, not a full session stop', async () => {
    const deps = createDeps();
    deps.sessionDataService.findAgentSessionById.mockResolvedValue({
      workspaceId: 'ws-1',
    });
    const handleSoftStop = createVoiceSoftStopHandler(deps);

    await handleSoftStop('session-1');

    expect(deps.acpRuntimeManager.cancelPrompt).toHaveBeenCalledWith('session-1');
    expect(deps.acpRuntimeManager.cancelPrompt).toHaveBeenCalledTimes(1);
  });

  it('records a TURN_INTERRUPTED/VOICE_INTERRUPT lifecycle event when the session has a workspace', async () => {
    const deps = createDeps();
    deps.sessionDataService.findAgentSessionById.mockResolvedValue({
      workspaceId: 'ws-1',
    });
    const handleSoftStop = createVoiceSoftStopHandler(deps);

    await handleSoftStop('session-1');

    expect(deps.sessionLifecycleEventService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        sessionId: 'session-1',
        kind: 'TURN_INTERRUPTED',
        reason: 'VOICE_INTERRUPT',
      })
    );
  });

  it('skips recording when no prompt was actually in flight to cancel', async () => {
    const deps = createDeps();
    deps.acpRuntimeManager.cancelPrompt.mockResolvedValue(false);
    deps.sessionDataService.findAgentSessionById.mockResolvedValue({ workspaceId: 'ws-1' });
    const handleSoftStop = createVoiceSoftStopHandler(deps);

    await handleSoftStop('session-idle');

    expect(deps.sessionDataService.findAgentSessionById).not.toHaveBeenCalled();
    expect(deps.sessionLifecycleEventService.record).not.toHaveBeenCalled();
  });

  it('cancels the prompt even when the session cannot be found, but skips recording', async () => {
    const deps = createDeps();
    deps.sessionDataService.findAgentSessionById.mockResolvedValue(null);
    const handleSoftStop = createVoiceSoftStopHandler(deps);

    await handleSoftStop('session-missing');

    expect(deps.acpRuntimeManager.cancelPrompt).toHaveBeenCalledWith('session-missing');
    expect(deps.sessionLifecycleEventService.record).not.toHaveBeenCalled();
  });

  it('cancels the prompt before looking up the session, so a slow lookup never delays the interrupt', async () => {
    const deps = createDeps();
    const callOrder: string[] = [];
    deps.acpRuntimeManager.cancelPrompt.mockImplementation(() => {
      callOrder.push('cancelPrompt');
      return Promise.resolve(true);
    });
    deps.sessionDataService.findAgentSessionById.mockImplementation(() => {
      callOrder.push('findAgentSessionById');
      return Promise.resolve({ workspaceId: 'ws-1' });
    });
    const handleSoftStop = createVoiceSoftStopHandler(deps);

    await handleSoftStop('session-1');

    expect(callOrder).toEqual(['cancelPrompt', 'findAgentSessionById']);
  });

  it('produces a distinct dedupeKey per call so repeated soft_stops each record their own event', async () => {
    const deps = createDeps();
    deps.sessionDataService.findAgentSessionById.mockResolvedValue({ workspaceId: 'ws-1' });
    const handleSoftStop = createVoiceSoftStopHandler(deps);

    await handleSoftStop('session-1');
    await new Promise((resolve) => setTimeout(resolve, 2));
    await handleSoftStop('session-1');

    const [firstCall, secondCall] = deps.sessionLifecycleEventService.record.mock.calls;
    expect(firstCall?.[0].dedupeKey).not.toEqual(secondCall?.[0].dedupeKey);
  });
});
