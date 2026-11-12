import { describe, expect, it } from 'vitest';
import { classifySlackEnvelope } from './slack-event-message';

const listener = { connectionId: 'connection-1', workspaceId: 'T1', appId: 'A1' };
const observedAt = new Date('2026-11-12T10:00:00.000Z');

function envelope(event: Record<string, unknown>) {
  return {
    type: 'events_api',
    body: {
      type: 'event_callback',
      team_id: 'T1',
      api_app_id: 'A1',
      event_id: 'Ev1',
      event: {
        type: 'message',
        channel: 'C1',
        user: 'U-human',
        text: 'Screenshot of the failing checkout',
        ts: '1700000001.000200',
        ...event,
      },
    },
  };
}

function stored(decision: ReturnType<typeof classifySlackEnvelope>) {
  if (decision.kind !== 'STORE') {
    throw new Error(`Expected a stored message, got ${JSON.stringify(decision)}`);
  }
  return decision.event;
}

describe('classifySlackEnvelope', () => {
  it("stores a person's file share as a text-only message and keeps its subtype", () => {
    const event = stored(
      classifySlackEnvelope(
        listener,
        envelope({
          subtype: 'file_share',
          upload: true,
          files: [{ id: 'F1', name: 'checkout.png', url_private: 'https://files.slack.com/F1' }],
        }),
        observedAt
      )
    );
    expect(event.payload).toMatchObject({
      provider: 'SLACK',
      channelId: 'C1',
      actorType: 'HUMAN',
      actorId: 'U-human',
      subtype: 'file_share',
      threadTs: null,
      text: 'Screenshot of the failing checkout',
    });
    expect(JSON.stringify(event)).not.toContain('files.slack.com');
    expect(JSON.stringify(event)).not.toContain('checkout.png');
  });

  it("stores a person's thread reply also sent to the channel as a thread reply", () => {
    const event = stored(
      classifySlackEnvelope(
        listener,
        envelope({
          subtype: 'thread_broadcast',
          thread_ts: '1700000000.000100',
          root: { ts: '1700000000.000100', text: 'Root text', user: 'U-other' },
        }),
        observedAt
      )
    );
    expect(event.payload).toMatchObject({
      subtype: 'thread_broadcast',
      threadTs: '1700000000.000100',
      eventTs: '1700000001.000200',
      text: 'Screenshot of the failing checkout',
    });
    expect(JSON.stringify(event)).not.toContain('Root text');
  });

  it('stores an ordinary message with a null subtype', () => {
    expect(stored(classifySlackEnvelope(listener, envelope({}), observedAt)).payload).toMatchObject(
      { subtype: null }
    );
  });

  it.each([
    ['a bot file share', { subtype: 'file_share', bot_id: 'B1' }],
    ['a bot thread broadcast', { subtype: 'thread_broadcast', bot_profile: { id: 'B1' } }],
    ['a hidden file share', { subtype: 'file_share', hidden: true }],
    ['a bot message', { subtype: 'bot_message', bot_id: 'B1' }],
    ['an edit', { subtype: 'message_changed', message: { text: 'edited' } }],
    ['a delete', { subtype: 'message_deleted', deleted_ts: '1700000000.000100' }],
    ['a channel join', { subtype: 'channel_join' }],
    ['a /me message', { subtype: 'me_message' }],
    ['a file comment', { subtype: 'file_comment' }],
    ['a bot without a subtype', { bot_id: 'B1' }],
  ])('ignores %s', (_name, event) => {
    expect(classifySlackEnvelope(listener, envelope(event), observedAt)).toEqual({
      kind: 'IGNORE',
      reason: 'NOT_HUMAN_MESSAGE',
    });
  });
});
