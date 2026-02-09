/**
 * TestSession - A wrapper for running Claude CLI sessions in integration tests.
 *
 * Provides a high-level API for sending messages, waiting for responses,
 * and verifying tool usage in integration tests.
 */

import { ClaudeProcess, type ClaudeProcessOptions } from '@/backend/claude/process';
import type {
  AssistantMessage,
  ClaudeContentItem,
  ClaudeJson,
  ResultMessage,
  ToolUseContent,
} from '@/backend/claude/types';

/**
 * Options for creating a test session.
 */
export interface TestSessionOptions {
  /** Model to use (default: sonnet) */
  model?: 'haiku' | 'sonnet' | 'opus' | string;
  /** Working directory for the session */
  workspacePath: string;
  /** Resume a previous session by Claude session ID */
  resumeSessionId?: string;
}

/**
 * Options for waiting operations.
 */
export interface WaitOptions {
  /** Timeout in milliseconds (default: 60000) */
  timeout?: number;
}

/**
 * Options for waiting for a specific tool use.
 */
export interface WaitForToolOptions extends WaitOptions {
  /** Tool name to wait for (e.g., 'Read', 'Write', 'Bash') */
  name?: string;
}

/**
 * Represents a message received from Claude.
 */
export interface ReceivedMessage {
  type: 'assistant' | 'user';
  content: string;
  toolUses: ToolUseContent[];
  raw: ClaudeJson;
}

/**
 * Represents a tool use event.
 */
export interface ToolUseEvent {
  id: string;
  name: string;
  input: Record<string, unknown>;
  raw: ToolUseContent;
}

/**
 * Helper to extract content items from a message content field.
 * The content can be either a string or an array of content items.
 */
function getContentItems(content: string | ClaudeContentItem[]): ClaudeContentItem[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return content;
}

/**
 * Extract text content and tool uses from an assistant message.
 */
function extractMessageContent(msg: AssistantMessage): {
  textContent: string;
  toolUses: ToolUseContent[];
} {
  const contentItems = getContentItems(msg.message.content);

  const textContent = contentItems
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('');

  const toolUses = contentItems.filter((c): c is ToolUseContent => c.type === 'tool_use');

  return { textContent, toolUses };
}

/**
 * Find a tool use in an assistant message that matches the given name.
 */
function findToolUseInMessage(msg: AssistantMessage, name?: string): ToolUseEvent | null {
  const contentItems = getContentItems(msg.message.content);

  for (const content of contentItems) {
    if (content.type === 'tool_use') {
      const toolUseContent = content as ToolUseContent;
      if (!name || toolUseContent.name === name) {
        return {
          id: toolUseContent.id,
          name: toolUseContent.name,
          input: toolUseContent.input,
          raw: toolUseContent,
        };
      }
    }
  }

  return null;
}

/**
 * TestSession provides a high-level interface for running Claude CLI sessions
 * in integration tests.
 *
 * @example
 * ```typescript
 * const session = await TestSession.create({
 *   workspacePath: '/path/to/test/dir',
 *   model: 'haiku',
 * });
 *
 * await session.send('Read the package.json file');
 * const toolUse = await session.waitForToolUse({ name: 'Read' });
 * const response = await session.waitForResponse();
 *
 * await session.cleanup();
 * ```
 */
export class TestSession {
  private process: ClaudeProcess | null = null;
  private messages: ClaudeJson[] = [];
  private messageResolvers: Array<(msg: ClaudeJson) => void> = [];
  private resultReceived = false;
  private claudeSessionId: string | null = null;

  private constructor(private options: TestSessionOptions) {}

  /**
   * Creates and initializes a new test session.
   */
  static async create(options: TestSessionOptions): Promise<TestSession> {
    const session = new TestSession(options);
    await session.initialize();
    return session;
  }

  /**
   * Initializes the Claude process.
   */
  private async initialize(): Promise<void> {
    const modelMap: Record<string, string> = {
      haiku: 'claude-3-5-haiku-20241022',
      sonnet: 'claude-sonnet-4-5-20250929',
      opus: 'claude-opus-4-5-20251101',
    };

    const model =
      modelMap[this.options.model || 'sonnet'] ||
      this.options.model ||
      'claude-sonnet-4-5-20250929';

    const processOptions: ClaudeProcessOptions = {
      workingDir: this.options.workspacePath,
      model,
      permissionMode: 'bypassPermissions', // Auto-approve all tools for testing
      includePartialMessages: false, // We only care about complete messages
      resourceMonitoring: {
        enabled: false, // Disable for tests
      },
    };

    if (this.options.resumeSessionId) {
      processOptions.resumeClaudeSessionId = this.options.resumeSessionId;
    }

    this.process = await ClaudeProcess.spawn(processOptions);

    // Listen for messages
    this.process.on('message', (msg: ClaudeJson) => {
      this.handleMessage(msg);
    });

    // Wait for process to be ready
    await this.waitForReady();
  }

  /**
   * Handle an incoming message from the Claude process.
   */
  private handleMessage(msg: ClaudeJson): void {
    this.messages.push(msg);

    // Extract session ID from messages
    if ('session_id' in msg && msg.session_id) {
      this.claudeSessionId = msg.session_id;
    }

    // Check for result message (conversation turn complete)
    if (msg.type === 'result') {
      this.resultReceived = true;
    }

    // Resolve any pending waiters
    const resolvers = [...this.messageResolvers];
    this.messageResolvers = [];
    for (const resolve of resolvers) {
      resolve(msg);
    }
  }

  /**
   * Waits for the process to be ready to receive messages.
   */
  private async waitForReady(): Promise<void> {
    const timeout = 30_000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      if (this.process?.getStatus() === 'ready') {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`TestSession: Process did not become ready within ${timeout}ms`);
  }

