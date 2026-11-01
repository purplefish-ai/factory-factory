import type { AgentEventPayload } from '@/shared/agent-runtime';
import type { AgentTriggerInput } from '@/shared/schemas/agent-definition.schema';

export type MatchResult = {
  status: 'MATCHED' | 'SKIPPED';
  reasonCode: string;
  explanation: string;
};
const skip = (reasonCode: string, explanation: string): MatchResult => ({
  status: 'SKIPPED',
  reasonCode,
  explanation,
});

/** Deterministic matching only; event content never configures execution or permissions. */
export function matchAgentEvent(event: AgentEventPayload, trigger: AgentTriggerInput): MatchResult {
  if (trigger.type === 'SCHEDULE') {
    return skip('UNSUPPORTED_TRIGGER', 'Schedules use PeriodicTask.');
  }
  if (trigger.filterInstructions) {
    return skip('SEMANTIC_FILTER_UNAVAILABLE', 'Semantic filters are not available.');
  }
  if (
    (trigger.type === 'GITHUB_ISSUE' && trigger.config.creatorIds) ||
    (trigger.type === 'SLACK_MESSAGE' && trigger.config.senderIds)
  ) {
    return skip('UNSUPPORTED_ACTOR_FILTER', 'Actor filters require actor discovery.');
  }
  if (trigger.type === 'GITHUB_ISSUE' && event.provider === 'GITHUB') {
    return matchGithub(event, trigger);
  } else if (trigger.type === 'SLACK_MESSAGE' && event.provider === 'SLACK') {
    return matchSlack(event, trigger);
  } else {
    return skip('SOURCE_IDENTITY_MISMATCH', 'Event and trigger providers differ.');
  }
}

function matched(): MatchResult {
  return {
    status: 'MATCHED',
    reasonCode: 'DETERMINISTIC_MATCH',
    explanation: 'The deterministic trigger filters match.',
  };
}

function matchGithub(
  event: Extract<AgentEventPayload, { provider: 'GITHUB' }>,
  trigger: Extract<AgentTriggerInput, { type: 'GITHUB_ISSUE' }>
): MatchResult {
  if (event.action !== 'labeled' || trigger.config.actions.some((action) => action !== 'labeled')) {
    return skip('UNSUPPORTED_ACTION', 'Only GitHub labeled events are executable.');
  }
  if (!trigger.config.repositoryIds.includes(event.repositoryId)) {
    return skip('SOURCE_IDENTITY_MISMATCH', 'Repository is outside the trigger scope.');
  }
  if (
    !event.issue.addedLabel ||
    (trigger.config.labels && !trigger.config.labels.includes(event.issue.addedLabel))
  ) {
    return skip('LABEL_MISMATCH', 'The added label does not match.');
  }
  return matched();
}

function matchSlack(
  event: Extract<AgentEventPayload, { provider: 'SLACK' }>,
  trigger: Extract<AgentTriggerInput, { type: 'SLACK_MESSAGE' }>
): MatchResult {
  if (event.actorType !== 'HUMAN' || event.subtype !== null) {
    return skip('UNSUPPORTED_MESSAGE', 'Only ordinary human messages are supported.');
  }
  if (!trigger.config.channelIds.includes(event.channelId)) {
    return skip('SOURCE_IDENTITY_MISMATCH', 'Channel is outside the trigger scope.');
  }
  if (
    trigger.config.messageContains &&
    !event.text.toLowerCase().includes(trigger.config.messageContains.toLowerCase())
  ) {
    return skip('TEXT_MISMATCH', 'Message does not contain the literal filter text.');
  }
  return matched();
}
