// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { claimWorkspaceCompletion } from './workspace-notification-claim';

const key = 'factoryfactory_recent_workspace_completions';
const identity = { workspaceId: 'workspace-1', finishedAt: '2026-11-04T00:00:00Z' };
let request: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear();
  let tail = Promise.resolve();
  request = vi.fn((_name: string, callback: () => boolean) => {
    const result = tail.then(callback);
    tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  });
  vi.stubGlobal('navigator', { locks: { request } });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});
it('atomically claims a completion once across concurrent contexts and keeps distinct completions', async () => {
  expect(
    await Promise.all([claimWorkspaceCompletion(identity), claimWorkspaceCompletion(identity)])
  ).toEqual([true, false]);
  expect(await claimWorkspaceCompletion({ ...identity, workspaceId: 'workspace-2' })).toBe(true);
  expect(await claimWorkspaceCompletion({ ...identity, finishedAt: '2026-11-05T00:00:00Z' })).toBe(
    true
  );
  expect(await claimWorkspaceCompletion(identity)).toBe(false);
});
it.each(['malformed json', 'null', '[false]', '[{"workspaceId":"w","finishedAt":"invalid"}]'])(
  'repairs invalid cached identities under the lock: %s',
  async (value) => {
    localStorage.setItem(key, value);
    expect(await claimWorkspaceCompletion(identity)).toBe(true);
    expect(await claimWorkspaceCompletion(identity)).toBe(false);
  }
);
it('keeps only the most recent 1000 validated completion identities', async () => {
  const initial = Array.from({ length: 1000 }, (_, i) => ({
    ...identity,
    workspaceId: `seed-${i}`,
  }));
  localStorage.setItem(key, JSON.stringify(initial));
  expect(await claimWorkspaceCompletion(identity)).toBe(true);
  const stored = z
    .array(z.object({ workspaceId: z.string(), finishedAt: z.string() }))
    .parse(JSON.parse(localStorage.getItem(key) ?? '[]'));
  expect(stored).toHaveLength(1000);
  expect(stored[0]?.workspaceId).toBe('seed-1');
  expect(await claimWorkspaceCompletion(initial[0]!)).toBe(true);
});
it('preserves per-tab delivery when Web Locks are absent', async () => {
  vi.stubGlobal('navigator', {});
  expect(await claimWorkspaceCompletion(identity)).toBe(true);
  expect(localStorage.getItem(key)).toBeNull();
});
it.each(['getItem', 'setItem'] as const)(
  'preserves per-tab delivery when storage %s is unavailable',
  async (method) => {
    vi.spyOn(Storage.prototype, method).mockImplementation(() => {
      throw new Error('Storage denied');
    });
    expect(await claimWorkspaceCompletion(identity)).toBe(true);
  }
);
it('preserves per-tab delivery when lock acquisition is rejected', async () => {
  request.mockRejectedValue(new Error('SecurityError'));
  expect(await claimWorkspaceCompletion(identity)).toBe(true);
});
