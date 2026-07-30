import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionLifecycleEventKind, SessionLifecycleEventReason } from '@/shared/core';

const { mockFindMany, mockUpsert } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockUpsert: vi.fn(),
}));

vi.mock('@/backend/db', () => ({
  prisma: {
    sessionLifecycleEvent: {
      findMany: mockFindMany,
      upsert: mockUpsert,
    },
  },
}));

import { prisma } from '@/backend/db';
import { sessionLifecycleEventAccessor } from './session-lifecycle-event.accessor';

describe('sessionLifecycleEventAccessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('upserts by the compound session and dedupe key', async () => {
    const createdAt = new Date('2026-07-30T12:22:23.353Z');
    const eventRecord = { id: 'event-1' };
    vi.mocked(prisma.sessionLifecycleEvent.upsert).mockResolvedValue(eventRecord as never);

    await sessionLifecycleEventAccessor.upsert({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      kind: SessionLifecycleEventKind.TURN_INTERRUPTED,
      reason: SessionLifecycleEventReason.PROMPT_TIMEOUT,
      message: 'Turn stopped: reached the 4-hour limit.',
      dedupeKey: 'turn:attempt-1:stop',
      createdAt,
    });

    expect(prisma.sessionLifecycleEvent.upsert).toHaveBeenCalledWith({
      where: {
        sessionId_dedupeKey: {
          sessionId: 'session-1',
          dedupeKey: 'turn:attempt-1:stop',
        },
      },
      create: {
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        kind: 'TURN_INTERRUPTED',
        reason: 'PROMPT_TIMEOUT',
        message: 'Turn stopped: reached the 4-hour limit.',
        dedupeKey: 'turn:attempt-1:stop',
        createdAt,
      },
      update: {},
    });
  });

  it('loads events in chronological and id order', async () => {
    vi.mocked(prisma.sessionLifecycleEvent.findMany).mockResolvedValue([]);

    await sessionLifecycleEventAccessor.findBySessionId('session-1');

    expect(prisma.sessionLifecycleEvent.findMany).toHaveBeenCalledWith({
      where: { sessionId: 'session-1' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  });
});
