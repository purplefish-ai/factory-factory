import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadFile = vi.hoisted(() => vi.fn());
const mockSessionDataService = vi.hoisted(() => ({
  findClosedSessionsByWorkspaceId: vi.fn(),
  findClosedSessionByIdWithWorkspace: vi.fn(),
  deleteClosedSession: vi.fn(),
  resolveClosedSessionTranscriptPath: vi.fn(),
  readClosedSessionTranscript: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

import { closedSessionsRouter } from './closed-sessions.trpc';

function createCaller() {
  return closedSessionsRouter.createCaller({
    appContext: { services: { sessionDataService: mockSessionDataService } },
  } as never);
}

beforeEach(() => {
  mockSessionDataService.readClosedSessionTranscript.mockImplementation((_archive, path) =>
    mockReadFile(path, 'utf-8')
  );
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

  it('delegates deletion and artifact ownership to the session data service', async () => {
    mockSessionDataService.findClosedSessionByIdWithWorkspace.mockResolvedValue({
      id: 'closed-1',
      transcriptPath: 'transcripts/closed-1.json',
      workspace: { worktreePath: '/tmp/worktree' },
    });
    mockSessionDataService.deleteClosedSession.mockResolvedValue(undefined);
    const caller = createCaller();

    await expect(caller.delete({ id: 'closed-1' })).resolves.toEqual({ success: true });
    expect(mockSessionDataService.deleteClosedSession).toHaveBeenCalledWith('closed-1');
  });

  it('does not report success when the deletion owner rejects', async () => {
    mockSessionDataService.findClosedSessionByIdWithWorkspace.mockResolvedValue({
      id: 'closed-1',
      transcriptPath: 'transcripts/closed-1.json',
      workspace: { worktreePath: '/tmp/worktree' },
    });
    mockSessionDataService.deleteClosedSession.mockRejectedValue(new Error('database unavailable'));
    const caller = createCaller();

    await expect(caller.delete({ id: 'closed-1' })).rejects.toThrow('database unavailable');
    expect(mockSessionDataService.deleteClosedSession).toHaveBeenCalledExactlyOnceWith('closed-1');
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

it('sanitizes transcript path resolution failures before reading', async () => {
  mockSessionDataService.findClosedSessionByIdWithWorkspace.mockResolvedValue({
    id: 'closed-1',
    archiveKey: 'key',
    workspace: { worktreePath: null },
  });
  mockSessionDataService.resolveClosedSessionTranscriptPath.mockImplementationOnce(() => {
    throw new Error('invalid /private/archive/location');
  });
  await expect(createCaller().getTranscript({ id: 'closed-1' })).rejects.toMatchObject({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Failed to read transcript file',
  });
  expect(mockSessionDataService.readClosedSessionTranscript).not.toHaveBeenCalled();
});

it('projects archived messages without exposing internal native prompt evidence', async () => {
  const transcript = {
    version: 1,
    sessionId: 'session',
    workspaceId: 'workspace',
    metadata: {
      name: null,
      workflow: 'followup',
      provider: 'CLAUDE',
      model: 'model',
      startedAt: '2026-01-01',
      completedAt: '2026-01-01',
    },
    messages: [
      {
        id: 'human',
        source: 'user',
        text: 'visible',
        timestamp: '2026-01-01',
        order: 0,
        providerPrompt: [{ type: 'text', text: 'private native evidence' }],
      },
    ],
  };
  mockSessionDataService.findClosedSessionByIdWithWorkspace.mockResolvedValue({
    id: 'closed-1',
    archiveKey: 'key',
    workspace: { worktreePath: null },
  });
  mockSessionDataService.readClosedSessionTranscript.mockResolvedValueOnce(
    JSON.stringify(transcript)
  );
  const result = await createCaller().getTranscript({ id: 'closed-1' });
  expect(result.messages[0]).not.toHaveProperty('providerPrompt');
  expect(result.messages[0]).toMatchObject({ id: 'human', text: 'visible' });
  expect(transcript.messages[0]?.providerPrompt).toEqual([
    { type: 'text', text: 'private native evidence' },
  ]);
});

it('returns list metadata without private archive identity, publication state or hash', async () => {
  const published = {
    id: 'archive',
    sessionId: 'session',
    workspaceId: 'workspace',
    name: 'Archive',
    workflow: 'default',
    provider: 'CLAUDE',
    model: 'sonnet',
    transcriptPath: 'owned/file.json',
    startedAt: new Date(0),
    completedAt: new Date(1),
    archiveKey: 'private-key',
    archiveState: 'COMPLETE',
    transcriptHash: 'private-hash',
  };
  mockSessionDataService.findClosedSessionsByWorkspaceId.mockResolvedValue([published]);
  const { archiveKey: _key, archiveState: _state, transcriptHash: _hash, ...summary } = published;
  await expect(createCaller().list({ workspaceId: 'workspace' })).resolves.toEqual([summary]);
});
