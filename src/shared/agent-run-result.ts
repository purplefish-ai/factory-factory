import { agentRunResultSchema } from './agent-runtime';
import { parseGitHubPRLink } from './github-pr-preview';

/** Compact cache facts without a provider read; unhydrated GitHub links carry their number. */
export function compactAgentRunResult(prs: readonly { url: string; number: number | null }[]) {
  return agentRunResultSchema.parse({
    version: 1,
    summary: '',
    pullRequests: [
      ...new Map(
        prs.flatMap((pr) => {
          const parsed = agentRunResultSchema.shape.pullRequests.element.safeParse({
            url: pr.url,
            number: pr.number ?? parseGitHubPRLink(pr.url)?.number,
          });
          return parsed.success ? [[parsed.data.url.toLowerCase(), parsed.data] as const] : [];
        })
      ).values(),
    ].slice(0, 20),
  });
}
