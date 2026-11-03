import { beforeEach, expect, it, vi } from 'vitest';
import type { WorkspacePullRequest } from '@/shared/workspace-pr';
import { deriveWorkspacePRSummary } from '@/shared/workspace-pr-summary';

const mocks = vi.hoisted(() => ({
  listEnabled: vi.fn(),
  listPending: vi.fn(),
  markChecked: vi.fn(),
  snapshot: vi.fn(),
}));
vi.mock('@/backend/services/job-runner.service', () => ({
  jobRunner: { register: vi.fn() },
}));
vi.mock('@/backend/services/workspace', () => ({
  workspacePRMonitoringService: mocks,
  workspacePrSnapshotService: { list: mocks.snapshot },
}));

import { RatchetService, RATCHET_STATE_CHANGED } from './ratchet.service';

const pr = (id: string, fields: Partial<WorkspacePullRequest> = {}): WorkspacePullRequest => ({
  id,
  url: `https://github.com/o/r/pull/${id}`,
  number: Number(id),
  title: null,
  headRefName: null,
  baseRefName: null,
  state: 'OPEN',
  reviewState: null,
  ciStatus: 'SUCCESS',
  hasMergeConflict: false,
  syncedAt: null,
  ...fields,
});
// Polling reads persisted dates; workspace projections serialize them to strings.
const persisted = (prs: WorkspacePullRequest[]) =>
  prs.map((pr) => ({ ...pr, syncedAt: new Date('2026-11-03T12:00:00Z') }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listPending.mockResolvedValue([]);
  mocks.markChecked.mockResolvedValue(undefined);
});

it.each([
  {
    name: 'CI failure before conflict',
    prs: [pr('1', { ciStatus: 'FAILURE' }), pr('2', { hasMergeConflict: true })],
    state: 'CI_FAILED',
  },
  {
    name: 'running CI before review',
    prs: [pr('1', { ciStatus: 'PENDING' }), pr('2', { reviewState: 'CHANGES_REQUESTED' })],
    state: 'CI_RUNNING',
  },
  { name: 'unobserved association', prs: [pr('1', { state: 'NONE' })], state: 'CI_RUNNING' },
  {
    name: 'terminal failures with active sibling',
    prs: [pr('1', { state: 'CLOSED', ciStatus: 'FAILURE', hasMergeConflict: true }), pr('2')],
    state: 'READY',
  },
  {
    name: 'all merged',
    prs: [pr('1', { state: 'MERGED' }), pr('2', { state: 'MERGED' })],
    state: 'MERGED',
  },
  {
    name: 'mixed terminal',
    prs: [pr('1', { state: 'MERGED' }), pr('2', { state: 'CLOSED' })],
    state: 'IDLE',
  },
  { name: 'empty', prs: [], state: 'IDLE' },
] as const)(
  'uses the projection policy before and after polling: $name',
  async ({ prs, state }) => {
    const rows = persisted([...prs]);
    mocks.listEnabled.mockResolvedValue([
      { workspaceId: 'w', enabled: true, eventEpoch: 1, workspace: { prs: rows } },
    ]);
    mocks.snapshot.mockResolvedValue(rows);
    const service = new RatchetService();
    const changed = vi.fn();
    service.on(RATCHET_STATE_CHANGED, changed);
    service.configure({
      observe: vi.fn().mockResolvedValue(true),
      wake: vi.fn().mockResolvedValue(undefined),
      setMonitoring: vi.fn(),
    });

    const result = await service.checkAllWorkspaces();

    expect(deriveWorkspacePRSummary(prs, true).ratchetState).toBe(state);
    expect(result.results[0]).toMatchObject({ previousState: state, newState: state });
    expect(result.stateChanges).toBe(0);
    expect(changed).not.toHaveBeenCalled();
  }
);

it('emits the collection transition while observing each association and waking queued delivery', async () => {
  const before = [pr('1', { state: 'NONE' }), pr('2', { state: 'MERGED' })];
  const after = [pr('1', { ciStatus: 'FAILURE' }), pr('2', { state: 'MERGED' })];
  mocks.listEnabled.mockResolvedValue([
    { workspaceId: 'w', enabled: true, eventEpoch: 1, workspace: { prs: persisted(before) } },
  ]);
  mocks.snapshot.mockResolvedValue(persisted(after));
  mocks.listPending.mockResolvedValue([{ id: 'failure-event' }]);
  const observed: string[] = [];
  const service = new RatchetService();
  const transitions: unknown[] = [];
  service.on(RATCHET_STATE_CHANGED, (event) => transitions.push(event));
  const wake = vi.fn().mockResolvedValue(undefined);
  service.configure({
    observe: (target) => {
      observed.push(target.prId);
      return Promise.resolve(true);
    },
    wake,
    setMonitoring: vi.fn(),
  });

  const result = await service.checkAllWorkspaces();

  expect(result.results[0]).toMatchObject({
    previousState: 'CI_RUNNING',
    newState: 'CI_FAILED',
    action: { type: 'EVENTS_QUEUED' },
  });
  expect(result).toMatchObject({ stateChanges: 1, actionsTriggered: 1 });
  expect(transitions).toEqual([
    { workspaceId: 'w', fromState: 'CI_RUNNING', toState: 'CI_FAILED' },
  ]);
  expect(observed).toEqual(['1', '2']);
  expect(wake).toHaveBeenCalledExactlyOnceWith('w', expect.any(Function));
});

it('does not poll or wake monitoring-disabled workspaces', async () => {
  mocks.listEnabled.mockResolvedValue([]);
  const service = new RatchetService();
  const observe = vi.fn(),
    wake = vi.fn();
  service.configure({ observe, wake, setMonitoring: vi.fn() });
  expect(await service.checkWorkspaceById('disabled')).toBeNull();
  expect(await service.checkAllWorkspaces()).toEqual({
    checked: 0,
    stateChanges: 0,
    actionsTriggered: 0,
    results: [],
  });
  expect(observe).not.toHaveBeenCalled();
  expect(wake).not.toHaveBeenCalled();
});
