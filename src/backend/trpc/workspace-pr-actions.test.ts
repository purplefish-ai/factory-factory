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
it('detaches only the selected association without stopping conversation sessions', async () => {
  detach
    .mockResolvedValueOnce({ removed: true, dispatchReleased: false })
    .mockResolvedValue({ removed: false, dispatchReleased: false });
  const api = caller();
  const input = { workspaceId: 'w', prId: 'a' };
  await expect(api.detachPR(input)).resolves.toEqual({ removed: true });
  await expect(api.detachPR(input)).resolves.toEqual({ removed: false });
  expect(detach.mock.calls).toEqual([[input], [input]]);
  expect(stop).not.toHaveBeenCalled();
  expect(sessions).not.toHaveBeenCalled();
});

it('returns a pending retained association when the configured observer throws offline', async () => {
  attach.mockResolvedValue({ success: false, reason: 'error', prId: 'a' });
  await expect(
    caller().attachPR({ id: 'w', prUrl: 'https://github.com/o/r/pull/1' })
  ).resolves.toMatchObject({ id: 'w', attachedPrId: 'a', prSyncStatus: 'pending' });
});
it('rejects attachment errors that did not persist an association', async () => {
  attach.mockResolvedValue({ success: false, reason: 'error' });
  await expect(
    caller().attachPR({ id: 'w', prUrl: 'https://github.com/o/r/pull/1' })
  ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
});
