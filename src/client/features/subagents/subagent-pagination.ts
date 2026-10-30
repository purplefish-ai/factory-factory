import type { SubagentListResult } from './types';

export function getNextSubagentPageParam(
  lastPage: SubagentListResult,
  _pages: SubagentListResult[],
  _lastPageParam: unknown,
  pageParams: unknown[]
): string | undefined {
  if (!(lastPage.supported && lastPage.nextCursor) || pageParams.includes(lastPage.nextCursor)) {
    return undefined;
  }
  return lastPage.nextCursor;
}

export function getSubagentListError(query: {
  error: { message: string } | null;
  data?: { pages: SubagentListResult[]; pageParams: unknown[] };
}): { message: string } | null {
  if (query.error || !query.data) {
    return query.error;
  }
  const lastPage = query.data.pages.at(-1);
  if (
    lastPage?.supported &&
    lastPage.nextCursor &&
    query.data.pageParams.includes(lastPage.nextCursor)
  ) {
    return { message: 'The provider repeated a sub-agent page cursor. Retry to reload the list.' };
  }
  return null;
}
