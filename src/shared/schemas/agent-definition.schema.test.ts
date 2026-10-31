import { describe, expect, it } from 'vitest';
import {
  agentDefinitionInputSchema,
  agentRunInputSchema,
  agentTriggerInputSchema,
} from './agent-definition.schema';

describe('agent definitions', () => {
  it('supports an agent without a schedule and defaults to paused', () => {
    expect(
      agentDefinitionInputSchema.parse({ name: 'Investigate', instructions: 'Find bugs' })
    ).toMatchObject({ isEnabled: false });
  });

  it('rejects empty instructions', () => {
    expect(
      agentDefinitionInputSchema.safeParse({ name: 'Investigate', instructions: '  ' }).success
    ).toBe(false);
  });
});

describe('agent triggers', () => {
  const slack = {
    type: 'SLACK_MESSAGE',
    connectionId: 'slack-connection',
    description: 'Watch feedback channels for possible bugs',
    filterInstructions: 'When uncertain, investigate',
    config: { version: 1, channelIds: ['C-feedback', 'C-bugs'] },
  };

  it('retains natural-language intent separately from resolved configuration', () => {
    expect(agentTriggerInputSchema.parse(slack)).toMatchObject(slack);
  });

  it.each([
    { ...slack, connectionId: null },
    { ...slack, config: { version: 1, channelIds: [] } },
    { ...slack, config: { version: 2, channelIds: ['C-feedback'] } },
    { ...slack, config: { version: 1, repositoryIds: ['123'] } },
  ])('rejects an unresolved or incompatible Slack configuration: %j', (input) => {
    expect(agentTriggerInputSchema.safeParse(input).success).toBe(false);
  });

  it('supports deterministic GitHub triggers without AI criteria', () => {
    expect(
      agentTriggerInputSchema.parse({
        type: 'GITHUB_ISSUE',
        connectionId: 'github-connection',
        description: 'Execute agent issues',
        config: {
          version: 1,
          repositoryIds: ['123'],
          actions: ['opened', 'labeled'],
          labels: ['agent'],
        },
      })
    ).toMatchObject({ filterInstructions: null });
  });

  it('supports schedule triggers without a provider connection', () => {
    expect(
      agentTriggerInputSchema.safeParse({
        type: 'SCHEDULE',
        description: 'Every weekday',
        config: {
          version: 1,
          cadence: 'DAILY',
          scheduledTime: '09:00',
          timezone: 'America/New_York',
        },
      }).success
    ).toBe(true);
  });

  it.each([
    { version: 1, cadence: 'DAILY', scheduledTime: '09:00' },
    { version: 1, cadence: 'DAILY', scheduledTime: '25:00', timezone: 'UTC' },
    { version: 1, cadence: 'DAILY', scheduledTime: '09:00', timezone: 'not/a-zone' },
    { version: 1, cadence: 'DAILY', scheduledDayOfMonth: 15 },
  ])('rejects invalid schedule configuration: %j', (config) => {
    expect(
      agentTriggerInputSchema.safeParse({ type: 'SCHEDULE', description: 'Daily', config }).success
    ).toBe(false);
  });
});

describe('agent run inputs', () => {
  it('rejects arbitrary provider payloads rather than treating them as trusted run context', () => {
    expect(
      agentRunInputSchema.safeParse({ version: 1, arbitraryPayload: { command: 'run' } }).success
    ).toBe(false);
  });

  it('accepts bounded normalized source context', () => {
    expect(
      agentRunInputSchema.parse({
        version: 1,
        eventId: 'Ev-1',
        sourceUrl: 'https://slack.com/archives/C/p123',
        context: [{ id: 'message-1', text: 'Packet unlocked' }],
      })
    ).toMatchObject({ eventId: 'Ev-1' });
  });
});
