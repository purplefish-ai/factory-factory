import { createPRDeliveryPorts } from './pr-delivery-dependencies';
import { wakePRDelivery } from './pr-event-delivery.orchestrator';
import { retireLegacyRatchetSessions } from './pr-monitoring-cutover.orchestrator';
import { createPRObservationPorts, type PRMonitoringServices } from './pr-monitoring-dependencies';
import { setPRMonitoring } from './pr-monitoring.orchestrator';
import { observeMonitoredPR } from './pr-observation.orchestrator';
import { RatchetService } from './ratchet.service';

/**
 * Compose one graph's PR event poll. The services object is read on first use
 * because the poll is itself one of those services, and the delivery ports it
 * builds publish through it.
 */
export function createRatchetService(getServices: () => PRMonitoringServices): RatchetService {
  let ports:
    | {
        observation: ReturnType<typeof createPRObservationPorts>;
        delivery: ReturnType<typeof createPRDeliveryPorts>;
      }
    | undefined;
  const resolvePorts = () => {
    if (!ports) {
      const services = getServices();
      ports = {
        observation: createPRObservationPorts(services),
        delivery: createPRDeliveryPorts(services),
      };
    }
    return ports;
  };
  return new RatchetService({
    retireLegacy: () => retireLegacyRatchetSessions(getServices()),
    observe: (target, signal) => observeMonitoredPR(resolvePorts().observation, target, { signal }),
    wake: (workspaceId, isCurrent) =>
      wakePRDelivery(workspaceId, resolvePorts().delivery, isCurrent),
    setMonitoring: (input) => setPRMonitoring(input, getServices()),
  });
}
