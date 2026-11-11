import type { trpc } from '@/client/lib/trpc';

type TrpcUtils = ReturnType<typeof trpc.useUtils>;

/**
 * Invalidates every cached read of one project after it changes: the list,
 * by id and by slug. Active queries refetch; inactive ones refetch when next used.
 */
export function invalidateProject(utils: TrpcUtils, projectId: string): Promise<unknown> {
  return Promise.all([
    utils.project.list.invalidate(),
    utils.project.getById.invalidate({ id: projectId }),
    // Slug reads are keyed by slug, which callers that only know the id cannot name.
    utils.project.getBySlug.invalidate(),
  ]);
}
