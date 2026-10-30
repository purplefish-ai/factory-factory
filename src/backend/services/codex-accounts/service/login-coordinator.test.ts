import { expect, it, vi } from 'vitest';
import { LoginCoordinator } from './login-coordinator';
import type { CodexRuntimeContext, AccountRow } from './types';
it.each(['resolve', 'prepare'] as const)(
  'cancels a stalled %s without waiting for unrelated work',
  async (phase) => {
    const row: AccountRow = {
      id: 'managed',
      kind: 'MANAGED',
      label: 'One',
      identityKey: null,
      enabled: true,
    };
    const context: CodexRuntimeContext = {
      accountId: row.id,
      homeDir: '/unused',
      sessionsDir: '/unused/sessions',
      env: {},
    };
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let signal: AbortSignal | undefined;
    const stalled = (received?: AbortSignal) => {
      signal = received;
      entered();
      return new Promise<never>(() => undefined);
    };
    const login = vi.fn();
    const coordinator = new LoginCoordinator({
      resolve: async (_id, received) =>
        phase === 'resolve' ? stalled(received) : { row, context },
      prepare: async (_id, received) => (phase === 'prepare' ? stalled(received) : undefined),
      probe: vi.fn(),
      verify: vi.fn(),
      login,
      invalidate: vi.fn(),
    });
    const started = coordinator.start(row.id);
    const rejected = expect(started).rejects.toThrow('cancelled');
    await ready;
    const cancelled = coordinator.cancel(row.id);
    await expect(cancelled).resolves.toMatchObject({ status: 'cancelled' });
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(login).not.toHaveBeenCalled();
  }
);
