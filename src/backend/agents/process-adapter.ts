/**
 * Agent Process Adapter
 *
 * Bridge layer between agent IDs and ClaudeClient instances.
 * Handles tool execution, heartbeat updates, and process lifecycle management.
 */

import { EventEmitter } from 'node:events';
import {
  ClaudeClient,
  type ClaudeClientOptions,
  type ClaudeJson,
  type ExitResult,
  type ResultMessage,
  type StreamEventMessage,
  type ToolUseContent,
} from '../claude/index';
import { executeMcpTool } from '../routers/mcp/server';
import type { McpToolResponse } from '../routers/mcp/types';
import { createLogger } from '../services/logger.service';

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
  message: ClaudeJson;
}

export interface ToolUseEventData {
  agentId: string;
  toolUse: { type: 'tool_use'; tool: string; input: Record<string, unknown>; id: string };
}

export interface ToolResultEventData {
  agentId: string;
  toolResult: {
    type: 'tool_result';
    tool_use_id: string;
    result: unknown;
    is_error: boolean;
  };
  mcpResponse: McpToolResponse;
}

export interface ResultEventData {
  agentId: string;
  /** Claude CLI session ID from the result message (used for history in ~/.claude/projects/) */
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
  /** Claude CLI session ID (used for history in ~/.claude/projects/) */
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
  tool_result: ToolResultEventData;
  result: ResultEventData;
  exit: ExitEventData;
  error: ErrorEventData;
}

export interface AgentProcessAdapterEvents {
  message: (data: MessageEventData) => void;
  tool_use: (data: ToolUseEventData) => void;
  tool_result: (data: ToolResultEventData) => void;
  result: (data: ResultEventData) => void;
  exit: (data: ExitEventData) => void;
  error: (data: ErrorEventData) => void;
}

// ============================================================================
// Agent Process Adapter
// ============================================================================

/**
 * AgentProcessAdapter bridges agent IDs with ClaudeClient instances.
 *
 * Responsibilities:
 * - Map agentId to ClaudeClient instances
 * - Listen for messages and re-emit with agentId
 * - Handle tool_use messages by calling executeMcpTool()
 * - Send tool results using proper tool_result content blocks
 * - Handle process exit and update agent status
 */
export class AgentProcessAdapter extends EventEmitter {
  // agentId -> ClaudeClient mapping
  private agents = new Map<string, ClaudeClient>();
  // Track agent types for tool permissions
  private agentTypes = new Map<string, AgentType>();

  /**
   * Set up listeners on a ClaudeClient instance
   */
  private setupClientListeners(agentId: string, client: ClaudeClient): void {
    // Handle tool use events
    client.on('tool_use', async (toolUse: ToolUseContent) => {
      logger.info('Handling tool use', { agentId, tool: toolUse.name, toolId: toolUse.id });
      this.emit('tool_use', {
        agentId,
        toolUse: { type: 'tool_use', tool: toolUse.name, input: toolUse.input, id: toolUse.id },
      });
      await this.executeToolAndRespond(agentId, client, toolUse);
    });

    // Handle message events (for UI forwarding)
    client.on('message', (msg) => {
      this.emit('message', { agentId, message: msg as ClaudeJson });
    });

    // Handle stream events (for real-time UI)
    client.on('stream', (event: StreamEventMessage) => {
      this.emit('message', { agentId, message: event });
    });

    // Handle result events
    client.on('result', (result: ResultMessage) => {
      this.emit('result', {
        agentId,
        claudeSessionId: client.getClaudeSessionId() || result.session_id || result.sessionId || '',
        usage: {
          input_tokens: result.usage?.input_tokens || 0,
          output_tokens: result.usage?.output_tokens || 0,
        },
        totalCostUsd: 0, // Not provided in new format
        durationMs: result.durationMs || result.duration_ms || 0,
        numTurns: result.numTurns || result.num_turns || 0,
      });
    });

    // Handle exit events
    client.on('exit', (exitResult: ExitResult) => {
      this.emit('exit', {
        agentId,
        code: exitResult.code,
        signal: exitResult.signal,
        claudeSessionId: exitResult.claudeSessionId,
      });

      this.cleanupAgent(agentId);
    });

    // Handle errors
    client.on('error', (error: Error) => {
      logger.error('Agent error', error, { agentId });
      this.emit('error', { agentId, error });
    });
  }

  /**
   * Execute MCP tool and send result back to Claude using proper tool_result content block
   */
  private async executeToolAndRespond(
    agentId: string,
    client: ClaudeClient,
    toolUse: ToolUseContent
  ): Promise<void> {
    let mcpResponse: McpToolResponse;

    try {
      // Execute the tool via MCP server
      mcpResponse = await executeMcpTool(agentId, toolUse.name, toolUse.input);

      logger.info('Tool execution completed', {
        agentId,
        tool: toolUse.name,
        toolId: toolUse.id,
        success: mcpResponse.success,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Tool execution failed', err, {
        agentId,
        tool: toolUse.name,
        toolId: toolUse.id,
      });

      mcpResponse = {
        success: false,
        error: {
          code: 'EXECUTION_ERROR',
          message: err.message,
          details: { stack: err.stack },
        },
        timestamp: new Date(),
      };
    }

    // Send result using proper tool_result content block
    const resultData = mcpResponse.success
      ? (mcpResponse.data as string | object)
      : { error: mcpResponse.error.message };
    client.sendToolResult(toolUse.id, resultData, !mcpResponse.success);

    // Emit tool_result event
    this.emit('tool_result', {
      agentId,
      toolResult: {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        result: mcpResponse.success ? mcpResponse.data : { error: mcpResponse.error.message },
        is_error: !mcpResponse.success,
      },
      mcpResponse,
    });
  }

