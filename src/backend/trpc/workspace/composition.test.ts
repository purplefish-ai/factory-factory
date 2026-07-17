import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { workspaceRouter } from '@/backend/trpc/workspace.trpc';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';

describe('workspace router composition', () => {
  it('does not read internal procedure definitions', () => {
    const workspaceRouterSource = readFileSync(
      new URL('../workspace.trpc.ts', import.meta.url),
      'utf8'
    );

    expect(workspaceRouterSource).not.toContain('_def.procedures');
  });

  it('keeps core, child-workspace, and file procedures on the public flat caller', async () => {
    const caller = workspaceRouter.createCaller(unsafeCoerce({ appContext: { services: {} } }));
    const invalidCalls = [
      () => caller.get(unsafeCoerce({ id: 42 })),
      () =>
        caller.sendMessageToParent(unsafeCoerce({ childWorkspaceId: 42, message: 'hello parent' })),
      () =>
        caller.sendMessageToChild(
          unsafeCoerce({
            parentWorkspaceId: 'parent-1',
            childWorkspaceId: 42,
            message: 'hello child',
          })
        ),
      () => caller.readFile(unsafeCoerce({ workspaceId: 42, path: 'README.md' })),
    ];

    for (const call of invalidCalls) {
      await expect(call()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
  });
});
