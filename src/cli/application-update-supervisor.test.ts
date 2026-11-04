import { expect, it, vi } from 'vitest';
import { ApplicationUpdateSupervisor } from './application-update-supervisor';
function fixture() {
  const prepared = {
    activate: vi.fn(async () => {
      /* Successful test operation. */
    }),
    rollback: vi.fn(async () => {
      /* Successful test operation. */
    }),
    dispose: vi.fn(async () => {
      /* Successful test operation. */
    }),
    recoveryPath: '/backup',
    packageRoot: '/app',
  };
  const options = {
    prepare: vi.fn(async () => prepared),
    stopBackend: vi.fn(async () => {
      /* Successful test operation. */
    }),
    backupDatabase: vi.fn(async () =>
      vi.fn(async () => {
        /* Successful test operation. */
      })
    ),
    migrate: vi.fn(async () => {
      /* Successful test operation. */
    }),
    publish: vi.fn(),
    persist: vi.fn(async () => {
      /* Successful test operation. */
    }),
    automaticUpdate: true,
  };
  return { prepared, options, supervisor: new ApplicationUpdateSupervisor(options) };
}
it('waits for readiness, coalesces requests and installs exactly once', async () => {
  const { supervisor, options, prepared } = fixture();
  supervisor.request('0.5.4');
  supervisor.request('0.5.4');
  expect(supervisor.status.phase).toBe('waiting');
  expect(options.prepare).not.toHaveBeenCalled();
  const pending = supervisor.ready();
  void supervisor.ready();
  await pending;
  expect(options.prepare).toHaveBeenCalledTimes(1);
  expect(options.stopBackend).toHaveBeenCalledOnce();
  expect(prepared.activate).toHaveBeenCalledOnce();
  expect(options.migrate).toHaveBeenCalledOnce();
  expect(supervisor.restartRequired).toBe(true);
  expect(supervisor.status.phase).toBe('restarting');
  await supervisor.backendReady();
  expect(supervisor.status.phase).toBe('idle');
});
it('cancels waiting without installing or stopping agents', async () => {
  const { supervisor, options } = fixture();
  supervisor.request('0.5.4');
  supervisor.cancel();
  await supervisor.ready();
  expect(supervisor.status.phase).toBe('idle');
  expect(options.prepare).not.toHaveBeenCalled();
});
it('keeps the old backend alive when preparation fails', async () => {
  const { supervisor, options } = fixture();
  options.prepare.mockRejectedValue(new Error('npmjs is unavailable'));
  supervisor.request('0.5.4');
  await supervisor.ready();
  expect(supervisor.status.phase).toBe('failed');
  expect(options.stopBackend).not.toHaveBeenCalled();
  expect(supervisor.restartRequired).toBe(false);
});
it('restores the database and package on migration failure before requesting recovery restart', async () => {
  const { supervisor, options, prepared } = fixture();
  const restore = vi.fn(async () => {
    /* Successful test operation. */
  });
  options.backupDatabase.mockResolvedValue(restore);
  options.migrate.mockRejectedValue(new Error('migration failed'));
  supervisor.request('0.5.4');
  await supervisor.ready();
  expect(restore).toHaveBeenCalledOnce();
  expect(prepared.rollback).toHaveBeenCalledOnce();
  expect(supervisor.status.phase).toBe('failed');
  expect(supervisor.restartRequired).toBe(true);
  await supervisor.backendReady();
  expect(supervisor.status.phase).toBe('failed');
});
it('rejects unsupported installations and arbitrary version arguments', () => {
  const { options } = fixture();
  const supervisor = new ApplicationUpdateSupervisor({ ...options, automaticUpdate: false });
  expect(() => supervisor.request('0.5.4')).toThrow(/manual/i);
  expect(() => supervisor.request('$(touch injected)')).toThrow();
});
it('retains the backup and reports recovery failure instead of destroying it', async () => {
  const { supervisor, options, prepared } = fixture();
  options.migrate.mockRejectedValue(new Error('migration failed'));
  prepared.rollback.mockRejectedValue(new Error('permission denied'));
  supervisor.request('0.5.4');
  await expect(supervisor.ready()).rejects.toThrow(/recover/i);
  expect(prepared.dispose).not.toHaveBeenCalled();
});
it('restores the previous package and database if replacement startup fails', async () => {
  const { supervisor, options, prepared } = fixture();
  const restore = vi.fn(async () => {
    /* Successful test operation. */
  });
  options.backupDatabase.mockResolvedValue(restore);
  supervisor.request('0.5.4');
  await supervisor.ready();
  await supervisor.backendFailed(new Error('startup failed'));
  expect(restore).toHaveBeenCalledOnce();
  expect(prepared.rollback).toHaveBeenCalledOnce();
  expect(supervisor.status.phase).toBe('failed');
  expect(supervisor.restartRequired).toBe(true);
});
it('can retry after a transient persistence failure without stopping the backend', async () => {
  const { supervisor, options } = fixture();
  options.persist.mockRejectedValueOnce(new Error('disk unavailable'));
  supervisor.request('0.5.4');
  await supervisor.ready();
  expect(supervisor.status.phase).toBe('failed');
  expect(options.stopBackend).not.toHaveBeenCalled();
  supervisor.request('0.5.4');
  await supervisor.ready();
  expect(supervisor.status.phase).toBe('restarting');
});
it('requests recovery restart when graceful shutdown exits unsuccessfully', async () => {
  const { options, prepared } = fixture();
  options.stopBackend.mockRejectedValue(new Error('Backend shutdown failed (1)'));
  const supervisor = new ApplicationUpdateSupervisor({ ...options, isBackendStopped: () => true });
  supervisor.request('0.5.4');
  await supervisor.ready();
  expect(supervisor.status.phase).toBe('failed');
  expect(supervisor.restartRequired).toBe(true);
  expect(prepared.activate).not.toHaveBeenCalled();
});
