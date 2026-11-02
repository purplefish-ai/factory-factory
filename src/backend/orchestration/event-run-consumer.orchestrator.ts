import { ApplicationError } from '@/backend/lib/application-error';
import {
  agentInitialDelivery,
  eventRunLaunch,
  type EventLaunchClaim,
} from '@/backend/services/agent-definition';
import { configService } from '@/backend/services/config.service';
import { createLogger } from '@/backend/services/logger.service';
import { eventSessionAuthority, withEventEvidenceDeadline } from '@/backend/services/session';
import { launchEventRun } from './event-run-launch.orchestrator';

const logger = createLogger('event-run-consumer');
type OwnedTask = {
  claim: EventLaunchClaim;
  controller: AbortController;
  task: Promise<void>;
  leaseUntil: number;
  revoked: boolean;
  failed: boolean;
  physicalDone: Promise<void>;
  release(): void;
};

/** Tracks committed handoffs before their first await. Durable RUNNING rows own capacity. */
export function createEventRunConsumer() {
  eventSessionAuthority.configure(agentInitialDelivery);
  const tasks = new Map<string, OwnedTask>();
  let closing = false;
  const consumeClaim = (claim: EventLaunchClaim, signal: AbortSignal): Promise<void> => {
    const existing = tasks.get(claim.runId);
    if (existing) {
      if (existing.claim.workerGeneration !== claim.workerGeneration) {
        return Promise.reject(new Error('Event owner replacement requires drain'));
      }
      return Promise.resolve();
    }
    const controller = new AbortController();
    if (
      closing ||
      signal.aborted ||
      tasks.size >= configService.getAgentRuntimeLimits().activeGlobal
    ) {
      controller.abort();
    }
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const owned: OwnedTask = {
      claim,
      controller,
      task: Promise.resolve(),
      leaseUntil: 0,
      revoked: false,
      failed: false,
      physicalDone: Promise.resolve(),
      release: () => {
        tasks.delete(claim.runId);
        signal.removeEventListener('abort', abort);
      },
    };
    tasks.set(claim.runId, owned);
    let finishPhysical: (() => void) | undefined;
    const physicalStage = (active: boolean) => {
      if (active && !finishPhysical) {
        owned.physicalDone = new Promise<void>((resolve) => {
          finishPhysical = resolve;
        });
      } else if (!active) {
        finishPhysical?.();
        finishPhysical = undefined;
      }
    };
    const assertOwned = () => {
      if (owned.revoked || Date.now() >= owned.leaseUntil) {
        throw new Error('Event local ownership expired');
      }
    };
    owned.task = Promise.resolve()
      .then(async () => {
        const current = await eventRunLaunch.read(claim);
        owned.leaseUntil = current.leaseExpiresAt?.getTime() ?? 0;
        await launchEventRun(claim, controller.signal, assertOwned, physicalStage);
      })
      .then(
        () => {
          owned.release();
        },
        (error: unknown) => {
          // Failed persistence keeps the committed claim tracked; maintenance/shutdown retries disposition.
          owned.failed = true;
          if (error instanceof ApplicationError && error.code === 'CONFLICT') {
            owned.revoked = true;
          }
          if (owned.revoked) {
            owned.release();
          }
          logger.warn('Event launch disposition requires recovery', { runId: claim.runId });
        }
      );
    return Promise.resolve();
  };
  const maintainOwned = async (owned: OwnedTask) => {
    try {
      owned.leaseUntil = (await eventRunLaunch.renew(owned.claim)).getTime();
      if (owned.failed && !closing) {
        await eventRunLaunch.dispose(owned.claim, {
          kind: 'FAILED',
          cleanup: 'UNKNOWN',
          category: 'UNKNOWN',
        });
        owned.release();
      }
    } catch {
      owned.revoked = true;
      owned.controller.abort();
      if (owned.failed) {
        owned.release();
      }
    }
  };
  return {
    consumeClaim,
    canClaim: () => !closing && tasks.size < configService.getAgentRuntimeLimits().activeGlobal,
    async maintain(signal: AbortSignal) {
      for (const owned of tasks.values()) {
        await maintainOwned(owned);
      }
      if (closing || signal.aborted) {
        return;
      }
      const available = configService.getAgentRuntimeLimits().activeGlobal - tasks.size;
      if (available <= 0) {
        return;
      }
      const recovered = await eventRunLaunch.recover([...tasks.keys()], available);
      // A committed takeover is owned even if the job was stopped while its transaction returned.
      for (const run of recovered) {
        await consumeClaim(run.claim, signal);
      }
    },
    async drain() {
      await Promise.all([...tasks.values()].map((owned) => owned.task));
    },
    closeAdmission() {
      closing = true;
    },
    async stop() {
      closing = true;
      for (const owned of tasks.values()) {
        owned.controller.abort();
      }
      await Promise.all(
        [...tasks.values()].map(async (owned) => {
          // Include failed-claim persistence in the same tracked lifetime, independently per claim.
          owned.task = owned.task
            .then(async () => {
              if (!owned.failed || owned.revoked) {
                return;
              }
              await eventRunLaunch.dispose(
                owned.claim,
                {
                  kind: 'SHUTDOWN',
                  cleanup: 'UNKNOWN',
                  category: 'UNKNOWN',
                },
                () => {
                  if (owned.revoked) {
                    throw new Error('Event shutdown disposition closed');
                  }
                }
              );
              owned.release();
            })
            .catch(() => {
              owned.revoked = true;
              logger.warn('Event shutdown disposition remains unresolved', {
                runId: owned.claim.runId,
              });
            });
          // Never abandon setup/Git. Provider interruption owns its existing evidence deadlines.
          await owned.physicalDone;
          await withEventEvidenceDeadline(owned.task, () => {
            owned.revoked = true;
          }).catch(() => {
            logger.warn('Event durable handoff drain remains unresolved', {
              runId: owned.claim.runId,
            });
          });
          // Fencing prevents later operations; directly join one already started during the drain.
          await owned.physicalDone;
        })
      );
    },
  };
}
