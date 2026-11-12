import { describe, expect, it, vi } from 'vitest';
import type { AgentTriggerInput } from '@/shared/schemas/agent-definition.schema';
import { triggerCapability } from './agent-management-projection';

vi.mock('./semantic-filter-gate', () => ({
  semanticFilterSupported: (provider: string | undefined) => provider === 'CLAUDE',
}));

const trigger: AgentTriggerInput = {
  type: 'GITHUB_ISSUE',
  description: 'Agent labels',
  isEnabled: false,
  filterInstructions: 'Only billing bugs',
  connectionId: 'connection',
  config: { version: 1, repositoryIds: ['repo'], actions: ['labeled'] },
};

describe('triggerCapability with natural-language filters', () => {
  it('stays unsupported unless the automation provider passed the classifier gate', () => {
    expect(triggerCapability(trigger, true, 'CODEX')).toMatchObject({
      status: 'UNSUPPORTED',
      reasonCode: 'UNSUPPORTED_SEMANTIC_FILTER',
    });
    expect(triggerCapability(trigger, true)).toMatchObject({
      reasonCode: 'UNSUPPORTED_SEMANTIC_FILTER',
    });
    expect(triggerCapability(trigger, true, 'CLAUDE')).toMatchObject({
      status: 'SUPPORTED',
      reasonCode: 'SUPPORTED',
    });
  });

  it('still applies the other capability checks to a proven provider', () => {
    expect(triggerCapability(trigger, false, 'CLAUDE')).toMatchObject({
      reasonCode: 'SOURCE_UNVERIFIED',
    });
    expect(
      triggerCapability(
        { ...trigger, config: { ...trigger.config, creatorIds: ['someone'] } },
        true,
        'CLAUDE'
      )
    ).toMatchObject({ reasonCode: 'UNSUPPORTED_ACTOR_FILTER' });
  });
});

describe('triggerCapability for Slack messages', () => {
  const slack = {
    type: 'SLACK_MESSAGE' as const,
    description: 'Support messages',
    isEnabled: false,
    filterInstructions: null,
    connectionId: 'connection',
    config: {
      version: 1,
      channelIds: ['C1'],
      context: { includeThread: true, nearbyMessageCount: 0 },
    },
  } satisfies AgentTriggerInput;

  it('stays unavailable while intake is off, whatever else is ready', () => {
    expect(triggerCapability(slack, true)).toMatchObject({
      status: 'UNAVAILABLE',
      reasonCode: 'SLACK_INTAKE_UNAVAILABLE',
    });
    expect(triggerCapability(slack, true, 'CLAUDE', 'INTAKE_OFF').reasonCode).toBe(
      'SLACK_INTAKE_UNAVAILABLE'
    );
  });

  it('needs an app-level token, then verified channels', () => {
    expect(triggerCapability(slack, true, 'CLAUDE', 'APP_TOKEN_REQUIRED')).toMatchObject({
      status: 'UNAVAILABLE',
      reasonCode: 'SLACK_APP_TOKEN_REQUIRED',
    });
    expect(triggerCapability(slack, false, 'CLAUDE', 'READY').reasonCode).toBe('SOURCE_UNVERIFIED');
    expect(triggerCapability(slack, true, 'CLAUDE', 'READY')).toMatchObject({
      status: 'SUPPORTED',
      reasonCode: 'SUPPORTED',
    });
  });

  it('keeps sender filters unsupported with intake on', () => {
    const senders = { ...slack, config: { ...slack.config, senderIds: ['U1'] } };
    expect(triggerCapability(senders, true, 'CLAUDE', 'READY')).toMatchObject({
      status: 'UNSUPPORTED',
      reasonCode: 'UNSUPPORTED_ACTOR_FILTER',
    });
  });
});
