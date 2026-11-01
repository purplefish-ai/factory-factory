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
import { observeEventRun } from './event-run-monitor.orchestrator';

const logger = createLogger('event-run-consumer');
type OwnedTask = {
  claim: EventLaunchClaim;
  controller: AbortController;
  task: Promise<void>;
  maintenance: Promise<void>;
  leaseUntil: number;
  revoked: boolean;
  failed: boolean;
  launched: boolean;
  physicalDone: Promise<void>;
  release(): void;
};

/** Tracks committed handoffs before their first await. Durable RUNNING rows own capacity. */
export function createEventRunConsumer() {
  eventSessionAuthority.configure(agentInitialDelivery);
  const tasks = new Map<string, OwnedTask>();
  let closing = false;
  let observationCursor: string | undefined;
  const consumeClaim = (
    claim: EventLaunchClaim,
    signal: AbortSignal,
    observationOnly = false
  ): Promise<void> => {
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
      maintenance: Promise.resolve(),
      leaseUntil: 0,
      revoked: false,
      failed: false,
      launched: false,
      physicalDone: Promise.resolve(),
      release: () => {
        owned.revoked = true;
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
        if (!observationOnly) {
          await launchEventRun(claim, controller.signal, assertOwned, physicalStage);
        }
      })
      .then(
        () => {
          owned.launched = true;
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
    const check = () => {
      if (owned.revoked) {
        throw new Error('Event maintenance observation closed');
      }
    };
    const operation = async () => {
      check();
      owned.leaseUntil = (await eventRunLaunch.renew(owned.claim, check)).getTime();
      check();
      if (owned.failed && !closing) {
        await eventRunLaunch.dispose(
          owned.claim,
          {
            kind: 'FAILED',
            cleanup: 'UNKNOWN',
            category: 'UNKNOWN',
          },
          check
        );
        check();
        owned.release();
      } else if (!closing) {
        const result = await observeEventRun(owned.claim, () => {
          check();
          if (Date.now() >= owned.leaseUntil) {
            throw new Error('Event observation lease expired');
          }
        });
        if (result === 'SETTLED') {
          owned.release();
        }
      }
    };
    owned.maintenance = operation();
    try {
      await withEventEvidenceDeadline(owned.maintenance, () => {
        owned.revoked = true;
      });
    } catch {
      owned.revoked = true;
      owned.controller.abort();
      if (owned.failed || owned.launched) {
        owned.release();
      }
    }
  };
  const adoptObservation = async (claim: EventLaunchClaim, signal: AbortSignal) => {
    let open = true;
    const check = () => {
      if (!open || closing || signal.aborted) {
        throw new Error('Event observation adoption closed');
      }
    };
    try {
      const adopted = await withEventEvidenceDeadline(eventRunLaunch.adopt(claim, check), () => {
        open = false;
      });
      check();
      await consumeClaim(adopted.claim, signal, true);
    } catch {
      logger.warn('Event observation adoption requires recovery', { runId: claim.runId });
    }
  };
  const canObserve = (run: Awaited<ReturnType<typeof eventRunLaunch.read>>) =>
    !tasks.has(run.claim.runId) &&
    tasks.size < configService.getAgentRuntimeLimits().activeGlobal &&
    (!run.leaseExpiresAt || run.leaseExpiresAt.getTime() <= Date.now()) &&
    (run.delivery.state !== 'PENDING' || run.phase === 'NEEDS_ATTENTION');
  const adoptObservers = async (signal: AbortSignal) => {
    const page = await withEventEvidenceDeadline(eventRunLaunch.list(observationCursor)).catch(
      () => null
    );
    if (!page) {
      return;
    }
    observationCursor = page.nextCursor ?? undefined;
    for (const run of page.runs) {
      if (closing || signal.aborted) {
        return;
      }
      if (!canObserve(run)) {
        continue;
      }
      await adoptObservation(run.claim, signal);
    }
  };
  return {
    consumeClaim,
    canClaim: () => !closing && tasks.size < configService.getAgentRuntimeLimits().activeGlobal,
    async maintain(signal: AbortSignal) {
      await Promise.all([...tasks.values()].map(maintainOwned));
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
      if (closing || signal.aborted) {
        return;
      }
      await adoptObservers(signal);
    },
    async drain() {
      await Promise.allSettled(
        [...tasks.values()].flatMap((owned) => [owned.task, owned.maintenance])
      );
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
          owned.task = Promise.allSettled([owned.task, owned.maintenance])
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
