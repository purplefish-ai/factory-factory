import { expect, it } from 'vitest';
import * as runtime from '@/backend/services/agent-definition';
import type { AgentEventPayload, AgentTriggerInput } from '@/backend/services/agent-definition';

const github: AgentEventPayload = {
  version: 1,
  provider: 'GITHUB',
  repositoryId: 'repo',
  repositoryFullName: 'org/repo',
  action: 'labeled',
  actorId: 'human',
  creatorId: 'creator',
  occurredAt: new Date().toISOString(),
  observedAt: new Date().toISOString(),
  sourceUrl: 'https://github.com/org/repo/issues/1',
  issue: {
    number: 1,
    title: 'Bug',
    body: 'already has wanted label',
    addedLabel: 'other',
    labels: ['wanted', 'other'],
  },
};
const trigger: AgentTriggerInput = {
  type: 'GITHUB_ISSUE',
  description: 'Label',
  isEnabled: true,
  filterInstructions: null,
  connectionId: 'connection',
  config: { version: 1, repositoryIds: ['repo'], actions: ['labeled'], labels: ['wanted'] },
};
it('requires the added label itself and repository scope to match', () => {
  expect(runtime.matchAgentEvent).toBeTypeOf('function');
  expect(runtime.matchAgentEvent(github, trigger)).toMatchObject({
    status: 'SKIPPED',
    reasonCode: 'LABEL_MISMATCH',
  });
  const matching = { ...github, issue: { ...github.issue, addedLabel: 'wanted' } };
  expect(runtime.matchAgentEvent(matching, trigger)).toMatchObject({ status: 'MATCHED' });
  expect(runtime.matchAgentEvent({ ...matching, repositoryId: 'other' }, trigger)).toMatchObject({
    status: 'SKIPPED',
  });
});
it.each(['opened', 'edited', 'closed'])('fails closed for unsupported %s actions', (action) => {
  expect(runtime.matchAgentEvent).toBeTypeOf('function');
  expect(runtime.matchAgentEvent({ ...github, action }, trigger)).toMatchObject({
    status: 'SKIPPED',
    reasonCode: 'UNSUPPORTED_ACTION',
  });
});
it('rejects unsupported actor filters, semantic filters and schedule triggers', () => {
  expect(runtime.matchAgentEvent).toBeTypeOf('function');
  expect(
    runtime.matchAgentEvent(github, {
      ...trigger,
      config: { ...trigger.config, creatorIds: ['creator'] },
    })
  ).toMatchObject({ reasonCode: 'UNSUPPORTED_ACTOR_FILTER' });
  expect(
    runtime.matchAgentEvent(github, { ...trigger, filterInstructions: 'Only urgent issues' })
  ).toMatchObject({ reasonCode: 'SEMANTIC_FILTER_UNAVAILABLE' });
  expect(
    runtime.matchAgentEvent(github, {
      type: 'SCHEDULE',
      description: 'Timer',
      isEnabled: true,
      filterInstructions: null,
      connectionId: null,
      config: { version: 1, cadence: 'EVERY_MINUTE' },
    })
  ).toMatchObject({ reasonCode: 'UNSUPPORTED_TRIGGER' });
});
const slack: AgentEventPayload = {
  version: 1,
  provider: 'SLACK',
  workspaceId: 'team',
  appId: 'app',
  channelId: 'channel',
  action: 'message',
  actorId: 'human',
  actorType: 'HUMAN',
  subtype: null,
  eventTs: '1.0001',
  threadTs: '1.0000',
  occurredAt: new Date().toISOString(),
  observedAt: new Date().toISOString(),
  sourceUrl: 'https://slack.com/message',
  text: 'Please FIX [bug] now',
};
const slackTrigger: AgentTriggerInput = {
  type: 'SLACK_MESSAGE',
  description: 'Messages',
  isEnabled: true,
  filterInstructions: null,
  connectionId: 'connection',
  config: {
    version: 1,
    channelIds: ['channel'],
    messageContains: 'fix [bug]',
    context: { includeThread: true, nearbyMessageCount: 0 },
  },
};
it('matches human replies with case-insensitive literal text', () => {
  expect(runtime.matchAgentEvent).toBeTypeOf('function');
  expect(runtime.matchAgentEvent(slack, slackTrigger)).toMatchObject({ status: 'MATCHED' });
  expect(runtime.matchAgentEvent({ ...slack, text: 'fix b' }, slackTrigger)).toMatchObject({
    status: 'SKIPPED',
  });
  expect(runtime.matchAgentEvent({ ...slack, channelId: 'other' }, slackTrigger)).toMatchObject({
    status: 'SKIPPED',
  });
});
it.each([
  { actorType: 'BOT' },
  { actorType: 'SYSTEM' },
  { subtype: 'message_changed' },
  { subtype: 'message_deleted' },
  { subtype: 'channel_join' },
] as const)('rejects nonhuman or subtype messages %j', (change) => {
  expect(runtime.matchAgentEvent).toBeTypeOf('function');
  expect(runtime.matchAgentEvent({ ...slack, ...change }, slackTrigger)).toMatchObject({
    status: 'SKIPPED',
    reasonCode: 'UNSUPPORTED_MESSAGE',
  });
});

