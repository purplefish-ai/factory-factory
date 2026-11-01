import { z } from 'zod';
import { agentEventPayloadSchema } from './agent-runtime';
import { agentSourcePageNumberSchema } from './agent-source-state';

const id = z.string().min(1).max(256);
export const agentIssueEventPageSchema = z
  .strictObject({
    events: z
      .array(z.strictObject({ providerEventId: id, payload: agentEventPayloadSchema.nullable() }))
      .max(100),
    nextPage: agentSourcePageNumberSchema.nullable(),
  })
  .refine(
    (page) =>
      new Set(page.events.map((event) => event.providerEventId)).size === page.events.length,
    'Duplicate feed identities'
  );
export type AgentIssueEventPage = z.infer<typeof agentIssueEventPageSchema>;
export interface AgentIssueEventRequest {
  repository: string;
  repositoryId: string;
  page: number;
  perPage: 100;
}
export interface AgentGitHubSourcePort {
  getRepositoryIdentity(
    repository: string,
    signal?: AbortSignal
  ): Promise<{ id: string; name: string }>;
  listIssueEvents(
    input: AgentIssueEventRequest,
    signal?: AbortSignal
  ): Promise<AgentIssueEventPage>;
  classifyError(error: unknown): string;
}
