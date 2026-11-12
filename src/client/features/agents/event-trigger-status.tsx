import type { ReactNode } from 'react';
import { StatusChip } from '@/client/components/status-indicators';
import type { StatusTone } from '@/client/lib/status-tones';
import type { AgentPausedReasonCode } from '@/shared/agent-management';
import { SlackVerification } from './event-slack-verification';
import type { EventAgent } from './types';

type Trigger = EventAgent['configuredTriggers'][number];
type SourceHealth = Trigger['sourceHealth'];

export type TriggerStateLabel = 'Listening' | 'Starting' | 'Paused' | "Can't run";
export interface TriggerDisplayState {
  label: TriggerStateLabel;
  tone: StatusTone;
  /** Why it is in this state, in words; null when the label says enough. */
  reason: string | null;
}

const PAUSED_REASONS: Readonly<Record<AgentPausedReasonCode, string>> = {
  ACTIVATION_EXPIRED: 'It took too long to start. Enable the automation again to retry.',
  SOURCE_ERROR:
    "The source couldn't be read while it was starting. Enable the automation again to retry.",
  SOURCE_RECOVERY_REQUIRED: 'The source needs a reset before it can listen again.',
};
const SLACK_EXPIRED =
  "The test message didn't arrive in every channel within 10 minutes. Enable the automation again for a new message.";

function pausedReason(trigger: Trigger) {
  const code = trigger.pausedReasonCode;
  if (code === 'ACTIVATION_EXPIRED' && trigger.configuration?.type === 'SLACK_MESSAGE') {
    return SLACK_EXPIRED;
  }
  return code ? PAUSED_REASONS[code] : null;
}

/**
 * A trigger's state as the user should read it. It comes from the trigger,
 * not the definition: after an edit the definition can stay enabled while
 * every trigger is paused.
 *
 * The backend stores PAUSED and STARTING triggers with `isEnabled: false`;
 * only activation sets `isEnabled: true`, together with ACTIVE. So Starting
 * reads from `activationState` alone.
 */
export function describeTriggerState(trigger: Trigger): TriggerDisplayState {
  if (trigger.capability.status !== 'SUPPORTED') {
    return { label: "Can't run", tone: 'warning', reason: trigger.capability.explanation };
  }
  if (trigger.isEnabled && trigger.activationState === 'ACTIVE') {
    return { label: 'Listening', tone: 'success', reason: null };
  }
  if (trigger.activationState === 'STARTING') {
    // A Slack trigger starts from a test message, once its listener is connected.
    const waiting = trigger.pendingVerification
      ? trigger.sourceHealth?.state === 'READY'
        ? 'Connected; waiting for test message'
        : 'Connecting…'
      : null;
    return { label: 'Starting', tone: 'working', reason: waiting };
  }
  const reason = pausedReason(trigger);
  return { label: 'Paused', tone: reason ? 'warning' : 'neutral', reason };
}

export function isTriggerRunning(trigger: Trigger): boolean {
  const { label } = describeTriggerState(trigger);
  return label === 'Listening' || label === 'Starting';
}

/** The automation reads Active while any trigger listens, using the scheduled Active/Paused words. */
export function describeAutomationState(
  triggers: readonly Trigger[]
): 'Active' | 'Starting' | 'Paused' {
  const labels = triggers.map((trigger) => describeTriggerState(trigger).label);
  if (labels.includes('Listening')) {
    return 'Active';
  }
  return labels.includes('Starting') ? 'Starting' : 'Paused';
}

const SOURCE_REASONS: Readonly<Record<string, string>> = {
  GITHUB_SOURCE_RESET: 'Reset. Enable the automation to listen from now on.',
  GITHUB_BASELINE_REQUIRED: 'Waiting for a fresh starting point from GitHub',
  GITHUB_RATE_LIMITED: 'GitHub rate limit reached; checking again shortly',
  GITHUB_AUTH_REQUIRED: 'GitHub sign-in needed. Run gh auth login; checking resumes on its own.',
  GITHUB_SOURCE_UNAVAILABLE: "GitHub couldn't be reached; checking again shortly",
  GITHUB_CONTINUITY_LOST:
    'Needs a reset: GitHub can no longer list every event since the last check',
};
const SOURCE_STATES: Readonly<Record<NonNullable<SourceHealth>['state'], string>> = {
  READY: 'Up to date',
  STARTING: 'Starting',
  CATCHING_UP: 'Catching up on recent events',
  DISCONNECTED: 'Disconnected',
  ERROR: "Couldn't read the source",
  RECOVERY_REQUIRED: 'Needs a reset',
};

/** Source health in words; the stored codes stay in the trigger's details. */
export function describeSourceHealth(health: SourceHealth): string {
  if (!health) {
    return 'No source status yet';
  }
  const reason = health.reasonCode ? SOURCE_REASONS[health.reasonCode] : undefined;
  return reason ?? SOURCE_STATES[health.state];
}

function membership(trigger: Trigger) {
  if (trigger.isConfigured === true) {
    return 'Configured';
  }
  return trigger.isConfigured === false ? 'Removed' : 'Unknown membership';
}

/** One trigger: its plain state and source, with stored facts in a collapsed section. */
export function EventTriggerCard({ trigger, action }: { trigger: Trigger; action?: ReactNode }) {
  const state = describeTriggerState(trigger);
  return (
    <article className="min-w-0 space-y-2 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h4 className="min-w-0 break-words font-medium">
          {trigger.configuration?.description ?? 'Configuration unavailable'}
        </h4>
        <StatusChip tone={state.tone} size="md">
          {state.label}
        </StatusChip>
      </div>
      {state.reason && <p className="break-words text-muted-foreground">{state.reason}</p>}
      <p className="break-words text-xs text-muted-foreground">
        Source: {trigger.sourceName ?? 'Name unavailable'} ·{' '}
        {describeSourceHealth(trigger.sourceHealth)}
      </p>
      {/* An unsupported trigger reads Can't run; a message to post would mislead. */}
      {trigger.capability.status === 'SUPPORTED' &&
        trigger.activationState === 'STARTING' &&
        trigger.pendingVerification && <SlackVerification pending={trigger.pendingVerification} />}
      {action}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Details</summary>
        <div className="mt-2 space-y-1">
          <p className="break-words">Trigger {trigger.id}</p>
          <p>
            {membership(trigger)} · Activation state {trigger.activationState} ·{' '}
            {trigger.isEnabled ? 'Enabled' : 'Disabled'}
            {trigger.pausedReasonCode ? ` · ${trigger.pausedReasonCode}` : ''}
          </p>
          <p>
            Trigger revision {trigger.triggerRevision} · Activation generation{' '}
            {trigger.activationGeneration}
          </p>
          <p>Capability {trigger.capability.reasonCode}</p>
          <p>
            Source health{' '}
            {trigger.sourceHealth
              ? `${trigger.sourceHealth.state}${trigger.sourceHealth.reasonCode ? ` · ${trigger.sourceHealth.reasonCode}` : ''}`
              : 'unavailable'}
          </p>
          {trigger.configuration && (
            <pre className="whitespace-pre-wrap break-words">
              {JSON.stringify(trigger.configuration, null, 2)}
            </pre>
          )}
        </div>
      </details>
    </article>
  );
}
