import type { ContentBlock, SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import type {
  SubagentBrowseCapability,
  SubagentListParams,
  SubagentListResult,
  SubagentReadParams,
  SubagentReadResult,
} from '@/shared/acp-protocol/subagents';
import { AcpClientFactory } from './acp-client-factory';
import type { AcpProcessHandle } from './acp-process-handle';
import { AcpPromptController } from './acp-prompt-controller';
import { AcpRuntimeConfigController } from './acp-runtime-config-controller';
import type { AcpRuntimeContext, AcpRuntimeCreatedCallback } from './acp-runtime-contracts';
import type { AcpRuntimeEventHandlers, AcpRuntimePurpose } from './acp-runtime-events';
import type { AcpClientCreationOperation } from './acp-runtime-quiescence';
import { AcpRuntimeSupervisor } from './acp-runtime-supervisor';
import { steerAcpPrompt } from './acp-steering';
import { AcpSubagentBrowser } from './acp-subagent-browser';
import type { AcpClientOptions } from './types';

export type { AcpRuntimeCreatedCallback } from './acp-runtime-contracts';
export { AcpBrowseSessionUnavailableError, PromptTimeoutError } from './acp-runtime-errors';

export class AcpRuntimeManager {
  private readonly clientFactory: AcpClientFactory;
  private readonly promptController: AcpPromptController;
  private readonly configController = new AcpRuntimeConfigController();
  private readonly subagentBrowser = new AcpSubagentBrowser();
  private readonly supervisor: AcpRuntimeSupervisor;

  constructor(options?: { acpStartupTimeoutMs?: number }) {
    this.clientFactory = new AcpClientFactory(options);
    let supervisor!: AcpRuntimeSupervisor;
    this.promptController = new AcpPromptController({
      isCurrentHandle: (sessionId, handle) => supervisor.isCurrentHandle(sessionId, handle),
      stopClient: (sessionId) => supervisor.stopClient(sessionId),
    });
    supervisor = new AcpRuntimeSupervisor({
      clientFactory: this.clientFactory,
      cancelPrompt: (sessionId, handle) => this.promptController.cancelPrompt(sessionId, handle),
    });
    this.supervisor = supervisor;
  }

  setAcpStartupTimeoutMs(timeoutMs: number): void {
    this.clientFactory.setAcpStartupTimeoutMs(timeoutMs);
  }

  configureEnvironment(options: { childProcessEnvProvider: () => NodeJS.ProcessEnv }): void {
    this.clientFactory.configureEnvironment(options);
  }

  setOnClientCreated(callback: AcpRuntimeCreatedCallback): void {
    this.supervisor.setOnClientCreated(callback);
  }

  isStopInProgress(sessionId: string): boolean {
    return this.supervisor.isStopInProgress(sessionId);
  }

  getClient(sessionId: string): AcpProcessHandle | undefined {
    return this.supervisor.getClient(sessionId);
  }

  getBrowseClient(sessionId: string): AcpProcessHandle | undefined {
    return this.supervisor.getBrowseClient(sessionId);
  }

  hasObservedEmptyProviderSession(
    sessionId: string,
    provider: AcpClientOptions['provider'],
    providerSessionId: string
  ): boolean {
    return this.supervisor.hasObservedEmptyProviderSession(sessionId, provider, providerSessionId);
  }

  forgetObservedEmptyProviderSession(sessionId: string): void {
    this.supervisor.forgetObservedEmptyProviderSession(sessionId);
  }

  isBrowseOnlySession(sessionId: string): boolean {
    return this.supervisor.isBrowseOnlySession(sessionId);
  }

  hasClientCreationOperation(sessionId: string): boolean {
    return this.supervisor.hasClientCreationOperation(sessionId);
  }

  getPendingClient(sessionId: string): Promise<AcpProcessHandle> | undefined {
    return this.supervisor.getPendingClient(sessionId);
  }

  runClientCreationOperation<T>(
    sessionId: string,
    purpose: AcpRuntimePurpose,
    operation: (registration: AcpClientCreationOperation) => Promise<T>
  ): Promise<T> {
    return this.supervisor.runClientCreationOperation(sessionId, purpose, operation);
  }

  stopAndQuiesce(sessionId: string): Promise<void> {
    return this.supervisor.stopAndQuiesce(sessionId);
  }

  getSubagentBrowseCapability(sessionId: string): SubagentBrowseCapability | null {
    return this.subagentBrowser.getCapability(this.supervisor.getBrowseClient(sessionId));
  }

  listSubagents(
    sessionId: string,
    input: Omit<SubagentListParams, 'sessionId'>
  ): Promise<SubagentListResult> {
    return this.subagentBrowser.listSubagents(this.supervisor.getBrowseClient(sessionId), input);
  }

  readSubagentTranscript(
    sessionId: string,
    input: Omit<SubagentReadParams, 'sessionId'>
  ): Promise<SubagentReadResult> {
    return this.subagentBrowser.readSubagentTranscript(
      this.supervisor.getBrowseClient(sessionId),
      input
    );
  }

  getOrCreateClient(
    sessionId: string,
    options: AcpClientOptions,
    handlers: AcpRuntimeEventHandlers,
    context: AcpRuntimeContext
  ): Promise<AcpProcessHandle> {
    return this.supervisor.getOrCreateClient(sessionId, options, handlers, context);
  }

  beginShutdown(): string[] {
    return this.supervisor.beginShutdown();
  }

  stopClient(sessionId: string): Promise<void> {
    return this.supervisor.stopClient(sessionId);
  }

  async sendPrompt(
    sessionId: string,
    prompt: ContentBlock[],
    timeoutMs?: number
  ): Promise<{ stopReason: string }> {
    const handle = this.requireInstalledHandle(sessionId);
    while (handle.configurationReady !== undefined || handle.pendingConfigUpdates !== undefined) {
      await Promise.all([handle.configurationReady, handle.pendingConfigUpdates]);
    }
    if (
      this.supervisor.getClient(sessionId) !== handle ||
      this.supervisor.isStopInProgress(sessionId) ||
      !handle.isRunning()
    ) {
      throw new Error(`ACP session is not ready for prompts: ${sessionId}`);
    }
    this.supervisor.forgetObservedEmptyProviderSession(sessionId);
    return await this.promptController.sendPrompt(sessionId, handle, prompt, timeoutMs);
  }

  /** Adds input to the active turn while its original prompt keeps owning completion. */
  async steerSession(
    sessionId: string,
    prompt: ContentBlock[]
  ): Promise<{ outcome: 'injected' | 'promptRequired' }> {
    const handle = this.supervisor.getClient(sessionId);
    if (!handle?.isPromptInFlight) {
      return { outcome: 'promptRequired' };
    }
    if (
      this.supervisor.isStopInProgress(sessionId) ||
      !handle.isRunning() ||
      handle.configurationReady !== undefined
    ) {
      throw new Error(`ACP session is not ready for steering: ${sessionId}`);
    }
    return await steerAcpPrompt(handle, prompt);
  }

  /** Returns true when a prompt was actually in flight and got cancelled. */
  async cancelPrompt(sessionId: string): Promise<boolean> {
    return await this.promptController.cancelPrompt(
      sessionId,
      this.supervisor.getInstalledHandle(sessionId)
    );
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string
  ): Promise<SessionConfigOption[]> {
    return await this.configController.setConfigOption(
      this.requireInstalledHandle(sessionId),
      configId,
      value,
      sessionId
    );
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<SessionConfigOption[]> {
    return await this.configController.setSessionMode(
      this.requireInstalledHandle(sessionId),
      modeId,
      sessionId
    );
  }

  async setSessionModel(sessionId: string, modelId: string): Promise<SessionConfigOption[]> {
    return await this.configController.setSessionModel(
      this.requireInstalledHandle(sessionId),
      modelId,
      sessionId
    );
  }

  stopAllClients(timeoutMs = 5000): Promise<void> {
    return this.supervisor.stopAllClients(timeoutMs);
  }

  getAllClients(): IterableIterator<[string, AcpProcessHandle]> {
    return this.supervisor.getAllClients();
  }

  isSessionRunning(sessionId: string): boolean {
    return this.supervisor.isSessionRunning(sessionId);
  }

  isSessionWorking(sessionId: string): boolean {
    return this.supervisor.isSessionWorking(sessionId);
  }

  isSessionPromptInFlight(sessionId: string): boolean {
    return this.supervisor.isSessionPromptInFlight(sessionId);
  }

  isAnySessionWorking(sessionIds: string[]): boolean {
    return this.supervisor.isAnySessionWorking(sessionIds);
  }

  getAllActiveProcesses(): Array<{
    sessionId: string;
    pid: number | undefined;
    status: string;
    isRunning: boolean;
    isPromptInFlight: boolean;
    provider: string;
  }> {
    return this.supervisor.getAllActiveProcesses();
  }

  private requireInstalledHandle(sessionId: string): AcpProcessHandle {
    const handle = this.supervisor.getInstalledHandle(sessionId);
    if (!handle) {
      throw new Error(`No ACP session found for sessionId: ${sessionId}`);
    }
    return handle;
  }
}

function createAcpRuntimeManager(): AcpRuntimeManager {
  return new AcpRuntimeManager();
}

export const acpRuntimeManager = createAcpRuntimeManager();
