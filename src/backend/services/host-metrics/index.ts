// Domain: host-metrics
// Public API for whole-machine CPU and memory load.

export type { HostProcessGroup, ProcessOwner } from './service/host-processes';
export {
  type HostProcessBreakdown,
  HostMetricsService,
  hostMetricsService,
} from './service/host-metrics.service';
