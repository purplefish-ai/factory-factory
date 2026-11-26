import { SERVICE_INTERVAL_MS } from '@/backend/services/constants';
import { type JobRunner, jobRunner } from '@/backend/services/job-runner.service';
import { createLogger } from '@/backend/services/logger.service';
import {
  type ArchivedWorktreeRegistrationCleanupResult,
  archivedWorktreeRegistrationService,
} from '@/backend/services/workspace';
import {
  type ArchiveWorkspaceDependencies,
  resumeStaleArchives,
} from './workspace-archive.orchestrator';

const JOB = 'archive-recovery';
const logger = createLogger(JOB);

/** Stale ARCHIVING rows resumed per run; each stops runtimes and moves a worktree. */
export const ARCHIVE_RECOVERY_BATCH = 10;
/** Leftover registrations change rarely, so their sweep (a `git worktree list` per project) is throttled. */
export const REGISTRATION_SWEEP_INTERVAL_MS = 30 * 60_000;
export const REGISTRATION_REMOVALS_PER_SWEEP = 20;

interface Dependencies {
  archive: ArchiveWorkspaceDependencies;
  registrations?: Pick<typeof archivedWorktreeRegistrationService, 'removeLeftoverRegistrations'>;
  now?: () => number;
}

/**
 * Finishes archives no process is running any more: at start, then every
 * `SERVICE_INTERVAL_MS.archiveRecovery`, it resumes ARCHIVING rows whose lease
 * is stale, and at most every `REGISTRATION_SWEEP_INTERVAL_MS` it removes Git
 * registrations left for archived workspaces whose worktree is gone.
 */
export class WorkspaceArchiveRecovery {
  private readonly registrations: NonNullable<Dependencies['registrations']>;
  private readonly now: () => number;
  private lastRegistrationSweepAt: number | null = null;

  constructor(
    private readonly dependencies: Dependencies,
    private readonly runner: JobRunner = jobRunner
  ) {
    this.registrations = dependencies.registrations ?? archivedWorktreeRegistrationService;
    this.now = dependencies.now ?? Date.now;
    runner.register({
      name: JOB,
      intervalMs: SERVICE_INTERVAL_MS.archiveRecovery,
      runImmediately: true,
      run: (signal) => this.run(signal),
    });
  }

  start(): void {
    this.runner.start(JOB);
  }

  async stop(): Promise<void> {
    await this.runner.stop(JOB);
  }

  async run(signal: AbortSignal): Promise<void> {
    const archives = await resumeStaleArchives(this.dependencies.archive, {
      limit: ARCHIVE_RECOVERY_BATCH,
      signal,
    });
    let registrations: ArchivedWorktreeRegistrationCleanupResult | null = null;
    if (!signal.aborted && this.registrationSweepDue()) {
      registrations = await this.registrations.removeLeftoverRegistrations({
        limit: REGISTRATION_REMOVALS_PER_SWEEP,
        signal,
      });
      // Only a completed sweep defers the next one; a failed one retries next run.
      this.lastRegistrationSweepAt = this.now();
    }

    const summary = {
      archived: archives.archived,
      failed: archives.failed,
      skipped: archives.skipped,
      registrationsRemoved: registrations?.removed ?? [],
      registrationsFailed: registrations?.failed ?? [],
    };
    // Rows only skipped (owned here, or claimed elsewhere) are not news.
    const { skipped: _skipped, ...work } = summary;
    if (Object.values(work).some((items) => items.length > 0)) {
      logger.info('Archive recovery run finished', summary);
    }
  }

  private registrationSweepDue(): boolean {
    return (
      this.lastRegistrationSweepAt === null ||
      this.now() - this.lastRegistrationSweepAt >= REGISTRATION_SWEEP_INTERVAL_MS
    );
  }
}
