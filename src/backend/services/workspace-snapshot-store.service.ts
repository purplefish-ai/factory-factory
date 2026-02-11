/**
 * Workspace Snapshot Store Service
 *
 * A versioned, per-workspace in-memory store with field-level timestamp merging,
 * derived state recomputation via injected functions, and EventEmitter-based
 * change notifications.
 *
 * This is the foundational data structure for the Project Snapshot Service.
 * All subsequent phases (event collection, reconciliation, WebSocket transport,
 * client integration) build on this store.
 *
 * ARCH-02: Zero imports from @/backend/domains/ — derivation functions are
 * injected via configure() at startup through the orchestration layer.
 */

import { EventEmitter } from 'node:events';
import type {
  CIStatus,
  KanbanColumn,
  PRState,
  RatchetState,
  RunScriptStatus,
  WorkspaceStatus,
} from '@prisma-gen/client';
import type { WorkspaceSidebarStatus } from '@/shared/workspace-sidebar-status';
import { createLogger } from './logger.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * String literal union for timestamp group keys.
 * Represents coherent groups of fields that update together from a single
 * event source (grouped by update source, not per-field).
 */
export type SnapshotFieldGroup =
  | 'workspace'
  | 'pr'
  | 'session'
  | 'ratchet'
  | 'runScript'
  | 'reconciliation';

/**
 * Flow phase derived from PR + ratchet state.
 * Duplicated from workspace domain to maintain ARCH-02 compliance (no domain imports).
 */
export type WorkspaceFlowPhase =
  | 'NO_PR'
  | 'CI_WAIT'
  | 'RATCHET_VERIFY'
  | 'RATCHET_FIXING'
  | 'READY'
  | 'MERGED';

/**
 * CI observation state derived from PR CI status.
 * Duplicated from workspace domain to maintain ARCH-02 compliance (no domain imports).
 */
export type WorkspaceCiObservation =
  | 'NOT_FETCHED'
  | 'NO_CHECKS'
  | 'CHECKS_PENDING'
  | 'CHECKS_FAILED'
  | 'CHECKS_PASSED'
  | 'CHECKS_UNKNOWN';

/**
 * The full snapshot entry shape for a workspace.
 * Matches the output of getProjectSummaryState() with additional versioning,
 * debug metadata, and field-level timestamps for concurrent update safety.
 */
export interface WorkspaceSnapshotEntry {
  // Identity
  workspaceId: string;
  projectId: string;

  // Versioning (STORE-02): monotonically increasing per entry
  version: number;

  // Debug metadata (STORE-03)
  computedAt: string; // ISO timestamp
  source: string; // e.g. 'event:workspace_state_change', 'reconciliation'

  // Raw workspace state
  name: string;
  status: WorkspaceStatus;
  createdAt: string;
  branchName: string | null;
  prUrl: string | null;
  prNumber: number | null;
  prState: PRState;
  prCiStatus: CIStatus;
  prUpdatedAt: string | null;
  ratchetEnabled: boolean;
  ratchetState: RatchetState;
  runScriptStatus: RunScriptStatus;
  hasHadSessions: boolean;

  // In-memory state (from session domain)
  isWorking: boolean;
  pendingRequestType: 'plan_approval' | 'user_question' | null;

  // Reconciliation-only state
  gitStats: {
    total: number;
    additions: number;
    deletions: number;
    hasUncommitted: boolean;
  } | null;
  lastActivityAt: string | null;

  // Derived state (STORE-05): recomputed on every upsert
  sidebarStatus: WorkspaceSidebarStatus;
  kanbanColumn: KanbanColumn | null;
  flowPhase: WorkspaceFlowPhase;
  ciObservation: WorkspaceCiObservation;
  ratchetButtonAnimated: boolean;

  // Field-level timestamps for concurrent update safety
  fieldTimestamps: Record<SnapshotFieldGroup, number>;
}

/**
 * Input type for upsert(). Contains optional versions of all raw + session +
 * reconciliation fields. Does NOT include derived fields (recomputed) or
 * version/computedAt/source (managed by the store).
 */
export interface SnapshotUpdateInput {
  projectId?: string; // Required on first upsert, optional on updates

  // Workspace fields (group: 'workspace')
  name?: string;
  status?: WorkspaceStatus;
  createdAt?: string;
  branchName?: string | null;
  hasHadSessions?: boolean;

