import { beforeEach, expect, it, vi } from 'vitest';
import type { AppContext } from '@/backend/app-context';
import { createFakeApplicationGraph } from '@/test-utils/application-graph';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { workspaceCoreRouter } from './workspace.trpc';

const detach = vi.fn(),
  attach = vi.fn(),
  stop = vi.fn(),
  sessions = vi.fn();
function caller() {
  const graph = createFakeApplicationGraph('pr-actions');
  const services = {
    ...graph.services,
    workspaceDataService: { findById: vi.fn().mockResolvedValue({ id: 'w' }) },
    prSnapshotService: { attachAndRefreshPR: attach, detachPR: detach },
    sessionLifecycleService: { stopSession: stop },
    sessionDataService: { findAgentSessionsByWorkspaceId: sessions },
  };
  return workspaceCoreRouter.createCaller({
    appContext: unsafeCoerce<AppContext>({ ...graph, services }),
  });
}
beforeEach(() => vi.resetAllMocks());
it('preserves NOT_FOUND if the workspace disappears during attachment', async () => {
  attach.mockResolvedValue({ success: false, reason: 'workspace_not_found' });
  await expect(
    caller().attachPR({ id: 'w', prUrl: 'https://github.com/o/r/pull/1' })
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
it('retries detached fixer cleanup without stopping sibling or review sessions', async () => {
  detach
    .mockResolvedValueOnce({ removed: true, sessionId: 'fixer' })
    .mockResolvedValue({ removed: false, sessionId: null });
  sessions.mockResolvedValue([
    { id: 'fixer', workspacePrId: 'a', workflow: 'ratchet', status: 'IDLE' },
    { id: 'sibling', workspacePrId: 'b', workflow: 'ratchet', status: 'RUNNING' },
    { id: 'review', workspacePrId: 'a', workflow: 'adversarial_review', status: 'RUNNING' },
  ]);
  stop.mockRejectedValueOnce(new Error('runtime unavailable')).mockResolvedValue(undefined);
  const api = caller(),
    input = { workspaceId: 'w', prId: 'a' };
  await expect(api.detachPR(input)).rejects.toThrow('runtime unavailable');
  await expect(api.detachPR(input)).resolves.toEqual({ removed: false });
  expect(stop.mock.calls).toEqual([['fixer'], ['fixer']]);
});
