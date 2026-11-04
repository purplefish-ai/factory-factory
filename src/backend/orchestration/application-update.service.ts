import { ApplicationError } from '@/backend/lib/application-error';
import { type ApplicationUpdateAdmission } from '@/backend/services/application-update-admission.service';
import { SERVICE_INTERVAL_MS } from '@/backend/services/constants';
import { type JobRunner } from '@/backend/services/job-runner.service';
import {
  type ApplicationUpdates,
  type ApplicationUpdateStatus,
  type UpdateNotice,
  releaseVersionSchema,
  updateSupervisorMessageSchema,
} from '@/shared/application-updates';

const JOB = 'application-update-idle';
type SupervisorMessage = ReturnType<typeof updateSupervisorMessageSchema.parse>;
export interface UpdateSupervisorPort {
  send(message: SupervisorMessage): void;
  subscribe(listener: (message: unknown) => void): () => void;
}
interface Dependencies {
  release: { check(): Promise<{ currentVersion: string; notices: UpdateNotice[] }> };
  admission: ApplicationUpdateAdmission;
  hasWork(): boolean;
  jobs: Pick<JobRunner, 'register' | 'start' | 'stop'>;
  supervisor?: UpdateSupervisorPort;
  manualCommand?: string;
}

/** The supervisor owns installation; the backend validates intent and drains agent work. */
export class ApplicationUpdateService {
  private automaticUpdate = false;
  private manualCommand = 'npm install -g factory-factory@latest';
  private status: ApplicationUpdateStatus = { phase: 'idle' };
  private unsubscribe?: () => void;
  private ready = false;
  private parentWaiting = false;
  private request: Promise<ApplicationUpdateStatus> | undefined;
  private requestedVersion: string | undefined;
  private started = false;

  constructor(private readonly dependencies: Dependencies) {
    this.manualCommand = dependencies.manualCommand ?? this.manualCommand;
    dependencies.jobs.register({
      name: JOB,
      intervalMs: SERVICE_INTERVAL_MS.applicationUpdateIdle,
      run: () => Promise.resolve(this.pollIdle()),
    });
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.unsubscribe = this.dependencies.supervisor?.subscribe((message) => this.receive(message));
    try {
      this.dependencies.supervisor?.send({ type: 'update-hello' });
    } catch (error) {
      this.automaticUpdate = false;
      this.fail(error);
    }
    this.dependencies.jobs.start(JOB);
  }

  async stop(): Promise<void> {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.dependencies.jobs.stop(JOB);
  }

  async checkUpdates(): Promise<ApplicationUpdates> {
    return {
      ...(await this.dependencies.release.check()),
      automaticUpdate: this.automaticUpdate,
      manualCommand: this.manualCommand,
      status: { ...this.status },
    };
  }

  requestUpdate(version: string): Promise<ApplicationUpdateStatus> {
    if (!releaseVersionSchema.safeParse(version).success) {
      return Promise.reject(new ApplicationError('INVALID_INPUT', 'Invalid release version.'));
    }
    if (this.request) {
      return this.requestedVersion === version
        ? this.request
        : Promise.reject(
            new ApplicationError('CONFLICT', 'Another update request is in progress.')
          );
    }
    if (this.status.phase !== 'idle' && this.status.phase !== 'failed') {
      return this.status.targetVersion === version
        ? Promise.resolve({ ...this.status })
        : Promise.reject(new ApplicationError('CONFLICT', 'Another update is in progress.'));
    }
    this.requestedVersion = version;
    const request = this.validateAndRequest(version).finally(() => {
      if (this.request === request) {
        this.request = undefined;
        this.requestedVersion = undefined;
      }
    });
    this.request = request;
    return request;
  }

