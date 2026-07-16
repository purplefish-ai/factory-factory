import {
  CheckCircleIcon,
  CircleIcon,
  type Icon,
  ProhibitIcon,
  PulseIcon,
  SpinnerGapIcon,
  XCircleIcon,
} from '@phosphor-icons/react';
import type { SessionStatus as DbSessionStatus } from '@/shared/core';
import {
  getSessionSummaryErrorMessage,
  type SessionSummary,
  sessionUiStatusKindFromSummary,
} from '@/shared/session-runtime';

export type WorkspaceSessionRuntimeSummary = SessionSummary;

export interface SessionTabRuntimeInfo {
  color: string;
  pulse: boolean;
  spin: boolean;
  label: string;
  description: string;
  icon: Icon;
  isRunning: boolean;
}

const IDLE_STATUS: SessionTabRuntimeInfo = {
  color: 'text-emerald-500',
  pulse: false,
  spin: false,
  label: 'Idle',
  description: 'Ready for input',
  icon: CircleIcon,
  isRunning: false,
};

function getFallbackStatusInfo(persistedStatus?: DbSessionStatus): SessionTabRuntimeInfo {
  if (persistedStatus === 'RUNNING') {
    return {
      color: 'text-brand',
      pulse: true,
      spin: false,
      label: 'Running',
      description: 'Processing your request',
      icon: PulseIcon,
      isRunning: true,
    };
  }

  if (persistedStatus === 'PAUSED') {
    return {
      color: 'text-muted-foreground',
      pulse: false,
      spin: false,
      label: 'Paused',
      description: 'Session paused',
      icon: ProhibitIcon,
      isRunning: false,
    };
  }

  if (persistedStatus === 'COMPLETED') {
    return {
      color: 'text-blue-500',
      pulse: false,
      spin: false,
      label: 'Completed',
      description: 'Session finished',
      icon: CheckCircleIcon,
      isRunning: false,
    };
  }

  if (persistedStatus === 'FAILED') {
    return {
      color: 'text-destructive',
      pulse: false,
      spin: false,
      label: 'Failed',
      description: 'Session failed',
      icon: XCircleIcon,
      isRunning: false,
    };
  }

  return IDLE_STATUS;
}

export function deriveSessionTabRuntime(
  summary?: WorkspaceSessionRuntimeSummary,
  persistedStatus?: DbSessionStatus
): SessionTabRuntimeInfo {
  if (!summary) {
    return getFallbackStatusInfo(persistedStatus);
  }

  switch (sessionUiStatusKindFromSummary(summary)) {
    case 'loading':
      return {
        color: 'text-muted-foreground',
        pulse: false,
        spin: true,
        label: 'Loading',
        description: 'Loading session...',
        icon: SpinnerGapIcon,
        isRunning: false,
      };

    case 'starting':
      return {
        color: 'text-muted-foreground',
        pulse: false,
        spin: true,
        label: 'Starting',
        description: 'Launching agent...',
        icon: SpinnerGapIcon,
        isRunning: false,
      };

    case 'stopping':
      return {
        color: 'text-brand',
        pulse: false,
        spin: true,
        label: 'Stopping',
        description: 'Finishing current request...',
        icon: SpinnerGapIcon,
        isRunning: false,
      };

    case 'error':
      return {
        color: 'text-destructive',
        pulse: false,
        spin: false,
        label: 'Error',
        description: getSessionSummaryErrorMessage(summary) ?? 'Session entered an error state',
        icon: XCircleIcon,
        isRunning: false,
      };

    case 'unexpected-exit':
      return {
        color: 'text-destructive',
        pulse: false,
        spin: false,
        label: 'Error',
        description:
          getSessionSummaryErrorMessage(summary) ??
          `Exited unexpectedly${summary.lastExit?.code != null ? ` (code ${summary.lastExit.code})` : ''}`,
        icon: XCircleIcon,
        isRunning: false,
      };

    case 'stopped':
      return {
        color: 'text-muted-foreground',
        pulse: false,
        spin: false,
        label: 'Stopped',
        description: 'Send a message to start',
        icon: ProhibitIcon,
        isRunning: false,
      };

    case 'working':
      return {
        color: 'text-brand',
        pulse: true,
        spin: false,
        label: 'Running',
        description: 'Processing your request',
        icon: PulseIcon,
        isRunning: true,
      };

    default:
      return IDLE_STATUS;
  }
}
