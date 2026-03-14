import type { StopReason, ToolCallUpdate } from '@agentclientprotocol/sdk';
import type { CodexRpcClient } from './codex-rpc-client';

export type ApprovalPolicy = string;
export type ReasoningEffort = string;
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type UserInputAnswers = Record<string, { answers: string[] }>;

export type ToolUserInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
};

export type CodexModelEntry = {
  id: string;
  displayName: string;
  description: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: Array<{
    reasoningEffort: string;
    description?: string;
  }>;
  inputModalities: string[];
  isDefault: boolean;
};

export type CollaborationModeEntry = {
  mode: string;
  name: string;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  developerInstructions: string | null;
};

export type CodexMcpServerConfig = {
  enabled: boolean;
  args?: string[];
  command?: string;
  env?: Record<string, string>;
  http_headers?: Record<string, string>;
  transport?: 'sse';
  url?: string;
};

export type ToolCallState = {
  toolCallId: string;
  kind: NonNullable<ToolCallUpdate['kind']>;
  title: string;
  locations: Array<{ path: string; line?: number | null }>;
};

export type ActiveTurnState = {
  turnId: string;
  cancelRequested: boolean;
  settled: boolean;
  resolve: (value: StopReason) => void;
};

export type PendingTurnCompletion = {
  stopReason: StopReason;
  errorMessage?: string;
};

export type ExecutionPreset = {
  id: string;
  name: string;
  description?: string;
  approvalPolicy: ApprovalPolicy;
  sandboxMode: SandboxMode;
};

export type AdapterSession = {
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
  activeTurn: ActiveTurnState | null;
  toolCallsByItemId: Map<string, ToolCallState>;
  syntheticallyCompletedToolItemIds: Set<string>;
  reasoningDeltaItemIds: Set<string>;
  planTextByItemId: Map<string, string>;
  planApprovalRequestedByTurnId: Set<string>;
  pendingPlanApprovalsByTurnId: Map<string, number>;
  pendingTurnCompletionsByTurnId: Map<string, PendingTurnCompletion>;
  commandApprovalScopes: Set<string>;
  replayedTurnItemKeys: Set<string>;
};

export type CodexClient = Pick<
  CodexRpcClient,
  'start' | 'stop' | 'request' | 'notify' | 'respondSuccess' | 'respondError'
>;
