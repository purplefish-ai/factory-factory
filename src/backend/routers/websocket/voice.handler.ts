/**
 * Voice WebSocket Handler
 *
 * Delivers Deepgram TTS audio for voice mode and receives voice control
 * messages (soft_stop, see voice-soft-stop.handler.ts). Typed or transcribed
 * text still flows entirely through the existing /chat WebSocket — this
 * connection carries only voice-specific control plane and audio, so it adds
 * zero new message types to ChatMessageSchema.
 */

import type { AppContext } from '@/backend/app-context';
import { toError } from '@/backend/lib/error-utils';
import { VoiceClientMessageSchema } from '@/shared/websocket/voice-message.schema';
import { parseWebSocketMessage } from './message-utils';
import { createWebSocketUpgradeHandler } from './upgrade-utils';
import { createVoiceSoftStopHandler } from './voice-soft-stop.handler';

export function createVoiceUpgradeHandler(appContext: AppContext) {
  const {
    acpRuntimeManager,
    configService,
    createLogger,
    sessionDataService,
    sessionLifecycleEventService,
    voiceNarrationService,
  } = appContext.services;
  const logger = createLogger('voice-handler');
  const handleSoftStop = createVoiceSoftStopHandler({
    acpRuntimeManager,
    sessionDataService,
    sessionLifecycleEventService,
  });

  return createWebSocketUpgradeHandler({
    connectionName: 'voice WebSocket',
    configService,
    logger,
    requiredParams: ['sessionId'] as const,
    onOpen: (ws, { params }) => {
      const { sessionId } = params;
      logger.info('Voice WebSocket connection established', { sessionId });
      voiceNarrationService.registerConnection(sessionId, ws);

      ws.on('message', (data) => {
        const message = parseWebSocketMessage(
          VoiceClientMessageSchema,
          data,
          logger,
          'voice message',
          { sessionId }
        );
        if (message?.type === 'soft_stop') {
          handleSoftStop(sessionId).catch((error) => {
            logger.error('Failed to handle voice soft_stop', toError(error), { sessionId });
          });
        }
      });

      ws.on('close', () => {
        logger.info('Voice WebSocket connection closed', { sessionId });
        voiceNarrationService.unregisterConnection(sessionId);
      });

      ws.on('error', (error) => {
        logger.error('Voice WebSocket error', toError(error));
      });
    },
  });
}
