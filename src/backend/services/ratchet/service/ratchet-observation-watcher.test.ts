import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listEnabled: vi.fn(),
  listPending: vi.fn(),
  markChecked: vi.fn(),
  register: vi.fn(),
}));
vi.mock('@/backend/services/job-runner.service', () => ({
  jobRunner: { register: mocks.register, start: vi.fn(), stop: vi.fn() },
}));
vi.mock('@/backend/services/workspace', () => ({
  workspacePRMonitoringService: mocks,
  workspacePrSnapshotService: { list: vi.fn().mockResolvedValue([]) },
}));

import { RatchetService } from './ratchet.service';

it('observes every association and wakes the main queue once without creating fixer sessions', async () => {
  mocks.listEnabled.mockResolvedValue([
    {
      workspaceId: 'w',
      enabled: true,
      workspace: {
        prs: [
          {
            id: 'p1',
            state: 'OPEN',
            ciStatus: 'FAILURE',
            hasMergeConflict: false,
            reviewState: null,
          },
          {
            id: 'p2',
            state: 'MERGED',
            ciStatus: 'SUCCESS',
            hasMergeConflict: false,
            reviewState: null,
          },
        ],
      },
    },
  ]);
  mocks.listPending.mockResolvedValue([]);
  const observe = vi.fn().mockResolvedValue(true),
    wake = vi.fn().mockResolvedValue(undefined);
  const ratchetService = new RatchetService();
  ratchetService.configure({ observe, wake, setMonitoring: vi.fn() });
  await ratchetService.checkAllWorkspaces();
  expect(observe.mock.calls.map((c) => c[0])).toEqual([
    { workspaceId: 'w', prId: 'p1' },
    { workspaceId: 'w', prId: 'p2' },
  ]);
  expect(wake).toHaveBeenCalledExactlyOnceWith('w');
  expect(mocks.register).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'pr-event-poll', intervalMs: 120_000 })
  );
});
