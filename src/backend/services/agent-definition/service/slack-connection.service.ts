import { z } from 'zod';
import { ApplicationError } from '@/backend/lib/application-error';
import { slackConnectInputSchema, type SlackConnectionSummary } from '@/shared/slack-connection';
import { slackConnectionAccessor } from '../resources/slack-connection.accessor';

const botIdentitySchema = z.object({
  ok: z.literal(true),
  team_id: z.string().min(1),
  team: z.string().min(1),
  user_id: z.string().min(1),
  bot_id: z.string().min(1),
});
const slackFailureSchema = z.object({ ok: z.literal(false), error: z.string() });
type Crypto = { encrypt(value: string): string; decrypt(value: string): string };
type Connection = Awaited<ReturnType<typeof slackConnectionAccessor.save>>;

function summary(connection: Connection): SlackConnectionSummary {
  return {
    id: connection.id,
    name: connection.name,
    workspaceId: connection.externalId,
    isEnabled: connection.isEnabled,
    hasCredentials: Boolean(connection.credentialsEncrypted),
  };
}

/** Tokens stay server-side. Provider errors are never propagated verbatim. */
export class SlackConnectionService {
  constructor(
    private readonly crypto: Crypto,
    private readonly request: typeof fetch = fetch
  ) {}

  async list() {
    return (await slackConnectionAccessor.list()).map(summary);
  }

  async connect(input: unknown) {
    const { botToken } = slackConnectInputSchema.parse(input);
    const identity = await this.identify(botToken);
    const connection = await slackConnectionAccessor.save(
      identity.team_id,
      identity.team,
      this.crypto.encrypt(botToken)
    );
    return summary(connection);
  }

  async test(id: string) {
    const connection = await slackConnectionAccessor.get(id);
    if (!connection?.credentialsEncrypted) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'No Slack credentials are saved for this connection.'
      );
    }
    let token: string;
    try {
      token = this.crypto.decrypt(connection.credentialsEncrypted);
    } catch {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Could not decrypt Slack credentials. Reconnect this workspace.'
      );
    }
    const identity = await this.identify(token);
    if (identity.team_id !== connection.externalId) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'The saved Slack token identifies a different workspace. Reconnect this workspace.'
      );
    }
    return { valid: true as const, workspaceName: identity.team };
  }

  async disconnect(id: string) {
    const result = await slackConnectionAccessor.disconnect(id);
    if (!result.count) {
      throw new ApplicationError('NOT_FOUND', 'Slack connection not found.');
    }
    return { disconnected: true };
  }

  private async identify(token: string) {
    let response: Response;
    let body: unknown;
    try {
      response = await this.request('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
    } catch {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Could not reach Slack. Check your connection and try again.'
      );
    }
    if (!response.ok) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        response.status === 429
          ? 'Slack is rate limiting requests. Wait a moment and try again.'
          : 'Slack could not validate this connection. Try again.'
      );
    }
    try {
      body = await response.json();
    } catch {
      throw new ApplicationError(
        'INVALID_INPUT',
        'Slack returned an invalid bot identity. Use a workspace bot token.'
      );
    }
    const failure = slackFailureSchema.safeParse(body);
    if (failure.success) {
      throw new ApplicationError(
        'INVALID_INPUT',
        'Slack rejected this bot token. Check that it is valid and has not been revoked.'
      );
    }
    const identity = botIdentitySchema.safeParse(body);
    if (!identity.success) {
      throw new ApplicationError(
        'INVALID_INPUT',
        'Slack returned an invalid bot identity. Use a workspace bot token.'
      );
    }
    return identity.data;
  }
}
