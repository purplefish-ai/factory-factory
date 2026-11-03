// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { WorkspaceRetryAvailability } from '@/shared/workspace-init-retry';
import { useRetryWorkspaceInit } from './use-retry-workspace-init';
const mutate = vi.hoisted(() => vi.fn());
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      workspace: { getInitStatus: { invalidate: vi.fn(async () => undefined) } },
    }),
    workspace: { retryInit: { useMutation: () => ({ mutate, isPending: false }) } },
  },
}));
let retry: () => void = () => {
  throw new Error('Probe not mounted');
};
function Probe({ availability }: { availability?: WorkspaceRetryAvailability }) {
  retry = useRetryWorkspaceInit('workspace', availability).retry;
  return null;
}
it('the real retry callback requires current AVAILABLE projection before mutation', async () => {
  const root = createRoot(document.createElement('div'));
  try {
    for (const availability of [
      undefined,
      { status: 'BLOCKED', reason: 'INITIAL_PENDING', explanation: 'Initial task pending' },
    ] as const) {
      await act(async () => root.render(createElement(Probe, { availability })));
      retry();
      expect(mutate).not.toHaveBeenCalled();
    }
    await act(async () =>
      root.render(createElement(Probe, { availability: { status: 'AVAILABLE' } }))
    );
    retry();
    expect(mutate).toHaveBeenCalledExactlyOnceWith({
      id: 'workspace',
      useExistingBranch: undefined,
    });
    await act(async () => root.render(createElement(Probe, {})));
    retry();
    expect(mutate).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
  }
});
it('keeps the retry callback stable while the mutation result object changes', async () => {
  const root = createRoot(document.createElement('div'));
  const availability = { status: 'AVAILABLE' } as const;
  try {
    await act(async () => root.render(createElement(Probe, { availability })));
    const initial = retry;
    await act(async () => root.render(createElement(Probe, { availability })));
    expect(retry).toBe(initial);
  } finally {
    await act(async () => root.unmount());
  }
});
