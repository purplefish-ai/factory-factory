import { afterEach, expect, it, vi } from 'vitest';
import type { AgentSessionRecord } from '@/backend/services/session';
import { recipientCanDispatch } from './pr-delivery-readiness';
const otherSession: AgentSessionRecord = {
  id: 'other',
  workspaceId: 'w',
  name: null,
  workflow: 'implement',
  model: 'gpt-6.1-sol',
  status: 'RUNNING',
  provider: 'CODEX',
  providerSessionId: 'provider-other',
  providerProjectPath: null,
  providerProcessPid: null,
  providerMetadata: null,
  createdAt: new Date('2026-10-28T00:00:00Z'),
  updatedAt: new Date('2026-10-28T00:00:00Z'),
};
afterEach(() => vi.useRealTimers());
it('allows PR work when another conversation only has background activity', async () => {
  const services = {
    sessionDataService: { findAgentSessionsByWorkspaceId: vi.fn(async () => [otherSession]) },
    acpRuntimeManager: {
      isSessionWorking: () => true,
      isSessionPromptInFlight: () => false,
    },
  };
  expect(await recipientCanDispatch('w', 'main', services)).toBe(true);
});
it('fails closed within five seconds when the recipient lookup stalls', async () => {
  vi.useFakeTimers();
  const services = {
    acpRuntimeManager: { isSessionPromptInFlight: vi.fn(() => false) },
    sessionDataService: {
      findAgentSessionsByWorkspaceId: vi.fn(
        () =>
          new Promise<never>(() => {
            /* Simulate a stalled query. */
          })
      ),
    },
  };
  const pending = recipientCanDispatch('w', 'main', services);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await pending).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it('fails closed on query failure and blocks another working session', async () => {
  const query = vi
    .fn()
    .mockRejectedValueOnce(new Error('database unavailable'))
    .mockResolvedValueOnce([otherSession]);
  const services = {
    sessionDataService: {
      findAgentSessionsByWorkspaceId: query,
    },
    acpRuntimeManager: {
      isSessionPromptInFlight: vi.fn(() => true),
    },
  };
  expect(await recipientCanDispatch('w', 'main', services)).toBe(false);
  expect(await recipientCanDispatch('w', 'main', services)).toBe(false);
});
