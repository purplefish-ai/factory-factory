import type { GroupedMessageItem } from '@/lib/chat-protocol';
import type { SessionWorkState } from '@/shared/session-runtime';
import type { WorkspaceInitBanner } from '@/shared/workspace-init';

export interface TranscriptDisplayProps {
  /** Workspace ID (enables persisted tool expansion state per workspace) */
  workspaceId?: string;
  messages: GroupedMessageItem[];
  running: boolean;
  work?: SessionWorkState;
  onOpenAgents?: () => void;
  startingSession: boolean;
  loadingSession: boolean;
  latestThinking?: string | null;
  startingLabel?: string;
  /** Set of message IDs that are still queued (not yet dispatched to agent) */
  queuedMessageIds?: Set<string>;
  /** Callback to remove/cancel a queued message */
  onRemoveQueuedMessage?: (id: string) => void;
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
