/**
 * The one status presentation map: status tone → theme-token classes + icon.
 *
 * Every status color in the client comes from here (or from the status tokens
 * directly), so a state looks the same in the sidebar, board, tabs and PR
 * panels, and follows the selected color scheme. See docs/status-colors.md.
 *
 * Tones extend `WorkspaceStatusReasonTone` (`@/shared/workspace-status-reason`) with
 * presentation-only tones for messages (`warning`, `info`).
 */

import { BellRingingIcon } from '@phosphor-icons/react/dist/csr/BellRinging';
import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { CircleIcon } from '@phosphor-icons/react/dist/csr/Circle';
import { ClockIcon } from '@phosphor-icons/react/dist/csr/Clock';
import { GitMergeIcon } from '@phosphor-icons/react/dist/csr/GitMerge';
import { InfoIcon } from '@phosphor-icons/react/dist/csr/Info';
import { PulseIcon } from '@phosphor-icons/react/dist/csr/Pulse';
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import { XCircleIcon } from '@phosphor-icons/react/dist/csr/XCircle';
import type { Icon } from '@phosphor-icons/react/dist/lib/types';
import type { PRState, WorkspaceSidebarCiState } from '@/shared/core';

export const STATUS_TONES = [
  'neutral',
  'working',
  'waiting',
  'attention',
  'success',
  'warning',
  'danger',
  'info',
  'merged',
] as const;

export type StatusTone = (typeof STATUS_TONES)[number];

export interface StatusToneStyle {
  /** Human-readable tone name, for stories and accessible fallbacks. */
  name: string;
  /** Theme token backing the tone, e.g. `running` for `text-running`. */
  token: string;
  /** Text and icon color. */
  text: string;
  /** Solid fill for small dots. */
  dot: string;
  /** Tinted chip or badge (text on a bright accent tint). */
  chip: string;
  /** Tinted panel or banner with a matching border. */
  surface: string;
  /** Accent border for cards that carry this status. */
  border: string;
  icon: Icon;
  /** Whether indicators animate by default (only live agent work does). */
  pulse: boolean;
}

/*
 * Class strings are written out in full so Tailwind can find them. Attention
 * ("needs you") deliberately shares the warning token: both ask the user to act,
 * and the remaining distinct hues are taken by running (brand yellow), danger,
 * success, waiting/info and merged. Icons and labels tell them apart.
 */
