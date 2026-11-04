import { createLogger } from '@/backend/services/logger.service';
import type {
  SessionCommandPromptService,
  SessionCommandRuntimeManager,
} from '@/backend/services/session/service/chat/session-command.types';
import type {
  SessionCommandHandler,
  SessionCommandError,
  SessionCommandOutcome,
  SessionExecutionCommandServices,
} from '@/backend/services/session/service/chat/session-command.types';
import type { UserInputMessage } from '@/shared/websocket';
import { DirectInputContentSchema } from '@/shared/websocket/direct-input-content.schema';

const logger = createLogger('chat-message-handlers');

export function createUserInputHandler(deps: {
  acpRuntimeManager: SessionCommandRuntimeManager;
  sessionService: SessionCommandPromptService;
  backgroundDelivery: SessionExecutionCommandServices['backgroundDelivery'];
  humanMessageAccepted?: SessionExecutionCommandServices['humanMessageAccepted'];
  reportInputFailure(
    error: Extract<SessionCommandError, { kind: 'user_input_failed' }>
  ): void | Promise<void>;
}): SessionCommandHandler<UserInputMessage> {
  const { acpRuntimeManager, sessionService } = deps;
  const pendingAdmissions = new Map<string, Promise<void>>();

  return ({ sessionId }, message) => {
    const rawContent = message.content || message.text;
    if (!rawContent) {
      return { replies: [] };
    }

    if (typeof rawContent === 'string' && !rawContent.trim()) {
      return { replies: [] };
    }

    const parsed = DirectInputContentSchema.safeParse(rawContent);
    if (!parsed.success) {
      return {
        replies: [
          {
            type: 'error',
            error: {
              kind: 'user_input_failed',
              sessionId,
              content: rawContent,
              cause: parsed.error,
            },
          },
        ],
      };
    }
    const messageContent = parsed.data;

    if (acpRuntimeManager.isSessionRunning(sessionId)) {
      const isCurrent = deps.backgroundDelivery.captureResumeGuard(sessionId);
      const acceptedAt = new Date();
      const assertCurrent = () => {
        if (!(isCurrent() && acpRuntimeManager.isSessionRunning(sessionId))) {
          throw new DOMException('Session stopped before input submission', 'AbortError');
        }
      };
      const submit = async (): Promise<SessionCommandOutcome> => {
        try {
          assertCurrent();
          await deps.humanMessageAccepted?.(sessionId, acceptedAt);
          assertCurrent();
          // The send promise spans the entire provider turn. Serialize only
          // admission and submission; the prompt service owns turn ordering.
          void sessionService.sendSessionMessage(sessionId, messageContent).catch(async (cause) => {
            logger.error('Failed to send message to provider', { sessionId, error: cause });
            try {
              await deps.reportInputFailure({
                kind: 'user_input_failed',
                sessionId,
                content: messageContent,
                cause,
              });
            } catch (error) {
              logger.warn('Failed to publish direct input recovery', { sessionId, error });
            }
          });
          void deps.backgroundDelivery.userResume(sessionId, isCurrent).catch((error) => {
            logger.warn('Failed to resume PR delivery after human input', { sessionId, error });
          });
          return { replies: [] };
        } catch (cause) {
          logger.warn('Failed to admit direct human input', { sessionId, error: cause });
          return {
            replies: [
              {
                type: 'error',
                error: { kind: 'user_input_failed', sessionId, content: messageContent, cause },
              },
            ],
          };
        }
      };
      const previous = pendingAdmissions.get(sessionId);
      const outcome = previous !== undefined ? previous.then(submit) : submit();
      const tail = outcome.then(() => undefined);
      pendingAdmissions.set(sessionId, tail);
      void tail.then(() => {
        if (pendingAdmissions.get(sessionId) === tail) {
          pendingAdmissions.delete(sessionId);
        }
      });
      return outcome;
    }

    return { replies: [{ type: 'error', error: { kind: 'no_active_session' } }] };
  };
}
