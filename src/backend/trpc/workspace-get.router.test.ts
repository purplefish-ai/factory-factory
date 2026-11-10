import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/backend/app-context';
import { createFakeApplicationGraph } from '@/test-utils/application-graph';
import { workspaceCoreRouter } from './workspace.trpc';

function fixture() {
  const graph = createFakeApplicationGraph('get-router');
  const findDetailById = vi.fn(() => Promise.resolve(null));
  const context = {
    services: {
      ...graph.services,
      workspaceDataService: Object.assign({}, graph.services.workspaceDataService, {
        findDetailById,
      }),
    },
    lifecycle: graph.lifecycle,
    config: graph.config,
  } satisfies AppContext;
  return { caller: workspaceCoreRouter.createCaller({ appContext: context }), findDetailById };
}

describe('workspace detail transport', () => {
  it('answers NOT_FOUND for a missing workspace so the client can tell it from a failure', async () => {
    const f = fixture();
    await expect(f.caller.get({ id: 'gone' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Workspace not found: gone',
    });
    expect(f.findDetailById).toHaveBeenCalledExactlyOnceWith('gone');
  });
});
