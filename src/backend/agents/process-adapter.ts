/**
 * Agent Process Adapter
 *
 * Bridge layer between agent IDs and ClaudeStreamingClient sessions.
 * Handles tool execution, heartbeat updates, and process lifecycle management.
 */

import { EventEmitter } from 'node:events';
import {
  type ClaudeOutputMessage,
  type ClaudeStreamOptions,
  claudeStreamingClient,
  type ToolResultMessage,
  type ToolUseMessage,
} from '../clients/claude-streaming.client.js';
import { agentAccessor } from '../resource_accessors/index.js';
import { executeMcpTool } from '../routers/mcp/server.js';
import type { McpToolResponse } from '../routers/mcp/types.js';
import { createLogger } from '../services/index.js';

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
  resumeSessionId?: string;
  allowedTools?: string[];
  agentType: AgentType;
  initialPrompt?: string;
}

export type CliProcessStatus = 'running' | 'idle' | 'exited' | 'not_found';

// Event data types
export interface MessageEventData {
  agentId: string;
  message: ClaudeOutputMessage;
}

export interface ToolUseEventData {
  agentId: string;
  toolUse: ToolUseMessage;
}

export interface ToolResultEventData {
  agentId: string;
  toolResult: ToolResultMessage;
  mcpResponse: McpToolResponse;
}

export interface ResultEventData {
  agentId: string;
  sessionId: string;
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
  sessionId: string | null;
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
 * AgentProcessAdapter bridges agent IDs with ClaudeStreamingClient sessions.
 *
 * Responsibilities:
 * - Map agentId to sessionId for ClaudeStreamingClient
 * - Listen for messages and re-emit with agentId
 * - Handle tool_use messages by calling executeMcpTool()
 * - Update Agent.lastHeartbeat on message activity
 * - Handle process exit and update agent status
 * - Support session resume for crash recovery
 */
export class AgentProcessAdapter extends EventEmitter {
  // agentId -> sessionId mapping
  private agentToSession = new Map<string, string>();
  // sessionId -> agentId reverse mapping
  private sessionToAgent = new Map<string, string>();
  // Track pending tool executions
  private pendingToolExecutions = new Map<string, Promise<void>>();
  // Track agent types for tool permissions
  private agentTypes = new Map<string, AgentType>();

  constructor() {
    super();
    this.setupClientListeners();
  }

  /**
   * Set up listeners on the ClaudeStreamingClient singleton
   */
  private setupClientListeners(): void {
    // Handle incoming messages from Claude
    claudeStreamingClient.on('message', async (data) => {
      const agentId = this.sessionToAgent.get(data.sessionId);
      if (!agentId) {
        logger.warn('Received message for unknown session', { sessionId: data.sessionId });
        return;
      }

      // Update heartbeat on any message
      await this.updateHeartbeat(agentId);

      // Re-emit with agentId
      this.emit('message', { agentId, message: data.message });

      // Handle specific message types
      await this.handleMessage(agentId, data.message);
    });

    // Handle process exit
    claudeStreamingClient.on('exit', (data) => {
      const agentId = this.sessionToAgent.get(data.sessionId);
      if (!agentId) {
        return;
      }

      logger.info('Agent process exited', {
        agentId,
        code: data.code,
        signal: data.signal,
        claudeSessionId: data.claudeSessionId,
      });

      // Emit exit event
      this.emit('exit', {
        agentId,
        code: data.code,
        signal: data.signal,
        sessionId: data.claudeSessionId,
      });

      // Clean up mappings
      this.cleanupAgent(agentId);
    });

    // Handle errors
    claudeStreamingClient.on('error', (data) => {
      const agentId = this.sessionToAgent.get(data.sessionId);
      if (!agentId) {
        return;
      }

      logger.error('Agent process error', data.error, { agentId });
      this.emit('error', { agentId, error: data.error });
    });
  }

