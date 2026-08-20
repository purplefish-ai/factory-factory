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
    expect(supervisor.isSessionWorking('browse-session')).toBe(false);
    expect(supervisor.isAnySessionWorking(['missing', 'browse-session'])).toBe(false);
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

  it('tracks task activity between prompts until the current runtime reports idle', async () => {
    // Catches work status relying only on prompt-in-flight state.
    const handle = createTestProcessHandle();
    const { supervisor, createClient } = createHarness();
    createClient.mockImplementationOnce((params) => {
      params.handlers.onAcpEvent?.('session-1', {
        type: 'acp_task_status_changed',
        active: true,
      });
      return Promise.resolve(handle);
    });

    await supervisor.getOrCreateClient(
      'session-1',
      defaultOptions(),
      defaultHandlers(),
      defaultContext()
    );

    expect(supervisor.isSessionWorking('session-1')).toBe(true);
    const runtimeHandlers = createClient.mock.calls[0]?.[0].handlers;
    runtimeHandlers?.onAcpEvent?.('session-1', {
      type: 'acp_task_status_changed',
      active: false,
    });
    expect(supervisor.isSessionWorking('session-1')).toBe(false);
  });

  it('keeps browse task activity hidden until the runtime is promoted', async () => {
    // Catches browse-only runtimes affecting workspace work indicators.
    const handle = createTestProcessHandle();
    const { supervisor, createClient } = createHarness();
    createClient.mockImplementationOnce((params) => {
      params.handlers.onAcpEvent?.('session-1', {
        type: 'acp_task_status_changed',
        active: true,
      });
      return Promise.resolve(handle);
    });

    await supervisor.getOrCreateClient(
      'session-1',
      { ...defaultOptions(), purpose: 'browse' },
      defaultHandlers(),
      defaultContext()
    );
    handle.isPromptInFlight = true;
    expect(supervisor.isSessionWorking('session-1')).toBe(false);

    await supervisor.getOrCreateClient(
      'session-1',
      defaultOptions(),
      defaultHandlers(),
      defaultContext()
    );
    handle.isPromptInFlight = false;
    expect(supervisor.isSessionWorking('session-1')).toBe(true);
  });
});
