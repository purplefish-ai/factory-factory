import type WebSocket from 'ws';
import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
import { sessionService } from '../../../lifecycle/session.service';

interface GetClientOptions {
  sessionId: string;
  ws: WebSocket;
  requestId?: string;
}

export function sendWebSocketError(ws: WebSocket, message: string): void {
  ws.send(JSON.stringify({ type: 'error', message }));
}

export function clearPendingInteractiveRequest(sessionId: string, requestId: string): void {
  sessionDomainService.clearPendingInteractiveRequestIfMatches(sessionId, requestId);
}

export function getClientOrSendError({
  sessionId,
  ws,
  requestId,
}: GetClientOptions): NonNullable<ReturnType<typeof sessionService.getClient>> | null {
  const client = sessionService.getClient(sessionId);
  if (!client) {
    if (requestId) {
      clearPendingInteractiveRequest(sessionId, requestId);
    }
    sendWebSocketError(ws, 'No active client for session');
    return null;
  }
  return client;
}
