// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkspacePrActions } from './use-workspace-pr-actions';

const mocks = vi.hoisted(() => ({
  success: vi.fn(),
  invalidate: vi.fn(),
  status: 'already_active',
  mutate: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: vi.fn() } }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      workspace: { get: { invalidate: vi.fn() }, listForProject: { invalidate: vi.fn() } },
      session: { listSessions: { invalidate: mocks.invalidate } },
    }),
    workspace: {
      attachPR: { useMutation: () => ({ isPending: false }) },
      detachPR: { useMutation: () => ({ isPending: false }) },
    },
    adversarialReview: {
      trigger: {
        useMutation: (options: { onSuccess: (result: { status: string }) => void }) => ({
          isPending: false,
          mutate: (input: unknown) => {
            mocks.mutate(input);
            options.onSuccess({ status: mocks.status });
          },
        }),
      },
    },
  },
}));
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
});
afterEach(async () => {
  await act(() => root.unmount());
  document.body.innerHTML = '';
});
function ReviewButton() {
  const actions = useWorkspacePrActions('workspace-1', 'project-1');
  return <button onClick={() => actions.review('pr-42')}>Review</button>;
}
it.each([
  ['already_active', 'Adversarial review is already running'],
  ['started', 'Review started'],
])('reports the %s review result and refreshes sessions', async (status, message) => {
  mocks.status = status;
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(() => root.render(<ReviewButton />));
  await act(() => host.querySelector('button')!.click());
  expect(mocks.mutate).toHaveBeenCalledWith({ workspaceId: 'workspace-1', prId: 'pr-42' });
  expect(mocks.success).toHaveBeenCalledWith(message);
  expect(mocks.invalidate).toHaveBeenCalledWith({ workspaceId: 'workspace-1' });
});
