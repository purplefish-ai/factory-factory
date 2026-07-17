import { describe, expect, it, vi } from 'vitest';
import {
  type ApplicationDependencies,
  type ApplicationLifecycle,
  type ApplicationServices,
  createApplication,
  createDefaultApplicationDependencies,
} from './app-context';

function createApplicationDependencies(label: string): ApplicationDependencies {
  const defaults = createDefaultApplicationDependencies();
  const setAcpStartupTimeoutMs =
    vi.fn<NonNullable<ApplicationServices['acpRuntimeManager']['setAcpStartupTimeoutMs']>>();
  const configureEnvironment =
    vi.fn<NonNullable<ApplicationServices['acpRuntimeManager']['configureEnvironment']>>();
  const getAcpStartupTimeoutMs = vi.fn(() => 4321);
  const isProduction = vi.fn(() => false);
  const getChildProcessEnv = vi.fn(() => ({ APPLICATION_LABEL: label }));
  const getSystemConfig = vi.fn(() => defaults.services.configService.getSystemConfig());
  const getRuntimeSnapshot = vi.fn<ApplicationServices['sessionService']['getRuntimeSnapshot']>();
  const getAllPendingRequests = vi.fn<
    ApplicationServices['chatEventForwarderService']['getAllPendingRequests']
  >(() => new Map());

  const acpRuntimeManager = new Proxy(defaults.services.acpRuntimeManager, {
    get(target, property, receiver) {
      if (property === 'setAcpStartupTimeoutMs') {
        return setAcpStartupTimeoutMs;
      }
      if (property === 'configureEnvironment') {
        return configureEnvironment;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const configService = new Proxy(defaults.services.configService, {
    get(target, property, receiver) {
      if (property === 'getAcpStartupTimeoutMs') {
        return getAcpStartupTimeoutMs;
      }
      if (property === 'isProduction') {
        return isProduction;
      }
      if (property === 'getChildProcessEnv') {
        return getChildProcessEnv;
      }
      if (property === 'getSystemConfig') {
        return getSystemConfig;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const sessionService = new Proxy(defaults.services.sessionService, {
    get(target, property, receiver) {
      return property === 'getRuntimeSnapshot'
        ? getRuntimeSnapshot
        : Reflect.get(target, property, receiver);
    },
  });
  const chatEventForwarderService = new Proxy(defaults.services.chatEventForwarderService, {
    get(target, property, receiver) {
      return property === 'getAllPendingRequests'
        ? getAllPendingRequests
        : Reflect.get(target, property, receiver);
    },
  });

  const services = {
    ...defaults.services,
    acpRuntimeManager,
    configService,
    sessionService,
    chatEventForwarderService,
  } satisfies ApplicationServices;

  vi.spyOn(defaults.lifecycle.eventCollector, 'configure').mockImplementation(() => undefined);
  vi.spyOn(defaults.lifecycle.eventCollector, 'stop').mockImplementation(() => undefined);
  vi.spyOn(defaults.lifecycle.snapshotReconciliation, 'configure').mockImplementation(
    () => undefined
  );
  vi.spyOn(defaults.lifecycle.snapshotReconciliation, 'start').mockImplementation(() => undefined);
  vi.spyOn(defaults.lifecycle.snapshotReconciliation, 'stop').mockResolvedValue(undefined);

  const lifecycle = {
    ...defaults.lifecycle,
    interceptors: { register: vi.fn(), start: vi.fn(), stop: vi.fn() },
    wireDomainBridges: vi.fn(),
    recoverStaleArchivingWorkspaces: vi.fn(),
  } satisfies ApplicationLifecycle;

  return { services, lifecycle };
}

describe('createApplication', () => {
  it('keeps complete graph A and graph B bridge wiring isolated', () => {
    const firstDependencies = createApplicationDependencies('first');
    const secondDependencies = createApplicationDependencies('second');

    const first = createApplication(firstDependencies);
    const second = createApplication(secondDependencies);

    expect(first.lifecycle.wireDomainBridges).toHaveBeenCalledWith(first.services);
    expect(second.lifecycle.wireDomainBridges).toHaveBeenCalledWith(second.services);
    expect(vi.mocked(first.lifecycle.wireDomainBridges).mock.calls[0]?.[0]).toBe(
      firstDependencies.services
    );
    expect(vi.mocked(second.lifecycle.wireDomainBridges).mock.calls[0]?.[0]).toBe(
      secondDependencies.services
    );
    expect(vi.mocked(first.lifecycle.wireDomainBridges).mock.calls[0]?.[0]).not.toBe(
      secondDependencies.services
    );
    expect(first.lifecycle.eventCollector.configure).toHaveBeenCalledWith(first.services);
    expect(second.lifecycle.eventCollector.configure).toHaveBeenCalledWith(second.services);
    expect(first.lifecycle.snapshotReconciliation.configure).toHaveBeenCalledTimes(1);
    expect(second.lifecycle.snapshotReconciliation.configure).toHaveBeenCalledTimes(1);

    const firstSnapshotBridges = vi.mocked(first.lifecycle.snapshotReconciliation.configure).mock
      .calls[0]?.[0];
    const secondSnapshotBridges = vi.mocked(second.lifecycle.snapshotReconciliation.configure).mock
      .calls[0]?.[0];
    firstSnapshotBridges?.session.getRuntimeSnapshot('first-session');
    firstSnapshotBridges?.session.getAllPendingRequests();
    expect(first.services.sessionService.getRuntimeSnapshot).toHaveBeenCalledWith('first-session');
    expect(first.services.chatEventForwarderService.getAllPendingRequests).toHaveBeenCalledTimes(1);
    expect(second.services.sessionService.getRuntimeSnapshot).not.toHaveBeenCalled();
    expect(second.services.chatEventForwarderService.getAllPendingRequests).not.toHaveBeenCalled();

    secondSnapshotBridges?.session.getRuntimeSnapshot('second-session');
    secondSnapshotBridges?.session.getAllPendingRequests();
    expect(second.services.sessionService.getRuntimeSnapshot).toHaveBeenCalledWith(
      'second-session'
    );
    expect(second.services.chatEventForwarderService.getAllPendingRequests).toHaveBeenCalledTimes(
      1
    );
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