  private async validateAndRequest(version: string): Promise<ApplicationUpdateStatus> {
    if (!(this.automaticUpdate && this.dependencies.supervisor)) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        `This installation does not support automatic updates. ${this.manualCommand}`
      );
    }
    const releases = await this.dependencies.release.check();
    const advertised = releases.notices.some(
      (notice) => notice.id === 'factory-factory' && notice.latestVersion === version
    );
    const retainedTarget = this.status.phase === 'failed' && this.status.targetVersion === version;
    if (!(advertised || retainedTarget)) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'The requested version is not the advertised application release.'
      );
    }
    if (!(this.started && this.automaticUpdate)) {
      throw new ApplicationError('PRECONDITION_FAILED', 'The update supervisor is unavailable.');
    }
    this.parentWaiting = false;
    this.ready = false;
    this.status = { phase: 'waiting', targetVersion: version };
    try {
      this.dependencies.supervisor.send({ type: 'update-request', version });
    } catch (error) {
      this.fail(error);
      throw error;
    }
    return { ...this.status };
  }

  cancelUpdate(): Promise<ApplicationUpdateStatus> {
    if (this.request || this.status.phase === 'preparing' || this.status.phase === 'restarting') {
      return Promise.reject(
        new ApplicationError('CONFLICT', 'The application update is already preparing.')
      );
    }
    if (this.status.phase === 'waiting') {
      this.dependencies.supervisor?.send({ type: 'update-cancel' });
      // Readiness can race the parent's preparation. Only its idle acknowledgement
      // may reopen admission once update-ready has been sent.
      if (!this.ready) {
        this.setStatus({ phase: 'idle' });
      }
    } else {
      this.setStatus({ phase: 'idle' });
    }
    return Promise.resolve({ ...this.status });
  }

  pollIdle(): void {
    if (!this.started || this.status.phase !== 'waiting' || !this.parentWaiting || this.ready) {
      return;
    }
    if (!this.dependencies.admission.tryClose(this.dependencies.hasWork)) {
      return;
    }
    this.ready = true;
    try {
      this.dependencies.supervisor?.send({ type: 'update-ready' });
    } catch (error) {
      this.fail(error);
    }
  }

  private receive(message: unknown): void {
    const parsed = updateSupervisorMessageSchema.safeParse(message);
    if (!parsed.success) {
      return;
    }
    if (parsed.data.type === 'update-capabilities') {
      this.automaticUpdate = parsed.data.automaticUpdate;
      this.manualCommand = parsed.data.manualCommand;
    } else if (parsed.data.type === 'update-status') {
      this.setStatus(parsed.data.status);
    }
  }

  private setStatus(status: ApplicationUpdateStatus): void {
    this.status = { ...status };
    this.parentWaiting = status.phase === 'waiting';
    if (status.phase === 'idle' || status.phase === 'failed') {
      this.ready = false;
      this.dependencies.admission.release();
    }
  }

  private fail(error: unknown): void {
    this.setStatus({
      phase: 'failed',
      targetVersion: this.status.targetVersion,
      error: error instanceof Error ? error.message : 'Update supervisor unavailable.',
    });
  }
}

export function createProcessUpdateSupervisor(): UpdateSupervisorPort | undefined {
  if (!process.send) {
    return undefined;
  }
  let receive: ((message: unknown) => void) | undefined;
  return {
    send: (message) => {
      if (!(process.connected && process.send)) {
        throw new Error('Update supervisor disconnected.');
      }
      process.send(message, (error) => {
        if (error) {
          receive?.({ type: 'update-status', status: { phase: 'failed', error: error.message } });
        }
      });
    },
    subscribe: (listener) => {
      receive = listener;
      const disconnected = () => {
        listener({
          type: 'update-capabilities',
          automaticUpdate: false,
          manualCommand: 'npm install -g factory-factory@latest',
        });
        listener({
          type: 'update-status',
          status: { phase: 'failed', error: 'Update supervisor disconnected.' },
        });
      };
      process.on('message', listener);
      process.on('disconnect', disconnected);
      return () => {
        receive = undefined;
        process.off('message', listener);
        process.off('disconnect', disconnected);
      };
    },
  };
}
