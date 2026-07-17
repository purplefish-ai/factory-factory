import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindByProjectId = vi.hoisted(() => vi.fn());
const mockCountPending = vi.hoisted(() => vi.fn());
const mockGetWorkspaceWithWorktree = vi.hoisted(() => vi.fn());

vi.mock('@/backend/services/workspace', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/backend/services/workspace')>();
  return {
    ...original,
    workspaceDataService: {
      ...original.workspaceDataService,
      findByProjectId: mockFindByProjectId,
    },
    workspaceNotificationAccessor: {
      ...original.workspaceNotificationAccessor,
      countPending: mockCountPending,
    },
  };
});

vi.mock('@/backend/trpc/workspace/workspace-helpers', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/backend/trpc/workspace/workspace-helpers')>();
  return {
    ...original,
    getWorkspaceWithWorktree: mockGetWorkspaceWithWorktree,
  };
});

import { workspaceRouter } from '@/backend/trpc/workspace.trpc';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';

describe('workspace router composition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindByProjectId.mockResolvedValue([]);
    mockCountPending.mockResolvedValue(0);
    mockGetWorkspaceWithWorktree.mockResolvedValue(null);
  });

  it('does not read internal procedure definitions', () => {
    const workspaceRouterSource = readFileSync(
      new URL('../workspace.trpc.ts', import.meta.url),
      'utf8'
    );

    expect(workspaceRouterSource).not.toContain('_def.procedures');
  });

  it('keeps core, child-workspace, and file procedures on the public flat caller', async () => {
    const caller = workspaceRouter.createCaller(
      unsafeCoerce({
        appContext: {
          services: {
            createLogger: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
      })
    );

    await expect(caller.list({ projectId: 'project-1' })).resolves.toEqual([]);
    await expect(caller.getPendingNotificationCount({ workspaceId: 'workspace-1' })).resolves.toBe(
      0
    );
    await expect(caller.listAllFiles({ workspaceId: 'workspace-1', limit: 50 })).resolves.toEqual({
      files: [],
      hasWorktree: false,
    });
  });
});
