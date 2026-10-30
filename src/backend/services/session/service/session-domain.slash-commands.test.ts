import { afterEach, expect, it, vi } from 'vitest';
import { sessionDomainService } from './session-domain.service';
import { sessionEventBus } from './session-event-bus';

afterEach(() => {
  sessionDomainService.clearAllSessions();
  vi.restoreAllMocks();
});

it('publishes empty slash commands to the stopped conversation without clearing another session', () => {
  const publish = vi.spyOn(sessionEventBus, 'publishToSession').mockImplementation(() => undefined);
  sessionDomainService.markIdle('account-a', 'alive');
  sessionDomainService.markIdle('account-b', 'alive');
  sessionDomainService.emitDelta('account-a', {
    type: 'slash_commands',
    slashCommands: [{ name: '/a', description: 'A' }],
  });
  sessionDomainService.emitDelta('account-b', {
    type: 'slash_commands',
    slashCommands: [{ name: '/b', description: 'B' }],
  });
  publish.mockClear();
  sessionDomainService.markProcessExit('account-a', 0);
  expect(publish).toHaveBeenCalledWith('account-a', {
    type: 'session_delta',
    data: { type: 'slash_commands', slashCommands: [] },
  });
  expect(publish.mock.calls.every(([id]) => id === 'account-a')).toBe(true);
  expect(
    sessionDomainService.prepareLoad('account-b', {
      phase: 'idle',
      processState: 'alive',
      activity: 'IDLE',
      updatedAt: new Date().toISOString(),
    }).replayEvents
  ).toContainEqual({
    type: 'slash_commands',
    slashCommands: [{ name: '/b', description: 'B' }],
  });
});
