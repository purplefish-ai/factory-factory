import type { ChatMessage, CommandInfo, MessageState, QueuedMessage } from '@/shared/acp-protocol';
import type { AcpPlanNotification } from '@/shared/acp-protocol/task-plan';
import type { PendingInteractiveRequest } from '@/shared/pending-request-types';
import type { SessionRuntimeState } from '@/shared/session-runtime';

export interface RecentMessageRejection {
  id: string;
  errorMessage: string;
  submittedOptions?: Pick<QueuedMessage, 'settings' | 'voiceMode'>;
  rejectedAt: string;
  expiresAt: number;
  state?: MessageState.REJECTED | MessageState.FAILED;
  userMessage?: Pick<QueuedMessage, 'text' | 'timestamp' | 'attachments' | 'voiceMode'> & {
    sessionId?: string;
  };
}

/** A provider history file as `stat` saw it. Any changed field means the content may differ. */
export interface HistoryFileIdentity {
  filePath: string;
  size: number;
  mtimeMs: number;
  ino: number;
}

export interface SessionStore {
  sessionId: string;
  initialized: boolean;
  historyHydrated?: boolean;
  historyProviderSessionId?: string;
  historyReadGeneration?: number;
  historySuspended?: boolean;
  historyHydratedAt?: string;
  historyHydrationSource?: 'jsonl' | 'acp_fallback' | 'none';
  /** The history file a `jsonl` hydration projected, when it was unchanged across the read. */
  historyFile?: HistoryFileIdentity;
  liveSlashCommands?: CommandInfo[];
  taskPlan?: AcpPlanNotification;
  transcript: ChatMessage[];
  transcriptIdToIndex: Map<string, number>;
  queue: QueuedMessage[];
  /** Taken by dispatch, still visible until each handoff or failure. */
  dispatching?: Map<QueuedMessage, symbol>;
  recentRejections: RecentMessageRejection[];
  pendingInteractiveRequest: PendingInteractiveRequest | null;
  runtime: SessionRuntimeState;
  nextOrder: number;
}

export type SnapshotReason =
  | 'subscribe_load'
  | 'enqueue'
  | 'remove_queued_message'
  | 'remove_transcript_message'
  | 'process_exit_reset'
  | 'queue_cleared'
  | 'manual_emit'
  | 'inject_user_message';
