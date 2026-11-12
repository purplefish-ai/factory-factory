import { z } from 'zod';
import { isAgentGithubExecutableAction } from '@/shared/agent-runtime';
import { agentIssueEventPageSchema, type AgentIssueEventRequest } from '@/shared/agent-source';
import { agentSourcePageNumberSchema } from '@/shared/agent-source-state';
import { githubIssuePreviewInputSchema } from '@/shared/github-issue-preview';

const id = z.string().min(1).max(256);
// GitHub documents `actor` and `issue.user` as nullable: a deleted account reads as null.
const account = z.object({ id }).nullable();
type Read = (args: string[]) => Promise<{ stdout: string }>;
const controlSchema = z.object({
  id,
  event: z.string(),
  // GitHub documents `issue` as nullable and optional; without one a row is only an anchor.
  issue: z.object({ pull_request: z.unknown().optional() }).nullish(),
});
const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  html_url: z.url(),
  user: account,
  // GitHub documents each issue label as a name string or a label object.
  labels: z
    .array(z.union([z.string(), z.object({ name: z.string().nullish() })]))
    .optional()
    .transform((labels = []) =>
      labels
        .map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
        .filter((name) => name.length > 0)
        .map((name) => name.slice(0, 256))
        .slice(0, 100)
    ),
});
const executableSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('labeled'),
    created_at: z.iso.datetime(),
    actor: account,
    label: z.object({ name: z.string().min(1) }),
    issue: issueSchema,
  }),
  z.object({
    event: z.literal('reopened'),
    created_at: z.iso.datetime(),
    actor: account,
    issue: issueSchema,
  }),
]);

/** Node's parse source preserves numeric identities beyond Number.MAX_SAFE_INTEGER. */
function parseProviderJson(text: string): unknown {
  return JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) => {
    if (key === 'id' && typeof value === 'number') {
      if (!(context?.source && /^\d+$/.test(context.source))) {
        throw new Error('Invalid provider identity');
      }
      return context.source;
    }
    return value;
  });
}

export async function getAgentRepositoryIdentity(repository: string, read: Read) {
  githubIssuePreviewInputSchema.shape.repo.parse(repository);
  const result = await read(['api', `repos/${repository}`]);
  const repo = z
    .object({
      id,
      full_name: githubIssuePreviewInputSchema.shape.repo,
      has_issues: z.literal(true),
    })
    .parse(parseProviderJson(result.stdout));
  return { id: repo.id, name: repo.full_name };
}

function nextPage(headers: string, input: AgentIssueEventRequest) {
  const link = /^link:\s*(.+)$/im.exec(headers)?.[1];
  if (!link) {
    return null;
  }
  const next = link.split(',').find((part) => /rel="next"/.test(part));
  if (!next) {
    return null;
  }
  const address = /<([^>]+)>/.exec(next)?.[1];
  if (!address) {
    throw new Error('Invalid GitHub pagination');
  }
  const url = new URL(address);
  const allowedPaths = [
    `/repositories/${input.repositoryId}/issues/events`,
    `/repos/${input.repository}/issues/events`,
  ];
  const page = Number(url.searchParams.get('page'));
  if (
    url.origin !== 'https://api.github.com' ||
    url.username ||
    url.password ||
    url.hash ||
    !allowedPaths.includes(url.pathname) ||
    url.searchParams.get('per_page') !== '100' ||
    page !== input.page + 1 ||
    [...url.searchParams.keys()].some((key) => key !== 'page' && key !== 'per_page')
  ) {
    throw new Error('Invalid GitHub pagination');
  }
  return page;
}

export async function listAgentIssueEvents(input: AgentIssueEventRequest, read: Read) {
  githubIssuePreviewInputSchema.shape.repo.parse(input.repository);
  id.parse(input.repositoryId);
  agentSourcePageNumberSchema.parse(input.page);
  z.literal(100).parse(input.perPage);
  const result = await read([
    'api',
    `repos/${input.repository}/issues/events?per_page=100&page=${input.page}`,
    '--include',
    '-H',
    'X-GitHub-Api-Version: 2022-11-28',
  ]);
  const separator = /\r?\n\r?\n/.exec(result.stdout);
  if (!(separator && /^HTTP\/\S+ 200\b/.test(result.stdout))) {
    throw new Error('Invalid GitHub response');
  }
  const headers = result.stdout.slice(0, separator.index);
  const raw = z
    .array(z.unknown())
    .max(100)
    .parse(parseProviderJson(result.stdout.slice(separator.index + separator[0].length)));
  const observedAt = new Date().toISOString();
  const events = raw.map((row) => {
    const control = controlSchema.parse(row);
    if (
      !(isAgentGithubExecutableAction(control.event) && control.issue) ||
      control.issue.pull_request !== undefined
    ) {
      return { providerEventId: control.id, payload: null };
    }
    const event = executableSchema.parse(row);
    return {
      providerEventId: control.id,
      payload: {
        version: 1 as const,
        provider: 'GITHUB' as const,
        repositoryId: input.repositoryId,
        repositoryFullName: input.repository,
        action: event.event,
        actorId: event.actor?.id ?? null,
        creatorId: event.issue.user?.id ?? null,
        occurredAt: event.created_at,
        observedAt,
        sourceUrl: event.issue.html_url,
        issue: {
          number: event.issue.number,
          title: event.issue.title.slice(0, 4096),
          body: (event.issue.body ?? '').slice(0, 100_000),
          addedLabel: event.event === 'labeled' ? event.label.name.slice(0, 256) : null,
          labels: event.issue.labels,
        },
      },
    };
  });
  return agentIssueEventPageSchema.parse({ events, nextPage: nextPage(headers, input) });
}
