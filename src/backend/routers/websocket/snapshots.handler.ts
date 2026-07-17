/**
 * Snapshots WebSocket Handler
 *
 * Handles WebSocket connections for streaming workspace snapshot changes
 * to clients in real time, scoped by project ID. On connect, sends the
 * full project snapshot. On subsequent changes, pushes per-workspace deltas.
 */

import type { WebSocket } from 'ws';
import type { AppContext, Application, ApplicationServices } from '@/backend/app-context';
import { WS_READY_STATE } from '@/backend/constants/websocket';
import { TopicBroadcaster } from '@/backend/lib/topic-broadcaster';
import { safeSend } from '@/backend/lib/websocket-send';
import {
  SNAPSHOT_CHANGED,
  SNAPSHOT_REMOVED,
  type SnapshotChangedEvent,
  type SnapshotRemovedEvent,
} from '@/backend/services/workspace';
import { WorkspaceStatus } from '@/shared/core';
import type {
  SnapshotChangedMessage,
  SnapshotFullMessage,
  SnapshotRemovedMessage,
} from '@/shared/workspace-snapshot';
import { createWebSocketUpgradeHandler } from './upgrade-utils';

type SnapshotHandlerServices = Pick<
  ApplicationServices,
  'workspaceQueryService' | 'workspaceSnapshotStore'
>;

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
  private store: ApplicationServices['workspaceSnapshotStore'] | null = null;

  ensure(
    connections: TopicBroadcaster<string>,
    services: SnapshotHandlerServices,
    logger: ReturnType<AppContext['services']['createLogger']>
  ): void {
    if (this.active) {
      return;
    }
    const { workspaceQueryService, workspaceSnapshotStore } = services;
    this.store = workspaceSnapshotStore;

    // Buffered replays omit reviewCount: it is computed before the
    // snapshot_full baseline, and clients keep their current count when the
    // field is absent, so replaying it would regress the baseline's count.
    const fanOutToProject = (
      projectId: string,
      payload: SnapshotChangedMessage | SnapshotRemovedMessage,
      description: string
    ) => {
      const projectClients = connections.subscribers(projectId);
      if (projectClients.size === 0) {
        return;
      }

      const reviewCount = getSnapshotReviewCount(workspaceQueryService, logger);
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
      const payload: SnapshotChangedMessage | SnapshotRemovedMessage = isHiddenWorkspaceStatus(
        event.entry.status
      )
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

  dispose(): void {
    const storeWithOff = this.store as
      | (ApplicationServices['workspaceSnapshotStore'] & {
          off?: (event: string, listener: (...args: unknown[]) => unknown) => unknown;
        })
      | null;
    if (typeof storeWithOff?.off === 'function') {
      if (this.snapshotChangedListener) {
        storeWithOff.off(SNAPSHOT_CHANGED, this.snapshotChangedListener);
      }
      if (this.snapshotRemovedListener) {
        storeWithOff.off(SNAPSHOT_REMOVED, this.snapshotRemovedListener);
      }
    }

    this.snapshotChangedListener = null;
    this.snapshotRemovedListener = null;
    this.store = null;
    this.active = false;
  }
}

interface SnapshotHandlerState {
  readonly connections: TopicBroadcaster<string>;
  readonly subscriptionState: SnapshotStoreSubscriptionState;
}

const applicationSnapshotHandlerStates = new WeakMap<Application, SnapshotHandlerState>();

function getSnapshotHandlerState(
  application: Application,
  logger: ReturnType<ApplicationServices['createLogger']>
): SnapshotHandlerState {
  const existing = applicationSnapshotHandlerStates.get(application);
  if (existing) {
    return existing;
  }
  const state = {
    connections: new TopicBroadcaster<string>(logger, 'snapshot message'),
    subscriptionState: new SnapshotStoreSubscriptionState(),
  };
  applicationSnapshotHandlerStates.set(application, state);
  return state;
}

export function getSnapshotConnectionsForApplication(
  application: Application
): TopicBroadcaster<string> | undefined {
  return applicationSnapshotHandlerStates.get(application)?.connections;
}

function isHiddenWorkspaceStatus(status: WorkspaceStatus): boolean {
  return status === WorkspaceStatus.ARCHIVING || status === WorkspaceStatus.ARCHIVED;
}

function getSnapshotReviewCount(
  workspaceQueryService: ApplicationServices['workspaceQueryService'],
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

export function disposeSnapshotsHandlerState(application: Application): void {
  const state = applicationSnapshotHandlerStates.get(application);
  if (!state) {
    return;
  }
  state.connections.clear();
  state.subscriptionState.dispose();
  applicationSnapshotHandlerStates.delete(application);
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
  const { configService, workspaceQueryService, workspaceSnapshotStore } = appContext.services;
  const snapshotReconciliation = appContext.lifecycle.snapshotReconciliation;
  const services: SnapshotHandlerServices = { workspaceQueryService, workspaceSnapshotStore };
  const applicationState = getSnapshotHandlerState(appContext, logger);
  const connections = options.connections ?? applicationState.connections;
  const subscriptionState =
    options.subscriptionState ??
    (options.connections
      ? new SnapshotStoreSubscriptionState()
      : applicationState.subscriptionState);

  return createWebSocketUpgradeHandler({
    connectionName: 'snapshots WebSocket',
    configService,
    logger,
    requiredParams: ['projectId'],
    onOpen: (ws, { params }) => {
      const { projectId } = params;

      subscriptionState.ensure(connections, services, logger);

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
        const reviewCount = getSnapshotReviewCount(workspaceQueryService, logger);
        const entries = workspaceSnapshotStore
          .getByProjectId(projectId)
          .filter((entry) => !isHiddenWorkspaceStatus(entry.status));
        const message: SnapshotFullMessage = {
          type: 'snapshot_full',
          projectId,
          entries,
          reviewCount,
        };
        const baselineSent = safeSend(ws, JSON.stringify(message), logger, 'full snapshot');
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
        snapshotReconciliation
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
