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
/** Socket Mode app-level token; its app is verified against the bot, never inferred from the prefix. */
export const slackAppTokenSchema = z
  .string()
  .trim()
  .regex(/^xapp-[A-Za-z0-9-]+$/, 'Enter a Slack app-level token starting with xapp-')
  .max(4096);
export const slackSetAppTokenInputSchema = z.strictObject({
  connectionId: z.string().min(1),
  appToken: slackAppTokenSchema,
});
export const slackClearAppTokenInputSchema = z.strictObject({ connectionId: z.string().min(1) });
export const slackConnectionSummarySchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  workspaceId: z.string(),
  isEnabled: z.boolean(),
  hasCredentials: z.boolean(),
  hasAppToken: z.boolean(),
  /** The bot's Slack app, resolved when the app-level token was saved. */
  appId: z.string().nullable(),
});
export const slackConnectionTestSchema = z.strictObject({
  valid: z.literal(true),
  workspaceName: z.string(),
});
export type SlackConnectionSummary = z.infer<typeof slackConnectionSummarySchema>;
