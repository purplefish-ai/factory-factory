import type { GroupedMessageItem } from '@/lib/chat-protocol';
import type { SessionWorkState } from '@/shared/session-runtime';
import type { WorkspaceInitBanner } from '@/shared/workspace-init';
import type { AcpPlanState } from './reducer';

export interface TranscriptDisplayProps {
  /** Workspace ID (enables persisted tool expansion state per workspace) */
  workspaceId?: string;
  messages: GroupedMessageItem[];
  acpPlan?: AcpPlanState | null;
  running: boolean;
  work?: SessionWorkState;
  /** Present only while connected to this live session. */
  controlSessionId?: string;
  onOpenAgents?: () => void;
  runningSubagentIconIndices?: readonly number[];
  subagentTimelineError?: { message: string; onRetry: () => void } | null;
  startingSession: boolean;
  loadingSession: boolean;
  latestThinking?: string | null;
  /** The composer footer owns the live thinking preview. */
  hideThinkingIndicator?: boolean;
  startingLabel?: string;
  /** Set of message IDs that are still queued (not yet dispatched to agent) */
  queuedMessageIds?: Set<string>;
  /** Callback to remove/cancel a queued message */
  onRemoveQueuedMessage?: (id: string) => void;
  /** Send a queued human message into the active turn. */
  onSteerQueuedMessage?: (id: string) => void;
  /** Whether context compaction is in progress */
  isCompacting?: boolean;
  /** Get the SDK-assigned UUID for a user message by its stable message ID */
  getUuidForMessageId?: (messageId: string) => string | undefined;
  /** Callback when user initiates rewind to a message */
  onRewindToMessage?: (uuid: string) => void;
  resolveWorkspaceFileLink?: (href: string) => string | null;
  onWorkspaceFileLink?: (path: string) => void;
  /** Init banner for showing workspace initialization status */
  initBanner?: WorkspaceInitBanner | null;
}
