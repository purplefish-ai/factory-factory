import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/backend/app-context';
import type { RenamedWorkspace } from '@/backend/orchestration/workspace-rename.orchestrator';
import { createFakeApplicationGraph } from '@/test-utils/application-graph';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { workspaceCoreRouter } from './workspace.trpc';

function fixture() {
  const graph = createFakeApplicationGraph('rename-router');
  const canonical = unsafeCoerce<RenamedWorkspace>({
    id: 'workspace',
    name: 'Canonical name',
    updatedAt: new Date(200),
  });
  const rename = vi.fn(() => Promise.resolve(canonical));
  const find = vi.fn(() => Promise.resolve<RenamedWorkspace | null>(canonical));
  const context = {
    services: {
      ...graph.services,
      renameWorkspace: rename,
      workspaceDataService: Object.assign({}, graph.services.workspaceDataService, {
        findById: find,
      }),
    },
    lifecycle: graph.lifecycle,
    config: graph.config,
  } satisfies AppContext;
  const caller = workspaceCoreRouter.createCaller({ appContext: context });
  return { canonical, rename, find, caller };
}

describe('workspace rename transport', () => {
  it('routes trimmed input through the injected application use case and returns its canonical result', async () => {
    const f = fixture();
    expect(await f.caller.rename({ id: 'workspace', name: '  Requested name  ' })).toEqual(
      f.canonical
    );
    expect(f.rename).toHaveBeenCalledExactlyOnceWith('workspace', 'Requested name');
  });

  it('preserves the not-found response before invoking the application use case', async () => {
    const f = fixture();
    f.find.mockResolvedValueOnce(null);
    await expect(f.caller.rename({ id: 'missing', name: 'Name' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Workspace not found: missing',
    });
    expect(f.rename).not.toHaveBeenCalled();
  });

  it('preserves the original failed persistence result through the transport error boundary', async () => {
    const f = fixture();
    const failure = new Error('Database unavailable');
    f.rename.mockRejectedValueOnce(failure);
    await expect(f.caller.rename({ id: 'workspace', name: 'Name' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Database unavailable',
      cause: failure,
    });
  });
});
