import { useQueryClient } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { useState } from 'react';
import { type AppRouter, trpc } from '@/client/lib/trpc';
import { beginWorkspaceArchiveOperation } from '@/client/lib/workspace-archive-operation';
import { ARCHIVE_MANY_MAX_IDS } from '@/shared/workspace-archive';

export type WorkspaceArchiveOutcome =
  | { id: string; success: true }
  | { id: string; success: false; error: unknown };

type ArchiveManyResult =
  inferRouterOutputs<AppRouter>['workspace']['archiveMany']['results'][number];

function toArchiveOutcome(
  id: string,
  result: ArchiveManyResult | undefined
): WorkspaceArchiveOutcome {
  if (!result) {
    return {
      id,
      success: false,
      error: new Error('The server returned no result for this workspace'),
    };
  }
  if (result.success) {
    return { id, success: true };
  }
  return {
    id,
    success: false,
    error: {
      data: { code: result.code, applicationErrorKind: result.applicationErrorKind },
      message: result.error,
    },
  };
}

interface ArchiveTarget {
  projectId: string | undefined;
  ids: readonly string[];
}

/** One cache transaction owner for both archive endpoints; presentation stays with callers. */
export function useWorkspaceArchiveCommand() {
  const queryClient = useQueryClient();
  const utils = trpc.useUtils();
  const single = trpc.workspace.archive.useMutation({ meta: { errorToast: false } });
  const many = trpc.workspace.archiveMany.useMutation({ meta: { errorToast: false } });

  // Not the mutations' isPending: an observer tracks only its latest call, while
  // several archives can run at once, and an archive stays in progress from the
  // list cancel before the request until the caches are repaired after it.
  const [active, setActive] = useState({ single: 0, bulk: 0 });

  const executeArchive = async (
    target: ArchiveTarget,
    mutate: (ids: readonly string[]) => Promise<WorkspaceArchiveOutcome[]>
  ): Promise<WorkspaceArchiveOutcome[]> => {
    const { projectId } = target;
    const ids = [...target.ids];
    let operation: ReturnType<typeof beginWorkspaceArchiveOperation> | undefined;
    let outcomes: WorkspaceArchiveOutcome[];
    try {
      if (projectId) {
        await utils.workspace.listForProject.cancel({ projectId });
        operation = beginWorkspaceArchiveOperation(queryClient, projectId, ids);
      }
      outcomes = await mutate(ids);
    } catch (error) {
      outcomes = ids.map((id) => ({ id, success: false, error }));
    }
    operation?.settle(
      outcomes.filter((result) => !result.success).map((result) => result.id),
      outcomes.filter((result) => result.success).map((result) => result.id)
    );
    const affectedIds = [...new Set([...ids, ...outcomes.map((result) => result.id)])];
    // Mutation outcomes are final. A repair failure cannot turn success into failure.
    await Promise.allSettled([
      ...(projectId
        ? [Promise.resolve().then(() => utils.workspace.listForProject.invalidate({ projectId }))]
        : []),
      ...affectedIds.map((id) =>
        Promise.resolve().then(() => utils.workspace.get.invalidate({ id }))
      ),
      // The Setup logs tab stops polling once setup settles, and archive
      // releases the log, so refresh it to show the archived state.
      ...affectedIds.map((id) =>
        Promise.resolve().then(() => utils.workspace.getInitStatus.invalidate({ id }))
      ),
    ]);
    return outcomes;
  };

  const execute = async (
    kind: 'single' | 'bulk',
    target: ArchiveTarget,
    mutate: (ids: readonly string[]) => Promise<WorkspaceArchiveOutcome[]>
  ) => {
    setActive((current) => ({ ...current, [kind]: current[kind] + 1 }));
    try {
      return await executeArchive(target, mutate);
    } finally {
      setActive((current) => ({ ...current, [kind]: current[kind] - 1 }));
    }
  };

  const archiveWorkspace = ({
    projectId,
    id,
    removeGitIndexLock,
  }: {
    projectId: string | undefined;
    id: string;
    removeGitIndexLock?: boolean;
  }) =>
    execute('single', { projectId, ids: [id] }, async () => {
      await single.mutateAsync(removeGitIndexLock ? { id, removeGitIndexLock: true } : { id });
      return [{ id, success: true }];
    });

  /** Archives exactly these workspaces; each gets its own outcome. */
  const archiveWorkspaces = ({ projectId, ids }: { projectId: string; ids: readonly string[] }) =>
    execute('bulk', { projectId, ids }, async (capturedIds) => {
      const outcomes: WorkspaceArchiveOutcome[] = [];
      for (let start = 0; start < capturedIds.length; start += ARCHIVE_MANY_MAX_IDS) {
        const chunk = capturedIds.slice(start, start + ARCHIVE_MANY_MAX_IDS);
        try {
          const result = await many.mutateAsync({ projectId, ids: [...chunk] });
          const byId = new Map(result.results.map((item) => [item.id, item]));
          for (const id of chunk) {
            outcomes.push(toArchiveOutcome(id, byId.get(id)));
          }
        } catch (error) {
          outcomes.push(...chunk.map((id) => ({ id, success: false as const, error })));
        }
      }
      return outcomes;
    });

  return {
    archiveWorkspace,
    archiveWorkspaces,
    isArchiving: active.single > 0,
    isBulkArchiving: active.bulk > 0,
  };
}
