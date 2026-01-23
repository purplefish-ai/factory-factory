import Anthropic from '@anthropic-ai/sdk';
import type { AgentType } from '@prisma-gen/client';

/**
 * Agent execution profile configuration
 */
export interface AgentExecutionProfile {
  model: string;
  maxTokens: number;
  temperature: number;
  planMode: boolean;
  disabledTools: string[];
}

/**
 * Configuration for creating a Claude agent
 */
export interface CreateAgentConfig {
  systemPrompt: string;
  tools?: Anthropic.Tool[];
  profile: AgentExecutionProfile;
}

/**
 * Message in the agent conversation
 */
export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string | Anthropic.MessageParam['content'];
}

/**
 * Active agent session
 */
interface AgentSession {
  systemPrompt: string;
  profile: AgentExecutionProfile;
  messages: AgentMessage[];
  tools: Anthropic.Tool[];
}

/**
 * Default agent profiles by agent type
 */
export const AGENT_PROFILES: Record<AgentType, AgentExecutionProfile> = {
  SUPERVISOR: {
    model: process.env.SUPERVISOR_MODEL || 'claude-sonnet-4-5-20250929',
    maxTokens: 8192,
    temperature: 1.0,
    planMode: false,
    disabledTools: [],
  },
  ORCHESTRATOR: {
    model: process.env.ORCHESTRATOR_MODEL || 'claude-sonnet-4-5-20250929',
    maxTokens: 8192,
    temperature: 1.0,
    planMode: false,
    disabledTools: [],
  },
  WORKER: {
    model: process.env.WORKER_MODEL || 'claude-sonnet-4-5-20250929',
    maxTokens: 8192,
    temperature: 1.0,
    planMode: false,
    disabledTools: ['AskUserQuestion'], // Workers should not ask user questions
  },
};

/**
 * Get agent execution profile for a given agent type
 */
export function getProfileForAgentType(type: AgentType): AgentExecutionProfile {
  return AGENT_PROFILES[type];
}

/**
 * Claude SDK client wrapper for agent execution
 */
export class ClaudeClient {
  private client: Anthropic;
  private sessions: Map<string, AgentSession>;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is not set');
    }

    this.client = new Anthropic({ apiKey });
    this.sessions = new Map();
  }

  /**
   * Initialize the Claude client (verify API key works)
   */
  async initialize(): Promise<void> {
    // Test the API key by making a simple request
    try {
      await this.client.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Hello' }],
      });
    } catch (error) {
      throw new Error(
        `Failed to initialize Claude client: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Create a new agent session
   */
  createAgent(agentId: string, config: CreateAgentConfig): void {
    this.sessions.set(agentId, {
      systemPrompt: config.systemPrompt,
      profile: config.profile,
      messages: [],
      tools: config.tools || [],
    });
  }

  /**
   * Send a message to an agent and get response
   */
  async sendMessage(agentId: string, message: string): Promise<Anthropic.Message> {
    const session = this.sessions.get(agentId);
    if (!session) {
      throw new Error(`Agent session not found: ${agentId}`);
    }

    // Add user message to conversation
    session.messages.push({
      role: 'user',
      content: message,
    });

    try {
      // Call Claude API
      const response = await this.client.messages.create({
        model: session.profile.model,
        max_tokens: session.profile.maxTokens,
        temperature: session.profile.temperature,
        system: session.systemPrompt,
        messages: session.messages.map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
        tools: session.tools.length > 0 ? session.tools : undefined,
      });

      // Add assistant response to conversation
      session.messages.push({
        role: 'assistant',
        content: response.content,
      });

      return response;
    } catch (error) {
      throw new Error(
        `Failed to send message to Claude: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Send a tool result back to the agent
   */
  async sendToolResult(
    agentId: string,
    toolUseId: string,
    result: unknown
  ): Promise<Anthropic.Message> {
    const session = this.sessions.get(agentId);
    if (!session) {
      throw new Error(`Agent session not found: ${agentId}`);
    }

    // Add tool result to conversation
    session.messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result' as const,
          tool_use_id: toolUseId,
          content: JSON.stringify(result),
        },
      ],
    });

    try {
      // Get next response from Claude
      const response = await this.client.messages.create({
        model: session.profile.model,
        max_tokens: session.profile.maxTokens,
        temperature: session.profile.temperature,
        system: session.systemPrompt,
        messages: session.messages.map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
        tools: session.tools.length > 0 ? session.tools : undefined,
      });

      // Add assistant response to conversation
      session.messages.push({
        role: 'assistant',
        content: response.content,
      });

      return response;
    } catch (error) {
      throw new Error(
        `Failed to send tool result to Claude: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get the current conversation for an agent
   */
  getConversation(agentId: string): AgentMessage[] {
    const session = this.sessions.get(agentId);
    if (!session) {
      throw new Error(`Agent session not found: ${agentId}`);
    }
    return [...session.messages];
  }

  /**
   * Clear the conversation for an agent
   */
  clearConversation(agentId: string): void {
    const session = this.sessions.get(agentId);
    if (!session) {
      throw new Error(`Agent session not found: ${agentId}`);
    }
    session.messages = [];
  }

  /**
   * Destroy an agent session
   */
  destroyAgent(agentId: string): void {
    this.sessions.delete(agentId);
  }

  /**
   * Check if an agent session exists
   */
  hasAgent(agentId: string): boolean {
    return this.sessions.has(agentId);
  }
}

// Note: This client uses API key authentication.
// For OAuth-based authentication (recommended), use claude-code.client.ts instead.
//
// To use this client, create an instance explicitly:
//   const client = new ClaudeClient();
//   await client.initialize();
//
// The singleton pattern was removed to avoid requiring ANTHROPIC_API_KEY at module load time.
