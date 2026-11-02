import type { PromptConfigurationPermit } from '@/backend/services/session/service/acp/acp-prompt-configuration';
import { PromptNotInvokedError } from '@/backend/services/session/service/acp/acp-prompt-invocation';
import type { SessionCallerGuard } from '@/backend/services/session/service/bridges';
import { UncertainChatDispatchError } from '@/backend/services/session/service/chat/chat-intent-errors';
import type { PermanentAttachmentError } from '@/backend/services/session/service/chat/chat-message-handlers/attachment-processing';
import type { SessionChatIntentService } from '@/backend/services/session/service/chat/session-chat-intent.service';
import type { AgentContentItem, QueuedMessage } from '@/shared/acp-protocol';
import { prepareBatchContents } from './session-dispatch-batch';
import type { SessionDispatchDependencies } from './session-dispatch.types';

type AttemptInput = {
  owner?: SessionChatIntentService;
  sessionId: string;
  messages: QueuedMessage[];
  content: string | AgentContentItem[];
  settings: QueuedMessage['settings'];
  generation: number;
  expectedRevisions?: Record<string, number>;
  configurationPermit?: PromptConfigurationPermit;
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
    input.generation,
    input.expectedRevisions,
    input.configurationPermit
      ? {
          provider: input.configurationPermit.provider,
          providerSessionId: input.configurationPermit.providerSessionId,
          configOptions: input.configurationPermit.configOptions(),
        }
      : undefined
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
        return await rethrowAttemptFailure(input, id, error);
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
      await owner?.settleNotInvoked(
        input.sessionId,
        id,
        input.isCurrent() ? 'queued' : 'cancelled'
      );
    }
    throw new PromptNotInvokedError(error);
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

export function sendConfiguredMessage(
  service: SessionDispatchDependencies['promptService'],
  sessionId: string,
  content: string | AgentContentItem[],
  guard?: SessionCallerGuard,
  permit?: PromptConfigurationPermit
): Promise<void> {
  if (permit) {
    return service.sendSessionMessage(sessionId, content, guard, permit);
  }
  return guard
    ? service.sendSessionMessage(sessionId, content, guard)
    : service.sendSessionMessage(sessionId, content);
}

async function rethrowAttemptFailure(
  input: AttemptInput,
  id: string | null | undefined,
  error: unknown
): Promise<never> {
  if (id && error instanceof PromptNotInvokedError) {
    await input.owner?.settleNotInvoked(
      input.sessionId,
      id,
      input.isCurrent() ? 'queued' : 'cancelled'
    );
    throw error;
  }
  if (id) {
    throw new UncertainChatDispatchError(id, { cause: error });
  }
  throw error;
}
