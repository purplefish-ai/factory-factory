import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '@/backend/lib/application-error';

const mockUnlink = vi.hoisted(() => vi.fn());
const mockSessionDataService = vi.hoisted(() => ({
  findClosedSessionsByWorkspaceId: vi.fn(),
  findClosedSessionByIdWithWorkspace: vi.fn(),
  deleteClosedSession: vi.fn(),
  readClosedSessionTranscript: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  unlink: (...args: unknown[]) => mockUnlink(...args),
}));

import { closedSessionsRouter } from './closed-sessions.trpc';

function createCaller() {
  return closedSessionsRouter.createCaller({
    appContext: { services: { sessionDataService: mockSessionDataService } },
  } as never);
}

describe('closedSessionsRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists closed sessions with default and explicit limits', async () => {
    mockSessionDataService.findClosedSessionsByWorkspaceId.mockResolvedValue([]);
    const caller = createCaller();

    await expect(caller.list({ workspaceId: 'ws-1' })).resolves.toEqual([]);
    await expect(caller.list({ workspaceId: 'ws-1', limit: 7 })).resolves.toEqual([]);

    expect(mockSessionDataService.findClosedSessionsByWorkspaceId).toHaveBeenNthCalledWith(
      1,
      'ws-1',
      20
    );
    expect(mockSessionDataService.findClosedSessionsByWorkspaceId).toHaveBeenNthCalledWith(
      2,
      'ws-1',
      7
    );
  });

  it('returns the compatible owner DTO without adding current fields', async () => {
    const transcript = {
      messages: [{ role: 'user', content: 'hello' }],
      sessionSummary: 'Test summary',
    };
    mockSessionDataService.readClosedSessionTranscript.mockResolvedValue(transcript);
    await expect(createCaller().getTranscript({ id: 'closed-1' })).resolves.toEqual(transcript);
  });

  it.each([
    ['NOT_FOUND', 'NOT_FOUND', 'Closed session not found'],
    ['INVALID_INPUT', 'BAD_REQUEST', 'Workspace has no worktree path'],
    ['NOT_FOUND', 'NOT_FOUND', 'Transcript file not found'],
    ['INTERNAL_ERROR', 'INTERNAL_SERVER_ERROR', 'Failed to read transcript file'],
  ] as const)('maps owner %s to %s: %s', async (application, transport, message) => {
    mockSessionDataService.readClosedSessionTranscript.mockRejectedValue(
      new ApplicationError(application, message)
    );
    await expect(createCaller().getTranscript({ id: 'closed-1' })).rejects.toMatchObject({
      code: transport,
      message,
    });
  });

  it('deletes closed sessions and best-effort deletes transcript files', async () => {
    mockSessionDataService.findClosedSessionByIdWithWorkspace.mockResolvedValue({
      id: 'closed-1',
      transcriptPath: 'transcripts/closed-1.json',
      workspace: { worktreePath: '/tmp/worktree' },
    });
    mockSessionDataService.deleteClosedSession.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
    const caller = createCaller();

    await expect(caller.delete({ id: 'closed-1' })).resolves.toEqual({ success: true });
    expect(mockSessionDataService.deleteClosedSession).toHaveBeenCalledWith('closed-1');
    expect(mockUnlink).toHaveBeenCalledWith('/tmp/worktree/transcripts/closed-1.json');
  });

  it('returns success even when transcript unlink fails', async () => {
    mockSessionDataService.findClosedSessionByIdWithWorkspace.mockResolvedValue({
      id: 'closed-1',
      transcriptPath: 'transcripts/closed-1.json',
      workspace: { worktreePath: '/tmp/worktree' },
    });
    mockSessionDataService.deleteClosedSession.mockResolvedValue(undefined);
    mockUnlink.mockRejectedValue(new Error('permission denied'));
    const caller = createCaller();

    await expect(caller.delete({ id: 'closed-1' })).resolves.toEqual({ success: true });
  });

  it('throws NOT_FOUND when deleting an unknown closed session', async () => {
    mockSessionDataService.findClosedSessionByIdWithWorkspace.mockResolvedValue(null);
    const caller = createCaller();

    await expect(caller.delete({ id: 'missing' })).rejects.toThrow(
      'Closed session not found: missing'
    );
    expect(mockSessionDataService.deleteClosedSession).not.toHaveBeenCalled();
  });
});
