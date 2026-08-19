import { describe, expect, it, vi } from 'vitest';
import type { CreateAcpClientParams } from './acp-client-factory';
import type { AcpProcessHandle } from './acp-process-handle';
import {
  createTestProcessHandle,
  defaultContext,
  defaultHandlers,
  defaultOptions,
  type MockChildProcess,
} from './acp-runtime-manager.test-helpers';
import { AcpRuntimeSupervisor } from './acp-runtime-supervisor';

type FactoryImplementation = (params: CreateAcpClientParams) => Promise<AcpProcessHandle>;

function mockChildOf(handle: AcpProcessHandle): MockChildProcess {
  return handle.child as unknown as MockChildProcess;
}

function createHarness() {
  const createClient = vi.fn<FactoryImplementation>(() =>
    Promise.resolve(createTestProcessHandle())
  );
  const supervisor = new AcpRuntimeSupervisor({
    clientFactory: { createClient },
    cancelPrompt: () => Promise.resolve(false),
  });
  return { supervisor, createClient };
}

describe('AcpRuntimeSupervisor status queries', () => {
  it('reports installed runtime identity, liveness, work, and process snapshots', async () => {
    // Catches status queries filtering browse handles or deriving work from public visibility.
    const active = createTestProcessHandle({ provider: 'CLAUDE' });
    const browse = createTestProcessHandle({ provider: 'CODEX' });
    mockChildOf(browse).pid = 54_321;
    const { supervisor, createClient } = createHarness();
    createClient.mockResolvedValueOnce(active).mockResolvedValueOnce(browse);
    await supervisor.getOrCreateClient(
      'active-session',
      defaultOptions(),
      defaultHandlers(),
      defaultContext()
    );
    await supervisor.getOrCreateClient(
      'browse-session',
      { ...defaultOptions(), purpose: 'browse' },
      defaultHandlers(),
      defaultContext()
    );
    active.isPromptInFlight = true;
    browse.isPromptInFlight = true;

    expect(supervisor.isCurrentHandle('active-session', active)).toBe(true);
    expect(supervisor.isCurrentHandle('active-session', browse)).toBe(false);
    expect(supervisor.isSessionRunning('active-session')).toBe(true);
    expect(supervisor.isSessionRunning('browse-session')).toBe(false);
    expect(supervisor.isSessionWorking('browse-session')).toBe(true);
    expect(supervisor.isAnySessionWorking(['missing', 'browse-session'])).toBe(true);
    expect([...supervisor.getAllClients()]).toEqual([
      ['active-session', active],
      ['browse-session', browse],
    ]);
    expect(supervisor.getAllActiveProcesses()).toEqual([
      {
        sessionId: 'active-session',
        pid: 12_345,
        status: 'running',
        isRunning: true,
        isPromptInFlight: true,
        provider: 'CLAUDE',
      },
      {
        sessionId: 'browse-session',
        pid: 54_321,
        status: 'running',
        isRunning: true,
        isPromptInFlight: true,
        provider: 'CODEX',
      },
    ]);

    mockChildOf(browse).killed = true;
    expect(supervisor.getBrowseClient('browse-session')).toBeUndefined();
    expect(supervisor.getInstalledHandle('browse-session')).toBe(browse);
    expect(supervisor.getAllActiveProcesses()[1]).toMatchObject({
      status: 'stopped',
      isRunning: false,
    });
  });
});
