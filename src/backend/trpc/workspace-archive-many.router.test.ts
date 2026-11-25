import { TRPCError } from '@trpc/server';
import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/backend/app-context';
import { ApplicationError } from '@/backend/lib/application-error';
import { ARCHIVE_MANY_MAX_IDS } from '@/shared/workspace-archive';
import { createFakeApplicationGraph } from '@/test-utils/application-graph';
import { deferred } from '@/test-utils/deferred';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { workspaceCoreRouter } from './workspace.trpc';

type ArchiveWorkspace = AppContext['services']['archiveWorkspace'];
type WorkspaceWithProject = Parameters<ArchiveWorkspace>[0];
type Archived = Awaited<ReturnType<ArchiveWorkspace>>;
const archived = unsafeCoerce<Archived>({ id: 'archived' });

/** Workspaces belong to `p1` unless listed in `projects`; `missing` IDs are not found. */
function fixture({
  projects = {},
  missing = [],
}: { projects?: Record<string, string>; missing?: string[] } = {}) {
  const graph = createFakeApplicationGraph('archive-many-router');
  const archive = vi.fn<ArchiveWorkspace>(() => Promise.resolve(archived));
  const findByIdWithProject = vi.fn((id: string) =>
    Promise.resolve(
      missing.includes(id)
        ? null
        : unsafeCoerce<WorkspaceWithProject>({
            id,
            projectId: projects[id] ?? 'p1',
            project: { slug: 'demo' },
          })
    )
  );
  const context = {
    services: {
      ...graph.services,
      archiveWorkspace: archive,
      workspaceDataService: Object.assign({}, graph.services.workspaceDataService, {
        findByIdWithProject,
      }),
    },
    lifecycle: graph.lifecycle,
    config: graph.config,
  } satisfies AppContext;
  return { archive, caller: workspaceCoreRouter.createCaller({ appContext: context }) };
}

describe('workspace.archiveMany', () => {
  it('returns a result per ID with error codes and application kinds', async () => {
    const f = fixture({ missing: ['w-missing'] });
    const failures = new Map<string, Error>([
      [
        'w-blocked',
        new ApplicationError('CONFLICT', 'Index is locked', { kind: 'GIT_INDEX_LOCKED' }),
      ],
      ['w-gone', new TRPCError({ code: 'NOT_FOUND', message: 'Workspace was deleted' })],
      ['w-broken', new Error('cleanup failed')],
    ]);
    f.archive.mockImplementation((workspace) => {
      const failure = failures.get(workspace.id);
      return failure ? Promise.reject(failure) : Promise.resolve(archived);
    });

    await expect(
      f.caller.archiveMany({
        projectId: 'p1',
        ids: ['w-success', 'w-blocked', 'w-missing', 'w-gone', 'w-broken'],
      })
    ).resolves.toEqual({
      results: [
        { id: 'w-success', success: true },
        {
          id: 'w-blocked',
          success: false,
          error: 'Index is locked',
          code: 'CONFLICT',
          applicationErrorKind: 'GIT_INDEX_LOCKED',
        },
        {
          id: 'w-missing',
          success: false,
          error: 'Workspace not found: w-missing',
          code: 'NOT_FOUND',
          applicationErrorKind: null,
        },
        {
          id: 'w-gone',
          success: false,
          error: 'Workspace was deleted',
          code: 'NOT_FOUND',
          applicationErrorKind: null,
        },
        {
          id: 'w-broken',
          success: false,
          error: 'cleanup failed',
          code: 'INTERNAL_SERVER_ERROR',
          applicationErrorKind: null,
        },
      ],
      total: 5,
    });
    expect(f.archive).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'w-success' }),
      {},
      expect.anything()
    );
  });

  it('returns a per-ID CONFLICT for a workspace a delete is cleaning up', async () => {
    const orchestrator = await vi.importActual<
      typeof import('@/backend/orchestration/workspace-lifecycle/workspace-archive.orchestrator')
    >('@/backend/orchestration/workspace-lifecycle/workspace-archive.orchestrator');
    const f = fixture();
    f.archive.mockImplementation((workspace, options, services) =>
      workspace.id === 'w-deleting'
        ? orchestrator.archiveWorkspace(workspace, options, services)
        : Promise.resolve(archived)
    );
    const release = deferred();
    const deleting = orchestrator.withArchiveExcluded('w-deleting', () => release.promise);

    try {
      await expect(
        f.caller.archiveMany({ projectId: 'p1', ids: ['w-deleting', 'w-other'] })
      ).resolves.toEqual({
        results: [
          {
            id: 'w-deleting',
            success: false,
            error: 'Workspace is being deleted',
            code: 'CONFLICT',
            applicationErrorKind: null,
          },
          { id: 'w-other', success: true },
        ],
        total: 2,
      });
    } finally {
      release.resolve();
      await deleting;
    }
  });

  it('refuses workspaces from another project without archiving them', async () => {
    const f = fixture({ projects: { 'w-other': 'p2' } });

    const result = await f.caller.archiveMany({ projectId: 'p1', ids: ['w-mine', 'w-other'] });

    expect(result.results).toEqual([
      { id: 'w-mine', success: true },
      {
        id: 'w-other',
        success: false,
        error: 'Workspace not found in this project: w-other',
        code: 'NOT_FOUND',
        applicationErrorKind: null,
      },
    ]);
    expect(f.archive).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'w-mine' }),
      {},
      expect.anything()
    );
  });

  it('archives at most three workspaces at once and each ID once', async () => {
    const f = fixture();
    const pending = new Map<string, ReturnType<typeof deferred<Archived>>>();
    let active = 0;
    let maxActive = 0;
    f.archive.mockImplementation((workspace) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const settle = deferred<Archived>();
      pending.set(workspace.id, settle);
      return settle.promise.finally(() => {
        active -= 1;
      });
    });
    const request = f.caller.archiveMany({
      projectId: 'p1',
      ids: ['w1', 'w2', 'w3', 'w4', 'w5', 'w2'],
    });
    await vi.waitFor(() => expect(pending.size).toBe(3));
    expect([...pending.keys()]).toEqual(['w1', 'w2', 'w3']);

    pending.get('w2')?.resolve(archived);
    await vi.waitFor(() => expect(pending.size).toBe(4));
    expect(active).toBe(3);
    for (const id of ['w1', 'w3', 'w4']) {
      pending.get(id)?.resolve(archived);
    }
    await vi.waitFor(() => expect(pending.size).toBe(5));
    pending.get('w5')?.resolve(archived);

    await expect(request).resolves.toEqual({
      results: ['w1', 'w2', 'w3', 'w4', 'w5'].map((id) => ({ id, success: true })),
      total: 5,
    });
    expect(maxActive).toBe(3);
    expect(f.archive).toHaveBeenCalledTimes(5);
  });

  it('rejects an empty or oversized ID list', async () => {
    const f = fixture();

    await expect(f.caller.archiveMany({ projectId: 'p1', ids: [] })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      f.caller.archiveMany({
        projectId: 'p1',
        ids: Array.from({ length: ARCHIVE_MANY_MAX_IDS + 1 }, (_, index) => `w${index}`),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.archive).not.toHaveBeenCalled();
  });
});