  /**
   * Clean up agent mappings
   */
  private cleanupAgent(agentId: string): void {
    this.agents.delete(agentId);
    this.agentTypes.delete(agentId);
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Start a Claude CLI process for an agent
   *
   * @throws Error if agent is already running
   */
  async startAgent(options: AgentStartOptions): Promise<void> {
    const { agentId } = options;

    // Check if already running - throw error instead of silently returning
    if (this.agents.has(agentId)) {
      throw new Error(`Agent ${agentId} is already running`);
    }

    this.agentTypes.set(agentId, options.agentType);

    logger.info('Starting agent process', {
      agentId,
      workingDir: options.workingDir,
      agentType: options.agentType,
      resuming: !!options.resumeClaudeSessionId,
    });

    const clientOptions: ClaudeClientOptions = {
      workingDir: options.workingDir,
      systemPrompt: options.systemPrompt,
      model: options.model,
      resumeClaudeSessionId: options.resumeClaudeSessionId,
      permissionMode: 'bypassPermissions', // Auto-approve for agents
      disallowedTools: options.allowedTools ? undefined : [], // Configure as needed
      initialPrompt: options.initialPrompt,
    };

    try {
      const client = await ClaudeClient.create(clientOptions);
      this.agents.set(agentId, client);
      this.setupClientListeners(agentId, client);
    } catch (error) {
      // Clean up agentTypes on failure
      this.agentTypes.delete(agentId);
      throw error;
    }
  }

  /**
   * Stop an agent gracefully
   */
  async stopAgent(agentId: string): Promise<void> {
    const client = this.agents.get(agentId);
    if (!client) {
      logger.warn('Cannot stop agent - not found', { agentId });
      return;
    }

    logger.info('Stopping agent gracefully', { agentId });

    await client.stop();

    // Clean up mappings
    this.cleanupAgent(agentId);
  }

  /**
   * Kill an agent immediately
   */
  killAgent(agentId: string): void {
    const client = this.agents.get(agentId);
    if (!client) {
      logger.warn('Cannot kill agent - not found', { agentId });
      return;
    }

    logger.info('Killing agent immediately', { agentId });

    client.kill();

    // Clean up mappings immediately
    this.cleanupAgent(agentId);
  }

  /**
   * Send a message to an agent
   */
  sendToAgent(agentId: string, message: string): boolean {
    const client = this.agents.get(agentId);
    if (!client) {
      logger.warn('Cannot send message - agent not found', { agentId });
      return false;
    }

    try {
      client.sendMessage(message);
      return true;
    } catch (error) {
      logger.error('Failed to send message to agent', {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Send a message to an agent (alias for sendToAgent)
   */
  sendMessage(agentId: string, message: string): boolean {
    return this.sendToAgent(agentId, message);
  }

  /**
   * Check if an agent process is running
   */
  isRunning(agentId: string): boolean {
    const client = this.agents.get(agentId);
    if (!client) {
      return false;
    }
    return client.isRunning();
  }

  /**
   * Get the status of an agent process
   */
  getProcessStatus(agentId: string): CliProcessStatus {
    const client = this.agents.get(agentId);
    if (!client) {
      return 'not_found';
    }
    return client.isRunning() ? 'running' : 'exited';
  }

  /**
   * Get the Claude session ID for an agent (for resume functionality)
   */
  getClaudeSessionId(agentId: string): string | null {
    const client = this.agents.get(agentId);
    if (!client) {
      return null;
    }
    return client.getClaudeSessionId();
  }

  /**
   * Get statistics about running agents
   */
  getStats(): { total: number; running: number; idle: number; byType: Record<AgentType, number> } {
    const byType: Record<AgentType, number> = {
      worker: 0,
      supervisor: 0,
      orchestrator: 0,
    };

    let running = 0;
    let idle = 0;

    for (const [agentId, client] of this.agents) {
      const type = this.agentTypes.get(agentId);
      if (type && client.isRunning()) {
        byType[type]++;
        running++;
      } else {
        idle++;
      }
    }

    return {
      total: this.agents.size,
      running,
      idle,
      byType,
    };
  }

  /**
   * Clean up all agent processes
   */
  cleanup(): void {
    logger.info('Cleaning up all agent processes');

    for (const agentId of this.agents.keys()) {
      this.killAgent(agentId);
    }
  }
}

// Singleton instance
export const agentProcessAdapter = new AgentProcessAdapter();
