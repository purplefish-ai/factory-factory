import type { ChildProcess } from 'node:child_process';
import type { ClientSideConnection, SessionConfigOption } from '@agentclientprotocol/sdk';

export class AcpProcessHandle {
  readonly connection: ClientSideConnection;
  readonly child: ChildProcess;
  providerSessionId: string;
  agentCapabilities: Record<string, unknown>;
  isPromptInFlight: boolean;
  configOptions: SessionConfigOption[];
  readonly createdAt: Date;

  constructor(params: {
    connection: ClientSideConnection;
    child: ChildProcess;
    providerSessionId: string;
    agentCapabilities: Record<string, unknown>;
  }) {
    this.connection = params.connection;
    this.child = params.child;
    this.providerSessionId = params.providerSessionId;
    this.agentCapabilities = params.agentCapabilities;
    this.isPromptInFlight = false;
    this.configOptions = [];
    this.createdAt = new Date();
  }

  isRunning(): boolean {
    return this.child.exitCode === null && !this.child.killed;
  }

  getPid(): number | undefined {
    return this.child.pid;
  }
}
