import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadFile = vi.hoisted(() => vi.fn());
const mockUnlink = vi.hoisted(() => vi.fn());
const mockSessionDataService = vi.hoisted(() => ({
  findClosedSessionsByWorkspaceId: vi.fn(),
  findClosedSessionByIdWithWorkspace: vi.fn(),
  deleteClosedSession: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
}));

vi.mock('@/backend/domains/session', () => ({
  sessionDataService: mockSessionDataService,
}));

import { closedSessionsRouter } from './closed-sessions.trpc';

function createCaller() {
  return closedSessionsRouter.createCaller({ appContext: {} } as never);
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

  it('returns a parsed transcript when the transcript file exists', async () => {
    const transcript = {
      messages: [{ role: 'user', content: 'hello' }],
      sessionSummary: 'Test summary',
    };
    mockSessionDataService.findClosedSessionByIdWithWorkspace.mockResolvedValue({
      id: 'closed-1',
      transcriptPath: 'transcripts/closed-1.json',
      workspace: { worktreePath: '/tmp/worktree' },
    });
    mockReadFile.mockResolvedValue(JSON.stringify(transcript));

    const caller = createCaller();
    await expect(caller.getTranscript({ id: 'closed-1' })).resolves.toEqual(transcript);

    expect(mockReadFile).toHaveBeenCalledWith('/tmp/worktree/transcripts/closed-1.json', 'utf-8');
  });

  it('throws NOT_FOUND when transcript session metadata is missing', async () => {
    mockSessionDataService.findClosedSessionByIdWithWorkspace.mockResolvedValue(null);
    const caller = createCaller();

    await expect(caller.getTranscript({ id: 'missing' })).rejects.toThrow(
      'Closed session not found: missing'
    );
  });

  it('throws BAD_REQUEST when workspace has no worktree path', async () => {
    mockSessionDataService.findClosedSessionByIdWithWorkspace.mockResolvedValue({
      id: 'closed-1',
      transcriptPath: 'transcripts/closed-1.json',
      workspace: { worktreePath: null },
    });
    const caller = createCaller();

    await expect(caller.getTranscript({ id: 'closed-1' })).rejects.toThrow(
      'Workspace has no worktree path'
    );
  });

  it('maps ENOENT transcript reads to NOT_FOUND', async () => {
    mockSessionDataService.findClosedSessionByIdWithWorkspace.mockResolvedValue({
      id: 'closed-1',
      transcriptPath: 'transcripts/closed-1.json',
      workspace: { worktreePath: '/tmp/worktree' },
    });
    mockReadFile.mockRejectedValue(
      Object.assign(new Error('missing file'), {
        code: 'ENOENT',
      })
    );
    const caller = createCaller();

    await expect(caller.getTranscript({ id: 'closed-1' })).rejects.toThrow(
      'Transcript file not found'
    );
  });

  it('maps non-ENOENT transcript read failures to INTERNAL_SERVER_ERROR', async () => {
    mockSessionDataService.findClosedSessionByIdWithWorkspace.mockResolvedValue({
      id: 'closed-1',
      transcriptPath: 'transcripts/closed-1.json',
      workspace: { worktreePath: '/tmp/worktree' },
    });
    mockReadFile.mockRejectedValue(new Error('permission denied'));
    const caller = createCaller();

    await expect(caller.getTranscript({ id: 'closed-1' })).rejects.toThrow(
      'Failed to read transcript file'
    );
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
