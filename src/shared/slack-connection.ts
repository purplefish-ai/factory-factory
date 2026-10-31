import { z } from 'zod';

export const slackConnectInputSchema = z.strictObject({
  botToken: z
    .string()
    .trim()
    .regex(
      /^(?:xoxe\.)?xoxb-[A-Za-z0-9-]+$/,
      'Enter a Slack bot token starting with xoxb- or xoxe.xoxb-'
    )
    .max(4096),
});
export const slackConnectionSummarySchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  workspaceId: z.string(),
  isEnabled: z.boolean(),
  hasCredentials: z.boolean(),
});
export const slackConnectionTestSchema = z.strictObject({
  valid: z.literal(true),
  workspaceName: z.string(),
});
export type SlackConnectionSummary = z.infer<typeof slackConnectionSummarySchema>;
