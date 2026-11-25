import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/backend/app-context';
import { createFakeApplicationGraph } from '@/test-utils/application-graph';
import { deferred } from '@/test-utils/deferred';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { workspaceCoreRouter } from './workspace.trpc';

function fixture() {
  const graph = createFakeApplicationGraph('delete-router');
  const archiveSettled = deferred();
  const workspace = { id: 'w1', project: { slug: 'demo' } };
  const withArchiveExcluded = vi.fn(async (_id: string, operation: () => Promise<unknown>) => {
    await archiveSettled.promise;
    return await operation();
  });
  const findByIdWithProject = vi.fn(() => Promise.resolve(workspace));
  const cleanupWorkspaceRuntimeResources = vi.fn(() => Promise.resolve());
  const cleanupWorkspaceWorktree = vi.fn(() => Promise.resolve());
  const deleteWorkspace = vi.fn(() => Promise.resolve({ deleted: true }));
  const context = unsafeCoerce<AppContext>({
    services: {
      ...graph.services,
      withArchiveExcluded,
      cleanupWorkspaceRuntimeResources,
      cleanupWorkspaceScopedCaches: vi.fn(),
      workspaceActivityService: Object.assign({}, graph.services.workspaceActivityService, {
        withNotificationsSuppressed: <T>(_id: string, operation: () => Promise<T>) => operation(),
      }),
      runScriptService: Object.assign({}, graph.services.runScriptService, {
        evictWorkspaceBuffers: vi.fn(),
      }),
      sessionDataService: Object.assign({}, graph.services.sessionDataService, {
        findAgentSessionsByWorkspaceId: vi.fn(() => Promise.resolve([])),
      }),
      workspaceDataService: Object.assign({}, graph.services.workspaceDataService, {
        findByIdWithProject,
        delete: deleteWorkspace,
      }),
      worktreeLifecycleService: Object.assign({}, graph.services.worktreeLifecycleService, {
        cleanupWorkspaceWorktree,
      }),
    },
    lifecycle: graph.lifecycle,
    config: graph.config,
  });
  const caller = workspaceCoreRouter.createCaller({ appContext: context });
  return {
    archiveSettled,
    caller,
    cleanupWorkspaceRuntimeResources,
    cleanupWorkspaceWorktree,
    deleteWorkspace,
    findByIdWithProject,
    withArchiveExcluded,
  };
}

describe('workspace delete transport', () => {
  it('cleans up only inside the archive exclusion for the workspace', async () => {
    const f = fixture();

    const deletion = f.caller.delete({ id: 'w1' });
    await vi.waitFor(() =>
      expect(f.withArchiveExcluded).toHaveBeenCalledWith('w1', expect.any(Function))
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.findByIdWithProject).not.toHaveBeenCalled();
    expect(f.cleanupWorkspaceRuntimeResources).not.toHaveBeenCalled();
    expect(f.cleanupWorkspaceWorktree).not.toHaveBeenCalled();

    f.archiveSettled.resolve();
    await expect(deletion).resolves.toEqual({ deleted: true });
    expect(f.cleanupWorkspaceWorktree).toHaveBeenCalledOnce();
    expect(f.deleteWorkspace).toHaveBeenCalledWith('w1');
  });
});
