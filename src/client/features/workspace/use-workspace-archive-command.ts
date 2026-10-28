import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { trpc } from '@/client/lib/trpc';
import { beginWorkspaceArchiveOperation } from '@/client/lib/workspace-archive-operation';

export type WorkspaceArchiveOutcome =
  | { id: string; success: true }
  | { id: string; success: false; error: unknown };

interface ArchiveTarget {
  projectId: string | undefined;
  ids: readonly string[];
}

/** One cache transaction owner for both archive endpoints; presentation stays with callers. */
export function useWorkspaceArchiveCommand() {
  const queryClient = useQueryClient();
  const utils = trpc.useUtils();
  const single = trpc.workspace.archive.useMutation();
  const bulk = trpc.workspace.bulkArchive.useMutation();

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

  const archiveColumn = ({
    projectId,
    ids,
    kanbanColumn,
  }: {
    projectId: string;
    ids: readonly string[];
    kanbanColumn: 'WORKING' | 'WAITING' | 'DONE';
  }) =>
    execute('bulk', { projectId, ids }, async (capturedIds) => {
      const result = await bulk.mutateAsync({ projectId, kanbanColumn });
      const failures = new Map(
        result.results.filter((item) => !item.success).map((item) => [item.id, item])
      );
      // Omitted results retain the existing bulk endpoint's success semantics.
      return [...new Set([...capturedIds, ...result.results.map((item) => item.id)])].map((id) => {
        const failure = failures.get(id);
        return failure
          ? {
              id,
              success: false,
              error: {
                data: { code: failure.code, applicationErrorKind: failure.applicationErrorKind },
                message: failure.error,
              },
            }
          : { id, success: true };
      });
    });

  return {
    archiveWorkspace,
    archiveColumn,
    isArchiving: active.single > 0,
    isBulkArchiving: active.bulk > 0,
  };
}
