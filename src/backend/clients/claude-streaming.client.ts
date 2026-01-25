/**
 * Claude CLI JSON Streaming Client
 *
 * Manages Claude CLI processes with structured JSON I/O for real-time
 * bidirectional communication without terminal emulation.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../services/index.js';

const logger = createLogger('claude-streaming');

// ============================================================================
// Types
// ============================================================================

export interface ClaudeStreamOptions {
  sessionId: string;
  workingDir: string;
  resumeSessionId?: string;
  systemPrompt?: string;
  model?: string;
  allowedTools?: string[];
  initialPrompt?: string; // Required for first message when not resuming
  disableMcp?: boolean; // Skip MCP server loading for faster startup
  disableTools?: boolean; // Disable all tools for pure chat
  /**
   * Skip permission prompts. Defaults to true for POC.
   * WARNING: Should be false or use allowedTools in production.
   */
  skipPermissions?: boolean;
}

interface ProcessState {
  process: ChildProcess;
  buffer: string;
  claudeSessionId: string | null;
  status: 'running' | 'idle' | 'exited';
}

// Output message types from Claude CLI stream-json format
export interface AssistantMessage {
  type: 'assistant';
  message: {
    content: Array<{
      type: 'text';
      text: string;
    }>;
  };
}

export interface ToolUseMessage {
  type: 'tool_use';
  tool: string;
  input: Record<string, unknown>;
  id: string;
}

export interface ToolResultMessage {
  type: 'tool_result';
  tool_use_id: string;
  result: string | Record<string, unknown>;
  is_error?: boolean;
}

export interface ResultMessage {
  type: 'result';
  session_id: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  total_cost_usd: number;
  duration_ms: number;
  num_turns: number;
}

export interface SystemMessage {
  type: 'system';
  message: string;
}

export interface ErrorMessage {
  type: 'error';
  error: string;
  details?: string;
}

export interface StreamEventMessage {
  type: 'content_block_delta';
  index: number;
  delta: {
    type: 'text_delta';
    text: string;
  };
}

export type ClaudeOutputMessage =
  | AssistantMessage
  | ToolUseMessage
  | ToolResultMessage
  | ResultMessage
  | SystemMessage
  | ErrorMessage
  | StreamEventMessage
  | { type: string; [key: string]: unknown };

// Input message format for Claude CLI (stream-json)
export interface UserInput {
  type: 'user';
  message: {
    role: 'user';
    content: Array<{
      type: 'text';
      text: string;
    }>;
  };
}

// History message for displaying conversation history
export interface HistoryMessage {
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  content: string;
  timestamp: string;
  uuid: string;
  // Tool-specific fields
  toolName?: string;
  toolId?: string;
  toolInput?: Record<string, unknown>;
  isError?: boolean;
}

// ============================================================================
// Session History
// ============================================================================

/**
 * Get the path to Claude's project sessions directory for a given working directory
 */
function getClaudeProjectPath(workingDir: string): string {
  // Claude stores sessions in ~/.claude/projects/<escaped-path>/
  const escapedPath = workingDir.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', escapedPath);
}

// Helper to create base message metadata
function createBaseMessage(
  entry: { timestamp?: string; uuid?: string },
  type: HistoryMessage['type']
): Pick<HistoryMessage, 'type' | 'timestamp' | 'uuid'> {
  return { type, timestamp: entry.timestamp || '', uuid: entry.uuid || '' };
}

// Parse a single content item from user message array
function parseUserContentItem(
  item: Record<string, unknown>,
  entry: { timestamp?: string; uuid?: string }
): HistoryMessage | null {
  if (item.type === 'text' && item.text) {
    return { ...createBaseMessage(entry, 'user'), content: item.text as string };
  }
  if (item.type === 'tool_result') {
    const content = item.content;
    return {
      ...createBaseMessage(entry, 'tool_result'),
      content: typeof content === 'string' ? content : JSON.stringify(content),
      toolId: item.tool_use_id as string,
      isError: item.is_error as boolean,
    };
  }
  return null;
}

