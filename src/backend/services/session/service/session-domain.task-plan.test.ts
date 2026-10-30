import { afterEach, expect, it } from 'vitest';
import { sessionDomainService } from './session-domain.service';

afterEach(() => sessionDomainService.clearAllSessions());

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
