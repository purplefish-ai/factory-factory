export type AcpProvider = 'CLAUDE' | 'CODEX';

export interface AcpClientOptions {
  provider: AcpProvider;
  workingDir: string;
  model?: string;
  systemPrompt?: string;
  permissionMode?: string;
  sessionId: string; // FF database session ID for logging
}

export interface AcpSessionState {
  providerSessionId: string;
  agentCapabilities: Record<string, unknown>;
  isPromptInFlight: boolean;
}
