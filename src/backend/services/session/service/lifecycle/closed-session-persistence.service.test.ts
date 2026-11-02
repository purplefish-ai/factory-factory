import { readFile } from 'node:fs/promises';
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
  readFile: vi.fn(),
  unlink: vi.fn(),
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

    vi.mocked(writeFileAtomic).mockResolvedValue(undefined);
    vi.mocked(closedSessionAccessor.removeOrphan).mockResolvedValue(undefined);
    vi.mocked(closedSessionAccessor.reserve).mockImplementation(async (data) =>
      unsafeCoerce({ ...data, archiveState: 'PENDING' })
    );
    vi.mocked(writeFileAtomic).mockImplementation((_path, bytes) => {
      vi.mocked(readFile).mockResolvedValue(bytes.toString());
      return Promise.resolve();
    });
  });

  it('skips persistence when transcript has no messages', async () => {
    await expect(
      closedSessionPersistenceService.persistClosedSession(createInput({ messages: [] }))
    ).resolves.toBeUndefined();

    expect(writeFileAtomic).not.toHaveBeenCalled();
    expect(closedSessionAccessor.reserve).not.toHaveBeenCalled();
  });
  it('retains provider identity even when closure has no local messages', async () => {
    await closedSessionPersistenceService.persistClosedSession(
      createInput({ messages: [], ...{ providerSessionId: 'provider' } })
    );
    expect(writeFileAtomic).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('"providerSessionId": "provider"'),
      expect.anything()
    );
    expect(closedSessionAccessor.reserve).toHaveBeenCalledOnce();
  });

  it('rethrows file write errors so callers can handle failures', async () => {
    vi.mocked(writeFileAtomic).mockRejectedValue(new Error('Disk full'));

    await expect(
      closedSessionPersistenceService.persistClosedSession(createInput())
    ).rejects.toThrow('Disk full');

    expect(closedSessionAccessor.complete).not.toHaveBeenCalled();
  });

  it('rethrows database errors before transcript file write', async () => {
    vi.mocked(closedSessionAccessor.reserve).mockRejectedValue(new Error('DB locked'));

    await expect(
      closedSessionPersistenceService.persistClosedSession(createInput())
    ).rejects.toThrow('DB locked');

    expect(writeFileAtomic).not.toHaveBeenCalled();
  });
});
