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
  SEMANTIC_FILTER_UNAVAILABLE: "Natural-language filters aren't available yet.",
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
  // Pause, an edit and a source reset all cancel queued runs and stale decisions with this code.
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
