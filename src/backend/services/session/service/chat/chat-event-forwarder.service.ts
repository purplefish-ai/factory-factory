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

import { toError } from '@/backend/lib/error-utils';
import { createLogger } from '@/backend/services/logger.service';
import type { SessionWorkspaceBridge } from '@/backend/services/session/service/bridges';
import { sessionDataService } from '@/backend/services/session/service/data/session-data.service';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { sessionEventBus } from '@/backend/services/session/service/session-event-bus';
import { voiceNarrationService } from '@/backend/services/session/service/voice/voice-narration.service';
import type { PendingInteractiveRequest } from '@/shared/pending-request-types';

const logger = createLogger('chat-event-forwarder');

// A completed turn's voice-suppression check must not block workspace
// notifications indefinitely if the DB lookup stalls (pool exhaustion, a
// lock) rather than rejecting outright — bound it and fail open on timeout.
const VOICE_ACTIVE_CHECK_TIMEOUT_MS = 2000;

// ============================================================================
// Types
// ============================================================================

export interface EventForwarderContext {
  workspaceId: string;
  workingDir: string;
}

interface RequestNotificationData {
  workspaceId: string;
  workspaceName: string;
  sessionCount: number;
  finishedAt: Date;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
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
   * Serializes the async voice-suppression check + publish so back-to-back
   * completion events reach clients in the order they fired, not in
   * whichever order their DB lookups happen to resolve.
   */
  private notificationChain: Promise<void> = Promise.resolve();

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
      // Chained (not fired independently) so a slower lookup for an earlier
      // completion can't let a later one's notification arrive first.
      this.notificationChain = this.notificationChain.then(() =>
        this.publishWorkspaceNotification(data)
      );
    });
  }

  private async publishWorkspaceNotification(data: RequestNotificationData): Promise<void> {
    const { workspaceId, workspaceName, sessionCount, finishedAt } = data;

    const publish = () => {
      logger.debug('Broadcasting workspace notification request', { workspaceId });
      // Publish to all connected clients so any workspace can hear the
      // notification; the WebSocket adapter owns delivery.
      sessionEventBus.publishToAllClients({
        type: 'workspace_notification_request',
        workspaceId,
        workspaceName,
        sessionCount,
        finishedAt: finishedAt.toISOString(),
      });
    };

    // Voice mode already speaks the agent's reply aloud, so the chime is a
    // redundant, jarring second notification on top of it — suppress it
    // here, centrally, rather than relying on each connected browser
    // tab/window to independently know voice mode is active elsewhere.
    let sessions: Awaited<ReturnType<typeof sessionDataService.findAgentSessionsByWorkspaceId>>;
    try {
      sessions = await withTimeout(
        sessionDataService.findAgentSessionsByWorkspaceId(workspaceId),
        VOICE_ACTIVE_CHECK_TIMEOUT_MS
      );
    } catch (error) {
      // This lookup runs on every turn for every workspace, voice or not —
      // a DB hiccup (or a stall past the timeout) here must not silently
      // swallow the notification for non-voice users just because the new
      // voice-suppression check failed to resolve. Fail open.
      logger.error(
        'Failed to check voice-active state; publishing notification anyway',
        toError(error),
        { workspaceId }
      );
      publish();
      return;
    }

    if (sessions.some((session) => voiceNarrationService.hasActiveConnection(session.id))) {
      logger.debug('Suppressing workspace notification: voice mode active', { workspaceId });
      return;
    }
    publish();
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
