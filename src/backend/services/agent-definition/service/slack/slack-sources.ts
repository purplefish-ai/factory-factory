import { z } from 'zod';
import { ApplicationError } from '@/backend/lib/application-error';
import { slackConnectionAccessor } from '@/backend/services/agent-definition/resources/slack/slack-connection.accessor';

const channelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  is_member: z.boolean(),
  is_archived: z.boolean(),
});
const pageSchema = z.object({
  ok: z.literal(true),
  channels: z.array(channelSchema),
  response_metadata: z.object({ next_cursor: z.string().default('') }).optional(),
});
const infoSchema = z.object({ ok: z.literal(true), channel: channelSchema });

/**
 * Internal bot-token lookup for channel discovery and message context. The token
 * never leaves the capsule's Slack calls.
 */
export async function readSlackBotCredentials(
  connectionId: string,
  decrypt: (value: string) => string
): Promise<
  | { status: 'READY'; token: string; workspaceId: string }
  | { status: 'NOT_CONNECTED' | 'UNREADABLE' }
> {
  const connection = await slackConnectionAccessor.get(connectionId);
  if (!(connection?.isEnabled && connection.credentialsEncrypted)) {
    return { status: 'NOT_CONNECTED' };
  }
  try {
    return {
      status: 'READY',
      token: decrypt(connection.credentialsEncrypted),
      workspaceId: connection.externalId,
    };
  } catch {
    return { status: 'UNREADABLE' };
  }
}

export async function readSlackSource(options: {
  connectionId: string;
  decrypt: (value: string) => string;
  request: typeof fetch;
  channelId?: string;
  cursor?: string;
}) {
  const credentials = await readSlackBotCredentials(options.connectionId, options.decrypt);
  if (credentials.status !== 'READY') {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      credentials.status === 'NOT_CONNECTED'
        ? 'Connect this Slack workspace before selecting channels.'
        : 'Reconnect this Slack workspace to restore its credentials.'
    );
  }
  const { token } = credentials;
  const url = new URL(`https://slack.com/api/conversations.${options.channelId ? 'info' : 'list'}`);
  if (options.channelId) {
    url.searchParams.set('channel', options.channelId);
  } else {
    url.searchParams.set('types', 'public_channel,private_channel');
    url.searchParams.set('exclude_archived', 'true');
    url.searchParams.set('limit', '200');
    if (options.cursor) {
      url.searchParams.set('cursor', options.cursor);
    }
  }
  try {
    const response = await options.request(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error('Slack request failed');
    }
    const body: unknown = await response.json();
    const page = options.channelId ? null : pageSchema.parse(body);
    const channels = page ? page.channels : [infoSchema.parse(body).channel];
    const accessible = channels.filter((channel) => channel.is_member && !channel.is_archived);
    if (options.channelId && accessible[0]?.id !== options.channelId) {
      throw new Error('Channel unavailable');
    }
    return {
      channels: accessible.map(({ id, name }) => ({ id, name })),
      nextCursor: page?.response_metadata?.next_cursor || null,
    };
  } catch {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'Could not read Slack channels. Check bot permissions and channel membership, then retry.'
    );
  }
}
