/**
 * Readable phrases for the reason codes event history stores on runs and
 * evaluations. The code itself stays available beside the phrase for support.
 * Codes come from the backend runtime guards, matcher, admission and launch
 * dispositions; an unrecognized code reads as such rather than as a cause.
 */
const REASON_PHRASES: Readonly<Record<string, string>> = {
  // Matching an event against a trigger.
  DETERMINISTIC_MATCH: 'The event matched this trigger.',
  LABEL_MISMATCH: "The event's label doesn't match this trigger.",
  TEXT_MISMATCH: "The message doesn't contain this trigger's text.",
  UNSUPPORTED_ACTION: "This kind of GitHub event can't start a run.",
  UNSUPPORTED_MESSAGE: 'Only ordinary messages from people can start a run.',
  UNSUPPORTED_TRIGGER: "This trigger type can't start event runs.",
  UNSUPPORTED_ACTOR_FILTER: "Filters on who acted aren't supported.",
  // Natural-language filters (agent-semantic-filter.ts). Only a clear match starts a run.
  SEMANTIC_FILTER_MATCH: 'The event matched this trigger and its natural-language filter.',
  SEMANTIC_FILTER_SKIP: "The event doesn't meet the natural-language filter.",
  SEMANTIC_FILTER_UNCERTAIN:
    "The classifier couldn't tell whether the event meets the natural-language filter; uncertain events never run.",
  SEMANTIC_FILTER_PROVIDER_UNPROVEN:
    "The natural-language filter classifier hasn't passed evaluation for this automation's provider, so the event didn't run.",
  SEMANTIC_FILTER_TOO_LONG:
    "The natural-language filter is too long to check, so the event didn't run. Shorten the filter.",
  SEMANTIC_FILTER_UNAVAILABLE:
    "The natural-language filter couldn't be checked in this app, so the event didn't run.",
  SEMANTIC_FILTER_MALFORMED: "The classifier returned invalid output, so the event didn't run.",
  SEMANTIC_FILTER_TIMEOUT: 'The classifier timed out; it retries a limited number of times.',
  SEMANTIC_FILTER_RATE_LIMITED:
    "The classifier's provider is rate limited; it retries a limited number of times.",
  SEMANTIC_FILTER_FAILED: "The classifier couldn't run; it retries a limited number of times.",
  // Slack thread and channel context (slack-event-context.ts). A run never starts with partial context.
  SLACK_CONTEXT_RATE_LIMITED:
    'Slack is rate limiting message history reads; it retries a limited number of times.',
  SLACK_CONTEXT_RETRY:
    "The Slack message context couldn't be read; it retries a limited number of times.",
  SLACK_CONTEXT_MISSING_SCOPE:
    "The Slack bot can't read message history, so the event didn't run. Add the channels:history and groups:history bot scopes to the Slack app, then reinstall it.",
  SLACK_CONTEXT_CHANNEL_UNAVAILABLE:
    "Slack wouldn't return this channel's or thread's history, so the event didn't run. Invite the bot to the channel.",
  SLACK_CONTEXT_NOT_CONNECTED:
    "The Slack connection has no usable bot token for this workspace, so the event didn't run. Reconnect it in Slack settings.",
  SLACK_CONTEXT_FAILED:
    "Slack returned an unexpected response for the message context, so the event didn't run.",
  SLACK_CONTEXT_NOT_SELECTED:
    "The message is in a channel this trigger doesn't watch, so its context wasn't read and the event didn't run.",
  SLACK_CONTEXT_UNAVAILABLE:
    "Slack message context isn't available in this app, so the event didn't run.",
  SOURCE_IDENTITY_MISMATCH:
    "The event came from a repository or channel this trigger doesn't watch.",
  OWNERSHIP_MISMATCH: "The event doesn't belong to this trigger's source.",
  BEFORE_ACTIVATION: 'The event happened before this trigger started listening.',
  EVENT_EXPIRED: 'The event expired before it could run.',
  NOT_MATCHED: "The event didn't match this trigger.",
  // Automation, trigger and source state.
  DEFINITION_DISABLED: 'The automation was paused.',
  TRIGGER_DISABLED: 'The trigger was paused.',
  PROJECT_ARCHIVED: 'The project is archived.',
  CONNECTION_UNAVAILABLE: 'The source connection is unavailable.',
  SOURCE_RECOVERY_REQUIRED: 'The source needs to be reset before events can run.',
  // Queued runs cancelled by Pause, an edit or a source reset carry this code, as do decisions
  // made against a revision an edit has replaced.
  STALE_REVISION:
    'The automation was paused or edited, or its source was reset, before this could run.',
  STALE_EVENT_COHORT: 'A newer decision for this event replaced this one.',
  ACTIVATION_STARTING: 'The trigger was still starting.',
  SOURCE_ORDER_PENDING: 'Waiting for the source to confirm the event order.',
  EARLIER_EVALUATION_PENDING: 'Waiting for an earlier decision on this event.',
  EARLIER_EVALUATION_ERROR: 'An earlier decision on this event failed.',
  EXECUTION_RESOLUTION_RETRY: "Couldn't read the automation's execution settings; it will retry.",
  INVALID_EXECUTION_CONFIG: "The automation's execution settings are invalid.",
  INVALID_STORED_DATA: 'Stored data for this record is invalid.',
  NOT_FOUND: 'A record it depends on no longer exists.',
  // Queueing and capacity.
  QUEUE_OVERFLOW: 'Too many runs were already waiting for this automation.',
  QUEUE_EXPIRED: 'It waited too long for a free run slot.',
  CAPACITY: 'Waiting for a free run slot.',
  WAITING: 'Waiting for a free run slot.',
  // Workspace setup and the first message.
  PROVISIONING_RETRY: 'Workspace setup failed; it will retry.',
  PROVISIONING_FAILED: 'Workspace setup failed.',
  SETUP_TIMEOUT: 'Workspace setup took too long.',
  SHUTDOWN: 'The app stopped during workspace setup; it resumes on restart.',
  PREPARATION_CLEANUP_UNCERTAIN:
    "Workspace setup stopped and its cleanup couldn't be confirmed; check the workspace before retrying.",
  DELIVERY_UNCERTAIN:
    'The first message may have reached the agent; check the workspace before retrying.',
  // Child workspaces (working, setting up or never started). The run keeps its own outcome.
  CHILD_HOLD_EXPIRED:
    "Child workspaces hadn't finished after 24 hours; the run ended with its own outcome.",
  // A person's decision.
  EXPLICIT_ABANDONMENT: 'Abandoned by a person.',
  ABANDONED_WITH_CHILD_WORK: 'Abandoned by a person before its child workspaces had finished.',
  EXPLICITLY_RESOLVED: 'Marked resolved by a person.',
};

/** A readable phrase for a stored reason code, or null when none was stored. */
export function describeEventReason(code: string | null): string | null {
  if (code === null) {
    return null;
  }
  return REASON_PHRASES[code] ?? 'Unrecognized reason.';
}
