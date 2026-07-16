/**
 * Snapshots WebSocket Handler
 *
 * Handles WebSocket connections for streaming workspace snapshot changes
 * to clients in real time, scoped by project ID. On connect, sends the
 * full project snapshot. On subsequent changes, pushes per-workspace deltas.
 */

import type { WebSocket } from 'ws';
import type { AppContext } from '@/backend/app-context';
import { WS_READY_STATE } from '@/backend/constants/websocket';
import { TopicBroadcaster } from '@/backend/lib/topic-broadcaster';
import { safeSend } from '@/backend/lib/websocket-send';
import { snapshotReconciliationService } from '@/backend/orchestration/snapshot-reconciliation.orchestrator';
import { createLogger } from '@/backend/services/logger.service';
import { workspaceQueryService } from '@/backend/services/workspace';
import {
  SNAPSHOT_CHANGED,
  SNAPSHOT_REMOVED,
  type SnapshotChangedEvent,
  type SnapshotRemovedEvent,
  workspaceSnapshotStore,
} from '@/backend/services/workspace-snapshot-store.service';
import { WorkspaceStatus } from '@/shared/core';
import { createWebSocketUpgradeHandler } from './upgrade-utils';

// ============================================================================
// State
// ============================================================================

/** Snapshot WebSocket connections, keyed by project ID. */
export const snapshotConnections = new TopicBroadcaster<string>(
  createLogger('snapshots-handler'),
  'snapshot message'
);

/**
 * Deltas that arrive for a socket before its snapshot_full baseline has been
 * sent. Entries exist only between connection setup and the baseline send;
 * flushing after snapshot_full may replay deltas already reflected in the
 * baseline, which is safe because clients upsert by workspaceId.
 */
const pendingDeltaBuffers = new WeakMap<WebSocket, string[]>();

// ============================================================================
// Store Event Fan-Out
// ============================================================================

class SnapshotStoreSubscriptionState {
  private active = false;
  private snapshotChangedListener: ((event: SnapshotChangedEvent) => void | Promise<void>) | null =
    null;
  private snapshotRemovedListener: ((event: SnapshotRemovedEvent) => void | Promise<void>) | null =
    null;

  ensure(
    connections: TopicBroadcaster<string>,
    logger: ReturnType<AppContext['services']['createLogger']>
  ): void {
    if (this.active) {
      return;
    }

    // Buffered replays omit reviewCount: it is computed before the
    // snapshot_full baseline, and clients keep their current count when the
    // field is absent, so replaying it would regress the baseline's count.
    const fanOutToProject = (
      projectId: string,
      payload: Record<string, unknown>,
      description: string
    ) => {
      const projectClients = connections.subscribers(projectId);
      if (projectClients.size === 0) {
        return;
      }

      const reviewCount = getSnapshotReviewCount(logger);
      const message = JSON.stringify({ ...payload, reviewCount });
      let bufferedMessage: string | null = null;

      for (const ws of projectClients) {
        const pendingDeltas = pendingDeltaBuffers.get(ws);
        if (pendingDeltas) {
          bufferedMessage ??= JSON.stringify(payload);
          pendingDeltas.push(bufferedMessage);
        } else {
          safeSend(ws, message, logger, description);
        }
      }
    };

    const changedListener = (event: SnapshotChangedEvent) => {
      const payload = isHiddenWorkspaceStatus(event.entry.status)
        ? {
            type: 'snapshot_removed',
            workspaceId: event.workspaceId,
          }
        : {
            type: 'snapshot_changed',
            workspaceId: event.workspaceId,
            entry: event.entry,
          };

      fanOutToProject(event.projectId, payload, 'snapshot delta');
    };

    const removedListener = (event: SnapshotRemovedEvent) => {
      fanOutToProject(
        event.projectId,
        {
          type: 'snapshot_removed',
          workspaceId: event.workspaceId,
        },
        'snapshot removal'
      );
    };

    workspaceSnapshotStore.on(SNAPSHOT_CHANGED, changedListener);
    workspaceSnapshotStore.on(SNAPSHOT_REMOVED, removedListener);

    this.snapshotChangedListener = changedListener;
    this.snapshotRemovedListener = removedListener;
    this.active = true;

    logger.info('Snapshot WebSocket store subscription active');
  }

