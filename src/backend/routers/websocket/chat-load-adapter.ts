import type {
  SessionCommandOutcome,
  SessionEventBus,
  SessionFileLogger,
  SessionLoadService,
} from '@/backend/services/session';
import { frameSessionReplay } from './session-replay-framing';

interface SessionLoadAdapterDependencies {
  loadService: Pick<SessionLoadService, 'prepareLoad' | 'captureReplay' | 'completeLoad'>;
  eventBus: Pick<SessionEventBus, 'publishToSession'>;
  fileLogger: Pick<SessionFileLogger, 'log'>;
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
  for (const frame of frameSessionReplay({
    type: 'session_replay_batch',
    replayEvents: replay.replayEvents,
    ...(loadRequestId ? { loadRequestId } : {}),
  })) {
    deps.eventBus.publishToSession(sessionId, frame);
  }
  await deps.loadService.completeLoad(prepared);
  return { replies: [] };
}
