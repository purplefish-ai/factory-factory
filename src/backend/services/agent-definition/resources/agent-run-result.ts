import { agentRunResultSchema } from '@/shared/agent-runtime';

type Result = ReturnType<typeof agentRunResultSchema.parse>;

export function mergeRunResults(stored: unknown, incoming: Result): Result {
  const previous = stored === null ? null : agentRunResultSchema.parse(stored);
  return agentRunResultSchema.parse({
    version: 1,
    summary: previous?.summary || incoming.summary,
    pullRequests: [
      ...new Map(
        [...(previous?.pullRequests ?? []), ...incoming.pullRequests].map((pr) => [
          pr.url.toLowerCase(),
          pr,
        ])
      ).values(),
    ].slice(0, 20),
  });
}
