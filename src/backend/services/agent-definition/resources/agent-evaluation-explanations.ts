import { SessionProvider } from '@/shared/core/enums';

/** Longer filters are not sent to a provider; the trigger schema does not bound them. */
export const MAX_FILTER_INSTRUCTIONS_LENGTH = 4000;

const providerNames: Record<SessionProvider, string> = { CLAUDE: 'Claude', CODEX: 'Codex' };

/**
 * Every `AgentEvaluation.explanation` the system writes. Each is fixed text
 * with no event content, provider output or credentials, so history may show
 * it. Writers use these entries rather than their own strings.
 */
export const evaluationExplanations = {
  invalidStoredData: 'Stored event or configuration is invalid.',
  runtimeIneligible: 'Runtime eligibility prevents execution.',
  outsideBoundary: 'The event is outside the active trigger boundary.',
  executionRetry: 'Execution defaults could not be read; retry is bounded.',
  invalidExecution: 'Execution configuration is invalid.',
  pendingIneligible: 'The pending decision is no longer eligible for execution.',
  eventOverflowed: 'This event already exceeded the waiting-run limit.',
  queueOverflow: 'The waiting-run limit was reached.',
  // Deterministic matching.
  deterministicMatch: 'The deterministic trigger filters match.',
  schedule: 'Schedules use PeriodicTask.',
  actorFilter: 'Actor filters require actor discovery.',
  providerMismatch: 'Event and trigger providers differ.',
  unsupportedAction: 'Only GitHub labeled and reopened events are executable.',
  repositoryOutsideScope: 'Repository is outside the trigger scope.',
  actionMismatch: 'The trigger does not select this action.',
  addedLabelMismatch: 'The added label does not match.',
  labelsMismatch: 'The issue carries none of the selected labels.',
  unsupportedMessage: 'Only ordinary human messages are supported.',
  channelOutsideScope: 'Channel is outside the trigger scope.',
  textMismatch: 'Message does not contain the literal filter text.',
  // Natural-language filter.
  semanticMatch: 'The trigger filters and the natural-language filter match.',
  semanticSkip: 'The event does not meet the natural-language filter.',
  semanticUncertain:
    'The classifier could not tell whether the event meets the natural-language filter; uncertain events never start a run.',
  semanticUnavailable: 'Natural-language filtering is not available, so the event was not run.',
  semanticMalformed: 'The classifier returned invalid output, so the event was not run.',
  semanticTimeout: 'The classifier timed out; retry is bounded.',
  semanticRateLimited: 'The classifier provider is rate limited; retry is bounded.',
  semanticFailed: 'The classifier could not run; retry is bounded.',
  filterTooLong: `The natural-language filter is longer than ${MAX_FILTER_INSTRUCTIONS_LENGTH} characters, so the event was not run. Shorten the filter.`,
  // Slack message context.
  slackContextRateLimited: 'Slack is rate limiting message history reads; retry is bounded.',
  slackContextRetry: 'Slack message context could not be read; retry is bounded.',
  slackContextUnavailable: 'Slack message context is not available, so the event was not run.',
  slackContextMissingScope:
    'The Slack bot cannot read message history. Add the bot scopes channels:history (public channels) and groups:history (private channels), then reinstall the app. The event was not run.',
  slackContextChannelUnavailable:
    'Slack would not return history for this channel or thread. Invite the bot to the channel. The event was not run.',
  slackContextNotConnected:
    'The Slack connection has no usable bot token for this workspace. Reconnect it in Slack settings. The event was not run.',
  slackContextFailed:
    'Slack returned an unexpected response for the message context. The event was not run.',
  slackContextNotSelected:
    'The message is in a channel this trigger does not select, so its context was not read.',
} as const;

/** The only explanation that names something: one of the fixed provider names. */
export function unprovenProviderExplanation(provider: SessionProvider) {
  return `This automation now runs with ${providerNames[provider]}, whose natural-language filter classifier has not passed evaluation, so the event was not run.`;
}

const systemExplanations: ReadonlySet<string> = new Set([
  ...Object.values(evaluationExplanations),
  ...Object.values(SessionProvider).map(unprovenProviderExplanation),
]);

/**
 * The stored explanation when the system wrote it, otherwise null. A row from
 * another writer, or an older version's wording, is never shown as free text.
 */
export function publicEvaluationExplanation(stored: string): string | null {
  return systemExplanations.has(stored) ? stored : null;
}
