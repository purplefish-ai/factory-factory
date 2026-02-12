import type WebSocket from 'ws';
import { sessionDomainService } from '@/backend/domains/session/session-domain.service';

export function sendWebSocketError(ws: WebSocket, message: string): void {
  ws.send(JSON.stringify({ type: 'error', message }));
}

export function clearPendingInteractiveRequest(sessionId: string, requestId: string): void {
  sessionDomainService.clearPendingInteractiveRequestIfMatches(sessionId, requestId);
}
