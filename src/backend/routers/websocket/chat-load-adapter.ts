import { externalizeChatImages } from '@/backend/lib/chat-image-externalizer';
import type { ChatImageStore } from '@/backend/lib/chat-image-store';
import type {
  SessionCommandOutcome,
  SessionEventBus,
  SessionFileLogger,
  SessionLoadService,
} from '@/backend/services/session';
import { frameSessionReplay, SessionReplayLimitError } from './session-replay-framing';

interface SessionLoadAdapterDependencies {
  loadService: Pick<SessionLoadService, 'prepareLoad' | 'captureReplay' | 'completeLoad'>;
  eventBus: Pick<SessionEventBus, 'publishToSession'>;
  fileLogger: Pick<SessionFileLogger, 'log'>;
  /** Receives the images the replay sends as references. */
  images: ChatImageStore;
}

export async function executeSessionLoad(
  input: { sessionId: string; loadRequestId?: string },
  deps: SessionLoadAdapterDependencies
): Promise<SessionCommandOutcome> {
  const prepared = await deps.loadService.prepareLoad(input);
  if (prepared.status === 'error') {
    return prepared.outcome;
  }
  const { sessionId, loadRequestId } = prepared;
  const replay = deps.loadService.captureReplay(prepared);
  deps.fileLogger.log(sessionId, 'INFO', {
    type: 'parity_trace',
    path: 'replay_batch',
    reason: 'subscribe_load',
    loadRequestId: loadRequestId ?? null,
    replayEventCount: replay.replayEvents.length,
  });
  try {
    for (const frame of frameSessionReplay({
      type: 'session_replay_batch',
      // Before framing: an image would otherwise be resent on every load.
      replayEvents: externalizeChatImages(replay.replayEvents, deps.images),
      ...(loadRequestId ? { loadRequestId } : {}),
    })) {
      deps.eventBus.publishToSession(sessionId, frame.payload, frame.json);
    }
  } catch (error) {
    if (!(error instanceof SessionReplayLimitError)) {
      throw error;
    }
    deps.eventBus.publishToSession(sessionId, {
      type: 'error',
      code: 413,
      loadRequestId,
      message: error.message,
    });
  }
  await deps.loadService.completeLoad(prepared);
  return { replies: [] };
}
