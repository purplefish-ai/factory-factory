import type { ChildProcess } from 'node:child_process';
import type { ClientSideConnection, SessionConfigOption } from '@agentclientprotocol/sdk';
import {
  SUBAGENTS_CAPABILITY_META_KEY,
  type SubagentBrowseCapability,
  subagentBrowseCapabilitySchema,
} from '@/shared/acp-protocol/subagents';
import type { AcpNativeSessionTracker } from './acp-native-session-tracker';
import type { AcpPermissionBridge } from './acp-permission-bridge';
import type { AcpSessionCreationOutcome } from './acp-session-creation-outcome';
import { toAcpSessionId } from './acp-session-identity';
import type { AcpProvider } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class AcpProcessHandle {
  readonly connection: ClientSideConnection;
  readonly child: ChildProcess;
  readonly permissionBridge?: AcpPermissionBridge;
  readonly provider: AcpProvider;
  readonly nativeSessionTracker?: AcpNativeSessionTracker;
  providerSessionId: string;
  agentCapabilities: Record<string, unknown>;
  isPromptInFlight: boolean;
  configOptions: SessionConfigOption[];
  readonly createdAt: Date;
  readonly sessionCreationOutcome: AcpSessionCreationOutcome;

  constructor(params: {
    connection: ClientSideConnection;
    child: ChildProcess;
    permissionBridge?: AcpPermissionBridge;
    nativeSessionTracker?: AcpNativeSessionTracker;
    provider: AcpProvider;
    providerSessionId: string;
    sessionCreationOutcome?: AcpSessionCreationOutcome;
    agentCapabilities: Record<string, unknown>;
  }) {
    this.connection = params.connection;
    this.child = params.child;
    this.permissionBridge = params.permissionBridge;
    this.nativeSessionTracker = params.nativeSessionTracker;
    this.provider = params.provider;
    this.providerSessionId = params.providerSessionId;
    this.sessionCreationOutcome = params.sessionCreationOutcome ?? { kind: 'new' };
    this.agentCapabilities = params.agentCapabilities;
    this.isPromptInFlight = false;
    this.configOptions = [];
    this.createdAt = new Date();
  }

  get acpSessionId(): string {
    return toAcpSessionId(this.provider, this.providerSessionId);
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
