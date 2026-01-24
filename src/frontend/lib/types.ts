// Type helpers for tRPC responses that include relations
// These help TypeScript understand the relations that Prisma includes

export interface AgentRelation {
  id: string;
  type: string;
  state: string;
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
