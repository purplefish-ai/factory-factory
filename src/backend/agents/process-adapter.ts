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
} from '../claude/index.js';
import { agentAccessor } from '../resource_accessors/index.js';
import { executeMcpTool } from '../routers/mcp/server.js';
import type { McpToolResponse } from '../routers/mcp/types.js';
import { registerAgentStatusProvider } from '../services/agent-status.service.js';
import { createLogger } from '../services/logger.service.js';

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
 * AgentProcessAdapter bridges agent IDs with ClaudeClient instances.
 *
 * Responsibilities:
 * - Map agentId to ClaudeClient instances
 * - Listen for messages and re-emit with agentId
 * - Handle tool_use messages by calling executeMcpTool()
 * - Send tool results using proper tool_result content blocks
 * - Update Agent.lastHeartbeat on message activity
 * - Handle process exit and update agent status
 * - Sync process state to database for crash recovery
 * - Clean up orphan processes on startup
 * - Support session resume for crash recovery
 */
export class AgentProcessAdapter extends EventEmitter {
  // agentId -> ClaudeClient mapping
  private agents = new Map<string, ClaudeClient>();
  // Track agent types for tool permissions
  private agentTypes = new Map<string, AgentType>();
  // Flag to prevent multiple orphan cleanup runs
  private orphanCleanupDone = false;

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
    client.on('message', async (msg) => {
      await this.updateHeartbeat(agentId);
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
        sessionId: client.getSessionId() || '',
        claudeSessionId: result.session_id || result.sessionId || '',
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
    client.on('exit', async (exitResult: ExitResult) => {
      this.emit('exit', {
        agentId,
        code: exitResult.code,
        signal: exitResult.signal,
        sessionId: exitResult.sessionId,
      });

      // Sync exit status to database
      try {
        const status = exitResult.signal ? 'KILLED' : 'EXITED';
        await agentAccessor.updateCliProcess(agentId, {
          cliProcessStatus: status,
          cliProcessExitCode: exitResult.code,
          cliProcessPid: null, // Clear PID on exit
        });
      } catch (error) {
        logger.warn('Failed to update process exit status in database', {
          agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

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
      resuming: !!options.resumeSessionId,
    });

    // Mark as starting in database
    try {
      await agentAccessor.updateCliProcess(agentId, {
        cliProcessStatus: 'STARTING',
        cliProcessStartedAt: new Date(),
      });
    } catch (error) {
      logger.warn('Failed to update starting status in database', {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const clientOptions: ClaudeClientOptions = {
      workingDir: options.workingDir,
      systemPrompt: options.systemPrompt,
      model: options.model,
      resumeSessionId: options.resumeSessionId,
      permissionMode: 'bypassPermissions', // Auto-approve for agents
      disallowedTools: options.allowedTools ? undefined : [], // Configure as needed
      initialPrompt: options.initialPrompt,
    };

    try {
      const client = await ClaudeClient.create(clientOptions);
      this.agents.set(agentId, client);
      this.setupClientListeners(agentId, client);

      // Sync running status and PID to database
      const pid = client.getPid();
      try {
        await agentAccessor.updateCliProcess(agentId, {
          cliProcessStatus: 'RUNNING',
          cliProcessPid: pid ?? null,
        });
      } catch (error) {
        logger.warn('Failed to update running status in database', {
          agentId,
          pid,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      await this.updateHeartbeat(agentId);
    } catch (error) {
      // Clean up agentTypes on failure
      this.agentTypes.delete(agentId);

      // Mark as crashed in database
      try {
        await agentAccessor.updateCliProcess(agentId, {
          cliProcessStatus: 'CRASHED',
          cliProcessPid: null,
        });
      } catch (dbError) {
        logger.warn('Failed to update crashed status in database', {
          agentId,
          error: dbError instanceof Error ? dbError.message : String(dbError),
        });
      }

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
    return client.getSessionId();
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

  /**
   * Clean up orphan processes from previous crashes.
   * Called on startup to kill any processes that were marked as running
   * but whose parent process crashed.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: orphan cleanup requires multiple error handling branches
  async cleanupOrphanProcesses(): Promise<void> {
    if (this.orphanCleanupDone) {
      logger.debug('Orphan cleanup already done, skipping');
      return;
    }
    this.orphanCleanupDone = true;

    logger.info('Scanning for orphan CLI processes');

    try {
      // Find processes marked as RUNNING or STARTING in database
      const orphans = await agentAccessor.findRunningProcesses();

      if (orphans.length === 0) {
        logger.info('No orphan processes found');
        return;
      }

      logger.info('Found potential orphan processes', { count: orphans.length });

      for (const agent of orphans) {
        const pid = agent.cliProcessPid;

        if (pid) {
          try {
            // Check if process is still alive
            process.kill(pid, 0);
            // Process is alive - kill it
            logger.info('Killing orphan process', { agentId: agent.id, pid });
            try {
              // Try to kill process group first
              process.kill(-pid, 'SIGKILL');
            } catch {
              // Fallback to killing single process
              try {
                process.kill(pid, 'SIGKILL');
              } catch {
                // Process may have died between check and kill
              }
            }
          } catch {
            // Process not found - already dead
            logger.debug('Orphan process already dead', { agentId: agent.id, pid });
          }
        }

        // Mark as crashed in database
        try {
          await agentAccessor.updateCliProcess(agent.id, {
            cliProcessStatus: 'CRASHED',
            cliProcessPid: null,
          });
          logger.info('Marked orphan as crashed', { agentId: agent.id });
        } catch (error) {
          logger.warn('Failed to update orphan status', {
            agentId: agent.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      logger.info('Orphan cleanup completed', { cleaned: orphans.length });
    } catch (error) {
      logger.error('Failed to cleanup orphan processes', error as Error);
    }
  }
}

// Singleton instance
export const agentProcessAdapter = new AgentProcessAdapter();

// Register status provider for services to query agent status
registerAgentStatusProvider(
  (agentId: string) => agentProcessAdapter.isRunning(agentId),
  (agentId: string) => agentProcessAdapter.getClaudeSessionId(agentId)
);