  /**
   * Sends a message to Claude.
   */
  async send(message: string): Promise<void> {
    if (!this.process) {
      throw new Error('TestSession: Process not initialized');
    }

    // Reset result flag for new conversation turn
    this.resultReceived = false;

    await this.process.protocol.sendUserMessage(message);
  }

  /**
   * Waits for the next message from Claude with a timeout.
   */
  private waitForNextMessage(timeout: number): Promise<ClaudeJson> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const idx = this.messageResolvers.indexOf(resolve);
        if (idx !== -1) {
          this.messageResolvers.splice(idx, 1);
        }
        reject(new Error(`Timeout waiting for message (${timeout}ms)`));
      }, timeout);

      const wrappedResolve = (msg: ClaudeJson) => {
        clearTimeout(timeoutId);
        resolve(msg);
      };

      this.messageResolvers.push(wrappedResolve);
    });
  }

  /**
   * Try to find an assistant response in the current messages.
   */
  private findAssistantResponse(): ReceivedMessage | null {
    for (const msg of this.messages) {
      if (msg.type !== 'assistant') {
        continue;
      }

      const assistantMsg = msg as AssistantMessage;
      const { textContent, toolUses } = extractMessageContent(assistantMsg);

      if (textContent || toolUses.length > 0) {
        return { type: 'assistant', content: textContent, toolUses, raw: msg };
      }
    }
    return null;
  }

  /**
   * Find the last assistant response in messages (searching backwards).
   */
  private findLastAssistantResponse(): ReceivedMessage | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.type !== 'assistant') {
        continue;
      }

      const assistantMsg = msg as AssistantMessage;
      const { textContent, toolUses } = extractMessageContent(assistantMsg);

      return { type: 'assistant', content: textContent, toolUses, raw: msg };
    }
    return null;
  }

  /**
   * Find a tool use in any of the current messages.
   */
  private findToolUseInMessages(name?: string): ToolUseEvent | null {
    for (const msg of this.messages) {
      if (msg.type !== 'assistant') {
        continue;
      }

      const toolUse = findToolUseInMessage(msg as AssistantMessage, name);
      if (toolUse) {
        return toolUse;
      }
    }
    return null;
  }

  /**
   * Calculate remaining timeout for polling operations.
   */
  private getRemainingTimeout(startTime: number, totalTimeout: number): number {
    return Math.min(1000, totalTimeout - (Date.now() - startTime));
  }

  /**
   * Waits for Claude's response (assistant message with text content).
   *
   * @param options - Wait options
   * @returns The assistant message content
   */
  async waitForResponse(options: WaitOptions = {}): Promise<ReceivedMessage> {
    const { timeout = 60_000 } = options;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      // Check for existing response
      const response = this.findAssistantResponse();
      if (response) {
        return response;
      }

      // If turn is complete, get the last assistant message
      if (this.resultReceived) {
        const lastResponse = this.findLastAssistantResponse();
        if (lastResponse) {
          return lastResponse;
        }
      }

      // Wait for next message
      try {
        await this.waitForNextMessage(this.getRemainingTimeout(startTime, timeout));
      } catch {
        // Individual timeout is fine, we'll check the overall timeout
      }
    }

    throw new Error(`Timeout waiting for response (${timeout}ms)`);
  }

  /**
   * Waits for a tool use event.
   *
   * @param options - Wait options including optional tool name filter
   * @returns The tool use event
   */
  async waitForToolUse(options: WaitForToolOptions = {}): Promise<ToolUseEvent> {
    const { timeout = 60_000, name } = options;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      // Check for existing tool use
      const toolUse = this.findToolUseInMessages(name);
      if (toolUse) {
        return toolUse;
      }

      // If turn is complete and no tool found, error
      if (this.resultReceived) {
        throw new Error(`No tool use found${name ? ` with name "${name}"` : ''}`);
      }

      // Wait for next message
      try {
        await this.waitForNextMessage(this.getRemainingTimeout(startTime, timeout));
      } catch {
        // Individual timeout is fine
      }
    }

    throw new Error(`Timeout waiting for tool use${name ? ` "${name}"` : ''} (${timeout}ms)`);
  }

  /**
   * Waits for the current conversation turn to complete (result message received).
   */
  async waitForTurnComplete(options: WaitOptions = {}): Promise<ResultMessage | null> {
    const { timeout = 60_000 } = options;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      if (this.resultReceived) {
        // Find the result message
        for (let i = this.messages.length - 1; i >= 0; i--) {
          if (this.messages[i].type === 'result') {
            return this.messages[i] as ResultMessage;
          }
        }
        return null;
      }

      try {
        await this.waitForNextMessage(this.getRemainingTimeout(startTime, timeout));
      } catch {
        // Continue waiting
      }
    }

    throw new Error(`Timeout waiting for turn to complete (${timeout}ms)`);
  }

  /**
   * Gets all messages received so far.
   */
  getMessages(): ClaudeJson[] {
    return [...this.messages];
  }

  /**
   * Gets the Claude session ID (for resuming later).
   */
  getClaudeSessionId(): string | null {
    return this.claudeSessionId;
  }

  /**
   * Clears the message buffer (useful between test steps).
   */
  clearMessages(): void {
    this.messages = [];
    this.resultReceived = false;
  }

  /**
   * Cleans up the test session by killing the Claude process.
   */
  async cleanup(): Promise<void> {
    if (this.process) {
      try {
        await this.process.interrupt();
      } catch {
        // If interrupt fails, try force kill
        try {
          this.process.kill();
        } catch {
          // Ignore kill errors
        }
      }
      this.process = null;
    }
    this.messages = [];
    this.messageResolvers = [];
  }
}
