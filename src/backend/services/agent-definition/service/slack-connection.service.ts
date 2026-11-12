import { z } from 'zod';
import { ApplicationError } from '@/backend/lib/application-error';
import { slackConnectionAccessor } from '@/backend/services/agent-definition/resources/slack-connection.accessor';
import { slackConnectInputSchema, slackSetAppTokenInputSchema } from '@/shared/slack-connection';
import { callSlackApi, slackFailureSchema } from './slack-api';
import { resolveSlackBotAppId, verifySlackAppToken } from './slack-app-identity';
import { readSlackSource } from './slack-sources';

const botIdentitySchema = z.object({
  ok: z.literal(true),
  team_id: z.string().min(1),
  team: z.string().min(1),
  user_id: z.string().min(1),
  bot_id: z.string().min(1),
});
type Crypto = { encrypt(value: string): string; decrypt(value: string): string };
type StoredConnection = NonNullable<Awaited<ReturnType<typeof slackConnectionAccessor.get>>>;

/** Tokens stay server-side. Provider errors are never propagated verbatim. */
export class SlackConnectionService {
  constructor(
    private readonly crypto: Crypto,
    private readonly request: typeof fetch = fetch
  ) {}

  list() {
    return slackConnectionAccessor.list();
  }

  channels(connectionId: string, cursor?: string) {
    return readSlackSource({
      connectionId,
      cursor,
      decrypt: (value) => this.crypto.decrypt(value),
      request: this.request,
    });
  }

  async channel(connectionId: string, channelId: string) {
    const result = await readSlackSource({
      connectionId,
      channelId,
      decrypt: (value) => this.crypto.decrypt(value),
      request: this.request,
    });
    const channel = result.channels[0];
    if (!channel) {
      throw new ApplicationError('PRECONDITION_FAILED', 'Slack channel is unavailable.');
    }
    return channel;
  }

  async connect(input: unknown) {
    const { botToken } = slackConnectInputSchema.parse(input);
    const identity = await this.identify(botToken);
    const connection = await slackConnectionAccessor.save(
      identity.team_id,
      identity.team,
      this.crypto.encrypt(botToken),
      await this.appIdToKeep(identity, botToken)
    );
    return connection;
  }

  /**
   * A saved app-level token stays with a replacement bot only if Slack confirms
   * the bot belongs to the same app; otherwise saving clears it (fail closed).
   */
  private async appIdToKeep(identity: { team_id: string; bot_id: string }, botToken: string) {
    const storedAppId = await slackConnectionAccessor.appIdForWorkspace(identity.team_id);
    if (!storedAppId) {
      return null;
    }
    const appId = await resolveSlackBotAppId(this.request, botToken, identity.bot_id).catch(
      () => null
    );
    return appId === storedAppId ? storedAppId : null;
  }

  async test(id: string) {
    const connection = await slackConnectionAccessor.get(id);
    if (!connection?.credentialsEncrypted) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'No Slack credentials are saved for this connection.'
      );
    }
    const token = this.decryptBotToken(connection.credentialsEncrypted);
    const identity = await this.workspaceBot(token, connection.externalId);
    if (connection.appCredentialsEncrypted) {
      const appToken = this.decryptAppToken(connection.appCredentialsEncrypted);
      const appId = await resolveSlackBotAppId(this.request, token, identity.bot_id);
      if (appId !== connection.appId) {
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          'The bot now belongs to a different Slack app than the saved app-level token. Save an app-level token from the same app.'
        );
      }
      await verifySlackAppToken(this.request, appToken, appId, 'PRECONDITION_FAILED');
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

  /**
   * Saves a Socket Mode app-level token after confirming, with the saved bot
   * token, which app the bot belongs to and that Slack accepts the app token.
   */
  async setAppToken(input: unknown) {
    const { connectionId, appToken } = slackSetAppTokenInputSchema.parse(input);
    const connection = await this.requireConnection(connectionId);
    if (!(connection.isEnabled && connection.credentialsEncrypted)) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Connect this Slack workspace with a bot token before adding an app-level token.'
      );
    }
    const botToken = this.decryptBotToken(connection.credentialsEncrypted);
    const identity = await this.workspaceBot(botToken, connection.externalId);
    const appId = await resolveSlackBotAppId(this.request, botToken, identity.bot_id);
    await verifySlackAppToken(this.request, appToken, appId, 'INVALID_INPUT');
    const saved = await slackConnectionAccessor.saveAppCredentials({
      id: connection.id,
      validatedBotCredentials: connection.credentialsEncrypted,
      appCredentialsEncrypted: this.crypto.encrypt(appToken),
      appId,
    });
    if (!saved) {
      throw new ApplicationError(
        'CONFLICT',
        'This Slack connection changed while the app-level token was being checked. Try again.'
      );
    }
    return saved;
  }

  async clearAppToken(connectionId: string) {
    const cleared = await slackConnectionAccessor.clearAppCredentials(connectionId);
    if (!cleared) {
      throw new ApplicationError('NOT_FOUND', 'Slack connection not found.');
    }
    return cleared;
  }

  /**
   * Internal lookup for the Socket Mode listener. Returns null unless the
   * connection is enabled with both tokens and a resolved app ID.
   */
  async getAppCredentials(connectionId: string) {
    const connection = await slackConnectionAccessor.get(connectionId);
    if (
      !(
        connection?.isEnabled &&
        connection.credentialsEncrypted &&
        connection.appCredentialsEncrypted &&
        connection.appId
      )
    ) {
      return null;
    }
    return {
      connectionId: connection.id,
      workspaceId: connection.externalId,
      appId: connection.appId,
      appToken: this.decryptAppToken(connection.appCredentialsEncrypted),
    };
  }

  private async requireConnection(id: string): Promise<StoredConnection> {
    const connection = await slackConnectionAccessor.get(id);
    if (!connection) {
      throw new ApplicationError('NOT_FOUND', 'Slack connection not found.');
    }
    return connection;
  }

  private decryptBotToken(value: string) {
    try {
      return this.crypto.decrypt(value);
    } catch {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Could not decrypt Slack credentials. Reconnect this workspace.'
      );
    }
  }

  private decryptAppToken(value: string) {
    try {
      return this.crypto.decrypt(value);
    } catch {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Could not decrypt the Slack app-level token. Save it again in Slack settings.'
      );
    }
  }

  /** Identifies a saved bot token and requires it to still belong to the connection's workspace. */
  private async workspaceBot(token: string, workspaceId: string) {
    const identity = await this.identify(token, 'PRECONDITION_FAILED');
    if (identity.team_id !== workspaceId) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'The saved Slack token identifies a different workspace. Reconnect this workspace.'
      );
    }
    return identity;
  }

  private async identify(
    token: string,
    identityError: 'INVALID_INPUT' | 'PRECONDITION_FAILED' = 'INVALID_INPUT'
  ) {
    const body = await callSlackApi(this.request, 'auth.test', token, { post: true });
    const failure = slackFailureSchema.safeParse(body);
    if (failure.success) {
      throw new ApplicationError(
        identityError,
        'Slack rejected this bot token. Check that it is valid and has not been revoked.'
      );
    }
    const identity = botIdentitySchema.safeParse(body);
    if (!identity.success) {
      throw new ApplicationError(
        identityError,
        'Slack returned an invalid bot identity. Use a workspace bot token.'
      );
    }
    return identity.data;
  }
}