  /**
   * Handle individual messages based on type
   */
  private async handleMessage(agentId: string, message: ClaudeOutputMessage): Promise<void> {
    switch (message.type) {
      case 'tool_use':
        await this.handleToolUse(agentId, message as ToolUseMessage);
        break;

      case 'tool_result':
        // Tool results from Claude CLI (when it executes its own tools)
        // We just emit this for visibility
        this.emit('tool_result', {
          agentId,
          toolResult: message as ToolResultMessage,
          mcpResponse: { success: true, data: null, timestamp: new Date() },
        });
        break;

      case 'result':
        // Conversation turn completed
        this.emit('result', {
          agentId,
          sessionId: this.agentToSession.get(agentId) || '',
          claudeSessionId: message.session_id,
          usage: message.usage,
          totalCostUsd: message.total_cost_usd,
          durationMs: message.duration_ms,
          numTurns: message.num_turns,
        });
        break;

      case 'error':
        logger.error('Claude error message', {
          agentId,
          error: message.error,
          details: message.details,
        });
        break;

      default:
        // Other message types (assistant, system, content_block_delta) are passed through
        break;
    }
  }

  /**
   * Handle tool_use messages from Claude
   */
  private async handleToolUse(agentId: string, toolUse: ToolUseMessage): Promise<void> {
    logger.info('Handling tool use', {
      agentId,
      tool: toolUse.tool,
      toolId: toolUse.id,
    });

    // Emit tool_use event
    this.emit('tool_use', { agentId, toolUse });

    // Execute the MCP tool
    const executionKey = `${agentId}:${toolUse.id}`;
    const execution = this.executeToolAndRespond(agentId, toolUse);
    this.pendingToolExecutions.set(executionKey, execution);

    try {
      await execution;
    } finally {
      this.pendingToolExecutions.delete(executionKey);
    }
  }

