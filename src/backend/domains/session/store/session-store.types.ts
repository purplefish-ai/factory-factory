import type { ChatMessage, QueuedMessage } from '@/shared/claude';
import type { PendingInteractiveRequest } from '@/shared/pending-request-types';
import type { SessionRuntimeState } from '@/shared/session-runtime';

export interface SessionStore {
  sessionId: string;
  initialized: boolean;
  transcript: ChatMessage[];
  queue: QueuedMessage[];
  pendingInteractiveRequest: PendingInteractiveRequest | null;
  runtime: SessionRuntimeState;
  nextOrder: number;
}

export type SnapshotReason =
  | 'subscribe_load'
  | 'enqueue'
  | 'remove_queued_message'
  | 'dequeue'
  | 'requeue'
  | 'commit_user_message'
  | 'pending_request_set'
  | 'pending_request_cleared'
  | 'process_exit_reset'
  | 'queue_cleared'
  | 'manual_emit'
  | 'inject_user_message';