  // PR fields (group: 'pr')
  prUrl?: string | null;
  prNumber?: number | null;
  prState?: PRState;
  prCiStatus?: CIStatus;
  prUpdatedAt?: string | null;

  // Session fields (group: 'session')
  isWorking?: boolean;
  pendingRequestType?: 'plan_approval' | 'user_question' | null;

  // Ratchet fields (group: 'ratchet')
  ratchetEnabled?: boolean;
  ratchetState?: RatchetState;

  // Run-script fields (group: 'runScript')
  runScriptStatus?: RunScriptStatus;

  // Reconciliation fields (group: 'reconciliation')
  gitStats?: {
    total: number;
    additions: number;
    deletions: number;
    hasUncommitted: boolean;
  } | null;
  lastActivityAt?: string | null;
}

/**
 * Interface for injected derivation functions (ARCH-02 compliance).
 * These are provided via configure() from the orchestration layer,
 * keeping this service free of domain imports.
 */
export interface SnapshotDerivationFns {
  deriveFlowState: (input: {
    prUrl: string | null;
    prState: PRState;
    prCiStatus: CIStatus;
    prUpdatedAt: string | null; // NOTE: string, not Date -- snapshot stores ISO strings
    ratchetEnabled: boolean;
    ratchetState: RatchetState;
  }) => {
    phase: WorkspaceFlowPhase;
    ciObservation: WorkspaceCiObservation;
    isWorking: boolean;
    shouldAnimateRatchetButton: boolean;
  };
  computeKanbanColumn: (input: {
    lifecycle: WorkspaceStatus;
    isWorking: boolean;
    prState: PRState;
    hasHadSessions: boolean;
  }) => KanbanColumn | null;
  deriveSidebarStatus: (input: {
    isWorking: boolean;
    prUrl: string | null;
    prState: PRState | null;
    prCiStatus: CIStatus | null;
    ratchetState: RatchetState | null;
  }) => WorkspaceSidebarStatus;
}

// ---------------------------------------------------------------------------
// Event constants and payload types
// ---------------------------------------------------------------------------

export const SNAPSHOT_CHANGED = 'snapshot_changed' as const;
export const SNAPSHOT_REMOVED = 'snapshot_removed' as const;

export interface SnapshotChangedEvent {
  workspaceId: string;
  projectId: string;
  entry: WorkspaceSnapshotEntry;
}

export interface SnapshotRemovedEvent {
  workspaceId: string;
  projectId: string;
}

// ---------------------------------------------------------------------------
// Field-to-group mapping
// ---------------------------------------------------------------------------

const WORKSPACE_FIELDS = ['name', 'status', 'createdAt', 'branchName', 'hasHadSessions'] as const;
const PR_FIELDS = ['prUrl', 'prNumber', 'prState', 'prCiStatus', 'prUpdatedAt'] as const;
const SESSION_FIELDS = ['isWorking', 'pendingRequestType'] as const;
const RATCHET_FIELDS = ['ratchetEnabled', 'ratchetState'] as const;
const RUN_SCRIPT_FIELDS = ['runScriptStatus'] as const;
const RECONCILIATION_FIELDS = ['gitStats', 'lastActivityAt'] as const;

type FieldGroupMapping = {
  group: SnapshotFieldGroup;
  fields: readonly string[];
};

const FIELD_GROUP_MAPPINGS: FieldGroupMapping[] = [
  { group: 'workspace', fields: WORKSPACE_FIELDS },
  { group: 'pr', fields: PR_FIELDS },
  { group: 'session', fields: SESSION_FIELDS },
  { group: 'ratchet', fields: RATCHET_FIELDS },
  { group: 'runScript', fields: RUN_SCRIPT_FIELDS },
  { group: 'reconciliation', fields: RECONCILIATION_FIELDS },
];

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = createLogger('workspace-snapshot-store');

// ---------------------------------------------------------------------------
// Default field timestamps
// ---------------------------------------------------------------------------

function createDefaultFieldTimestamps(): Record<SnapshotFieldGroup, number> {
  return {
    workspace: 0,
    pr: 0,
    session: 0,
    ratchet: 0,
    runScript: 0,
    reconciliation: 0,
  };
}

// ---------------------------------------------------------------------------
// WorkspaceSnapshotStore class
// ---------------------------------------------------------------------------

