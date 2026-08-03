/**
 * soft_stop handling for the /voice WebSocket, split out from voice.handler.ts
 * so it's directly unit-testable without driving the WS upgrade machinery
 * (mirrors chat-message-handlers/handlers/stop.handler.ts's factory shape).
 *
 * Cancels the in-flight prompt via `acpRuntimeManager.cancelPrompt` — the
 * same lightweight primitive already used for prompt-timeout recovery —
 * rather than `SessionLifecycleService.stopSession`'s full teardown, so a
 * voice "please stop" doesn't kill and respawn the ACP subprocess.
 */

import { randomUUID } from 'node:crypto';
import type {
  AcpRuntimeManager,
  sessionDataService,
  sessionLifecycleEventService,
} from '@/backend/services/session';
import { SessionLifecycleEventKind, SessionLifecycleEventReason } from '@/shared/core';

export interface VoiceSoftStopDependencies {
  acpRuntimeManager: Pick<AcpRuntimeManager, 'cancelPrompt'>;
  sessionDataService: Pick<typeof sessionDataService, 'findAgentSessionById'>;
  sessionLifecycleEventService: Pick<typeof sessionLifecycleEventService, 'record'>;
  logger: { info(message: string, context?: Record<string, unknown>): void };
}

export function createVoiceSoftStopHandler(
  deps: VoiceSoftStopDependencies
): (sessionId: string) => Promise<void> {
  return async (sessionId: string) => {
    deps.logger.info('Voice soft_stop received', { sessionId });
    const cancelled = await deps.acpRuntimeManager.cancelPrompt(sessionId);
    deps.logger.info('cancelPrompt completed for voice soft_stop', { sessionId, cancelled });

    if (!cancelled) {
      // No prompt was actually in flight (e.g. an idle session) — recording
      // a "Turn interrupted" event here would be a false transcript entry.
      return;
    }

    const session = await deps.sessionDataService.findAgentSessionById(sessionId);
    if (!session) {
      deps.logger.info('Skipped voice_interrupt lifecycle event — session not found', {
        sessionId,
      });
      return;
    }
    await deps.sessionLifecycleEventService.record({
      workspaceId: session.workspaceId,
      sessionId,
      kind: SessionLifecycleEventKind.TURN_INTERRUPTED,
      reason: SessionLifecycleEventReason.VOICE_INTERRUPT,
      message: 'Turn interrupted by voice command.',
      dedupeKey: `voice-interrupt:${sessionId}:${randomUUID()}`,
    });
  };
}
