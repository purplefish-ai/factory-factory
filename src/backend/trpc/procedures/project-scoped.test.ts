import { describe, expect, it } from 'vitest';
import { router } from '@/backend/trpc/trpc';
import { projectScopedProcedure } from './project-scoped';

const testRouter = router({
  readProject: projectScopedProcedure.query(({ ctx }) => ({ projectId: ctx.projectId })),
});

describe('projectScopedProcedure', () => {
  it('allows calls when projectId is present', async () => {
    const caller = testRouter.createCaller({ appContext: {}, projectId: 'p1' } as never);
    await expect(caller.readProject()).resolves.toEqual({ projectId: 'p1' });
  });

  it('throws BAD_REQUEST when projectId is missing', async () => {
    const caller = testRouter.createCaller({ appContext: {} } as never);
    await expect(caller.readProject()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