  /**
   * Execute MCP tool and send result back to Claude
   */
  private async executeToolAndRespond(agentId: string, toolUse: ToolUseMessage): Promise<void> {
    let mcpResponse: McpToolResponse;

    try {
      // Execute the tool via MCP server
      mcpResponse = await executeMcpTool(agentId, toolUse.tool, toolUse.input);

      logger.info('Tool execution completed', {
        agentId,
        tool: toolUse.tool,
        toolId: toolUse.id,
        success: mcpResponse.success,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Tool execution failed', err, {
        agentId,
        tool: toolUse.tool,
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

    // Create tool result message
    const toolResult: ToolResultMessage = {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      result: mcpResponse.success
        ? (mcpResponse.data as string | Record<string, unknown>)
        : { error: mcpResponse.error.message },
      is_error: !mcpResponse.success,
    };

    // Emit tool_result event
    this.emit('tool_result', { agentId, toolResult, mcpResponse });

    // Send result back to Claude
    // Format as a message since Claude CLI expects user messages
    const resultText = mcpResponse.success
      ? `Tool ${toolUse.tool} result:\n${JSON.stringify(mcpResponse.data, null, 2)}`
      : `Tool ${toolUse.tool} error:\n${mcpResponse.error.message}`;

    this.sendToAgent(agentId, resultText);
  }

  /**
   * Update agent heartbeat
   */
  private async updateHeartbeat(agentId: string): Promise<void> {
    try {
      await agentAccessor.updateHeartbeat(agentId);
    } catch (error) {
      logger.warn('Failed to update heartbeat', {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Clean up agent mappings
   */
  private cleanupAgent(agentId: string): void {
    const sessionId = this.agentToSession.get(agentId);
    if (sessionId) {
      this.sessionToAgent.delete(sessionId);
    }
    this.agentToSession.delete(agentId);
    this.agentTypes.delete(agentId);
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Start a Claude CLI process for an agent
   */
  async startAgent(options: AgentStartOptions): Promise<void> {
    const { agentId } = options;

    // Check if already running
    if (this.isRunning(agentId)) {
      logger.warn('Agent already running', { agentId });
      return;
    }

    // Use agentId as sessionId for simplicity
    const sessionId = agentId;

    // Store mappings
    this.agentToSession.set(agentId, sessionId);
    this.sessionToAgent.set(sessionId, agentId);
    this.agentTypes.set(agentId, options.agentType);

    // Build stream options
    const streamOptions: ClaudeStreamOptions = {
      sessionId,
      workingDir: options.workingDir,
      systemPrompt: options.systemPrompt,
      model: options.model,
      resumeSessionId: options.resumeSessionId,
      allowedTools: options.allowedTools,
      initialPrompt: options.initialPrompt,
      skipPermissions: true, // Default for POC
    };

    logger.info('Starting agent process', {
      agentId,
      sessionId,
      workingDir: options.workingDir,
      agentType: options.agentType,
      resuming: !!options.resumeSessionId,
    });

    // Start the Claude process
    claudeStreamingClient.startProcess(streamOptions);

    // Update initial heartbeat
    await this.updateHeartbeat(agentId);
  }

  /**
   * Stop an agent gracefully with SIGTERM
   */
  async stopAgent(agentId: string): Promise<void> {
    const sessionId = this.agentToSession.get(agentId);
    if (!sessionId) {
      logger.warn('Cannot stop agent - not found', { agentId });
      return;
    }

    logger.info('Stopping agent gracefully', { agentId, sessionId });

    // Wait for pending tool executions to complete (with timeout)
    const pendingExecutions = Array.from(this.pendingToolExecutions.entries())
      .filter(([key]) => key.startsWith(`${agentId}:`))
      .map(([, promise]) => promise);

    if (pendingExecutions.length > 0) {
      logger.info('Waiting for pending tool executions', {
        agentId,
        count: pendingExecutions.length,
      });

      await Promise.race([
        Promise.all(pendingExecutions),
        new Promise((resolve) => setTimeout(resolve, 5000)), // 5 second timeout
      ]);
    }

    // Kill the process (ClaudeStreamingClient.killProcess sends SIGTERM)
    claudeStreamingClient.killProcess(sessionId);

    // Clean up mappings
    this.cleanupAgent(agentId);
  }

  /**
   * Kill an agent immediately with SIGKILL
   */
  killAgent(agentId: string): void {
    const sessionId = this.agentToSession.get(agentId);
    if (!sessionId) {
      logger.warn('Cannot kill agent - not found', { agentId });
      return;
    }

    logger.info('Killing agent immediately', { agentId, sessionId });

    // Note: ClaudeStreamingClient.killProcess sends SIGTERM
    // For a true SIGKILL, we'd need to enhance ClaudeStreamingClient
    // For now, we use the same method
    claudeStreamingClient.killProcess(sessionId);

    // Clean up mappings immediately
    this.cleanupAgent(agentId);
  }

  /**
   * Send a message to an agent
   */
  sendToAgent(agentId: string, message: string): boolean {
    const sessionId = this.agentToSession.get(agentId);
    if (!sessionId) {
      logger.warn('Cannot send message - agent not found', { agentId });
      return false;
    }

    return claudeStreamingClient.sendMessage(sessionId, message);
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
    const sessionId = this.agentToSession.get(agentId);
    if (!sessionId) {
      return false;
    }
    return claudeStreamingClient.isRunning(sessionId);
  }

  /**
   * Get the status of an agent process
   */
  getProcessStatus(agentId: string): CliProcessStatus {
    const sessionId = this.agentToSession.get(agentId);
    if (!sessionId) {
      return 'not_found';
    }
    return claudeStreamingClient.getStatus(sessionId);
  }

  /**
   * Get the Claude session ID for an agent (for resume functionality)
   */
  getClaudeSessionId(agentId: string): string | null {
    const sessionId = this.agentToSession.get(agentId);
    if (!sessionId) {
      return null;
    }
    return claudeStreamingClient.getClaudeSessionId(sessionId);
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

    for (const [agentId, type] of this.agentTypes) {
      if (this.isRunning(agentId)) {
        byType[type]++;
      }
    }

    const stats = claudeStreamingClient.getStats();
    return {
      total: stats.total,
      running: stats.running,
      idle: stats.idle,
      byType,
    };
  }

  /**
   * Clean up all agent processes
   */
  cleanup(): void {
    logger.info('Cleaning up all agent processes');

    for (const agentId of this.agentToSession.keys()) {
      this.killAgent(agentId);
    }

    claudeStreamingClient.cleanupAll();
  }
}

// Singleton instance
export const agentProcessAdapter = new AgentProcessAdapter();
