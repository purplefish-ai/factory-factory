/**
 * Types for the ToolInterceptor system.
 *
 * Interceptors observe tool events and trigger side effects.
 * They are fire-and-forget: errors are logged but don't block tool execution.
 */

/**
 * Context provided to interceptors for each tool event.
 */
export interface InterceptorContext {
  sessionId: string;
  workspaceId: string;
  workingDir: string;
  timestamp: Date;
}

/**
 * Tool event data passed to interceptors.
 */
export interface ToolEvent {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  output?: {
    content: string;
    isError: boolean;
  };
}

/**
 * Interface for tool interceptors.
 *
 * Interceptors declare which tools they care about and receive events
 * when those tools start or complete. Handlers are async and fire-and-forget.
 */
export interface ToolInterceptor {
  /** Unique name for this interceptor (used for logging) */
  readonly name: string;

  /** Tools to intercept: array of tool names or '*' for all tools */
  readonly tools: string[] | '*';

  /** Optional lifecycle hook called during server startup */
  start?(): void | Promise<void>;

  /** Optional lifecycle hook called during server shutdown */
  stop?(): void | Promise<void>;

  /** Called when a tool starts (before execution) */
  onToolStart?(event: ToolEvent, context: InterceptorContext): Promise<void>;

  /** Called when a tool completes (after execution) */
  onToolComplete?(event: ToolEvent, context: InterceptorContext): Promise<void>;
}