export class WorkspaceSnapshotStore extends EventEmitter {
  private entries = new Map<string, WorkspaceSnapshotEntry>();
  private projectIndex = new Map<string, Set<string>>();
  private deriveFns: SnapshotDerivationFns | null = null;

  /**
   * Configure derivation functions. Must be called before any upsert operations.
   * Typically called from domain-bridges orchestrator at startup.
   */
  configure(fns: SnapshotDerivationFns): void {
    this.deriveFns = fns;
    logger.info('Snapshot store configured with derivation functions');
  }

  /**
   * Get the derivation functions, throwing if not yet configured.
   */
  private get derive(): SnapshotDerivationFns {
    if (!this.deriveFns) {
      throw new Error('WorkspaceSnapshotStore not configured: call configure() first.');
    }
    return this.deriveFns;
  }

  /**
   * Create a new default snapshot entry for a workspace.
   */
  private createDefaultEntry(workspaceId: string, projectId: string): WorkspaceSnapshotEntry {
    return {
      workspaceId,
      projectId,
      version: 0,
      computedAt: '',
      source: '',
      name: '',
      status: 'NEW' as WorkspaceStatus,
      createdAt: '',
      branchName: null,
      prUrl: null,
      prNumber: null,
      prState: 'NONE' as PRState,
      prCiStatus: 'UNKNOWN' as CIStatus,
      prUpdatedAt: null,
      ratchetEnabled: false,
      ratchetState: 'IDLE' as RatchetState,
      runScriptStatus: 'IDLE' as RunScriptStatus,
      hasHadSessions: false,
      isWorking: false,
      pendingRequestType: null,
      gitStats: null,
      lastActivityAt: null,
      sidebarStatus: { activityState: 'IDLE', ciState: 'NONE' },
      kanbanColumn: null,
      flowPhase: 'NO_PR',
      ciObservation: 'NOT_FETCHED',
      ratchetButtonAnimated: false,
      fieldTimestamps: createDefaultFieldTimestamps(),
    };
  }

  /**
   * Apply field-level timestamp merge: only update fields in a group
   * if the provided timestamp is newer than the existing group timestamp.
   */
  private mergeFieldGroups(
    entry: WorkspaceSnapshotEntry,
    update: SnapshotUpdateInput,
    ts: number
  ): void {
    for (const mapping of FIELD_GROUP_MAPPINGS) {
      const hasFieldsInGroup = mapping.fields.some(
        (field) => (update as Record<string, unknown>)[field] !== undefined
      );
      if (!hasFieldsInGroup || ts <= entry.fieldTimestamps[mapping.group]) {
        continue;
      }
      entry.fieldTimestamps[mapping.group] = ts;
      for (const field of mapping.fields) {
        const value = (update as Record<string, unknown>)[field];
        if (value !== undefined) {
          (entry as unknown as Record<string, unknown>)[field] = value;
        }
      }
    }
  }

  /**
   * Recompute all derived state fields on an entry using the injected
   * derivation functions.
   */
  private recomputeDerivedState(entry: WorkspaceSnapshotEntry): void {
    const flowState = this.derive.deriveFlowState({
      prUrl: entry.prUrl,
      prState: entry.prState,
      prCiStatus: entry.prCiStatus,
      prUpdatedAt: entry.prUpdatedAt,
      ratchetEnabled: entry.ratchetEnabled,
      ratchetState: entry.ratchetState,
    });

    // Effective isWorking: session activity OR flow-state working
    const effectiveIsWorking = entry.isWorking || flowState.isWorking;

    entry.flowPhase = flowState.phase;
    entry.ciObservation = flowState.ciObservation;
    entry.ratchetButtonAnimated = flowState.shouldAnimateRatchetButton;

    entry.kanbanColumn = this.derive.computeKanbanColumn({
      lifecycle: entry.status,
      isWorking: effectiveIsWorking,
      prState: entry.prState,
      hasHadSessions: entry.hasHadSessions,
    });

    entry.sidebarStatus = this.derive.deriveSidebarStatus({
      isWorking: effectiveIsWorking,
      prUrl: entry.prUrl,
      prState: entry.prState,
      prCiStatus: entry.prCiStatus,
      ratchetState: entry.ratchetState,
    });
  }

