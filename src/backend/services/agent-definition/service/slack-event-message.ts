import { z } from 'zod';
import { agentEventInputSchema, type AgentEventInput } from '@/shared/agent-runtime';

/** The stored text cap of the Slack event payload schema. */
const MAX_TEXT = 100_000;
const TRUNCATION_MARKER = '\n[Message truncated by Factory Factory]';

const identitySchema = z.object({ team_id: z.string(), api_app_id: z.string() });
const callbackSchema = z.object({
  type: z.literal('event_callback'),
  event_id: z.string(),
  event: z.looseObject({ type: z.string() }),
});
/**
 * A person's message that shares files or also sends a thread reply to the channel is stored
 * like an ordinary message, text only; the files themselves are never stored or fetched, so a
 * file share without a comment carries nothing to act on and is ignored.
 */
export const slackHumanSubtypes = ['file_share', 'thread_broadcast'] as const;
const humanMessageSchema = z.object({
  type: z.literal('message'),
  subtype: z.enum(slackHumanSubtypes).optional(),
  channel: z.string(),
  user: z.string(),
  ts: z.string(),
  thread_ts: z.string().optional(),
  text: z.string().optional(),
});

export type SlackListenerIdentity = { connectionId: string; workspaceId: string; appId: string };
export type SlackEnvelopeDecision =
  | { kind: 'STORE'; channelId: string; event: AgentEventInput }
  | {
      kind: 'IGNORE';
      reason:
        | 'UNSUPPORTED_ENVELOPE'
        | 'UNSUPPORTED_EVENT'
        | 'NOT_HUMAN_MESSAGE'
        | 'BLANK_FILE_SHARE'
        | 'INVALID_PAYLOAD';
    }
  | { kind: 'REJECT'; reason: 'SLACK_APP_MISMATCH' | 'SLACK_WORKSPACE_MISMATCH' };

/**
 * Classifies one Socket Mode envelope for a verified listener. Identity is
 * checked before anything else: an events_api envelope for another app or
 * workspace is rejected, never stored. Only human messages (roots and thread
 * replies with no bot identity, and no subtype other than a file share or a
 * thread reply also sent to the channel) become ledger input.
 */
export function classifySlackEnvelope(
  listener: SlackListenerIdentity,
  envelope: { type: string; body: unknown },
  observedAt: Date
): SlackEnvelopeDecision {
  if (envelope.type !== 'events_api') {
    return { kind: 'IGNORE', reason: 'UNSUPPORTED_ENVELOPE' };
  }
  const identity = identitySchema.safeParse(envelope.body);
  if (!identity.success || identity.data.api_app_id !== listener.appId) {
    return { kind: 'REJECT', reason: 'SLACK_APP_MISMATCH' };
  }
  if (identity.data.team_id !== listener.workspaceId) {
    return { kind: 'REJECT', reason: 'SLACK_WORKSPACE_MISMATCH' };
  }
  const callback = callbackSchema.safeParse(envelope.body);
  if (!callback.success) {
    return { kind: 'IGNORE', reason: 'INVALID_PAYLOAD' };
  }
  const event = callback.data.event;
  if (event.type !== 'message') {
    return { kind: 'IGNORE', reason: 'UNSUPPORTED_EVENT' };
  }
  if (
    ('subtype' in event && !slackHumanSubtypes.some((subtype) => subtype === event.subtype)) ||
    'bot_id' in event ||
    'bot_profile' in event ||
    'hidden' in event
  ) {
    return { kind: 'IGNORE', reason: 'NOT_HUMAN_MESSAGE' };
  }
  const message = humanMessageSchema.safeParse(event);
  if (!message.success) {
    return { kind: 'IGNORE', reason: 'INVALID_PAYLOAD' };
  }
  if (message.data.subtype === 'file_share' && !message.data.text?.trim()) {
    return { kind: 'IGNORE', reason: 'BLANK_FILE_SHARE' };
  }
  const input = agentEventInputSchema.safeParse(
    eventInput(listener, callback.data.event_id, message.data, observedAt)
  );
  return input.success
    ? { kind: 'STORE', channelId: message.data.channel, event: input.data }
    : { kind: 'IGNORE', reason: 'INVALID_PAYLOAD' };
}

function eventInput(
  listener: SlackListenerIdentity,
  eventId: string,
  message: z.infer<typeof humanMessageSchema>,
  observedAt: Date
) {
  const threadTs = message.thread_ts ?? null;
  return {
    connectionId: listener.connectionId,
    providerEventId: eventId,
    payload: {
      version: 1,
      provider: 'SLACK',
      workspaceId: listener.workspaceId,
      appId: listener.appId,
      channelId: message.channel,
      action: 'message',
      eventTs: message.ts,
      threadTs,
      actorType: 'HUMAN',
      actorId: message.user,
      subtype: message.subtype ?? null,
      text: boundedText(message.text ?? ''),
      occurredAt: slackTimestampIso(message.ts),
      observedAt: observedAt.toISOString(),
      sourceUrl: permalink(message.channel, message.ts, threadTs),
    },
  };
}

/** Slack caps messages far below this; the bound protects the ledger from malformed input. */
function boundedText(text: string) {
  if (text.length <= MAX_TEXT) {
    return text;
  }
  let end = MAX_TEXT - TRUNCATION_MARKER.length;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd8_00 && code <= 0xdb_ff) {
    end -= 1;
  }
  return `${text.slice(0, end)}${TRUNCATION_MARKER}`;
}

/** Slack `ts` values are seconds with a fractional sequence; milliseconds keep their order. */
export function slackTimestampIso(ts: string) {
  const [seconds = '', fraction = ''] = ts.split('.');
  const millis = Number(seconds) * 1000 + Number(fraction.padEnd(3, '0').slice(0, 3));
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function permalink(channel: string, ts: string, threadTs: string | null) {
  const url = new URL(
    `https://slack.com/archives/${encodeURIComponent(channel)}/p${ts.replace('.', '')}`
  );
  if (threadTs && threadTs !== ts) {
    url.searchParams.set('thread_ts', threadTs);
    url.searchParams.set('cid', channel);
  }
  return url.toString();
}
