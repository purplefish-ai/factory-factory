import type { ChatMessage, QueuedMessage } from '@/shared/acp-protocol';
import type { PendingInteractiveRequest } from '@/shared/pending-request-types';
import type { SessionRuntimeState } from '@/shared/session-runtime';

export interface SessionStore {
  sessionId: string;
  initialized: boolean;
  historyHydrated?: boolean;
  historyHydratedAt?: string;
  historyHydrationSource?: 'jsonl' | 'acp_fallback' | 'none';
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