  /**
   * Update the project index when a workspace's projectId changes.
   */
  private updateProjectIndex(
    workspaceId: string,
    newProjectId: string,
    oldProjectId: string | undefined
  ): void {
    if (oldProjectId && oldProjectId !== newProjectId) {
      const oldSet = this.projectIndex.get(oldProjectId);
      if (oldSet) {
        oldSet.delete(workspaceId);
        if (oldSet.size === 0) {
          this.projectIndex.delete(oldProjectId);
        }
      }
    }

    let projectSet = this.projectIndex.get(newProjectId);
    if (!projectSet) {
      projectSet = new Set();
      this.projectIndex.set(newProjectId, projectSet);
    }
    projectSet.add(workspaceId);
  }

  /**
   * Insert or update a workspace snapshot entry.
   *
   * Field-level timestamp merging ensures concurrent updates preserve the
   * newest data per field group. Derived state is recomputed after every update.
   */
  upsert(
    workspaceId: string,
    update: SnapshotUpdateInput,
    source: string,
    timestamp?: number
  ): void {
    const ts = timestamp ?? Date.now();
    let entry = this.entries.get(workspaceId);
    const oldProjectId = entry?.projectId;

    if (!entry) {
      if (!update.projectId) {
        throw new Error(
          `Cannot create snapshot for workspace ${workspaceId}: projectId is required on first upsert.`
        );
      }
      entry = this.createDefaultEntry(workspaceId, update.projectId);
    }

    // Update projectId if provided
    if (update.projectId !== undefined) {
      entry.projectId = update.projectId;
    }

    // Field-level timestamp merge
    this.mergeFieldGroups(entry, update, ts);

    // Recompute derived state from raw fields
    this.recomputeDerivedState(entry);

    // Bump version and update metadata
    entry.version += 1;
    entry.computedAt = new Date().toISOString();
    entry.source = source;

    // Update project index and store entry
    this.updateProjectIndex(workspaceId, entry.projectId, oldProjectId);
    this.entries.set(workspaceId, entry);

    // Emit AFTER all state is consistent (per research pitfall 5)
    this.emit(SNAPSHOT_CHANGED, {
      workspaceId,
      projectId: entry.projectId,
      entry,
    } satisfies SnapshotChangedEvent);

    logger.debug('Snapshot updated', { workspaceId, version: entry.version, source });
  }

  /**
   * Remove a workspace snapshot entry.
   * Used when a workspace is archived or deleted.
   */
  remove(workspaceId: string): boolean {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      return false;
    }

    // Delete from entries map
    this.entries.delete(workspaceId);

    // Remove from project index
    const projectSet = this.projectIndex.get(entry.projectId);
    if (projectSet) {
      projectSet.delete(workspaceId);
      if (projectSet.size === 0) {
        this.projectIndex.delete(entry.projectId);
      }
    }

    // Emit removal event
    const event: SnapshotRemovedEvent = {
      workspaceId,
      projectId: entry.projectId,
    };
    this.emit(SNAPSHOT_REMOVED, event);

    logger.debug('Snapshot removed', { workspaceId, projectId: entry.projectId });

    return true;
  }

  /**
   * Get a snapshot entry by workspace ID.
   */
  getByWorkspaceId(workspaceId: string): WorkspaceSnapshotEntry | undefined {
    return this.entries.get(workspaceId);
  }

  /**
   * Get all snapshot entries for a project.
   */
  getByProjectId(projectId: string): WorkspaceSnapshotEntry[] {
    const workspaceIds = this.projectIndex.get(projectId);
    if (!workspaceIds) {
      return [];
    }
    return [...workspaceIds]
      .map((id) => this.entries.get(id))
      .filter((entry): entry is WorkspaceSnapshotEntry => entry !== undefined);
  }

  /**
   * Get the current version of a workspace's snapshot.
   */
  getVersion(workspaceId: string): number | undefined {
    return this.entries.get(workspaceId)?.version;
  }

  /**
   * Get the number of entries in the store (for testing/debugging).
   */
  size(): number {
    return this.entries.size;
  }

  /**
   * Clear all entries and indexes. Useful for testing and server shutdown.
   */
  clear(): void {
    this.entries.clear();
    this.projectIndex.clear();
    logger.info('Snapshot store cleared');
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const workspaceSnapshotStore = new WorkspaceSnapshotStore();
