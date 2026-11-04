import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationUpdateAdmission } from '@/backend/services/application-update-admission.service';
import { JobRunner } from '@/backend/services/job-runner.service';
import { ApplicationUpdateService } from './application-update.service';

const owned: ApplicationUpdateService[] = [];
afterEach(async () => {
  await Promise.all(owned.splice(0).map((service) => service.stop()));
});
function setup(manualCommand?: string, withSupervisor = true) {
  const ipc = new EventEmitter();
  const sent: unknown[] = [];
  const release = {
    check: vi.fn(async () => ({
      currentVersion: '1.0.0',
      notices: [
        {
          id: 'factory-factory' as const,
          label: 'Factory Factory',
          currentVersion: '1.0.0',
          latestVersion: '1.1.0',
        },
      ],
    })),
  };
  const gate = new ApplicationUpdateAdmission();
  const jobs = new JobRunner();
  let busy = false;
  const service = new ApplicationUpdateService({
    release,
    manualCommand,
    admission: gate,
    hasWork: () => busy,
    jobs,
    supervisor: withSupervisor
      ? {
          send: (message) => {
            sent.push(message);
          },
          subscribe: (listener) => {
            ipc.on('message', listener);
            return () => ipc.off('message', listener);
          },
        }
      : undefined,
  });
  owned.push(service);
  service.start();
  const emit = (message: unknown) => ipc.emit('message', message);
  const supported = () =>
    emit({
      type: 'update-capabilities',
      automaticUpdate: true,
      manualCommand: 'npm install -g factory-factory@latest',
    });
  return {
    service,
    release,
    gate,
    jobs,
    sent,
    emit,
    supported,
    setBusy: (value: boolean) => {
      busy = value;
    },
  };
}

describe('application update orchestration', () => {
  it('offers manual guidance without a supervisor and rejects installation', async () => {
    const { service } = setup(undefined, false);
    expect(await service.checkUpdates()).toMatchObject({
      automaticUpdate: false,
      status: { phase: 'idle' },
      manualCommand: 'npm install -g factory-factory@latest',
    });
    await expect(service.requestUpdate('1.1.0')).rejects.toThrow('automatic');
  });
  it('preserves installation-specific guidance without an updater parent', async () => {
    const { service } = setup('Download the latest Factory Factory desktop release.', false);
    expect(await service.checkUpdates()).toMatchObject({
      automaticUpdate: false,
      manualCommand: 'Download the latest Factory Factory desktop release.',
    });
  });
  it('accepts only the advertised stable app release and coalesces concurrent requests', async () => {
    const { service, supported, sent } = setup();
    supported();
    await expect(service.requestUpdate('1.1.0; malicious')).rejects.toThrow();
    await expect(service.requestUpdate('2.0.0')).rejects.toThrow('advertised');
    const statuses = await Promise.all([
      service.requestUpdate('1.1.0'),
      service.requestUpdate('1.1.0'),
    ]);
    expect(statuses).toEqual([
      { phase: 'waiting', targetVersion: '1.1.0' },
      { phase: 'waiting', targetVersion: '1.1.0' },
    ]);
    expect(sent.filter((value) => JSON.stringify(value).includes('update-request'))).toEqual([
      { type: 'update-request', version: '1.1.0' },
    ]);
  });
  it('rejects offline checks without sending an installation request', async () => {
    const { service, supported, release, sent } = setup();
    supported();
    release.check.mockRejectedValueOnce(new Error('Offline'));
    await expect(service.requestUpdate('1.1.0')).rejects.toThrow('Offline');
    expect(sent).toEqual([{ type: 'update-hello' }]);
  });
  it('waits for parent acknowledgement and all work before atomically fencing admission', async () => {
    const { service, supported, sent, emit, gate, setBusy } = setup();
    supported();
    await service.requestUpdate('1.1.0');
    await service.pollIdle();
    expect(gate.isClosed()).toBe(false);
    emit({ type: 'update-status', status: { phase: 'waiting', targetVersion: '1.1.0' } });
    setBusy(true);
    await service.pollIdle();
    expect(gate.isClosed()).toBe(false);
    setBusy(false);
    let complete!: () => void;
    const work = gate.run(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        })
    );
    await service.pollIdle();
    expect(gate.isClosed()).toBe(false);
    complete();
    await work;
    await service.pollIdle();
    expect(gate.isClosed()).toBe(true);
    await expect(gate.run(async () => undefined)).rejects.toThrow('update');
    expect(sent.at(-1)).toEqual({ type: 'update-ready' });
    await service.pollIdle();
    expect(sent.filter((value) => JSON.stringify(value).includes('update-ready'))).toHaveLength(1);
    emit({ type: 'update-status', status: { phase: 'failed', error: 'disk full' } });
    expect(gate.isClosed()).toBe(false);
    await expect(gate.run(async () => 42)).resolves.toBe(42);
  });
  it('cancels waiting work and ignores malformed IPC', async () => {
    const { service, supported, sent, emit, gate } = setup();
    supported();
    emit({ type: 'update-status', status: { phase: 'malformed' } });
    await service.requestUpdate('1.1.0');
    emit({ type: 'update-status', status: { phase: 'waiting', targetVersion: '1.1.0' } });
    await service.pollIdle();
    expect(gate.isClosed()).toBe(true);
    expect(await service.cancelUpdate()).toEqual({ phase: 'waiting', targetVersion: '1.1.0' });
    expect(gate.isClosed()).toBe(true);
    emit({ type: 'update-status', status: { phase: 'idle' } });
    expect(gate.isClosed()).toBe(false);
    expect(sent.at(-1)).toEqual({ type: 'update-cancel' });
    emit({ type: 'update-status', status: { phase: 'preparing', targetVersion: '1.1.0' } });
    await expect(service.cancelUpdate()).rejects.toThrow('preparing');
  });
});

it('keeps readiness fenced during backend shutdown and stops polling', async () => {
  const { service, supported, emit, gate, jobs } = setup();
  supported();
  await service.requestUpdate('1.1.0');
  emit({ type: 'update-status', status: { phase: 'waiting', targetVersion: '1.1.0' } });
  await service.pollIdle();
  await service.stop();
  expect(gate.isClosed()).toBe(true);
  expect(jobs.isRunning('application-update-idle')).toBe(false);
});

it('retries a previously validated failed target when release metadata is unavailable after restart', async () => {
  const { service, supported, emit, release, sent } = setup();
  supported();
  emit({
    type: 'update-status',
    status: { phase: 'failed', targetVersion: '1.1.0', error: 'Registry unavailable' },
  });
  release.check.mockResolvedValue({ currentVersion: '1.0.0', notices: [] });
  await expect(service.requestUpdate('1.1.0')).resolves.toMatchObject({
    phase: 'waiting',
    targetVersion: '1.1.0',
  });
  expect(sent).toContainEqual({ type: 'update-request', version: '1.1.0' });
});
