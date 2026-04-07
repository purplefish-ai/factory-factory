// Domain: auto-iteration
// Public API for the auto-iteration domain module.
// Consumers should import from '@/backend/services/auto-iteration' only.

import { createLogger } from '@/backend/services/logger.service';
import { AutoIterationService } from './auto-iteration.service';

// Types
export type {
  AgentLogbook,
  AgentLogbookEntry,
  AutoIterationConfig,
  AutoIterationProgress,
  AutoIterationSnapshot,
  CritiqueResult,
  IterationPhase,
  MetricEvaluation,
  TestCommandResult,
} from './auto-iteration.types';
// Bridge interfaces for orchestration layer wiring
export type {
  AutoIterationLogbookBridge,
  AutoIterationSessionBridge,
  AutoIterationWorkspaceBridge,
} from './bridges';
// Insights service (for reading/writing insights from tRPC routes)
export { insightsService } from './insights.service';
// Logbook service (for reading logbook from tRPC routes)
export { logbookService } from './logbook.service';

// Core service
export { AutoIterationService };
export const autoIterationService = new AutoIterationService(createLogger('auto-iteration'));