  reset(): void {
    const storeWithOff = workspaceSnapshotStore as typeof workspaceSnapshotStore & {
      off?: (event: string, listener: (...args: unknown[]) => unknown) => unknown;
    };
    if (typeof storeWithOff.off === 'function') {
      if (this.snapshotChangedListener) {
        storeWithOff.off(SNAPSHOT_CHANGED, this.snapshotChangedListener);
      }
      if (this.snapshotRemovedListener) {
        storeWithOff.off(SNAPSHOT_REMOVED, this.snapshotRemovedListener);
      }
    }

    this.snapshotChangedListener = null;
    this.snapshotRemovedListener = null;
    this.active = false;
  }
}

const defaultSnapshotStoreSubscriptionState = new SnapshotStoreSubscriptionState();

function isHiddenWorkspaceStatus(status: WorkspaceStatus): boolean {
  return status === WorkspaceStatus.ARCHIVING || status === WorkspaceStatus.ARCHIVED;
}

function getSnapshotReviewCount(
  logger: ReturnType<AppContext['services']['createLogger']>
): number | undefined {
  try {
    const reviewCount = workspaceQueryService.getCachedReviewCount();
    workspaceQueryService.refreshReviewCountIfStale();
    return reviewCount;
  } catch (error) {
    logger.debug('Failed to read review count for snapshot message', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export function resetSnapshotsHandlerStateForTests(): void {
  snapshotConnections.clear();
  defaultSnapshotStoreSubscriptionState.reset();
}

// ============================================================================
// Upgrade Handler
// ============================================================================

export function createSnapshotsUpgradeHandler(
  appContext: AppContext,
  options: {
    connections?: TopicBroadcaster<string>;
    subscriptionState?: SnapshotStoreSubscriptionState;
  } = {}
) {
  const logger = appContext.services.createLogger('snapshots-handler');
  const { configService } = appContext.services;
  const connections = options.connections ?? snapshotConnections;
  const subscriptionState = options.subscriptionState ?? defaultSnapshotStoreSubscriptionState;

  return createWebSocketUpgradeHandler({
    connectionName: 'snapshots WebSocket',
    configService,
    logger,
    requiredParams: ['projectId'],
    onOpen: (ws, { params }) => {
      const { projectId } = params;

      subscriptionState.ensure(connections, logger);

      logger.info('Snapshots WebSocket connection established', { projectId });

      // Add to connection set FIRST so we don't miss any delta events during
      // the optional reconciliation wait below. Deltas that arrive before the
      // snapshot_full baseline are buffered and flushed after it.
      const untrack = connections.subscribe(projectId, ws);
      pendingDeltaBuffers.set(ws, []);

      // If a startup reconciliation is in progress and the store has no entries
      // yet for this project, wait for it before sending snapshot_full so the
      // client receives populated data rather than an empty array.
      const sendSnapshot = () => {
        if (ws.readyState !== WS_READY_STATE.OPEN) {
          // Keep buffering; the close handler cleans the buffer up.
          return;
        }
        const reviewCount = getSnapshotReviewCount(logger);
        const entries = workspaceSnapshotStore
          .getByProjectId(projectId)
          .filter((entry) => !isHiddenWorkspaceStatus(entry.status));
        const baselineSent = safeSend(
          ws,
          JSON.stringify({
            type: 'snapshot_full',
            projectId,
            entries,
            reviewCount,
          }),
          logger,
          'full snapshot'
        );
        if (!baselineSent) {
          // The client has no baseline, so deltas must not start flowing.
          return;
        }
        const pendingDeltas = pendingDeltaBuffers.get(ws) ?? [];
        pendingDeltaBuffers.delete(ws);
        for (const delta of pendingDeltas) {
          safeSend(ws, delta, logger, 'buffered snapshot delta');
        }
      };

      const storeHasEntries = workspaceSnapshotStore.getByProjectId(projectId).length > 0;
      if (storeHasEntries) {
        void sendSnapshot();
      } else {
        snapshotReconciliationService
          .waitForInProgress()
          .then(sendSnapshot)
          .catch(() => void sendSnapshot());
      }

      ws.on('close', () => {
        logger.info('Snapshots WebSocket connection closed', { projectId });

        pendingDeltaBuffers.delete(ws);
        untrack();
      });

      ws.on('error', (error) => {
        logger.error('Snapshots WebSocket error', error);
      });
    },
  });
}
