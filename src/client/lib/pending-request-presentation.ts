/**
 * Copy and icons for a session blocked on the user (permission, question or
 * plan approval). Tabs, the thinking footer and the composer share this map so
 * a blocked session reads the same everywhere. The color is always the
 * `attention` status tone; the icon tells the request kinds apart and matches
 * the sidebar's per-workspace icon.
 */

import { ChatCircleDotsIcon } from '@phosphor-icons/react/dist/csr/ChatCircleDots';
import { ClipboardTextIcon } from '@phosphor-icons/react/dist/csr/ClipboardText';
import { ShieldWarningIcon } from '@phosphor-icons/react/dist/csr/ShieldWarning';
import type { Icon } from '@phosphor-icons/react/dist/lib/types';
import type { PendingRequestType } from '@/shared/pending-request-types';

export interface PendingRequestPresentation {
  icon: Icon;
  /** Short status label for tabs and accessible names. */
  label: string;
  /** One-line explanation for tab tooltips. */
  description: string;
  /** Replaces "Agent is working" while the agent waits. */
  waitingText: string;
  /** Composer placeholder; typed messages queue until the request resolves. */
  composerPlaceholder: string;
}

const PENDING_REQUEST_PRESENTATIONS: Record<PendingRequestType, PendingRequestPresentation> = {
  permission_request: {
    icon: ShieldWarningIcon,
    label: 'Needs approval',
    description: 'Waiting for your permission to continue',
    waitingText: 'Waiting for your approval',
    composerPlaceholder: 'Respond to the request above, or queue a message...',
  },
  user_question: {
    icon: ChatCircleDotsIcon,
    label: 'Needs answer',
    description: 'Waiting for your answer to a question',
    waitingText: 'Waiting for your answer',
    composerPlaceholder: 'Answer the question above, or queue a message...',
  },
  plan_approval: {
    icon: ClipboardTextIcon,
    label: 'Needs plan review',
    description: 'Waiting for you to approve the plan',
    waitingText: 'Waiting for your plan approval',
    composerPlaceholder: 'Approve the plan or keep planning...',
  },
};

export function getPendingRequestPresentation(
  type: PendingRequestType
): PendingRequestPresentation {
  return PENDING_REQUEST_PRESENTATIONS[type];
}
