import { z } from 'zod';
import { ApplicationError, type ApplicationErrorCode } from '@/backend/lib/application-error';
import { callSlackApi, slackFailureSchema } from './slack-api';

const botInfoSchema = z.object({
  ok: z.literal(true),
  bot: z.object({ id: z.string().min(1), app_id: z.string().min(1) }),
});
const socketTicketSchema = z.object({ ok: z.literal(true), url: z.string().min(1) });

/** Resolves the Slack app that owns a bot with `bots.info`; needs the bot's `users:read` scope. */
export async function resolveSlackBotAppId(request: typeof fetch, botToken: string, botId: string) {
  const body = await callSlackApi(request, 'bots.info', botToken, { query: { bot: botId } });
  const failure = slackFailureSchema.safeParse(body);
  if (failure.success) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      failure.data.error === 'missing_scope'
        ? 'Slack did not let the bot read its own app. Add the users:read bot scope, reinstall the Slack app, and reconnect.'
        : 'Slack could not confirm which app this bot belongs to. Try again.'
    );
  }
  const info = botInfoSchema.safeParse(body);
  if (!(info.success && info.data.bot.id === botId)) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'Slack returned an invalid bot app identity. Try again.'
    );
  }
  return info.data.bot.app_id;
}

/**
 * Validates an app-level token with `apps.connections.open`. The returned
 * Socket Mode URL is a live credential: it is read here only for the app ID
 * Slack embeds in it and then dropped, never stored, returned or logged.
 * Slack does not document that parameter, so its absence is accepted and the
 * listener enforces the app on each connection and event.
 */
export async function verifySlackAppToken(
  request: typeof fetch,
  appToken: string,
  expectedAppId: string,
  rejection: Extract<ApplicationErrorCode, 'INVALID_INPUT' | 'PRECONDITION_FAILED'>
) {
  const body = await callSlackApi(request, 'apps.connections.open', appToken, { post: true });
  if (slackFailureSchema.safeParse(body).success) {
    throw new ApplicationError(
      rejection,
      'Slack rejected this app-level token. Check that Socket Mode is on, the token has the connections:write scope, and it has not been revoked.'
    );
  }
  const ticket = socketTicketSchema.safeParse(body);
  const reportedAppId = ticket.success ? socketAppId(ticket.data.url) : undefined;
  if (reportedAppId === undefined) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'Slack returned an invalid Socket Mode response. Try again.'
    );
  }
  if (reportedAppId !== null && reportedAppId !== expectedAppId) {
    throw new ApplicationError(
      rejection,
      'This app-level token belongs to a different Slack app than the bot token. Create the token in the same Slack app.'
    );
  }
}

/** The `app_id` in a Socket Mode URL, null when absent, undefined when the URL is not a socket URL. */
function socketAppId(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  return url.protocol === 'wss:' ? url.searchParams.get('app_id') : undefined;
}
