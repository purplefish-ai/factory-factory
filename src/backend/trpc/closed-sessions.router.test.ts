import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadFile = vi.hoisted(() => vi.fn());
const mockUnlink = vi.hoisted(() => vi.fn());
const mockSessionDataService = vi.hoisted(() => ({
  findClosedSessionsByWorkspaceId: vi.fn(),
  findClosedSessionByIdWithWorkspace: vi.fn(),
  deleteClosedSession: vi.fn(),
  resolveClosedSessionTranscriptPath: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
}));

import { closedSessionsRouter } from './closed-sessions.trpc';

function createCaller() {
  return closedSessionsRouter.createCaller({
    appContext: { services: { sessionDataService: mockSessionDataService } },
  } as never);
}

beforeEach(() => {
  mockSessionDataService.resolveClosedSessionTranscriptPath.mockReturnValue(
    '/tmp/worktree/transcripts/closed-1.json'
  );
});

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
      version: 1,
      sessionId: 'session',
      workspaceId: 'ws-1',
      metadata: {
        name: null,
        workflow: 'followup',
        provider: 'CLAUDE',
        model: 'model',
        startedAt: '2026-01-01',
        completedAt: '2026-01-01',
      },
      messages: [{ id: 'm', source: 'user', text: 'hello', timestamp: '2026-01-01', order: 0 }],
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

it('reads application-owned archives without a live worktree', async () => {
  mockSessionDataService.findClosedSessionByIdWithWorkspace.mockResolvedValue({
    id: 'owned',
    workspaceId: 'ws-1',
    archiveKey: 'snapshot-key',
    transcriptPath: 'owned.json',
    workspace: { worktreePath: null },
  });
  mockSessionDataService.resolveClosedSessionTranscriptPath.mockReturnValue('/app-data/owned.json');
  mockReadFile.mockResolvedValue(
    JSON.stringify({
      version: 1,
      sessionId: 'session',
      workspaceId: 'ws-1',
      metadata: {
        name: null,
        workflow: 'followup',
        provider: 'CLAUDE',
        model: 'm',
        startedAt: '2026-01-01',
        completedAt: '2026-01-01',
      },
      messages: [],
    })
  );
  await expect(createCaller().getTranscript({ id: 'owned' })).resolves.toMatchObject({
    messages: [],
  });
  expect(mockSessionDataService.resolveClosedSessionTranscriptPath).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'owned' }),
    null
  );
  expect(mockReadFile).toHaveBeenCalledWith('/app-data/owned.json', 'utf-8');
});
