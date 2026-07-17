import { describe, expect, it, vi } from 'vitest';
import {
  type ApplicationDependencies,
  type ApplicationLifecycle,
  type ApplicationServices,
  createApplication,
} from './app-context';

function createApplicationDependencies(label: string): ApplicationDependencies {
  const services = {
    label,
    acpRuntimeManager: {
      setAcpStartupTimeoutMs: vi.fn(),
      configureEnvironment: vi.fn(),
    },
    configService: {
      getAcpStartupTimeoutMs: vi.fn(() => 4321),
      isProduction: vi.fn(() => false),
      getChildProcessEnv: vi.fn(() => ({ APPLICATION_LABEL: label })),
      getSystemConfig: vi.fn(() => ({ port: label })),
    },
    sessionService: {
      getRuntimeSnapshot: vi.fn(),
    },
    chatEventForwarderService: {
      getAllPendingRequests: vi.fn(() => new Map()),
    },
  } as unknown as ApplicationServices;

  const lifecycle = {
    database: { disconnect: vi.fn() },
    interceptors: { register: vi.fn(), start: vi.fn(), stop: vi.fn() },
    wireDomainBridges: vi.fn(),
    eventCollector: { configure: vi.fn(), stop: vi.fn() },
    snapshotReconciliation: {
      configure: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    },
    recoverStaleArchivingWorkspaces: vi.fn(),
  } as unknown as ApplicationLifecycle;

  return { services, lifecycle };
}

describe('createApplication', () => {
  it('wires only the complete dependency graph supplied by the caller', () => {
    const firstDependencies = createApplicationDependencies('first');
    const secondDependencies = createApplicationDependencies('second');

    const first = createApplication(firstDependencies);
    const second = createApplication(secondDependencies);

    expect(first.lifecycle.wireDomainBridges).toHaveBeenCalledWith(first.services);
    expect(second.lifecycle.wireDomainBridges).toHaveBeenCalledWith(second.services);
    expect(first.lifecycle.wireDomainBridges).not.toHaveBeenCalledWith(second.services);
    expect(second.lifecycle.wireDomainBridges).not.toHaveBeenCalledWith(first.services);
    expect(first.lifecycle.eventCollector.configure).toHaveBeenCalledWith(first.services);
    expect(second.lifecycle.eventCollector.configure).toHaveBeenCalledWith(second.services);
    expect(first.lifecycle.snapshotReconciliation.configure).toHaveBeenCalledTimes(1);
    expect(second.lifecycle.snapshotReconciliation.configure).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.services)).toBe(true);
    expect(Object.isFrozen(first.lifecycle)).toBe(true);
  });

  it('configures ACP from the supplied config service', () => {
    const dependencies = createApplicationDependencies('supplied');

    createApplication(dependencies);

    expect(dependencies.services.acpRuntimeManager.setAcpStartupTimeoutMs).toHaveBeenCalledWith(
      4321
    );
    expect(dependencies.services.acpRuntimeManager.configureEnvironment).toHaveBeenCalledWith({
      preferSourceEntrypoint: true,
      childProcessEnvProvider: expect.any(Function),
    });

    const environment = vi.mocked(dependencies.services.acpRuntimeManager.configureEnvironment).mock
      .calls[0]?.[0];
    expect(environment?.childProcessEnvProvider()).toEqual({ APPLICATION_LABEL: 'supplied' });
    expect(dependencies.services.configService.getChildProcessEnv).toHaveBeenCalledTimes(1);
  });
});
