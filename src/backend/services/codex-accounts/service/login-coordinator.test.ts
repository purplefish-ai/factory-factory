import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

it('reports a finished login only after releasing the account', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ff-login-coordinator-'));
  try {
    const home = join(base, 'managed');
    await mkdir(home);
    const row: AccountRow = {
      id: 'managed',
      kind: 'MANAGED',
      label: 'One',
      identityKey: null,
      enabled: true,
    };
    const context: CodexRuntimeContext = {
      accountId: row.id,
      homeDir: home,
      sessionsDir: join(home, 'sessions'),
      env: {},
    };
    const coordinator = new LoginCoordinator({
      resolve: async () => ({ row, context }),
      prepare: async () => undefined,
      probe: vi.fn(),
      verify: vi.fn(),
      login: () => Promise.reject(new Error('Browser login failed')),
      invalidate: vi.fn(),
    });
    await coordinator.start(row.id);
    // Sample every event-loop turn: removing the staged home spans several, and
    // a caller that sees the outcome may use the account immediately.
    while (coordinator.status(row.id).status === 'pending') {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(coordinator.status(row.id).status).toBe('failed');
    expect(coordinator.isPending(row.id)).toBe(false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
