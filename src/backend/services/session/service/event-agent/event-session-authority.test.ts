import { expect, it } from 'vitest';
import type { InitialDeliveryFence, InitialDeliveryOwnerPort } from '@/shared/event-agent-delivery';
import { EventSessionAuthority } from './event-session-authority';
const attempt = {
  runId: 'run',
  sessionId: 'reserved',
  workerGeneration: 1,
  attemptGeneration: 1,
  messageId: 'initial',
  sendAttemptId: 'send',
};
const execution = {
  version: 1 as const,
  provider: 'CLAUDE' as const,
  model: 'sonnet',
  reasoningEffort: null,
  codexAccountId: null,
  startupModePreset: 'non_interactive' as const,
  accessMode: 'bypassPermissions',
  planModeEnabled: false as const,
};
function harness() {
  const state: InitialDeliveryFence = { attempt, execution, state: 'PENDING', evidence: null };
  const authority = new EventSessionAuthority(async (id) =>
    id === 'reserved' ? { runId: 'run', execution } : null
  );
  const owner: InitialDeliveryOwnerPort = {
    readFence: async () => state,
    beforeSend: async () => undefined,
    outcome: async () => undefined,
    ambiguous: async () => undefined,
    stop: async () => undefined,
  };
  return { state, authority, owner };
}
it('blocks event sessions before observer restoration while preserving legacy sessions', async () => {
  const h = harness();
  await expect(h.authority.assertOrdinary('reserved')).rejects.toThrow();
  await expect(h.authority.assertOrdinary('ordinary')).resolves.toBeUndefined();
});
it.each(['PENDING', 'SENDING', 'ACCEPTED', 'AMBIGUOUS'] as const)(
  'fences %s after resets or manual resume',
  async (state) => {
    const h = harness();
    h.state.state = state;
    h.authority.configure(h.owner);
    await expect(h.authority.assertOrdinary('reserved')).rejects.toThrow();
  }
);
it('allows finished conversations through a durable read after restart', async () => {
  const h = harness();
  h.state.state = 'FINISHED';
  h.authority.configure(h.owner);
  await expect(h.authority.assertOrdinary('reserved')).resolves.toBeUndefined();
});
it('permits only the reserved session, pinned execution and current pending attempt', async () => {
  const h = harness();
  h.authority.configure(h.owner);
  await expect(
    h.authority.runInitial({ ...attempt, sessionId: 'extra-idle' }, async () => undefined)
  ).rejects.toThrow();
  await h.authority.runInitial(attempt, async (permit) => {
    expect(permit.execution).toEqual(execution);
    await h.authority.assertStartup('reserved', permit);
    await expect(h.authority.assertOrdinary('reserved')).rejects.toThrow();
    h.state.attempt = { ...attempt, sendAttemptId: 'rotated' };
    await expect(h.authority.assertStartup('reserved', permit)).rejects.toThrow();
  });
});
it('does not trust forged permits, foreign execution or unavailable durable reads', async () => {
  const h = harness();
  h.authority.configure(h.owner);
  await expect(h.authority.assertStartup('reserved', { attempt, execution })).rejects.toThrow();
  h.state.execution = { ...execution, model: 'opus' };
  await expect(h.authority.runInitial(attempt, async () => undefined)).rejects.toThrow();
  h.owner.readFence = () => Promise.reject(new Error('unavailable'));
  await expect(h.authority.assertOrdinary('reserved')).rejects.toThrow();
});
it('records unexpected exit uncertainty only for the captured provider incarnation', async () => {
  const h = harness();
  h.authority.configure(h.owner);
  h.state.state = 'SENDING';
  h.state.evidence = {
    version: 1,
    attempt,
    source: {
      version: 1,
      provider: 'CLAUDE',
      providerSessionId: 'native',
      runtimeIncarnationId: 'current',
      lifecycleGeneration: 1,
    },
  };
  const stops: unknown[] = [];
  h.owner.stop = (_attempt, stop) => {
    stops.push(stop);
    return Promise.resolve();
  };
  await h.authority.observeUnexpectedExit('reserved', 'old');
  expect(stops).toEqual([]);
  await h.authority.observeUnexpectedExit('reserved', 'current');
  expect(stops).toEqual([expect.objectContaining({ cause: 'UNEXPECTED_EXIT', status: 'UNKNOWN' })]);
});
