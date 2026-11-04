import type { ApplicationUpdateStatus } from '@/shared/application-updates';
import { releaseVersionSchema } from '@/shared/application-updates';
import type { PreparedApplicationUpdate } from './application-update-installer';

interface Options {
  automaticUpdate: boolean;
  prepare(version: string, signal: AbortSignal): Promise<PreparedApplicationUpdate>;
  stopBackend(): Promise<void>;
  isBackendStopped?(): boolean;
  backupDatabase(): Promise<() => Promise<void>>;
  migrate(): Promise<void>;
  publish(status: ApplicationUpdateStatus): void;
  persist(status: ApplicationUpdateStatus): Promise<void>;
}

/** The CLI owns status while the backend is stopped or replaced. */
export class ApplicationUpdateSupervisor {
  status: ApplicationUpdateStatus = { phase: 'idle' };
  restartRequired = false;
  private operation: Promise<void> | null = null;
  private persistence: Promise<void> = Promise.resolve();
  private prepared: PreparedApplicationUpdate | null = null;
  private restoreDatabase?: () => Promise<void>;
  private activated = false;
  get recoveryPath() {
    return this.prepared?.recoveryPath;
  }
  private readonly controller = new AbortController();

  constructor(private readonly options: Options) {}

  private setStatus(status: ApplicationUpdateStatus) {
    this.status = status;
    this.options.publish(status);
    this.persistence = this.persistence
      .catch(() => undefined)
      .then(() => this.options.persist(status));
    // A caller awaits the durable write before mutating an installation.
    void this.persistence.catch(() => undefined);
  }

  request(version: string) {
    releaseVersionSchema.parse(version);
    if (!this.options.automaticUpdate) {
      throw new Error('This installation requires a manual update.');
    }
    if (this.operation || ['waiting', 'preparing', 'restarting'].includes(this.status.phase)) {
      return;
    }
    this.setStatus({ phase: 'waiting', targetVersion: version });
  }

  cancel() {
    if (this.status.phase === 'waiting' && !this.operation) {
      this.setStatus({ phase: 'idle' });
    }
  }

  ready(): Promise<void> {
    if (this.operation !== null) {
      return this.operation;
    }
    const version = this.status.targetVersion;
    if (this.status.phase !== 'waiting' || !version) {
      return Promise.resolve();
    }
    this.operation = this.install(version).finally(() => {
      this.operation = null;
    });
    return this.operation;
  }

  async settled() {
    await this.operation;
  }

  async backendReady() {
    this.restartRequired = false;
    this.activated = false;
    this.restoreDatabase = undefined;
    if (this.status.phase === 'restarting') {
      this.setStatus({ phase: 'idle' });
    }
    await this.persistence;
    if (this.prepared) {
      await this.prepared.dispose();
      this.prepared = null;
    }
  }

  async backendFailed(error: unknown) {
    if (this.status.phase !== 'restarting' || !this.prepared) {
      throw error;
    }
    await this.recover(error, true);
  }

  abort() {
    this.controller.abort();
  }

  private async recover(error: unknown, stopped: boolean) {
    const version = this.status.targetVersion;
    if (this.activated) {
      try {
        await this.restoreDatabase?.();
        await this.prepared?.rollback();
        this.activated = false;
      } catch (recoveryError) {
        this.setStatus({
          phase: 'failed',
          targetVersion: version,
          error: `Update recovery failed. Previous installation: ${this.prepared?.recoveryPath}. ${String(recoveryError)}`,
        });
        await this.persistence;
        throw new Error('Update recovery failed; the previous installation has been retained.', {
          cause: recoveryError,
        });
      }
    }
    this.restartRequired = stopped;
    const message = error instanceof Error ? error.message : String(error);
    this.setStatus({
      phase: 'failed',
      targetVersion: version,
      error: `Could not update Factory Factory. ${message}`,
    });
    await this.persistence;
    if (!stopped && this.prepared) {
      await this.prepared.dispose();
      this.prepared = null;
    }
  }

  private async install(version: string) {
    let stopped = false;

    try {
      await this.persistence;
      this.setStatus({ phase: 'preparing', targetVersion: version });
      await this.persistence;
      this.prepared = await this.options.prepare(version, this.controller.signal);
      this.setStatus({ phase: 'restarting', targetVersion: version });
      await this.persistence;
      await this.options.stopBackend();
      stopped = true;
      this.restoreDatabase = await this.options.backupDatabase();
      // Journal both backup locations before the first rename or migration.
      this.setStatus({ ...this.status });
      await this.persistence;
      await this.prepared.activate();
      this.activated = true;
      await this.options.migrate();
      this.restartRequired = true;
    } catch (error) {
      await this.recover(error, stopped || (this.options.isBackendStopped?.() ?? false));
    }
  }
}