// Parse user message entry (string or array content)
function parseUserEntry(entry: Record<string, unknown>): HistoryMessage[] {
  const content = (entry.message as Record<string, unknown>)?.content;
  if (!content) {
    return [];
  }

  if (typeof content === 'string') {
    return [{ ...createBaseMessage(entry, 'user'), content }];
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => parseUserContentItem(item, entry))
      .filter((m): m is HistoryMessage => m !== null);
  }

  return [];
}

// Parse assistant message entry
function parseAssistantEntry(entry: Record<string, unknown>): HistoryMessage[] {
  const content = (entry.message as Record<string, unknown>)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const messages: HistoryMessage[] = [];
  for (const item of content) {
    if (item.type === 'text' && item.text) {
      messages.push({ ...createBaseMessage(entry, 'assistant'), content: item.text as string });
    } else if (item.type === 'tool_use') {
      messages.push({
        ...createBaseMessage(entry, 'tool_use'),
        content: '',
        toolName: item.name as string,
        toolId: item.id as string,
        toolInput: item.input as Record<string, unknown>,
      });
    }
    // Skip 'thinking' type - not shown in UI
  }
  return messages;
}

// Parse a single JSONL line
function parseHistoryLine(line: string): HistoryMessage[] {
  try {
    const entry = JSON.parse(line) as Record<string, unknown>;
    if (entry.type === 'user') {
      return parseUserEntry(entry);
    }
    if (entry.type === 'assistant') {
      return parseAssistantEntry(entry);
    }
    return [];
  } catch {
    return []; // Skip malformed lines
  }
}

/**
 * Read conversation history from a Claude session file
 */
export async function getSessionHistory(
  claudeSessionId: string,
  workingDir: string
): Promise<HistoryMessage[]> {
  const projectPath = getClaudeProjectPath(workingDir);
  const sessionFile = join(projectPath, `${claudeSessionId}.jsonl`);

  try {
    const content = await readFile(sessionFile, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim());
    return lines.flatMap(parseHistoryLine);
  } catch (error) {
    logger.warn('Failed to read session history', { claudeSessionId, error });
    return [];
  }
}

/**
 * List available Claude sessions for a working directory
 */
export async function listSessions(workingDir: string): Promise<string[]> {
  const projectPath = getClaudeProjectPath(workingDir);

  try {
    const files = await readdir(projectPath);
    return files.filter((f) => f.endsWith('.jsonl')).map((f) => f.replace('.jsonl', ''));
  } catch {
    return [];
  }
}

// ============================================================================
// Events
// ============================================================================

export interface ClaudeStreamingClientEvents {
  message: (data: { sessionId: string; message: ClaudeOutputMessage }) => void;
  raw: (data: { sessionId: string; data: string }) => void;
  stderr: (data: { sessionId: string; data: string }) => void;
  exit: (data: {
    sessionId: string;
    code: number | null;
    signal: string | null;
    claudeSessionId: string | null;
  }) => void;
  error: (data: { sessionId: string; error: Error }) => void;
}

// ============================================================================
// Client
// ============================================================================

export class ClaudeStreamingClient extends EventEmitter {
  private processes: Map<string, ProcessState> = new Map();
  // Track Claude session IDs across process restarts for --resume
  private claudeSessionIds: Map<string, string> = new Map();

