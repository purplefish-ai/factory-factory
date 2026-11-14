import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRuntimeState } from '@/shared/session-runtime';

const mocks = vi.hoisted(() => ({
  findChildRestFacts: vi.fn(),
  findAgentSessionsByWorkspaceId: vi.fn(),
  getRuntimeSnapshot: vi.fn(),
  getQueueLength: vi.fn(),
  getAllPendingRequests: vi.fn(),
}));
vi.mock('@/backend/services/workspace', () => ({
  workspaceRelationshipsService: { findChildRestFacts: mocks.findChildRestFacts },
}));
vi.mock('@/backend/services/session', () => ({
  sessionDataService: { findAgentSessionsByWorkspaceId: mocks.findAgentSessionsByWorkspaceId },
  sessionLifecycleService: { getRuntimeSnapshot: mocks.getRuntimeSnapshot },
  sessionDomainService: {
    getQueueLength: mocks.getQueueLength,
    getAllPendingRequests: mocks.getAllPendingRequests,
  },
}));

import { childRestState, observeChildRest } from './event-child-rest.orchestrator';

const idle = { working: false, queued: false, waitingOnPerson: false };
const ready = { status: 'READY' as const, hasHadSessions: true };

describe('childRestState', () => {
  it.each([
    ['deleted', null, [], 'ARCHIVED'],
    ['archived', { status: 'ARCHIVED', hasHadSessions: true }, [], 'ARCHIVED'],
    ['archiving', { status: 'ARCHIVING', hasHadSessions: true }, [], 'ARCHIVED'],
    ['setup failed', { status: 'FAILED', hasHadSessions: false }, [], 'SETUP_FAILED'],
    ['new', { status: 'NEW', hasHadSessions: false }, [], 'NOT_STARTED'],
    ['provisioning', { status: 'PROVISIONING', hasHadSessions: false }, [], 'NOT_STARTED'],
    ['ready, never started', { status: 'READY', hasHadSessions: false }, [idle], 'NOT_STARTED'],
    ['started and idle', ready, [idle], 'IDLE'],
    ['turn running', ready, [idle, { ...idle, working: true }], 'WORKING'],
    ['message queued', ready, [{ ...idle, queued: true }], 'WORKING'],
    [
      'waiting on a person',
      ready,
      [{ working: true, queued: true, waitingOnPerson: true }],
      'WAITING_ON_PERSON',
    ],
    [
      'one session waiting, another working',
      ready,
      [
        { ...idle, waitingOnPerson: true },
        { ...idle, working: true },
      ],
      'WORKING',
    ],
  ] as const)('classifies a child that is %s', (_name, workspace, sessions, expected) => {
    expect(childRestState(workspace, sessions)).toBe(expected);
  });
});

describe('observeChildRest', () => {
  const runtime = (overrides: Partial<SessionRuntimeState>): SessionRuntimeState => ({
    phase: 'idle',
    processState: 'alive',
    activity: 'IDLE',
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getQueueLength.mockReturnValue(0);
    mocks.getAllPendingRequests.mockReturnValue(new Map());
  });

  it('combines live, retained-only and session signals into one observation', async () => {
    mocks.findChildRestFacts.mockResolvedValue({
      workspaces: [
        { id: 'idle', status: 'READY', hasHadSessions: true },
        { id: 'starting', status: 'READY', hasHadSessions: true },
        { id: 'waiting', status: 'READY', hasHadSessions: true },
      ],
      retainedChildIds: ['idle', 'deleted'],
    });
    mocks.findAgentSessionsByWorkspaceId.mockImplementation(async (workspaceId: string) => [
      { id: `${workspaceId}-session` },
    ]);
    mocks.getRuntimeSnapshot.mockImplementation((sessionId: string) =>
      sessionId === 'starting-session'
        ? runtime({ phase: 'starting' })
        : sessionId === 'waiting-session'
          ? runtime({ phase: 'running', activity: 'WORKING' })
          : runtime({})
    );
    mocks.getAllPendingRequests.mockReturnValue(new Map([['waiting-session', {}]]));

    await expect(observeChildRest('parent')).resolves.toEqual({
      atRest: false,
      children: [
        { workspaceId: 'deleted', state: 'ARCHIVED' },
        { workspaceId: 'idle', state: 'IDLE' },
        { workspaceId: 'starting', state: 'WORKING' },
        { workspaceId: 'waiting', state: 'WAITING_ON_PERSON' },
      ],
    });
    expect(mocks.findChildRestFacts).toHaveBeenCalledWith('parent');
    expect(mocks.findAgentSessionsByWorkspaceId).not.toHaveBeenCalledWith('deleted');
  });

  it('treats queued input as unfinished work and an empty family as at rest', async () => {
    mocks.findChildRestFacts.mockResolvedValueOnce({
      workspaces: [{ id: 'child', status: 'READY', hasHadSessions: true }],
      retainedChildIds: ['child'],
    });
    mocks.findAgentSessionsByWorkspaceId.mockResolvedValue([{ id: 'session' }]);
    mocks.getRuntimeSnapshot.mockReturnValue(runtime({}));
    mocks.getQueueLength.mockReturnValue(1);
    await expect(observeChildRest('parent')).resolves.toEqual({
      atRest: false,
      children: [{ workspaceId: 'child', state: 'WORKING' }],
    });

    mocks.findChildRestFacts.mockResolvedValueOnce({ workspaces: [], retainedChildIds: [] });
    await expect(observeChildRest('parent')).resolves.toEqual({ atRest: true, children: [] });
  });
});
