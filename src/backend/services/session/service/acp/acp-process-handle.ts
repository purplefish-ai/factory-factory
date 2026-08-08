import type { ChildProcess } from 'node:child_process';
import type { ClientSideConnection, SessionConfigOption } from '@agentclientprotocol/sdk';
import {
  SUBAGENTS_CAPABILITY_META_KEY,
  type SubagentBrowseCapability,
  subagentBrowseCapabilitySchema,
} from '@/shared/acp-protocol/subagents';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class AcpProcessHandle {
  readonly connection: ClientSideConnection;
  readonly child: ChildProcess;
  readonly provider: string;
  providerSessionId: string;
  agentCapabilities: Record<string, unknown>;
  isPromptInFlight: boolean;
  configOptions: SessionConfigOption[];
  readonly createdAt: Date;

  constructor(params: {
    connection: ClientSideConnection;
    child: ChildProcess;
    provider: string;
    providerSessionId: string;
    agentCapabilities: Record<string, unknown>;
  }) {
    this.connection = params.connection;
    this.child = params.child;
    this.provider = params.provider;
    this.providerSessionId = params.providerSessionId;
    this.agentCapabilities = params.agentCapabilities;
    this.isPromptInFlight = false;
    this.configOptions = [];
    this.createdAt = new Date();
  }

  supportsImages(): boolean {
    const caps = this.agentCapabilities?.promptCapabilities;
    return (
      typeof caps === 'object' && caps !== null && (caps as Record<string, unknown>).image === true
    );
  }

  getSubagentBrowseCapability(): SubagentBrowseCapability | null {
    const meta = this.agentCapabilities._meta;
    if (!isRecord(meta)) {
      return null;
    }

    const parsed = subagentBrowseCapabilitySchema.safeParse(meta[SUBAGENTS_CAPABILITY_META_KEY]);
    return parsed.success ? parsed.data : null;
  }

  isRunning(): boolean {
    return this.child.exitCode === null && !this.child.killed;
  }

  getPid(): number | undefined {
    return this.child.pid;
  }
}