  /**
   * Start a new Claude CLI process with JSON streaming.
   * The process stays alive and accepts messages via stdin.
   */
  startProcess(options: ClaudeStreamOptions): string {
    const { sessionId } = options;

    // If process already exists and is running, just return
    const existingState = this.processes.get(sessionId);
    if (existingState && existingState.status !== 'exited') {
      logger.info('Process already running', { sessionId, status: existingState.status });
      return sessionId;
    }

    // Check if we have a previous Claude session to resume
    const existingClaudeSessionId = this.claudeSessionIds.get(sessionId);
    const { args, newClaudeSessionId } = this.buildArgs(options, existingClaudeSessionId);

    // Store new session ID immediately to prevent loss if process crashes
    if (newClaudeSessionId) {
      this.claudeSessionIds.set(sessionId, newClaudeSessionId);
    }

    logger.info('Starting Claude process', {
      sessionId,
      args,
      resuming: !!existingClaudeSessionId,
      newClaudeSessionId,
    });

    const proc = spawn('claude', args, {
      cwd: options.workingDir,
      env: {
        ...process.env,
        // Don't pass API key - use OAuth
        ANTHROPIC_API_KEY: undefined,
      },
      stdio: ['pipe', 'pipe', 'pipe'], // Keep stdin open for streaming input
    });

    if (!(proc.stdout && proc.stdin)) {
      throw new Error('Failed to create stdio streams for Claude process');
    }

    const state: ProcessState = {
      process: proc,
      buffer: '',
      claudeSessionId: null,
      status: 'idle', // Start idle, waiting for first message
    };

    this.processes.set(sessionId, state);
    this.setupListeners(sessionId, state);

    logger.info('Claude process spawned', {
      sessionId,
      pid: proc.pid,
      hasStdout: !!proc.stdout,
      hasStderr: !!proc.stderr,
      hasStdin: !!proc.stdin,
    });

    return sessionId;
  }

  private buildArgs(
    options: ClaudeStreamOptions,
    resumeSessionId?: string
  ): { args: string[]; newClaudeSessionId?: string } {
    const args: string[] = [];
    let newClaudeSessionId: string | undefined;

    // Use -p for non-interactive mode (required for stream-json)
    args.push('-p');

    // Enable bidirectional JSON streaming
    args.push(
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose' // Required for stream-json output
    );

    // Permission handling - skip by default for POC, but configurable
    // WARNING: In production, use allowedTools to restrict tool access
    if (options.skipPermissions !== false) {
      args.push('--dangerously-skip-permissions');
    }

    // Session handling - use resume for existing sessions, new ID for fresh ones
    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    } else {
      newClaudeSessionId = randomUUID();
      args.push('--session-id', newClaudeSessionId);
    }

    if (options.model) {
      args.push('--model', options.model);
    }

    if (options.systemPrompt) {
      args.push('--append-system-prompt', options.systemPrompt);
    }

    if (options.allowedTools?.length) {
      args.push('--allowedTools', options.allowedTools.join(','));
    }

    // Speed optimizations
    if (options.disableMcp) {
      args.push('--mcp-config', '{}');
    }

    if (options.disableTools) {
      args.push('--tools', '');
    }

