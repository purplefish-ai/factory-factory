import type { ResolvedReviewThreadsPage } from './schemas';
export interface TruncatedResolvedThread {
  threadId: string;
  afterCursor: string | null;
}

/**
 * Collect comment ids from resolved threads into resolvedIds, returning
 * continuations for resolved threads whose comment list was truncated at the
 * first page (they need follow-up node queries to fetch the tail).
 */
export function collectResolvedReviewCommentIds(
  threads: ResolvedReviewThreadsPage['nodes'],
  resolvedIds: Set<number>
): TruncatedResolvedThread[] {
  const truncatedThreads: TruncatedResolvedThread[] = [];
  for (const thread of threads) {
    if (!thread.isResolved) {
      continue;
    }
    for (const comment of thread.comments.nodes) {
      if (comment.fullDatabaseId !== null) {
        resolvedIds.add(comment.fullDatabaseId);
      }
    }
    if (thread.comments.pageInfo.hasNextPage) {
      truncatedThreads.push({
        threadId: thread.id,
        afterCursor: thread.comments.pageInfo.endCursor,
      });
    }
  }
  return truncatedThreads;
}
