export type AcpProvider = 'CLAUDE' | 'CODEX' | 'OPENCODE';

export interface AcpClientOptions {
  provider: AcpProvider;
  workingDir: string;
  /** Optional test hook to override the ACP adapter binary path. */
  adapterBinaryPath?: string;
  model?: string;
  systemPrompt?: string;
  permissionMode?: string;
  sessionId: string; // FF database session ID for logging
  /** Stored provider session ID for session resume via loadSession */
  resumeProviderSessionId?: string;
}

export interface AcpSessionState {
  providerSessionId: string;
  agentCapabilities: Record<string, unknown>;
  isPromptInFlight: boolean;
}
