/**
 * Agent Process Adapter
 *
 * Legacy bridge layer for multi-agent orchestration.
 * This module is retained as a stub for server shutdown cleanup.
 * Agent sessions now use AcpRuntimeManager via SessionService.
 */

import { EventEmitter } from 'node:events';
import { createLogger } from '@/backend/services/logger.service';

const logger = createLogger('agent-process-adapter');

// ============================================================================
// Types
// ============================================================================

export type AgentType = 'worker' | 'supervisor' | 'orchestrator';

export interface AgentStartOptions {
  agentId: string;
  workingDir: string;
  systemPrompt?: string;
  model?: string;
  resumeClaudeSessionId?: string;
  allowedTools?: string[];
  agentType: AgentType;
  initialPrompt?: string;
}

export type CliProcessStatus = 'running' | 'idle' | 'exited' | 'not_found';

// Event data types
export interface MessageEventData {
  agentId: string;
  message: unknown;
}

export interface ToolUseEventData {
  agentId: string;
  toolUse: { type: 'tool_use'; tool: string; input: Record<string, unknown>; id: string };
}

export interface ResultEventData {
  agentId: string;
  claudeSessionId: string;
  usage: { input_tokens: number; output_tokens: number };
  totalCostUsd: number;
  durationMs: number;
  numTurns: number;
}

export interface ExitEventData {
  agentId: string;
  code: number | null;
  signal: string | null;
  claudeSessionId: string | null;
}

export interface ErrorEventData {
  agentId: string;
  error: Error;
}

// Type-safe event map for consumers
export interface AgentProcessEvents {
  message: MessageEventData;
  tool_use: ToolUseEventData;
  result: ResultEventData;
  exit: ExitEventData;
  error: ErrorEventData;
}

export interface AgentProcessAdapterEvents {
  message: (data: MessageEventData) => void;
  tool_use: (data: ToolUseEventData) => void;
  result: (data: ResultEventData) => void;
  exit: (data: ExitEventData) => void;
  error: (data: ErrorEventData) => void;
}

// ============================================================================
// Agent Process Adapter (stub -- legacy agent orchestration removed)
// ============================================================================

/**
 * @deprecated Legacy agent process adapter. Agent sessions now use AcpRuntimeManager.
 * Retained as a stub for server shutdown cleanup compatibility.
 */
export class AgentProcessAdapter extends EventEmitter {
  startAgent(_options: AgentStartOptions): never {
    throw new Error(
      'Legacy AgentProcessAdapter.startAgent is no longer supported. Use ACP runtime.'
    );
  }

  stopAgent(_agentId: string): void {
    // no-op
  }

  killAgent(_agentId: string): void {
    // no-op
  }

  sendToAgent(_agentId: string, _message: string): boolean {
    return false;
  }

  sendMessage(agentId: string, message: string): boolean {
    return this.sendToAgent(agentId, message);
  }

  isRunning(_agentId: string): boolean {
    return false;
  }

  getProcessStatus(_agentId: string): CliProcessStatus {
    return 'not_found';
  }

  getClaudeSessionId(_agentId: string): string | null {
    return null;
  }

  getStats(): { total: number; running: number; idle: number; byType: Record<AgentType, number> } {
    return {
      total: 0,
      running: 0,
      idle: 0,
      byType: { worker: 0, supervisor: 0, orchestrator: 0 },
    };
  }

  cleanup(): void {
    logger.debug('AgentProcessAdapter cleanup (no-op -- legacy adapter)');
  }
}

// Singleton instance
export const agentProcessAdapter = new AgentProcessAdapter();
