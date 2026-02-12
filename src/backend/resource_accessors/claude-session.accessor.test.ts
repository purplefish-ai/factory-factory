import { SessionStatus } from '@factory-factory/core';
import { Prisma, SessionProvider } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAgentSession = vi.hoisted(() => ({
  create: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  findFirst: vi.fn(),
}));

const mockTransaction = vi.hoisted(() => ({
  agentSession: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
  },
}));

const mockPrisma = vi.hoisted(() => ({
  agentSession: mockAgentSession,
  $transaction: vi.fn(async (callback: (tx: typeof mockTransaction) => unknown) =>
    callback(mockTransaction)
  ),
}));

vi.mock('@/backend/db', () => ({
  prisma: mockPrisma,
}));

import { claudeSessionAccessor } from './claude-session.accessor';

function buildAgentSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    name: 'Session 1',
    workflow: 'followup',
    model: 'sonnet',
    status: SessionStatus.IDLE,
    provider: SessionProvider.CLAUDE,
    providerSessionId: 'provider-session-1',
    providerProjectPath: '/tmp/project',
    providerProcessPid: 4242,
    providerMetadata: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:01:00.000Z'),
    ...overrides,
  };
}

describe('claudeSessionAccessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates sessions with CLAUDE defaults and maps legacy fields', async () => {
    mockAgentSession.create.mockResolvedValue(
      buildAgentSession({
        providerSessionId: null,
        providerProjectPath: null,
        providerProcessPid: null,
      })
    );

    const result = await claudeSessionAccessor.create({
      workspaceId: 'workspace-1',
      workflow: 'followup',
    });

    expect(mockAgentSession.create).toHaveBeenCalledWith({
      data: {
        workspaceId: 'workspace-1',
        name: undefined,
        workflow: 'followup',
        model: 'sonnet',
        provider: SessionProvider.CLAUDE,
        providerProjectPath: null,
      },
    });
    expect(result.claudeSessionId).toBeNull();
    expect(result.claudeProjectPath).toBeNull();
    expect(result.claudeProcessPid).toBeNull();
  });

  it('respects explicit provider/model/path on create', async () => {
    mockAgentSession.create.mockResolvedValue(
      buildAgentSession({ provider: SessionProvider.CODEX })
    );

    await claudeSessionAccessor.create({
      workspaceId: 'workspace-1',
      workflow: 'followup',
      model: 'opus',
      provider: SessionProvider.CODEX,
      claudeProjectPath: '/tmp/custom',
    });

    expect(mockAgentSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        model: 'opus',
        provider: SessionProvider.CODEX,
        providerProjectPath: '/tmp/custom',
      }),
    });
  });

  it('findById returns null when missing', async () => {
    mockAgentSession.findUnique.mockResolvedValue(null);
    const result = await claudeSessionAccessor.findById('missing');
    expect(result).toBeNull();
  });

  it('findById maps provider fields to legacy claude fields', async () => {
    mockAgentSession.findUnique.mockResolvedValue({
      ...buildAgentSession(),
      workspace: { id: 'workspace-1' },
    });

    const result = await claudeSessionAccessor.findById('session-1');

    expect(result?.claudeSessionId).toBe('provider-session-1');
    expect(result?.claudeProjectPath).toBe('/tmp/project');
    expect(result?.claudeProcessPid).toBe(4242);
    expect(result?.workspace.id).toBe('workspace-1');
    const runtimeResult = result as unknown as Record<string, unknown>;
    expect('providerSessionId' in runtimeResult).toBe(false);
    expect('providerProjectPath' in runtimeResult).toBe(false);
    expect('providerProcessPid' in runtimeResult).toBe(false);
  });

  it('findByWorkspaceId applies filters and ordering', async () => {
    mockAgentSession.findMany.mockResolvedValue([buildAgentSession()]);

    await claudeSessionAccessor.findByWorkspaceId('workspace-1', {
      status: SessionStatus.RUNNING,
      provider: SessionProvider.CODEX,
      limit: 2,
    });

    expect(mockAgentSession.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: 'workspace-1',
        status: SessionStatus.RUNNING,
        provider: SessionProvider.CODEX,
      },
      take: 2,
      orderBy: { createdAt: 'asc' },
    });
  });

  it('maps providerMetadata null to Prisma.JsonNull on update', async () => {
    mockAgentSession.update.mockResolvedValue(buildAgentSession());

    await claudeSessionAccessor.update('session-1', {
      providerMetadata: null,
      claudeSessionId: 'updated-session',
      claudeProjectPath: '/tmp/updated',
      claudeProcessPid: 5000,
    });

    expect(mockAgentSession.update).toHaveBeenCalledWith({
      where: { id: 'session-1' },
      data: expect.objectContaining({
        providerMetadata: Prisma.JsonNull,
        providerSessionId: 'updated-session',
        providerProjectPath: '/tmp/updated',
        providerProcessPid: 5000,
      }),
    });
  });

  it('passes through providerMetadata object on update', async () => {
    mockAgentSession.update.mockResolvedValue(buildAgentSession());
    const metadata = { source: 'ratchet' };

    await claudeSessionAccessor.update('session-1', {
      providerMetadata: metadata,
    });

    expect(mockAgentSession.update).toHaveBeenCalledWith({
      where: { id: 'session-1' },
      data: expect.objectContaining({
        providerMetadata: metadata,
      }),
    });
  });

  it('findWithPid only queries sessions with non-null providerProcessPid', async () => {
    mockAgentSession.findMany.mockResolvedValue([buildAgentSession()]);

    await claudeSessionAccessor.findWithPid();

    expect(mockAgentSession.findMany).toHaveBeenCalledWith({
      where: {
        providerProcessPid: { not: null },
      },
      orderBy: { updatedAt: 'desc' },
    });
  });

  it('acquireFixerSession reuses existing matching session', async () => {
    mockTransaction.agentSession.findFirst.mockResolvedValueOnce({
      id: 'existing-session',
      status: SessionStatus.RUNNING,
    });

    const result = await claudeSessionAccessor.acquireFixerSession({
      workspaceId: 'workspace-1',
      workflow: 'ratchet',
      sessionName: 'Ratchet',
      maxSessions: 3,
      claudeProjectPath: '/tmp/project',
    });

    expect(result).toEqual({
      outcome: 'existing',
      sessionId: 'existing-session',
      status: SessionStatus.RUNNING,
    });
  });

  it('acquireFixerSession returns limit_reached when workspace cap is hit', async () => {
    mockTransaction.agentSession.findFirst.mockResolvedValueOnce(null);
    mockTransaction.agentSession.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);

    const result = await claudeSessionAccessor.acquireFixerSession({
      workspaceId: 'workspace-1',
      workflow: 'ratchet',
      sessionName: 'Ratchet',
      maxSessions: 2,
      claudeProjectPath: '/tmp/project',
    });

    expect(result).toEqual({ outcome: 'limit_reached' });
  });

  it('acquireFixerSession creates using recent model and explicit provider', async () => {
    mockTransaction.agentSession.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ model: 'opus' });
    mockTransaction.agentSession.findMany.mockResolvedValue([{ id: 'a' }]);
    mockTransaction.agentSession.create.mockResolvedValue({ id: 'new-session' });

    const result = await claudeSessionAccessor.acquireFixerSession({
      workspaceId: 'workspace-1',
      workflow: 'ratchet',
      sessionName: 'Ratchet',
      maxSessions: 5,
      provider: SessionProvider.CODEX,
      claudeProjectPath: null,
    });

    expect(mockTransaction.agentSession.create).toHaveBeenCalledWith({
      data: {
        workspaceId: 'workspace-1',
        workflow: 'ratchet',
        name: 'Ratchet',
        model: 'opus',
        status: SessionStatus.IDLE,
        provider: SessionProvider.CODEX,
        providerProjectPath: null,
      },
    });
    expect(result).toEqual({ outcome: 'created', sessionId: 'new-session' });
  });

  it('acquireFixerSession falls back to sonnet when no recent model exists', async () => {
    mockTransaction.agentSession.findFirst.mockResolvedValue(null);
    mockTransaction.agentSession.findMany.mockResolvedValue([]);
    mockTransaction.agentSession.create.mockResolvedValue({ id: 'new-session' });

    await claudeSessionAccessor.acquireFixerSession({
      workspaceId: 'workspace-1',
      workflow: 'ratchet',
      sessionName: 'Ratchet',
      maxSessions: 5,
      claudeProjectPath: '/tmp/project',
    });

    expect(mockTransaction.agentSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        model: 'sonnet',
        provider: SessionProvider.CLAUDE,
        providerProjectPath: '/tmp/project',
      }),
    });
  });
});
