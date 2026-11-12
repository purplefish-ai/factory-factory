import { evaluationExplanations } from '@/backend/services/agent-definition/resources/agent-evaluation-explanations';
import { type AgentEventPayload, isAgentGithubExecutableAction } from '@/shared/agent-runtime';
import type { AgentTriggerInput } from '@/shared/schemas/agent-definition.schema';
import { slackHumanSubtypes } from './slack-event-message';

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

/**
 * Deterministic matching only; event content never configures execution or
 * permissions. Natural-language filters run afterwards, during evaluation, and
 * can only narrow a deterministic match.
 */
export function matchAgentEvent(event: AgentEventPayload, trigger: AgentTriggerInput): MatchResult {
  if (trigger.type === 'SCHEDULE') {
    return skip('UNSUPPORTED_TRIGGER', evaluationExplanations.schedule);
  }
  if (
    (trigger.type === 'GITHUB_ISSUE' && trigger.config.creatorIds) ||
    (trigger.type === 'SLACK_MESSAGE' && trigger.config.senderIds)
  ) {
    return skip('UNSUPPORTED_ACTOR_FILTER', evaluationExplanations.actorFilter);
  }
  if (trigger.type === 'GITHUB_ISSUE' && event.provider === 'GITHUB') {
    return matchGithub(event, trigger);
  } else if (trigger.type === 'SLACK_MESSAGE' && event.provider === 'SLACK') {
    return matchSlack(event, trigger);
  } else {
    return skip('SOURCE_IDENTITY_MISMATCH', evaluationExplanations.providerMismatch);
  }
}

function matched(): MatchResult {
  return {
    status: 'MATCHED',
    reasonCode: 'DETERMINISTIC_MATCH',
    explanation: evaluationExplanations.deterministicMatch,
  };
}

function matchGithub(
  event: Extract<AgentEventPayload, { provider: 'GITHUB' }>,
  trigger: Extract<AgentTriggerInput, { type: 'GITHUB_ISSUE' }>
): MatchResult {
  if (
    !isAgentGithubExecutableAction(event.action) ||
    trigger.config.actions.some((action) => !isAgentGithubExecutableAction(action))
  ) {
    return skip('UNSUPPORTED_ACTION', evaluationExplanations.unsupportedAction);
  }
  if (!trigger.config.repositoryIds.includes(event.repositoryId)) {
    return skip('SOURCE_IDENTITY_MISMATCH', evaluationExplanations.repositoryOutsideScope);
  }
  if (!trigger.config.actions.some((action) => action === event.action)) {
    return skip('ACTION_MISMATCH', evaluationExplanations.actionMismatch);
  }
  const labels = trigger.config.labels;
  if (event.action === 'labeled') {
    if (!event.issue.addedLabel || (labels && !labels.includes(event.issue.addedLabel))) {
      return skip('LABEL_MISMATCH', evaluationExplanations.addedLabelMismatch);
    }
  } else if (labels && !event.issue.labels.some((label) => labels.includes(label))) {
    return skip('LABEL_MISMATCH', evaluationExplanations.labelsMismatch);
  }
  return matched();
}

function matchSlack(
  event: Extract<AgentEventPayload, { provider: 'SLACK' }>,
  trigger: Extract<AgentTriggerInput, { type: 'SLACK_MESSAGE' }>
): MatchResult {
  if (
    event.actorType !== 'HUMAN' ||
    (event.subtype !== null && !slackHumanSubtypes.some((subtype) => subtype === event.subtype))
  ) {
    return skip('UNSUPPORTED_MESSAGE', evaluationExplanations.unsupportedMessage);
  }
  if (!trigger.config.channelIds.includes(event.channelId)) {
    return skip('SOURCE_IDENTITY_MISMATCH', evaluationExplanations.channelOutsideScope);
  }
  if (
    trigger.config.messageContains &&
    !event.text.toLowerCase().includes(trigger.config.messageContains.toLowerCase())
  ) {
    return skip('TEXT_MISMATCH', evaluationExplanations.textMismatch);
  }
  return matched();
}
