import { expect, it, vi } from 'vitest';
import { EventSessionAuthority } from '@/backend/services/session/service/lifecycle/event-session-authority';
import type { InitialDeliveryFence } from '@/shared/event-agent-delivery';
import { EventInitialDispatcher } from './event-initial-dispatch';
const attempt = {
  runId: 'run',
  sessionId: 'reserved',
  workerGeneration: 1,
  attemptGeneration: 1,
  messageId: 'original',
  sendAttemptId: 'send',
};
const execution = {
  version: 1 as const,
  provider: 'CLAUDE' as const,
  model: 'sonnet',
  reasoningEffort: 'high',
  codexAccountId: null,
  startupModePreset: 'non_interactive' as const,
  accessMode: 'bypassPermissions',
  planModeEnabled: false as const,
};
it('dispatches the reserved initial turn alone while human input remains fenced through setup and outcome', async () => {
  const state: InitialDeliveryFence = { attempt, execution, state: 'PENDING', evidence: null };
  const authority = new EventSessionAuthority(async (id) =>
    id === 'reserved' ? { runId: 'run', execution } : null
  );
  authority.configure({
    readFence: async () => state,
    beforeSend: async () => undefined,
    outcome: async () => undefined,
    ambiguous: async () => undefined,
    stop: async () => undefined,
  });
  let ready!: () => void;
  const startup = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const send = vi.fn(async (id, text, permit) => {
    expect(id).toBe('reserved');
    expect(text).toBe('frozen task');
    expect(permit.execution).toEqual(execution);
    await expect(authority.assertOrdinary(id)).rejects.toThrow();
    state.state = 'FINISHED';
  });
  const commit = vi.fn();
  const dispatcher = new EventInitialDispatcher({
    authority,
    start: async (id) => {
      expect(id).toBe('reserved');
      await startup;
    },
    send,
    commit,
  });
  const pending = dispatcher.dispatch({
    attempt,
    text: 'frozen task',
    assertCurrent: () => undefined,
  });
  await vi.waitFor(() => expect(authority.assertOrdinary('reserved')).rejects.toThrow());
  expect(send).not.toHaveBeenCalled();
  await expect(
    dispatcher.dispatch({
      attempt: { ...attempt, sessionId: 'extra-idle' },
      text: 'wrong',
      assertCurrent: () => undefined,
    })
  ).rejects.toThrow();
  ready();
  await pending;
  expect(send).toHaveBeenCalledTimes(1);
  expect(commit).toHaveBeenCalledWith(
    'reserved',
    expect.objectContaining({
      id: 'original',
      text: 'frozen task',
      settings: {
        selectedModel: 'sonnet',
        reasoningEffort: 'high',
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    })
  );
  await expect(authority.assertOrdinary('reserved')).resolves.toBeUndefined();
});
