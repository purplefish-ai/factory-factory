import { z } from 'zod';
import { ApplicationError } from '@/backend/lib/application-error';
import { slackConnectionAccessor } from '@/backend/services/agent-definition/resources/slack-connection.accessor';

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

export async function readSlackSource(options: {
  connectionId: string;
  decrypt: (value: string) => string;
  request: typeof fetch;
  channelId?: string;
  cursor?: string;
}) {
  const connection = await slackConnectionAccessor.get(options.connectionId);
  if (!(connection?.isEnabled && connection.credentialsEncrypted)) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'Connect this Slack workspace before selecting channels.'
    );
  }
  let token: string;
  try {
    token = options.decrypt(connection.credentialsEncrypted);
  } catch {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'Reconnect this Slack workspace to restore its credentials.'
    );
  }
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
