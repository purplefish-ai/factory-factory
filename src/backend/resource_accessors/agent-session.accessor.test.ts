import { Prisma } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSessionModelForProvider } from '@/backend/lib/session-model';
import { SessionStatus } from '@/shared/core';

const mockCreate = vi.fn();
const mockFindUnique = vi.fn();
const mockFindMany = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();

vi.mock('@/backend/db', () => ({
  prisma: {
    agentSession: {
      create: (...args: unknown[]) => mockCreate(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      findMany: (...args: unknown[]) => mockFindMany(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      delete: (...args: unknown[]) => mockDelete(...args),
    },
  },
}));

import { agentSessionAccessor } from './agent-session.accessor';

describe('agentSessionAccessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('create applies default provider and model resolution', async () => {
    mockCreate.mockResolvedValue({ id: 'session-1' });

    await agentSessionAccessor.create({
      workspaceId: 'workspace-1',
      workflow: 'user',
    });

    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        workspaceId: 'workspace-1',
        name: undefined,
        workflow: 'user',
        model: resolveSessionModelForProvider(undefined, 'CLAUDE'),
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
        model: resolveSessionModelForProvider('gpt-5-codex', 'CODEX'),
        provider: 'CODEX',
        providerProjectPath: '/tmp/workspace',
      },
    });
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
});
