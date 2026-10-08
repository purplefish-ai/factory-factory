import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  setBinding: vi.fn(),
  sessions: vi.fn(),
  invalidate: vi.fn(),
  control: vi.fn(),
  wake: vi.fn(),
}));
vi.mock('@/backend/services/workspace', () => ({
  workspacePRMonitoringService: {
    get: mocks.get,
    setBinding: mocks.setBinding,
    addEnabledControl: mocks.control,
  },
}));
vi.mock('@/backend/services/session', () => ({
  sessionDataService: { findAgentSessionsByWorkspaceId: mocks.sessions },
  sessionBackgroundDeliveryService: { invalidate: mocks.invalidate },
}));
vi.mock('@/backend/services/settings', () => ({
  userSettingsService: { get: async () => ({ ratchetReplyToPrComments: false }) },
}));
vi.mock('./pr-event-delivery.orchestrator', () => ({ wakePRDelivery: mocks.wake }));

import { bindIssueMonitoringSession, setPRMonitoring } from './pr-monitoring.orchestrator';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({
    workspaceId: 'w',
    enabled: false,
    recipientSessionId: null,
    bindingRevision: 2,
  });
  mocks.sessions.mockResolvedValue([
    { id: 'a', workflow: 'code', provider: 'CLAUDE' },
    { id: 'b', workflow: 'implement', provider: 'CODEX' },
    { id: 'fixer', workflow: 'ratchet', provider: 'CLAUDE' },
  ]);
  mocks.setBinding.mockResolvedValue({ applied: true, bindingRevision: 3 });
});
it('requires an explicit recipient when more than one ordinary conversation exists', async () => {
  expect(
    await setPRMonitoring({ workspaceId: 'w', enabled: true, expectedBindingRevision: 2 })
  ).toMatchObject({
    status: 'recipient_required',
    bindingRevision: 2,
    candidates: [{ id: 'a' }, { id: 'b' }],
  });
  expect(mocks.setBinding).not.toHaveBeenCalled();
  expect(mocks.wake).not.toHaveBeenCalled();
});
it('binds the unique ordinary conversation and emits one trusted enable control', async () => {
  mocks.sessions.mockResolvedValue([
    { id: 'a', workflow: 'code' },
    { id: 'aux', workflow: 'auto-iteration' },
  ]);
  await setPRMonitoring({ workspaceId: 'w', enabled: true, expectedBindingRevision: 2 });
  expect(mocks.setBinding).toHaveBeenCalledWith({
    workspaceId: 'w',
    enabled: true,
    expectedBindingRevision: 2,
    recipientSessionId: 'a',
    replyToPrComments: false,
  });
  expect(mocks.control).toHaveBeenCalledExactlyOnceWith('w', 3, false);
  expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith('w', 2);
});
it('rejects stale binding changes without queuing control or facts', async () => {
  mocks.setBinding.mockResolvedValue({ applied: false, bindingRevision: 4 });
  await expect(
    setPRMonitoring({
      workspaceId: 'w',
      enabled: true,
      recipientSessionId: 'a',
      expectedBindingRevision: 2,
    })
  ).rejects.toThrow('refresh and retry');
  expect(mocks.control).not.toHaveBeenCalled();
  expect(mocks.wake).not.toHaveBeenCalled();
});
it('binds the issue-start conversation explicitly rather than choosing a recent session', async () => {
  mocks.get.mockResolvedValue({ enabled: true, recipientSessionId: null, bindingRevision: 2 });
  await bindIssueMonitoringSession('w', 'a');
  expect(mocks.setBinding).toHaveBeenCalledWith({
    workspaceId: 'w',
    enabled: true,
    expectedBindingRevision: 2,
    recipientSessionId: 'a',
    replyToPrComments: false,
  });
});

it('repairs a missing enable control when the same enabled binding is retried', async () => {
  mocks.get.mockResolvedValue({ enabled: true, recipientSessionId: 'a', bindingRevision: 3 });
  mocks.setBinding.mockResolvedValue({ applied: true, bindingRevision: 3 });
  await setPRMonitoring({
    workspaceId: 'w',
    enabled: true,
    recipientSessionId: 'a',
    expectedBindingRevision: 3,
  });
  expect(mocks.control).toHaveBeenCalledExactlyOnceWith('w', 3, false);
});
