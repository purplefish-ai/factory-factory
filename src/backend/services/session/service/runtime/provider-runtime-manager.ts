export type RuntimeCreatedCallback<TClient> = (
  sessionId: string,
  client: TClient,
  context: { workspaceId: string; workingDir: string }
) => void;

export type RuntimeEventHandlers = {
  onSessionId?: (sessionId: string, providerSessionId: string) => Promise<void>;
  onExit?: (sessionId: string, code: number | null) => Promise<void>;
  onError?: (sessionId: string, error: Error) => Promise<void> | void;
};

export interface ProviderRuntimeManager<TClient = unknown, TOptions = unknown> {
  setOnClientCreated(callback: RuntimeCreatedCallback<TClient>): void;
  isStopInProgress(sessionId: string): boolean;
  getOrCreateClient(
    sessionId: string,
    options: TOptions,
    handlers: RuntimeEventHandlers,
    context: { workspaceId: string; workingDir: string }
  ): Promise<TClient>;
  getClient(sessionId: string): TClient | undefined;
  getPendingClient(sessionId: string): Promise<TClient> | undefined;
  stopClient(sessionId: string): Promise<void>;
}
