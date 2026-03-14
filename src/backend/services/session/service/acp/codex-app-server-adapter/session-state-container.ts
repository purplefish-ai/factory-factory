import type {
  AdapterSession,
  ApprovalPolicy,
  CodexMcpServerConfig,
  ReasoningEffort,
} from './adapter-state';

type CreateSessionArgs = {
  sessionId: string;
  threadId: string;
  cwd: string;
  defaults: {
    model: string;
    approvalPolicy: ApprovalPolicy;
    sandboxPolicy: Record<string, unknown>;
    reasoningEffort: ReasoningEffort | null;
    collaborationMode: string;
  };
};

export class CodexAdapterSessionStateContainer {
  readonly sessions = new Map<string, AdapterSession>();
  readonly sessionIdByThreadId = new Map<string, string>();
  readonly mcpServersByThreadId = new Map<string, Record<string, CodexMcpServerConfig>>();
  appliedMcpServerConfigJson = '{}';

  createSession(args: CreateSessionArgs): AdapterSession {
    return {
      sessionId: args.sessionId,
      threadId: args.threadId,
      cwd: args.cwd,
      defaults: {
        model: args.defaults.model,
        approvalPolicy: args.defaults.approvalPolicy,
        sandboxPolicy: args.defaults.sandboxPolicy,
        reasoningEffort: args.defaults.reasoningEffort,
        collaborationMode: args.defaults.collaborationMode,
      },
      activeTurn: null,
      toolCallsByItemId: new Map(),
      syntheticallyCompletedToolItemIds: new Set(),
      reasoningDeltaItemIds: new Set(),
      planTextByItemId: new Map(),
      planApprovalRequestedByTurnId: new Set(),
      pendingPlanApprovalsByTurnId: new Map(),
      pendingTurnCompletionsByTurnId: new Map(),
      commandApprovalScopes: new Set(),
      replayedTurnItemKeys: new Set(),
    };
  }

  registerSession(session: AdapterSession): void {
    this.sessions.set(session.sessionId, session);
    this.sessionIdByThreadId.set(session.threadId, session.sessionId);
  }

  getSession(sessionId: string): AdapterSession | undefined {
    return this.sessions.get(sessionId);
  }

  deleteSession(sessionId: string): AdapterSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }

    this.sessions.delete(sessionId);
    this.sessionIdByThreadId.delete(session.threadId);
    return session;
  }
}
