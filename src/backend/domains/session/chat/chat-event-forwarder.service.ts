/**
 * Chat Event Forwarder Service
 *
 * Handles interactive request routing and workspace notifications.
 * Responsible for:
 * - Managing pending interactive requests for session restore
 * - Broadcasting workspace notifications to WebSocket connections
 *
 * Note: Event forwarding from agents is now handled by AcpClientHandler/AcpEventTranslator.
 * This service retains the workspace notification and pending request management responsibilities.
 */

import { WS_READY_STATE } from '@/backend/constants/websocket';
import type { SessionWorkspaceBridge } from '@/backend/domains/session/bridges';
import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
import { createLogger } from '@/backend/services/logger.service';
import type { PendingInteractiveRequest } from '@/shared/pending-request-types';
import { chatConnectionService } from './chat-connection.service';

const logger = createLogger('chat-event-forwarder');

// ============================================================================
// Types
// ============================================================================

export interface EventForwarderContext {
  workspaceId: string;
  workingDir: string;
}

// ============================================================================
// Service
// ============================================================================

class ChatEventForwarderService {
  /** Guard to prevent multiple workspace notification setups */
  private workspaceNotificationsSetup = false;

  /** Cross-domain bridge for workspace activity (injected by orchestration layer) */
  private workspaceBridge: SessionWorkspaceBridge | null = null;

  /**
   * Configure cross-domain bridges. Called once at startup by orchestration layer.
   */
  configure(bridges: { workspace: SessionWorkspaceBridge }): void {
    this.workspaceBridge = bridges.workspace;
  }

  private get workspace(): SessionWorkspaceBridge {
    if (!this.workspaceBridge) {
      throw new Error(
        'ChatEventForwarderService not configured: workspace bridge missing. Call configure() first.'
      );
    }
    return this.workspaceBridge;
  }

  /**
   * Check if event forwarding is set up for a session.
   * With ACP, event forwarding is handled by AcpClientHandler, so this always returns false.
   */
  isSetup(_dbSessionId: string): boolean {
    return false;
  }

  /**
   * Get pending interactive request for a session.
   */
  getPendingRequest(dbSessionId: string): PendingInteractiveRequest | undefined {
    return sessionDomainService.getPendingInteractiveRequest(dbSessionId) ?? undefined;
  }

  /**
   * Clear pending interactive request unconditionally.
   * Used when stopping a session - the pending request is no longer valid.
   */
  clearPendingRequest(dbSessionId: string): void {
    sessionDomainService.clearPendingInteractiveRequest(dbSessionId);
  }

  /**
   * Clear pending interactive request only if the requestId matches.
   * Prevents clearing a newer request when responding to a stale one.
   */
  clearPendingRequestIfMatches(dbSessionId: string, requestId: string): void {
    sessionDomainService.clearPendingInteractiveRequestIfMatches(dbSessionId, requestId);
  }

  /**
   * Set up workspace-level notification forwarding.
   * Call this once during handler initialization.
   */
  setupWorkspaceNotifications(): void {
    if (this.workspaceNotificationsSetup) {
      return; // Already set up
    }
    this.workspaceNotificationsSetup = true;

    this.workspace.on('request_notification', (data) => {
      const { workspaceId, workspaceName, sessionCount, finishedAt } = data;

      logger.debug('Broadcasting workspace notification request', { workspaceId });

      // Send to all open connections so any workspace can hear the notification
      const message = JSON.stringify({
        type: 'workspace_notification_request',
        workspaceId,
        workspaceName,
        sessionCount,
        finishedAt: finishedAt.toISOString(),
      });

      for (const info of chatConnectionService.values()) {
        if (info.ws.readyState === WS_READY_STATE.OPEN) {
          try {
            info.ws.send(message);
          } catch (error) {
            logger.error('Failed to send workspace notification', error as Error);
          }
        }
      }
    });
  }

  /**
   * Get all pending interactive requests indexed by session ID.
   * Used by workspace query service to determine which workspaces have pending requests.
   */
  getAllPendingRequests(): Map<string, PendingInteractiveRequest> {
    return sessionDomainService.getAllPendingRequests();
  }
}

export const chatEventForwarderService = new ChatEventForwarderService();
