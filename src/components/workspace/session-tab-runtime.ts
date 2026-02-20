import {
  Activity,
  CheckCircle2,
  Circle,
  CircleSlash,
  Loader2,
  type LucideIcon,
  XCircle,
} from 'lucide-react';
import type { SessionStatus as DbSessionStatus } from '@/shared/core';
import { getSessionSummaryErrorMessage, type SessionSummary } from '@/shared/session-runtime';

export type WorkspaceSessionRuntimeSummary = SessionSummary;

export interface SessionTabRuntimeInfo {
  color: string;
  pulse: boolean;
  spin: boolean;
  label: string;
  description: string;
  icon: LucideIcon;
  isRunning: boolean;
}

const IDLE_STATUS: SessionTabRuntimeInfo = {
  color: 'text-emerald-500',
  pulse: false,
  spin: false,
  label: 'Idle',
  description: 'Ready for input',
  icon: Circle,
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
      icon: Activity,
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
      icon: CircleSlash,
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
      icon: CheckCircle2,
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
      icon: XCircle,
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

  if (summary.runtimePhase === 'loading') {
    return {
      color: 'text-muted-foreground',
      pulse: false,
      spin: true,
      label: 'Loading',
      description: 'Loading session...',
      icon: Loader2,
      isRunning: false,
    };
  }

  if (summary.runtimePhase === 'starting') {
    return {
      color: 'text-muted-foreground',
      pulse: false,
      spin: true,
      label: 'Starting',
      description: 'Launching agent...',
      icon: Loader2,
      isRunning: false,
    };
  }

  if (summary.runtimePhase === 'stopping') {
    return {
      color: 'text-brand',
      pulse: false,
      spin: true,
      label: 'Stopping',
      description: 'Finishing current request...',
      icon: Loader2,
      isRunning: false,
    };
  }

  if (summary.runtimePhase === 'error') {
    const runtimeError = getSessionSummaryErrorMessage(summary);
    return {
      color: 'text-destructive',
      pulse: false,
      spin: false,
      label: 'Error',
      description: runtimeError ?? 'Session entered an error state',
      icon: XCircle,
      isRunning: false,
    };
  }

  if (summary.processState === 'stopped') {
    if (summary.lastExit?.unexpected) {
      const runtimeError = getSessionSummaryErrorMessage(summary);
      return {
        color: 'text-destructive',
        pulse: false,
        spin: false,
        label: 'Error',
        description:
          runtimeError ??
          `Exited unexpectedly${summary.lastExit.code !== null ? ` (code ${summary.lastExit.code})` : ''}`,
        icon: XCircle,
        isRunning: false,
      };
    }

    return {
      color: 'text-muted-foreground',
      pulse: false,
      spin: false,
      label: 'Stopped',
      description: 'Send a message to start',
      icon: CircleSlash,
      isRunning: false,
    };
  }

  if (summary.activity === 'WORKING' || summary.runtimePhase === 'running') {
    return {
      color: 'text-brand',
      pulse: true,
      spin: false,
      label: 'Running',
      description: 'Processing your request',
      icon: Activity,
      isRunning: true,
    };
  }

  return IDLE_STATUS;
}
