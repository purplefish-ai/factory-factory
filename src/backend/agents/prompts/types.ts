/**
 * Shared types for prompt building
 */

/**
 * Base context fields shared by all agent types
 */
export interface BaseAgentContext {
  agentId: string;
  backendUrl: string;
}

/**
 * Orchestrator-specific context
 */
export interface OrchestratorContext extends BaseAgentContext {
  // Orchestrator has minimal context - just monitors the system
}

/**
 * Supervisor-specific context
 */
export interface SupervisorContext extends BaseAgentContext {
  taskId: string;
  taskTitle: string;
  taskDescription: string;
  taskBranchName: string;
  worktreePath: string;
}

/**
 * Worker-specific context
 */
export interface WorkerContext extends BaseAgentContext {
  taskId: string;
  taskTitle: string;
  taskDescription: string;
  parentTaskTitle: string;
  parentTaskBranchName: string;
  worktreePath: string;
  branchName: string;
  supervisorAgentId: string;
}

/**
 * Tool definition for generating curl examples
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputExample?: Record<string, unknown>;
  inputComments?: string[];
}

/**
 * Category of tools for grouping in the prompt
 */
export interface ToolCategory {
  name: string;
  tools: ToolDefinition[];
}

/**
 * Guidelines configuration for DO/DON'T sections
 */
export interface GuidelinesConfig {
  dos: string[];
  donts: string[];
}

/**
 * Additional field for context footer
 */
export interface ContextField {
  label: string;
  value: string;
}

export type AgentType = 'orchestrator' | 'supervisor' | 'worker';
