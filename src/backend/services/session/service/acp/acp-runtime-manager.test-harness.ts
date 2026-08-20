import { vi } from 'vitest';
import type {
  AcpRuntimeManager as AcpRuntimeManagerType,
  PromptTimeoutError as PromptTimeoutErrorType,
} from './acp-runtime-manager';
import {
  createMockChildProcess,
  defaultConfigOptions,
  type MockChildProcess,
} from './acp-runtime-manager.test-helpers';

const mocks = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockInitialize: vi.fn(),
  mockLoadSession: vi.fn(),
  mockNewSession: vi.fn(),
  mockPrompt: vi.fn(),
  mockCancel: vi.fn(),
  mockSetSessionConfigOption: vi.fn(),
  mockSetSessionMode: vi.fn(),
  mockSetSessionModel: vi.fn(),
  mockExtMethod: vi.fn(),
  mockNdJsonStream: vi
    .fn()
    .mockReturnValue({ writable: {}, readable: { pipeThrough: () => ({}) } }),
  mockLoggerWarn: vi.fn(),
  mockAcpClients: [] as unknown[],
}));

export const mockSpawn: ReturnType<typeof vi.fn> = mocks.mockSpawn;
export const mockInitialize: ReturnType<typeof vi.fn> = mocks.mockInitialize;
export const mockLoadSession: ReturnType<typeof vi.fn> = mocks.mockLoadSession;
export const mockNewSession: ReturnType<typeof vi.fn> = mocks.mockNewSession;
export const mockPrompt: ReturnType<typeof vi.fn> = mocks.mockPrompt;
export const mockCancel: ReturnType<typeof vi.fn> = mocks.mockCancel;
export const mockSetSessionConfigOption: ReturnType<typeof vi.fn> =
  mocks.mockSetSessionConfigOption;
export const mockSetSessionMode: ReturnType<typeof vi.fn> = mocks.mockSetSessionMode;
export const mockSetSessionModel: ReturnType<typeof vi.fn> = mocks.mockSetSessionModel;
export const mockExtMethod: ReturnType<typeof vi.fn> = mocks.mockExtMethod;
export const mockNdJsonStream: ReturnType<typeof vi.fn> = mocks.mockNdJsonStream;
export const mockLoggerWarn: ReturnType<typeof vi.fn> = mocks.mockLoggerWarn;
export const mockAcpClients: unknown[] = mocks.mockAcpClients;

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mocks.mockSpawn(...args),
}));

vi.mock('@agentclientprotocol/sdk', () => {
  class MockCSC {
    toClient: (agent: unknown) => unknown;
    initialize = mockInitialize;
    loadSession = mockLoadSession;
    newSession = mockNewSession;
    prompt = mockPrompt;
    cancel = mockCancel;
    setSessionConfigOption = mockSetSessionConfigOption;
    setSessionMode = mockSetSessionMode;
    unstable_setSessionModel = mockSetSessionModel;
    extMethod = mockExtMethod;

    constructor(toClient: (agent: unknown) => unknown, _stream: unknown) {
      this.toClient = toClient;
      mocks.mockAcpClients.push(toClient({}));
    }
  }

  return {
    ClientSideConnection: MockCSC,
    ndJsonStream: (...args: unknown[]) => mocks.mockNdJsonStream(...args),
    PROTOCOL_VERSION: 1,
  };
});

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: mocks.mockLoggerWarn,
    error: vi.fn(),
  }),
  getCurrentProcessEnv: () => ({}),
}));

import * as acpRuntimeManager from './acp-runtime-manager';

export const AcpRuntimeManager = acpRuntimeManager.AcpRuntimeManager;
export const PromptTimeoutError = acpRuntimeManager.PromptTimeoutError;
export type AcpRuntimeManager = AcpRuntimeManagerType;
export type PromptTimeoutError = PromptTimeoutErrorType;

export function setupSuccessfulSpawn(
  agentCapabilities: Record<string, unknown> = { loadSession: {} }
): MockChildProcess {
  const child = createMockChildProcess();
  mockSpawn.mockReturnValue(child);
  mockInitialize.mockResolvedValue({
    protocolVersion: 1,
    agentCapabilities,
    agentInfo: { name: 'claude-agent-acp' },
  });
  mockNewSession.mockResolvedValue({
    sessionId: 'provider-session-123',
    configOptions: defaultConfigOptions(),
  });
  mockLoadSession.mockResolvedValue({
    configOptions: defaultConfigOptions(),
  });
  mockSetSessionConfigOption.mockResolvedValue({
    configOptions: defaultConfigOptions(),
  });
  mockSetSessionMode.mockResolvedValue({});
  mockSetSessionModel.mockResolvedValue({});
  return child;
}

export type ManagerTestHarness = {
  manager: AcpRuntimeManager;
  setupSuccessfulSpawn(agentCapabilities?: Record<string, unknown>): MockChildProcess;
};

export function createManagerTestHarness(): ManagerTestHarness {
  return { manager: new AcpRuntimeManager(), setupSuccessfulSpawn };
}
