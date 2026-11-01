export type AcpProvider = 'CLAUDE' | 'CODEX';

export type PermissionPreset = 'STRICT' | 'RELAXED' | 'YOLO';

/** An opaque server-resolved profile; ACP owns no account lookup or admission policy. */
export interface AcpCodexAccountContext {
  accountId: string;
  homeDir: string;
  sessionsDir: string;
  env: NodeJS.ProcessEnv;
}

export interface AcpMcpServerConfig {
  /** Human-readable name for the MCP server (required by ACP SDK) */
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AcpClientOptions {
  provider: AcpProvider;
  /** Trusted session owner policy; never accepted from a public transport. */
  ownedProcessGroup?: boolean;
  eventLifecycleGeneration?: number;
  /** Server-resolved immutable profile; never accepted directly from clients. */
  codexAccountContext?: AcpCodexAccountContext;
  /** Whether the adapter is serving an active turn or read-only history browsing. */
  purpose?: 'active' | 'browse';
  /** Lifecycle setup must finish before this incarnation accepts prompts. */
  deferPromptReadiness?: boolean;
  workingDir: string;
  /** Optional test hook to override the ACP adapter binary path. */
  adapterBinaryPath?: string;
  model?: string;
  /** User-configured permission preset for this session (STRICT/RELAXED/YOLO). */
  permissionPreset?: PermissionPreset;
  sessionId: string; // FF database session ID for logging
  /** Stored provider session ID for session resume via loadSession */
  resumeProviderSessionId?: string;
  resumePolicy?: 'allow_fallback' | 'require_existing';
  /** MCP servers to register with the agent session */
  mcpServers?: AcpMcpServerConfig[];
}

export interface AcpSessionState {
  providerSessionId: string;
  agentCapabilities: Record<string, unknown>;
  isPromptInFlight: boolean;
}
