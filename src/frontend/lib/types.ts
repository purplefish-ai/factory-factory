// Type helpers for tRPC responses that include relations
// These help TypeScript understand the relations that Prisma includes

export interface AgentRelation {
  id: string;
  type: string;
  state: string;
}

export interface EpicRelation {
  id: string;
  title: string;
}

export interface TaskRelation {
  id: string;
  title: string;
}

// Mail with relations
export interface MailWithRelations {
  id: string;
  createdAt: Date;
  isRead: boolean;
  fromAgentId: string | null;
  toAgentId: string | null;
  isForHuman: boolean;
  subject: string;
  body: string;
  readAt: Date | null;
  fromAgent?: AgentRelation | null;
  toAgent?: AgentRelation | null;
}

// Agent with relations
export interface AgentWithRelations {
  id: string;
  type: string;
  state: string;
  tmuxSessionName: string | null;
  lastActiveAt: Date;
  currentEpicId: string | null;
  currentTaskId: string | null;
  currentEpic?: EpicRelation | null;
  assignedTasks?: TaskRelation[];
  isHealthy?: boolean;
  minutesSinceHeartbeat?: number;
}

// Task with relations
export interface TaskWithRelations {
  id: string;
  title: string;
  description: string | null;
  state: string;
  epicId: string;
  assignedAgentId: string | null;
  branchName: string | null;
  worktreePath: string | null;
  prUrl: string | null;
  attempts: number;
  failureReason: string | null;
  createdAt: Date;
  epic?: EpicRelation | null;
  assignedAgent?: AgentRelation | null;
}

// Decision log with relations
export interface DecisionLogWithRelations {
  id: string;
  agentId: string;
  decision: string;
  reasoning: string;
  context: string | null;
  timestamp: Date;
  agent?: AgentRelation | null;
}
