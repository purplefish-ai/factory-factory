import { describe, expect, it, vi } from 'vitest';
import { createFakeApplicationGraph } from '@/test-utils/application-graph';
import { createApplication } from './app-context';

describe('createApplication', () => {
  it('keeps two complete fake graphs isolated', () => {
    const firstDependencies = createFakeApplicationGraph('first');
    const secondDependencies = createFakeApplicationGraph('second');

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
    expect(first.lifecycle.eventCollector.start).toHaveBeenCalledOnce();
    expect(second.lifecycle.eventCollector.start).toHaveBeenCalledOnce();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.services)).toBe(true);
    expect(Object.isFrozen(first.lifecycle)).toBe(true);
  });

  it('configures ACP from the supplied fake config service', () => {
    const dependencies = createFakeApplicationGraph('supplied');

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
