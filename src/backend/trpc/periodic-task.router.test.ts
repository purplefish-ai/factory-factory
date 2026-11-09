import { describe, expect, it, vi } from 'vitest';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { periodicTaskRouter } from './periodic-task.trpc';
import type { Context } from './trpc';

function createCaller(requestTrust?: Context['requestTrust']) {
  const periodicTaskService = {
    create: vi.fn(async () => ({ id: 'task-1' })),
    update: vi.fn(async () => ({ id: 'task-1' })),
    toggleEnabled: vi.fn(async () => ({ id: 'task-1' })),
    delete: vi.fn(async () => undefined),
  };
  const caller = periodicTaskRouter.createCaller(
    unsafeCoerce<Context>({
      requestTrust,
      appContext: {
        services: {
          periodicTaskService,
          configService: {
            getCorsConfig: () => ({ allowedOrigins: ['http://localhost:3000'] }),
          },
        },
      },
    })
  );
  return { caller, periodicTaskService };
}

const createInput = {
  projectId: 'project-1',
  name: 'Nightly',
  prompt: 'Run the checks',
  cadence: 'DAILY' as const,
  scheduledTime: '02:00',
  timezone: 'UTC',
};

describe('periodic task scheduling trust boundary', () => {
  it.each([
    { remoteAddress: '203.0.113.10', isLocal: false },
    { remoteAddress: '127.0.0.1', isLocal: true, origin: 'https://untrusted.example' },
    { remoteAddress: '127.0.0.1', isLocal: true, hasForwardedClientAddressHeaders: true },
  ])('rejects scheduling changes from untrusted clients: %j', async (trust) => {
    const { caller, periodicTaskService } = createCaller(trust);

    await expect(caller.create(createInput)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.update({ id: 'task-1', prompt: 'Other' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller.toggleEnabled({ id: 'task-1', enabled: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(periodicTaskService.create).not.toHaveBeenCalled();
    expect(periodicTaskService.update).not.toHaveBeenCalled();
    expect(periodicTaskService.toggleEnabled).not.toHaveBeenCalled();
  });

  it('allows scheduling changes from a trusted local client', async () => {
    const { caller, periodicTaskService } = createCaller({
      remoteAddress: '127.0.0.1',
      isLocal: true,
      origin: 'http://localhost:3000',
    });

    await caller.create(createInput);
    await caller.update({ id: 'task-1', prompt: 'Other' });
    await caller.toggleEnabled({ id: 'task-1', enabled: false });

    expect(periodicTaskService.create).toHaveBeenCalledWith(createInput);
    expect(periodicTaskService.update).toHaveBeenCalledWith('task-1', { prompt: 'Other' });
    expect(periodicTaskService.toggleEnabled).toHaveBeenCalledWith('task-1', false);
  });

  it('keeps deletion available to remote clients', async () => {
    const { caller, periodicTaskService } = createCaller({
      remoteAddress: '203.0.113.10',
      isLocal: false,
    });

    await expect(caller.delete({ id: 'task-1' })).resolves.toEqual({ success: true });
    expect(periodicTaskService.delete).toHaveBeenCalledWith('task-1');
  });
});
