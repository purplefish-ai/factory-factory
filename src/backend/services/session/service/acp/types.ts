export type AcpProvider = 'CLAUDE' | 'CODEX';

export type PermissionPreset = 'STRICT' | 'RELAXED' | 'YOLO';

export interface AcpClientOptions {
  provider: AcpProvider;
  workingDir: string;
  /** Optional test hook to override the ACP adapter binary path. */
  adapterBinaryPath?: string;
  model?: string;
  systemPrompt?: string;
  /** User-configured permission preset for this session (STRICT/RELAXED/YOLO). */
  permissionPreset?: PermissionPreset;
  sessionId: string; // FF database session ID for logging
  /** Stored provider session ID for session resume via loadSession */
  resumeProviderSessionId?: string;
}

export interface AcpSessionState {
  providerSessionId: string;
  agentCapabilities: Record<string, unknown>;
  isPromptInFlight: boolean;
}
