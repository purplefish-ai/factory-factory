import type { AgentContentItem, QueuedMessage } from '@/shared/acp-protocol';
import type { SessionCallerGuard } from '../bridges';
import { UncertainChatDispatchError } from '../chat/chat-intent-errors';
import type { PermanentAttachmentError } from '../chat/chat-message-handlers/attachment-processing';
import type { SessionChatIntentService } from '../chat/session-chat-intent.service';
import { prepareBatchContents } from './session-dispatch-batch';

type AttemptInput = {
  owner?: SessionChatIntentService;
  sessionId: string;
  messages: QueuedMessage[];
  content: string | AgentContentItem[];
  settings: QueuedMessage['settings'];
  generation: number;
  isCurrent(): boolean;
  guard?: SessionCallerGuard;
};

export async function prepareDurableAttempt(input: AttemptInput) {
  const { owner } = input;
  const id = await owner?.claim(
    input.sessionId,
    input.messages,
    input.content,
    input.settings,
    input.generation
  );
  return {
    async invoke<T>(
      send: () => Promise<T>,
      outcome: (result: T) => 'committed' | 'queued' = () => 'committed'
    ): Promise<T> {
      await checkBeforeInvocation(input, id);
      try {
        const result = await send();
        if (id) {
          const desired = outcome(result);
          const status = desired === 'queued' && !input.isCurrent() ? 'cancelled' : desired;
          await owner?.store.settle(
            id,
            status,
            status === 'committed'
              ? 'provider acknowledged prompt/injection'
              : 'provider explicitly declined injection; normal prompt required'
          );
        }
        return result;
      } catch (error) {
        if (id) {
          throw new UncertainChatDispatchError(id, { cause: error });
        }
        throw error;
      }
    },
  };
}

async function checkBeforeInvocation(
  input: AttemptInput,
  id: string | null | undefined
): Promise<void> {
  const { owner } = input;
  try {
    await input.guard?.check();
    input.guard?.assertCurrent?.();
    if (!input.isCurrent()) {
      throw new Error('Session stopped before provider invocation');
    }
  } catch (error) {
    if (id) {
      await owner?.store.settle(
        id,
        input.isCurrent() ? 'queued' : 'cancelled',
        'fence prevented provider invocation'
      );
    }
    throw error;
  }
}

/** Reject terminally invalid members durably before continuing with the valid batch. */
export async function prepareDurableBatchContents(
  owner: SessionChatIntentService | undefined,
  sessionId: string,
  messages: QueuedMessage[],
  buildContent: (message: QueuedMessage) => string | AgentContentItem[],
  reject: (message: QueuedMessage, error: PermanentAttachmentError) => void
) {
  const rejected: QueuedMessage[] = [];
  const contents = prepareBatchContents(messages, buildContent, (message, error) => {
    rejected.push(message);
    reject(message, error);
  });
  for (const message of rejected) {
    await owner?.cancel(sessionId, message.id, 'failed');
  }
  return contents;
}
