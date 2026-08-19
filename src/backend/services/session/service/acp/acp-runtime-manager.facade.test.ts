import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AcpRuntimeManager,
  createManagerTestHarness,
  setupSuccessfulSpawn,
} from './acp-runtime-manager.test-harness';
import {
  defaultContext,
  defaultHandlers,
  defaultOptions,
} from './acp-runtime-manager.test-helpers';

type ExpectedRuntimeSurface = Pick<
  AcpRuntimeManager,
  | 'setAcpStartupTimeoutMs'
  | 'configureEnvironment'
  | 'setOnClientCreated'
  | 'isStopInProgress'
  | 'getClient'
  | 'getBrowseClient'
  | 'isBrowseOnlySession'
  | 'hasClientCreationOperation'
  | 'getPendingClient'
  | 'getOrCreateClient'
  | 'runClientCreationOperation'
  | 'stopAndQuiesce'
  | 'beginShutdown'
  | 'stopClient'
  | 'stopAllClients'
  | 'sendPrompt'
  | 'cancelPrompt'
  | 'setConfigOption'
  | 'setSessionMode'
  | 'setSessionModel'
  | 'getSubagentBrowseCapability'
  | 'listSubagents'
  | 'readSubagentTranscript'
  | 'getAllClients'
  | 'isSessionRunning'
  | 'isSessionWorking'
  | 'isAnySessionWorking'
  | 'getAllActiveProcesses'
>;

const acceptsExpectedRuntimeSurface = (_runtime: ExpectedRuntimeSurface): void => undefined;
acceptsExpectedRuntimeSurface(new AcpRuntimeManager());

describe('AcpRuntimeManager', () => {
  let manager: AcpRuntimeManager;

  beforeEach(() => {
    ({ manager } = createManagerTestHarness());
  });

  it('keeps cross-session runtime state in exactly one supervisor', () => {
    const source = readFileSync(new URL('./acp-runtime-manager.ts', import.meta.url), 'utf8');
    for (const forbidden of [
      'new Map<string, AcpProcessHandle>()',
      'new Map<string, Promise<AcpProcessHandle>>()',
      'new WeakMap<ChildProcess, AcpRuntimeMetadata>()',
      'new Set<string>()',
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source.match(/new AcpRuntimeSupervisor\(/g)).toHaveLength(1);
  });

  it('does not export internal runtime collaborators from the ACP barrel', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    for (const internalCollaborator of [
      'AcpRuntimeSupervisor',
      'AcpClientFactory',
      'AcpPromptController',
      'AcpRuntimeConfigController',
      'AcpSubagentBrowser',
    ]) {
      expect(source).not.toContain(internalCollaborator);
    }
  });

  describe('session status methods', () => {
    it('isSessionRunning returns true for active session', async () => {
      setupSuccessfulSpawn();

      await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      expect(manager.isSessionRunning('session-1')).toBe(true);
      expect(manager.isSessionRunning('nonexistent')).toBe(false);
    });

    it('isSessionWorking returns true when prompt is in flight', async () => {
      setupSuccessfulSpawn();

      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      expect(manager.isSessionWorking('session-1')).toBe(false);
      handle.isPromptInFlight = true;
      expect(manager.isSessionWorking('session-1')).toBe(true);
    });

    it('isAnySessionWorking checks multiple sessions', async () => {
      setupSuccessfulSpawn();

      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      expect(manager.isAnySessionWorking(['session-1', 'session-2'])).toBe(false);
      handle.isPromptInFlight = true;
      expect(manager.isAnySessionWorking(['session-1', 'session-2'])).toBe(true);
    });
  });
});