it('fails closed for a labeled event when the configuration also requests unsupported actions', () => {
  expect(
    runtime.matchAgentEvent(github, {
      ...trigger,
      config: { ...trigger.config, actions: ['opened', 'labeled'] },
    })
  ).toMatchObject({ status: 'SKIPPED', reasonCode: 'UNSUPPORTED_ACTION' });
});

const reopened = { ...github, action: 'reopened', issue: { ...github.issue, addedLabel: null } };
const reopenTrigger: AgentTriggerInput = {
  ...trigger,
  config: { ...trigger.config, actions: ['reopened'] },
};
it('matches a reopened issue only when it carries a configured label', () => {
  expect(runtime.matchAgentEvent(reopened, reopenTrigger)).toMatchObject({ status: 'MATCHED' });
  expect(
    runtime.matchAgentEvent(
      { ...reopened, issue: { ...reopened.issue, labels: ['other'] } },
      reopenTrigger
    )
  ).toMatchObject({ status: 'SKIPPED', reasonCode: 'LABEL_MISMATCH' });
  expect(
    runtime.matchAgentEvent(
      { ...reopened, issue: { ...reopened.issue, labels: [] } },
      reopenTrigger
    )
  ).toMatchObject({ status: 'SKIPPED', reasonCode: 'LABEL_MISMATCH' });
  expect(
    runtime.matchAgentEvent({ ...reopened, repositoryId: 'other' }, reopenTrigger)
  ).toMatchObject({ status: 'SKIPPED', reasonCode: 'SOURCE_IDENTITY_MISMATCH' });
});
it('matches every reopened issue when no labels are configured', () => {
  const unfiltered: AgentTriggerInput = {
    ...trigger,
    config: { version: 1, repositoryIds: ['repo'], actions: ['reopened'] },
  };
  expect(
    runtime.matchAgentEvent({ ...reopened, issue: { ...reopened.issue, labels: [] } }, unfiltered)
  ).toMatchObject({ status: 'MATCHED' });
});
it('matches only the actions a trigger selects', () => {
  const matching = { ...github, issue: { ...github.issue, addedLabel: 'wanted' } };
  expect(runtime.matchAgentEvent(reopened, trigger)).toMatchObject({
    status: 'SKIPPED',
    reasonCode: 'ACTION_MISMATCH',
  });
  expect(runtime.matchAgentEvent(matching, reopenTrigger)).toMatchObject({
    status: 'SKIPPED',
    reasonCode: 'ACTION_MISMATCH',
  });
  const both: AgentTriggerInput = {
    ...trigger,
    config: { ...trigger.config, actions: ['labeled', 'reopened'] },
  };
  expect(runtime.matchAgentEvent(matching, both)).toMatchObject({
    status: 'MATCHED',
  });
  expect(runtime.matchAgentEvent(reopened, both)).toMatchObject({
    status: 'MATCHED',
  });
  // The added label, not the labels already on the issue, decides a labeled event.
  expect(runtime.matchAgentEvent(github, both)).toMatchObject({
    status: 'SKIPPED',
    reasonCode: 'LABEL_MISMATCH',
  });
});
it('fails closed for a reopened event when the configuration also requests opened', () => {
  expect(
    runtime.matchAgentEvent(reopened, {
      ...trigger,
      config: { ...trigger.config, actions: ['opened', 'reopened'] },
    })
  ).toMatchObject({ status: 'SKIPPED', reasonCode: 'UNSUPPORTED_ACTION' });
});
