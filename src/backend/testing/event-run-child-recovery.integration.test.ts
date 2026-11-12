// Recovery for runs held only by child workspaces: ABANDON keeps the run's own outcome.
import { expect, it, vi } from 'vitest';
import {
  consumer,
  context,
  db,
  h,
  launch,
  providers,
  strictStop,
} from '@/test-utils/event-generic-retry.test-support';

const row = () => db.prisma.agentRun.findUniqueOrThrow({ where: { id: h.claim.runId } });

it.each(['completed', 'pr', 'failed', 'cancelled'] as const)(
  'abandons a child-held %s run with its own outcome and a child-work reason',
  async (outcome) => {
    await launch();
    providers[0]!.response.resolve(
      outcome === 'cancelled'
        ? { stopReason: 'cancelled' }
        : outcome === 'failed'
          ? {
              stopReason: 'end_turn',
              _meta: {
                jetbrains: {
                  air: { sessionFailure: { severity: 'error', title: 'Provider failed' } },
                },
              },
            }
          : { stopReason: 'end_turn' }
    );
    await consumer.drain();
    if (outcome === 'pr') {
      await db.prisma.agentRun.update({
        where: { id: h.claim.runId },
        data: {
          result: {
            version: 1,
            summary: '',
            pullRequests: [{ url: 'https://github.com/org/repo/pull/42', number: 42 }],
          },
        },
      });
    }
    const child = await h.creation.create({
      projectId: h.workspaceSource.projectId,
      name: 'Child',
      type: 'CHILD_WORKSPACE',
      parentWorkspaceId: h.claim.reservedWorkspaceId,
    });
    const input = await context();
    expect(await consumer.inspectRun(input)).toMatchObject({
      blocked: null,
      childHold: {
        children: [{ workspaceId: child.id, state: 'NOT_STARTED' }],
        keepsOutcome: outcome !== 'cancelled',
      },
    });
    await strictStop();
    expect(await consumer.resolveAmbiguousRun({ ...input, action: 'ABANDON' })).toMatchObject({
      status: 'ABANDONED',
    });
    expect(await row()).toMatchObject({
      status: {
        completed: 'COMPLETED',
        pr: 'PR_CREATED',
        failed: 'FAILED',
        cancelled: 'CANCELLED',
      }[outcome],
      launchPhase: 'FINISHED',
      leaseExpiresAt: null,
      reasonCode: 'ABANDONED_WITH_CHILD_WORK',
    });
    expect((await h.read()).evidence).toMatchObject({
      resolution: { action: 'ABANDON' },
      children: { counts: { NOT_STARTED: 1 }, held: [child.id] },
    });
  }
);
it('blocks Abandon when a child appears after the recovery observation', async () => {
  await launch();
  providers[0]!.response.resolve({ stopReason: 'end_turn' });
  await consumer.drain();
  await strictStop();
  const workspaces = await vi.importActual<typeof import('@/backend/services/workspace')>(
    '@/backend/services/workspace'
  );
  const read = workspaces.workspaceRelationshipsService.findChildRestFacts.bind(
    workspaces.workspaceRelationshipsService
  );
  vi.spyOn(workspaces.workspaceRelationshipsService, 'findChildRestFacts').mockImplementation(
    async (...args) => {
      const stale = await read(...args);
      await h.creation.create({
        projectId: h.workspaceSource.projectId,
        name: 'Late child',
        type: 'CHILD_WORKSPACE',
        parentWorkspaceId: h.claim.reservedWorkspaceId,
      });
      return stale;
    }
  );
  expect(
    await consumer.resolveAmbiguousRun({ ...(await context()), action: 'ABANDON' })
  ).toMatchObject({ status: 'BLOCKED' });
  expect(await row()).toMatchObject({ status: 'RUNNING' });
});
