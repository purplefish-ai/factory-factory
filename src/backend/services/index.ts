/**
 * Infrastructure Services Index
 *
 * Central export point for infrastructure services only.
 * Domain services are exported from their respective domain barrels
 * in src/backend/domains/{name}/index.ts.
 */

export {
  type ExportData,
  type ExportDataV1,
  type ExportDataV2,
  exportDataSchema,
} from '@/shared/schemas/export-data.schema';
// CLI health service
export { type CLIHealthStatus, cliHealthService } from './cli-health.service';
// Configuration service
export { configService, type SessionProfile } from './config.service';
// Data backup service
export {
  dataBackupService,
  type ImportCounter,
  type ImportResults,
} from './data-backup.service';
// Logger service
export { createLogger } from './logger.service';
// Notification service
export { notificationService } from './notification.service';
// Port service
export { findAvailablePort, isPortAvailable } from './port.service';
// Rate limiter service
export { rateLimiter } from './rate-limiter.service';
// Scheduler service
export { schedulerService } from './scheduler.service';
// Server instance service
export { serverInstanceService } from './server-instance.service';
// Workspace snapshot store service
export {
  SNAPSHOT_CHANGED,
  SNAPSHOT_REMOVED,
  type SnapshotChangedEvent,
  type SnapshotDerivationFns,
  type SnapshotFieldGroup,
  type SnapshotRemovedEvent,
  type SnapshotUpdateInput,
  type WorkspaceCiObservation,
  type WorkspaceFlowPhase,
  type WorkspaceSnapshotEntry,
  workspaceSnapshotStore,
} from './workspace-snapshot-store.service';
