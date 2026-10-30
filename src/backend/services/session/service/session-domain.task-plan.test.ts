import { afterEach, expect, it, vi } from 'vitest';
import { sessionDomainService } from './session-domain.service';
import { sessionEventBus } from './session-event-bus';

afterEach(() => {
  sessionDomainService.clearAllSessions();
  vi.restoreAllMocks();
});

it('includes current tasks in queue snapshots and clears tasks when provider history resets', () => {
  const publish = vi.spyOn(sessionEventBus, 'publishToSession').mockImplementation(() => undefined);
  const taskPlan = {
    type: 'acp_plan',
    entries: [{ content: 'Current work', status: 'in_progress', priority: 'high' }],
  };
  sessionDomainService.emitDelta('codex', {
    type: 'task_notification',
    message: JSON.stringify(taskPlan),
  });
  sessionDomainService.enqueue('codex', {
    id: 'queued',
    text: 'Next message',
    timestamp: '2026-10-30T00:00:00Z',
    settings: {
      selectedModel: null,
      reasoningEffort: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
  });
  expect(publish).toHaveBeenCalledWith(
    'codex',
    expect.objectContaining({ type: 'session_snapshot', taskPlan })
  );
  publish.mockClear();
  sessionDomainService.resetProviderHistory('codex', 'replacement-provider-session');
  expect(publish).toHaveBeenCalledWith(
    'codex',
    expect.objectContaining({ type: 'session_snapshot', taskPlan: null })
  );
});

it('replays the latest task snapshot per session, including an explicit clear', () => {
  const entries = [{ content: 'Ship the change', status: 'in_progress', priority: 'high' }];
  const update = {
    type: 'task_notification' as const,
    message: JSON.stringify({ type: 'acp_plan', entries }),
  };
  sessionDomainService.emitDelta('codex', update);
  sessionDomainService.emitDelta('claude', update);
  const load = (id: string) =>
    sessionDomainService
      .prepareLoad(id, {
        phase: 'idle',
        processState: 'alive',
        activity: 'IDLE',
        updatedAt: '2026-10-30T00:00:00Z',
      })
      .replayEvents.filter((event) => event.type === 'task_notification');
  expect(load('codex')).toEqual([update]);
  const clear = {
    type: 'task_notification' as const,
    message: JSON.stringify({ type: 'acp_plan', entries: [] }),
  };
  sessionDomainService.emitDelta('codex', clear);
  expect(load('codex')).toEqual([clear]);
  expect(load('claude')).toEqual([update]);
  sessionDomainService.emitDelta('claude', {
    type: 'task_notification',
    message: 'Subagent finished',
  });
  sessionDomainService.emitDelta('claude', {
    type: 'task_notification',
    message: JSON.stringify({ type: 'acp_plan', entries: [{ content: {} }] }),
  });
  expect(load('claude')).toEqual([update]);
});
