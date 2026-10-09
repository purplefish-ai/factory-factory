import { expect, it, vi } from 'vitest';
import { createResumeQueuedMessagesHandler } from '@/backend/services/session/service/chat/chat-message-handlers/handlers/resume-queued-messages.handler';
import { sessionBackgroundDeliveryService } from '@/backend/services/session/service/lifecycle/session-background-delivery.service';

it('does not enable or dispatch queued messages when a newer stop supersedes resume', async () => {
  const sessionId = 'queued-resume-stop';
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let pauseReason: string | null = 'SESSION_FAILED';
  sessionBackgroundDeliveryService.configure({
    prepare: () => Promise.resolve({ status: 'discard' }),
    validate: () => Promise.resolve(false),
    complete: () => Promise.resolve(),
    fail: () => Promise.resolve(),
    recover: () => Promise.resolve(),
    pause: (_id, reason) => {
      pauseReason = reason;
      return Promise.resolve();
    },
    resume: async (_id, isCurrent) => {
      entered();
      await pending;
      if (isCurrent?.()) {
        pauseReason = null;
      }
    },
  });
  const dispatch = vi.fn().mockResolvedValue(undefined);
  const manual = vi.fn();
  const resume = createResumeQueuedMessagesHandler({
    tryDispatchNextMessage: dispatch,
    setManualDispatchResume: manual,
  })({
    ws: { send: vi.fn() } as never,
    sessionId,
    workingDir: '/tmp',
    message: { type: 'resume_queued_messages' } as never,
  });
  await started;
  await sessionBackgroundDeliveryService.userStop(sessionId);
  release();
  await resume;
  expect(pauseReason).toBe('USER_STOPPED');
  expect(manual).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
});