const STATUS_TONE_STYLES: Record<StatusTone, StatusToneStyle> = {
  neutral: {
    name: 'Neutral',
    token: 'muted-foreground',
    text: 'text-muted-foreground',
    dot: 'bg-muted-foreground/50',
    chip: 'border-transparent bg-muted text-muted-foreground',
    surface: 'border-border bg-muted/50 text-muted-foreground',
    border: 'border-border',
    icon: CircleIcon,
    pulse: false,
  },
  working: {
    name: 'Running',
    token: 'running',
    text: 'text-running',
    dot: 'bg-running',
    chip: 'border-transparent bg-running-accent/15 text-running dark:bg-running/10',
    surface:
      'border-running-accent/50 bg-running-accent/15 dark:border-running/30 text-running dark:bg-running/10',
    border: 'border-running-accent/70 dark:border-running/40',
    icon: PulseIcon,
    pulse: true,
  },
  waiting: {
    name: 'Waiting',
    token: 'info',
    text: 'text-info',
    dot: 'bg-info',
    chip: 'border-transparent bg-info-accent/15 text-info dark:bg-info/10',
    surface:
      'border-info-accent/50 bg-info-accent/15 dark:border-info/30 text-info dark:bg-info/10',
    border: 'border-info-accent/70 dark:border-info/40',
    icon: ClockIcon,
    pulse: false,
  },
  attention: {
    name: 'Needs you',
    token: 'warning',
    text: 'text-warning',
    dot: 'bg-warning',
    chip: 'border-transparent bg-warning-accent/15 text-warning dark:bg-warning/10',
    surface:
      'border-warning-accent/50 bg-warning-accent/15 dark:border-warning/30 text-warning dark:bg-warning/10',
    border: 'border-warning-accent/70 dark:border-warning/40',
    icon: BellRingingIcon,
    pulse: false,
  },
  success: {
    name: 'Success',
    token: 'success',
    text: 'text-success',
    dot: 'bg-success',
    chip: 'border-transparent bg-success-accent/15 text-success dark:bg-success/10',
    surface:
      'border-success-accent/50 bg-success-accent/15 dark:border-success/30 text-success dark:bg-success/10',
    border: 'border-success-accent/70 dark:border-success/40',
    icon: CheckCircleIcon,
    pulse: false,
  },
  warning: {
    name: 'Warning',
    token: 'warning',
    text: 'text-warning',
    dot: 'bg-warning',
    chip: 'border-transparent bg-warning-accent/15 text-warning dark:bg-warning/10',
    surface:
      'border-warning-accent/50 bg-warning-accent/15 dark:border-warning/30 text-warning dark:bg-warning/10',
    border: 'border-warning-accent/70 dark:border-warning/40',
    icon: WarningIcon,
    pulse: false,
  },
  danger: {
    name: 'Danger',
    token: 'destructive',
    text: 'text-destructive',
    dot: 'bg-destructive',
    chip: 'border-transparent bg-destructive-accent/15 text-destructive dark:bg-destructive/10',
    surface:
      'border-destructive-accent/50 bg-destructive-accent/15 dark:border-destructive/30 text-destructive dark:bg-destructive/10',
    border: 'border-destructive-accent/70 dark:border-destructive/40',
    icon: XCircleIcon,
    pulse: false,
  },
  info: {
    name: 'Info',
    token: 'info',
    text: 'text-info',
    dot: 'bg-info',
    chip: 'border-transparent bg-info-accent/15 text-info dark:bg-info/10',
    surface:
      'border-info-accent/50 bg-info-accent/15 dark:border-info/30 text-info dark:bg-info/10',
    border: 'border-info-accent/70 dark:border-info/40',
    icon: InfoIcon,
    pulse: false,
  },
  merged: {
    name: 'Merged',
    token: 'merged',
    text: 'text-merged',
    dot: 'bg-merged',
    chip: 'border-transparent bg-merged-accent/15 text-merged dark:bg-merged/10',
    surface:
      'border-merged-accent/50 bg-merged-accent/15 dark:border-merged/30 text-merged dark:bg-merged/10',
    border: 'border-merged-accent/70 dark:border-merged/40',
    icon: GitMergeIcon,
    pulse: false,
  },
};

export function getStatusToneStyle(tone: StatusTone): StatusToneStyle {
  return STATUS_TONE_STYLES[tone];
}

/** Diff statistics (+added / −removed) use the success and danger text colors. */
export const DIFF_STAT_CLASS_NAMES = {
  added: 'text-success',
  removed: 'text-destructive',
} as const;

export interface StatusPresentation {
  tone: StatusTone;
  label: string;
}

/**
 * Pull request state, following GitHub's conventions: open is green, draft is
 * neutral, merged is purple and closed is red. Returns null when there is no PR.
 */
export function getPrStatePresentation(
  prState: PRState | null | undefined
): StatusPresentation | null {
  switch (prState) {
    case 'DRAFT':
      return { tone: 'neutral', label: 'Draft' };
    case 'OPEN':
      return { tone: 'success', label: 'Open' };
    case 'APPROVED':
      return { tone: 'success', label: 'Approved' };
    case 'CHANGES_REQUESTED':
      return { tone: 'danger', label: 'Changes requested' };
    case 'MERGED':
      return { tone: 'merged', label: 'Merged' };
    case 'CLOSED':
      return { tone: 'danger', label: 'Closed' };
    default:
      return null;
  }
}

/**
 * Tone for the combined CI/PR state shown in the sidebar, board and PR lists.
 * Terminal PR states match {@link getPrStatePresentation}.
 */
export function getCiStateTone(ciState: WorkspaceSidebarCiState): StatusTone {
  switch (ciState) {
    case 'PASSING':
      return 'success';
    case 'FAILING':
      return 'danger';
    case 'RUNNING':
      return 'waiting';
    case 'CONFLICT':
      return 'attention';
    case 'MERGED':
      return 'merged';
    case 'CLOSED':
      return 'danger';
    case 'UNKNOWN':
    case 'NONE':
      return 'neutral';
  }
}
