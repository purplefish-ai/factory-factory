import { Prisma } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStatus } from '@/shared/core';

const mockCreate = vi.fn();
const mockFindUnique = vi.fn();
const mockFindMany = vi.fn();
const mockCount = vi.fn();
const mockUpdate = vi.fn();
const mockUpdateMany = vi.fn();
const mockDelete = vi.fn();

vi.mock('@/backend/db', () => ({
  prisma: {
    agentSession: {
      create: (...args: unknown[]) => mockCreate(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      findMany: (...args: unknown[]) => mockFindMany(...args),
      count: (...args: unknown[]) => mockCount(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
      delete: (...args: unknown[]) => mockDelete(...args),
    },
    $transaction: vi.fn(),
  },
}));

import { agentSessionAccessor } from './agent-session.accessor';

describe('agentSessionAccessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('create persists the resolved provider and model', async () => {
    mockCreate.mockResolvedValue({ id: 'session-1' });

    await agentSessionAccessor.create({
      workspaceId: 'workspace-1',
      workflow: 'user',
      provider: 'CLAUDE',
      model: 'opus',
    });

    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        workspaceId: 'workspace-1',
        name: undefined,
        workflow: 'user',
        model: 'opus',
        provider: 'CLAUDE',
        providerProjectPath: null,
      },
    });
  });

  it('create preserves explicit provider and nullable project path', async () => {
    mockCreate.mockResolvedValue({ id: 'session-2' });

    await agentSessionAccessor.create({
      workspaceId: 'workspace-1',
      name: 'Chat 1',
      workflow: 'ratchet-fixer',
      model: 'gpt-5-codex',
      provider: 'CODEX',
      providerProjectPath: '/tmp/workspace',
    });

    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        workspaceId: 'workspace-1',
        name: 'Chat 1',
        workflow: 'ratchet-fixer',
        model: 'gpt-5-codex',
        provider: 'CODEX',
        providerProjectPath: '/tmp/workspace',
      },
    });
  });

  it('createWithinWorkspaceLimit creates when active sessions are below the limit', async () => {
    mockCount.mockResolvedValue(1);
    mockCreate.mockResolvedValue({ id: 'session-3' });

    await expect(
      agentSessionAccessor.createWithinWorkspaceLimit({
        workspaceId: 'workspace-1',
        workflow: 'user',
        provider: 'CODEX',
        model: 'gpt-5-codex',
        maxSessions: 2,
      })
    ).resolves.toEqual({ outcome: 'created', session: { id: 'session-3' } });

    expect(mockCount).toHaveBeenCalledWith({
      where: {
        workspaceId: 'workspace-1',
        status: { in: [SessionStatus.RUNNING, SessionStatus.IDLE] },
      },
    });
    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        workspaceId: 'workspace-1',
        name: undefined,
        workflow: 'user',
        model: 'gpt-5-codex',
        provider: 'CODEX',
        providerProjectPath: null,
      },
    });
  });

  it('createWithinWorkspaceLimit rejects creation when active sessions meet the limit', async () => {
    mockCount.mockResolvedValue(2);

    await expect(
      agentSessionAccessor.createWithinWorkspaceLimit({
        workspaceId: 'workspace-1',
        workflow: 'user',
        provider: 'CLAUDE',
        model: 'opus',
        maxSessions: 2,
      })
    ).resolves.toEqual({ outcome: 'limit_reached' });

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('createWithinWorkspaceLimit does not count failed rollback sessions as active', async () => {
    mockCount.mockResolvedValue(1);
    mockCreate.mockResolvedValue({ id: 'session-after-failed-rollback' });

    await expect(
      agentSessionAccessor.createWithinWorkspaceLimit({
        workspaceId: 'workspace-1',
        workflow: 'user',
        provider: 'CLAUDE',
        model: 'opus',
        maxSessions: 2,
      })
    ).resolves.toEqual({
      outcome: 'created',
      session: { id: 'session-after-failed-rollback' },
    });

    expect(mockCount).toHaveBeenCalledWith({
      where: {
        workspaceId: 'workspace-1',
        status: { in: [SessionStatus.RUNNING, SessionStatus.IDLE] },
      },
    });
    expect(mockCreate).toHaveBeenCalled();
  });

  it('findById includes workspace relation', async () => {
    mockFindUnique.mockResolvedValue({ id: 'session-1' });

    await agentSessionAccessor.findById('session-1');

    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { id: 'session-1' },
      include: { workspace: true },
    });
  });

  it('findByIds short-circuits empty list', async () => {
    const result = await agentSessionAccessor.findByIds([]);
    expect(result).toEqual([]);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('findByIds queries with IN filter', async () => {
    mockFindMany.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);

    await agentSessionAccessor.findByIds(['s1', 's2']);

    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['s1', 's2'] },
      },
    });
  });

  it('findByWorkspaceId applies optional filters and ordering', async () => {
    mockFindMany.mockResolvedValue([{ id: 'session-1' }]);

    await agentSessionAccessor.findByWorkspaceId('workspace-1', {
      status: SessionStatus.RUNNING,
      provider: 'CODEX',
      limit: 3,
    });

    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        workspaceId: 'workspace-1',
        status: SessionStatus.RUNNING,
        provider: 'CODEX',
      },
      take: 3,
      orderBy: { createdAt: 'asc' },
    });
  });

  it('countActiveByWorkspaceId counts only running and idle sessions', async () => {
    mockCount.mockResolvedValue(2);

    await expect(agentSessionAccessor.countActiveByWorkspaceId('workspace-1')).resolves.toBe(2);

    expect(mockCount).toHaveBeenCalledWith({
      where: {
        workspaceId: 'workspace-1',
        status: { in: [SessionStatus.RUNNING, SessionStatus.IDLE] },
      },
    });
  });

  it('update maps null providerMetadata to Prisma.JsonNull', async () => {
    mockUpdate.mockResolvedValue({ id: 'session-1' });

    await agentSessionAccessor.update('session-1', {
      status: SessionStatus.IDLE,
      providerMetadata: null,
    });

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'session-1' },
      data: expect.objectContaining({
        status: SessionStatus.IDLE,
        providerMetadata: Prisma.JsonNull,
      }),
    });
  });

  it('update preserves providerMetadata when undefined', async () => {
    mockUpdate.mockResolvedValue({ id: 'session-1' });

    await agentSessionAccessor.update('session-1', {
      providerProjectPath: null,
      providerProcessPid: 4321,
    });

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'session-1' },
      data: expect.objectContaining({
        providerMetadata: undefined,
        providerProjectPath: null,
        providerProcessPid: 4321,
      }),
    });
  });

  it('updateIfStatus updates only sessions currently in allowed statuses', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      agentSessionAccessor.updateIfStatus(
        'session-1',
        {
          status: SessionStatus.IDLE,
          providerMetadata: null,
        },
        [SessionStatus.RUNNING]
      )
    ).resolves.toBe(1);

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'session-1',
        status: { in: [SessionStatus.RUNNING] },
      },
      data: expect.objectContaining({
        status: SessionStatus.IDLE,
        providerMetadata: Prisma.JsonNull,
      }),
    });
  });

  it('updateIfStatus skips Prisma when no allowed statuses are provided', async () => {
    await expect(
      agentSessionAccessor.updateIfStatus('session-1', { status: SessionStatus.IDLE }, [])
    ).resolves.toBe(0);

    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('delete removes session by id', async () => {
    mockDelete.mockResolvedValue({ id: 'session-1' });

    await agentSessionAccessor.delete('session-1');

    expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'session-1' } });
  });

  it('findWithPid filters to sessions with non-null pid', async () => {
    mockFindMany.mockResolvedValue([{ id: 'session-1' }]);

    await agentSessionAccessor.findWithPid();

    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        providerProcessPid: { not: null },
      },
      orderBy: { updatedAt: 'desc' },
    });
  });

  it('recoverStaleRunning marks persisted running sessions idle and clears pids', async () => {
    mockUpdateMany.mockResolvedValue({ count: 2 });

    await expect(agentSessionAccessor.recoverStaleRunning()).resolves.toBe(2);

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: {
        status: SessionStatus.RUNNING,
      },
      data: {
        status: SessionStatus.IDLE,
        providerProcessPid: null,
      },
    });
  });
});
