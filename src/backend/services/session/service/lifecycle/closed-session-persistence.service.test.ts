import { mkdir } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileAtomic } from '@/backend/lib/atomic-file';
import { closedSessionAccessor } from '@/backend/services/session/resources/closed-session.accessor';
import type { ChatMessage } from '@/shared/acp-protocol';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  closedSessionPersistenceService,
  type PersistClosedSessionInput,
} from './closed-session-persistence.service';

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
}));

vi.mock('@/backend/lib/atomic-file');
vi.mock('@/backend/services/session/resources/closed-session.accessor');

const createInput = (
  overrides?: Partial<PersistClosedSessionInput>
): PersistClosedSessionInput => ({
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  worktreePath: '/tmp/work',
  name: 'Ratchet run',
  workflow: 'ratchet',
  provider: 'CLAUDE',
  model: 'sonnet',
  startedAt: new Date('2026-01-01T00:00:00.000Z'),
  messages: unsafeCoerce<ChatMessage[]>([{ type: 'mock-message' }]),
  ...overrides,
});

describe('closedSessionPersistenceService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFileAtomic).mockResolvedValue(undefined);
    vi.mocked(closedSessionAccessor.create).mockResolvedValue(
      unsafeCoerce({
        id: 'closed-session-1',
      })
    );
  });

  it('skips persistence when transcript has no messages', async () => {
    await expect(
      closedSessionPersistenceService.persistClosedSession(createInput({ messages: [] }))
    ).resolves.toBeUndefined();

    expect(writeFileAtomic).not.toHaveBeenCalled();
    expect(closedSessionAccessor.create).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
  });

  it('rethrows file write errors so callers can handle failures', async () => {
    vi.mocked(writeFileAtomic).mockRejectedValue(new Error('Disk full'));

    await expect(
      closedSessionPersistenceService.persistClosedSession(createInput())
    ).rejects.toThrow('Disk full');
    expect(mkdir).toHaveBeenCalledWith('/tmp/work/.context/closed-sessions', {
      recursive: true,
    });
    expect(closedSessionAccessor.create).not.toHaveBeenCalled();
  });

  it('rethrows database errors after transcript file write', async () => {
    vi.mocked(closedSessionAccessor.create).mockRejectedValue(new Error('DB locked'));

    await expect(
      closedSessionPersistenceService.persistClosedSession(createInput())
    ).rejects.toThrow('DB locked');
    expect(mkdir).toHaveBeenCalledWith('/tmp/work/.context/closed-sessions', {
      recursive: true,
    });
    expect(writeFileAtomic).toHaveBeenCalledTimes(1);
  });
});
