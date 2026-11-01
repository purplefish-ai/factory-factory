import { z } from 'zod';
import {
  eventAgentExecutionSchema,
  eventLaunchIdentifierSchema,
} from '@/shared/event-agent-launch';
import { agentRunInputSchema } from '@/shared/schemas/agent-definition.schema';

const identifier = eventLaunchIdentifierSchema;
export const eventWorkspaceSourceSchema = z.strictObject({
  type: z.literal('EVENT_AGENT'),
  runId: identifier,
  projectId: identifier,
  reservedWorkspaceId: identifier,
  reservedSessionId: identifier,
  initialMessageId: identifier,
  name: z.string().min(1).max(256),
  execution: eventAgentExecutionSchema,
  input: agentRunInputSchema,
  issue: z.strictObject({ number: z.number().int().positive(), url: z.url() }).optional(),
});
export type EventWorkspaceSource = z.infer<typeof eventWorkspaceSourceSchema>;