    return { args, newClaudeSessionId };
  }

  private setupListeners(sessionId: string, state: ProcessState): void {
    logger.info('Setting up listeners', { sessionId, pid: state.process.pid });

    // Parse NDJSON from stdout using manual line buffering
    state.process.stdout?.on('data', (chunk: Buffer) => {
      logger.info('STDOUT DATA EVENT', { sessionId, chunkLength: chunk.length });
      // Append chunk to buffer
      state.buffer += chunk.toString();

      // Process complete lines (split by newline)
      const lines = state.buffer.split('\n');

      // Keep the last incomplete line in the buffer
      state.buffer = lines.pop() || '';

      // Process each complete line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        try {
          const message = JSON.parse(trimmed) as ClaudeOutputMessage;
          logger.info('Parsed Claude message', { sessionId, type: message.type });

          // Capture session_id from result messages
          if (message.type === 'result' && 'session_id' in message) {
            const claudeSessionId = message.session_id as string;
            state.claudeSessionId = claudeSessionId;
            state.status = 'idle';
            // Store for future --resume calls
            this.claudeSessionIds.set(sessionId, claudeSessionId);
            logger.info('Stored Claude session ID for resume', { sessionId, claudeSessionId });
          }

          this.emit('message', { sessionId, message });
        } catch {
          // Non-JSON output (shouldn't happen with stream-json)
          logger.warn('Received non-JSON line', { sessionId, line: trimmed.slice(0, 200) });
          this.emit('raw', { sessionId, data: trimmed });
        }
      }
    });

    // Handle stderr (errors, debug info)
    state.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      logger.info('Claude stderr', { sessionId, text: text.slice(0, 500) });
      this.emit('stderr', { sessionId, data: text });
    });

    // Handle process exit
    state.process.on('exit', (code, signal) => {
      state.status = 'exited';
      logger.info('Claude process exited', {
        sessionId,
        code,
        signal,
        claudeSessionId: state.claudeSessionId,
      });
      this.emit('exit', {
        sessionId,
        code,
        signal,
        claudeSessionId: state.claudeSessionId,
      });
    });

    state.process.on('error', (error) => {
      logger.error('Claude process error', { sessionId, error });
      this.emit('error', { sessionId, error });
    });
  }

  /**
   * Send a user message to a Claude process
   */
  sendMessage(sessionId: string, text: string): boolean {
    const state = this.processes.get(sessionId);
    if (!state || state.status === 'exited') {
      logger.warn('Cannot send message - process not running', { sessionId });
      return false;
    }

    if (!state.process.stdin) {
      logger.error('Cannot send message - stdin not available', { sessionId });
      return false;
    }

    const message: UserInput = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    };

    const json = JSON.stringify(message);
    logger.debug('Sending message to Claude', { sessionId, length: text.length });

    try {
      const success = state.process.stdin.write(`${json}\n`);
      if (!success) {
        // Buffer is full, wait for drain event
        logger.warn('stdin buffer full, message queued', { sessionId });
      }
      state.status = 'running';
      return true;
    } catch (error) {
      logger.error('Failed to write to stdin', { sessionId, error });
      this.emit('error', { sessionId, error });
      return false;
    }
  }

  /**
   * Get the Claude session ID for resuming later
   */
  getClaudeSessionId(sessionId: string): string | null {
    // Check the persistent map first, then the current process
    return (
      this.claudeSessionIds.get(sessionId) || this.processes.get(sessionId)?.claudeSessionId || null
    );
  }

  /**
   * Set the Claude session ID for a session (used when reconnecting to existing sessions)
   */
  setClaudeSessionId(sessionId: string, claudeSessionId: string): void {
    logger.info('Setting Claude session ID', { sessionId, claudeSessionId });
    this.claudeSessionIds.set(sessionId, claudeSessionId);
  }

  /**
   * Kill a Claude process
   */
  killProcess(sessionId: string): void {
    const state = this.processes.get(sessionId);
    if (state) {
      logger.info('Killing Claude process', { sessionId });
      state.process.kill('SIGTERM');
      this.processes.delete(sessionId);
    }
  }

  /**
   * Check if a process is running
   */
  isRunning(sessionId: string): boolean {
    const state = this.processes.get(sessionId);
    return state?.status === 'running' || state?.status === 'idle';
  }

  /**
   * Get process status
   */
  getStatus(sessionId: string): 'running' | 'idle' | 'exited' | 'not_found' {
    return this.processes.get(sessionId)?.status || 'not_found';
  }

  /**
   * Get stats about all processes
   */
  getStats(): { total: number; running: number; idle: number } {
    let running = 0;
    let idle = 0;
    for (const state of this.processes.values()) {
      if (state.status === 'running') {
        running++;
      }
      if (state.status === 'idle') {
        idle++;
      }
    }
    return { total: this.processes.size, running, idle };
  }

  /**
   * Clean up all processes on shutdown
   */
  cleanupAll(): void {
    logger.info('Cleaning up all Claude processes', { count: this.processes.size });
    for (const sessionId of this.processes.keys()) {
      this.killProcess(sessionId);
    }
  }
}

// Singleton instance
export const claudeStreamingClient = new ClaudeStreamingClient();
