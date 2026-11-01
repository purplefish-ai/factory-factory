import type { ChildProcess } from 'node:child_process';
import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import {
  SUBAGENTS_CAPABILITY_META_KEY,
  type SubagentBrowseCapability,
  subagentBrowseCapabilitySchema,
} from '@/shared/acp-protocol/subagents';
import type { AcpConnection } from './acp-connection';
import type { AcpNativeSessionTracker } from './acp-native-session-tracker';
import type { AcpPermissionBridge } from './acp-permission-bridge';
import { type AcpConfigurationLease, AcpPromptReadiness } from './acp-prompt-readiness';
import type { AcpSessionCreationOutcome } from './acp-session-creation-outcome';
import { toAcpSessionId } from './acp-session-identity';
import type { AcpProvider } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class AcpProcessHandle {
  /** Live ownership only; never restored from persisted PID metadata. */
  ownedProcessGroup?: number;
  eventLifecycleGeneration?: number;
  unsupportedProcessOverride?: boolean;
  readonly connection: AcpConnection;
  readonly child: ChildProcess;
  readonly permissionBridge?: AcpPermissionBridge;
  readonly provider: AcpProvider;
  readonly nativeSessionTracker?: AcpNativeSessionTracker;
  providerSessionId: string;
  agentCapabilities: Record<string, unknown>;
  readonly supportsSteering: boolean;
  private promptLease?: AcpConfigurationLease;
  private readonly promptCompletion = new AcpPromptReadiness();
  private pendingConfigUpdate?: Promise<void>;
  configOptions: SessionConfigOption[];
  readonly createdAt: Date;
  readonly sessionCreationOutcome: AcpSessionCreationOutcome;
  private readonly promptReadiness = new AcpPromptReadiness();
  private initialConfiguration?: AcpConfigurationLease;

  constructor(params: {
    connection: AcpConnection;
    child: ChildProcess;
    permissionBridge?: AcpPermissionBridge;
    nativeSessionTracker?: AcpNativeSessionTracker;
    provider: AcpProvider;
    providerSessionId: string;
    sessionCreationOutcome?: AcpSessionCreationOutcome;
    agentCapabilities: Record<string, unknown>;
    supportsSteering?: boolean;
  }) {
    this.connection = params.connection;
    this.child = params.child;
    this.permissionBridge = params.permissionBridge;
    this.nativeSessionTracker = params.nativeSessionTracker;
    this.provider = params.provider;
    this.providerSessionId = params.providerSessionId;
    this.sessionCreationOutcome = params.sessionCreationOutcome ?? { kind: 'new' };
    this.agentCapabilities = params.agentCapabilities;
    this.supportsSteering = params.supportsSteering ?? false;
    this.isPromptInFlight = false;
    this.configOptions = [];
    this.createdAt = new Date();
  }

  get acpSessionId(): string {
    return toAcpSessionId(this.provider, this.providerSessionId);
  }

  get isPromptInFlight(): boolean {
    return this.promptLease !== undefined;
  }

  set isPromptInFlight(value: boolean) {
    if (value) {
      this.promptLease ??= this.promptCompletion.begin();
    } else {
      this.promptLease?.complete();
      this.promptLease = undefined;
    }
  }

  get promptComplete(): Promise<void> | undefined {
    return this.promptCompletion.wait();
  }

  /** Pending public edits block the next prompt, but never the current turn. */
  get pendingConfigUpdates(): Promise<void> | undefined {
    return this.pendingConfigUpdate;
  }

  trackPendingConfigUpdate(update: Promise<unknown>): void {
    const ready = update
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        if (this.pendingConfigUpdate === ready) {
          this.pendingConfigUpdate = undefined;
        }
      });
    this.pendingConfigUpdate = ready;
  }

  get configurationReady(): Promise<void> | undefined {
    return this.promptReadiness.wait();
  }

  beginConfiguration(): AcpConfigurationLease {
    return this.promptReadiness.begin();
  }

  deferPromptReadiness(): void {
    this.initialConfiguration ??= this.beginConfiguration();
  }

  completeConfiguration(assertCurrent?: () => void): void {
    assertCurrent?.();
    this.initialConfiguration?.complete();
  }

  /** Permanently reject this incarnation's configuration and prompt-completion waiters. */
  failConfiguration(error: unknown): void {
    this.promptReadiness.fail(error);
    this.promptCompletion.fail(error);
  }

  supportsImages(): boolean {
    const caps = this.agentCapabilities?.promptCapabilities;
    return (
      typeof caps === 'object' && caps !== null && (caps as Record<string, unknown>).image === true
    );
  }

  getSubagentBrowseCapability(): SubagentBrowseCapability | null {
    if (this.nativeSessionTracker?.isAvailable()) {
      return { version: 1, list: true, read: true, notifications: true };
    }
    const meta = this.agentCapabilities._meta;
    if (!isRecord(meta)) {
      return null;
    }

    const parsed = subagentBrowseCapabilitySchema.safeParse(meta[SUBAGENTS_CAPABILITY_META_KEY]);
    return parsed.success ? parsed.data : null;
  }

  isRunning(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null && !this.child.killed;
  }

  getPid(): number | undefined {
    return this.child.pid;
  }
}
