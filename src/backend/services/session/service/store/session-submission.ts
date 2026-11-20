import { isDeepStrictEqual } from 'node:util';
import { MessageState, type ChatMessage, type QueuedMessage } from '@/shared/acp-protocol';
import { visibleQueue } from './session-queue';
import type { RecentMessageRejection, SessionStore } from './session-store.types';

type SubmissionContent = Pick<ChatMessage, 'text' | 'attachments'>;
type SubmittedOptions = Pick<QueuedMessage, 'voiceMode' | 'settings'>;

function sameContent(left: SubmissionContent, right: SubmissionContent): boolean {
  return (
    left.text === right.text && isDeepStrictEqual(left.attachments ?? [], right.attachments ?? [])
  );
}

function sameSubmission(
  candidate: QueuedMessage,
  existing: SubmissionContent,
  options?: SubmittedOptions
): boolean {
  return (
    options !== undefined &&
    sameContent(candidate, existing) &&
    Boolean(candidate.voiceMode) === Boolean(options.voiceMode) &&
    isDeepStrictEqual(candidate.settings, options.settings)
  );
}

export function retainSubmissionOptions(
  store: SessionStore,
  transcript: readonly ChatMessage[],
  submittedOptions: WeakMap<QueuedMessage | ChatMessage, SubmittedOptions>
): void {
  for (const row of transcript) {
    const index = store.transcriptIdToIndex.get(row.id);
    const previous = index === undefined ? undefined : store.transcript[index];
    const options = previous && submittedOptions.get(previous);
    if (row.source === 'user' && previous && options && sameContent(previous, row)) {
      submittedOptions.set(row, options);
    }
  }
}

export function rejectionEvent(
  rejection: Pick<RecentMessageRejection, 'id' | 'state' | 'errorMessage' | 'userMessage'>
) {
  return {
    type: 'message_state_changed' as const,
    id: rejection.id,
    newState: rejection.state ?? MessageState.REJECTED,
    errorMessage: rejection.errorMessage,
    ...(rejection.userMessage ? { userMessage: rejection.userMessage } : {}),
  };
}

export function existingSubmission(
  store: SessionStore,
  candidate: QueuedMessage,
  pendingAdmissions: WeakMap<QueuedMessage, Promise<void>>,
  submittedOptions: WeakMap<QueuedMessage | ChatMessage, SubmittedOptions>
) {
  const queue = visibleQueue(store);
  const position = queue.findIndex((message) => message.id === candidate.id);
  const queued = queue[position];
  const index = store.transcriptIdToIndex.get(candidate.id);
  const committed = index === undefined ? undefined : store.transcript[index];
  if (queued) {
    if (
      queued.source ||
      !sameSubmission(candidate, queued, submittedOptions.get(queued) ?? queued)
    ) {
      return { kind: 'conflict' as const };
    }
    return pendingAdmissions.has(queued)
      ? { kind: 'pending' as const }
      : { kind: 'queued' as const, message: queued, position };
  }
  if (!committed) {
    return previousRejection(store, candidate);
  }
  if (
    committed.source !== 'user' ||
    !sameSubmission(candidate, committed, submittedOptions.get(committed))
  ) {
    return { kind: 'conflict' as const };
  }
  return { kind: 'committed' as const, message: committed, queue };
}

function previousRejection(store: SessionStore, candidate: QueuedMessage) {
  const rejection = store.recentRejections.find(
    (entry) => entry.id === candidate.id && entry.expiresAt > Date.now()
  );
  if (!rejection) {
    return;
  }
  return rejection.userMessage &&
    sameSubmission(candidate, rejection.userMessage, rejection.submittedOptions)
    ? { kind: 'rejected' as const, event: rejectionEvent(rejection) }
    : { kind: 'conflict' as const };
}
