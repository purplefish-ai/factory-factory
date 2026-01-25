# Claude CLI JSON Streaming Design

> **Status**: Proposed
> **Author**: AI Assistant
> **Date**: 2025-01-24

## Overview

Replace the current Tmux + Xterm.js terminal emulation architecture with Claude CLI's native JSON streaming capabilities. This simplifies the stack, provides structured message data, and enables a richer custom UI.

## Motivation

### Current Architecture Pain Points

1. **Terminal Emulation Complexity**: Xterm.js requires parsing ANSI escape codes, handling terminal state, and managing PTY processes
2. **Opaque Data**: Terminal output is unstructured text - we can't easily extract tool calls, results, or agent state
3. **Resource Overhead**: Each agent requires a Tmux session + PTY process + WebSocket connection
4. **Fragile Parsing**: Any UI features (progress indicators, tool visualization) require screen-scraping terminal output

### Benefits of JSON Streaming

1. **Structured Messages**: Tool calls, results, text output, and errors are distinct JSON objects
2. **Simpler Architecture**: No Tmux, no PTY, no terminal emulation - just process I/O
3. **Rich UI Potential**: Can render tool calls as cards, show progress bars, syntax highlight code blocks
4. **Better State Management**: Know exactly when agent is thinking, using tools, or waiting
5. **Native Session Management**: Claude CLI handles session persistence via `--resume`

## Architecture

### Current Architecture (Tmux + Xterm.js)

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (React)                          │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Xterm.js Terminal Component                         │   │
│  │  - ANSI escape code parsing                         │   │
│  │  - Terminal state management                        │   │
│  │  - Keyboard input handling                          │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              ↓ WebSocket (raw bytes)
┌─────────────────────────────────────────────────────────────┐
│                    Backend (Node.js)                         │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  PTY Manager                                         │   │
│  │  - node-pty spawn                                   │   │
│  │  - tmux attach-session                              │   │
│  │  - Bidirectional byte forwarding                    │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              ↓ stdin/stdout (raw bytes)
┌─────────────────────────────────────────────────────────────┐
│                    Tmux Session                              │
│  - Detached session per agent                               │
│  - Persists across disconnects                              │
│  - Capture-pane for async output reading                    │
└─────────────────────────────────────────────────────────────┘
                              ↓ interactive shell
┌─────────────────────────────────────────────────────────────┐
│                    Claude Code CLI                           │
│  - Interactive REPL mode                                    │
│  - System prompt via file injection                         │
│  - Session persistence via --session-id                     │
└─────────────────────────────────────────────────────────────┘
```

### Proposed Architecture (JSON Streaming)

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (React)                          │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Agent Activity Component (Custom)                   │   │
│  │  - Message list (text, tool calls, results)         │   │
│  │  - Tool call cards with syntax highlighting         │   │
│  │  - Progress/status indicators                       │   │
│  │  - Optional: collapsible thinking blocks            │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              ↓ WebSocket (JSON messages)
┌─────────────────────────────────────────────────────────────┐
│                    Backend (Node.js)                         │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Claude Process Manager                              │   │
│  │  - Spawn claude CLI with JSON streaming flags       │   │
│  │  - Parse NDJSON stdout line-by-line                 │   │
│  │  - Write JSON to stdin (for user input)             │   │
│  │  - Forward parsed messages to WebSocket             │   │
│  │  - Track session IDs for resume                     │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              ↓ stdin/stdout (NDJSON)
┌─────────────────────────────────────────────────────────────┐
│                    Claude Code CLI                           │
│  - Non-interactive mode (-p with streaming I/O)            │
│  - --output-format stream-json                             │
│  - --input-format stream-json                              │
│  - --include-partial-messages                              │
│  - Session persistence via --resume                        │
└─────────────────────────────────────────────────────────────┘
```

## CLI Flags Reference

Based on `claude --help`:

| Flag | Purpose |
|------|---------|
| `-p, --print` | Non-interactive mode (required for JSON I/O) |
| `--output-format stream-json` | Emit NDJSON (one JSON object per line) |
| `--input-format stream-json` | Accept JSON messages on stdin |
| `--include-partial-messages` | Include streaming chunks as they arrive |
| `--replay-user-messages` | Echo back user messages for acknowledgment |
| `-r, --resume <session_id>` | Resume a previous session |
| `--session-id <uuid>` | Use a specific session ID |
| `--fork-session` | Create new session ID when resuming |
| `--no-session-persistence` | Ephemeral mode (don't save sessions) |
| `--dangerously-skip-permissions` | Bypass permission prompts |
| `--allowedTools <tools>` | Auto-approve specific tools |
| `--append-system-prompt <prompt>` | Add to system prompt |
| `--model <model>` | Model selection |

## Message Types

### Output Messages (stdout, NDJSON)

Based on Claude CLI's stream-json format:

```typescript
// Base message structure
interface StreamMessage {
  type: string;
  timestamp?: string;
}

// Assistant text output
interface AssistantMessage extends StreamMessage {
  type: 'assistant';
  message: {
    content: Array<{
      type: 'text';
      text: string;
    }>;
  };
}

// Tool use request
interface ToolUseMessage extends StreamMessage {
  type: 'tool_use';
  tool: string;       // e.g., "Edit", "Bash", "Read"
  input: Record<string, unknown>;
  id: string;         // Tool call ID
}

// Tool result
interface ToolResultMessage extends StreamMessage {
  type: 'tool_result';
  tool_use_id: string;
  result: string | Record<string, unknown>;
  is_error?: boolean;
}

// Session completion
interface ResultMessage extends StreamMessage {
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

// Partial streaming (with --include-partial-messages)
interface StreamEventMessage extends StreamMessage {
  type: 'stream_event';
  event_type: 'text_delta' | 'tool_use_delta';
  delta: string;
}

// System messages
interface SystemMessage extends StreamMessage {
  type: 'system';
  message: string;
}

// Error messages
interface ErrorMessage extends StreamMessage {
  type: 'error';
  error: string;
  details?: string;
}
```

### Input Messages (stdin, JSON)

For `--input-format stream-json`:

```typescript
// User message
interface UserInput {
  type: 'user';
  message: {
    content: Array<{
      type: 'text';
      text: string;
    }>;
  };
}

// Example:
// {"type":"user","message":{"content":[{"type":"text","text":"Fix the bug"}]}}
```

## Implementation Plan

### Phase 1: Claude Process Manager

Replace `TmuxClient` + `PtyManager` with a new `ClaudeProcessManager`:

```typescript
// src/backend/clients/claude-process.client.ts

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { createInterface, Interface } from 'readline';

interface ClaudeProcessOptions {
  agentId: string;
  sessionId?: string;        // For resuming
  systemPrompt?: string;
  model?: string;
  workingDir: string;
  allowedTools?: string[];
}

interface ProcessState {
  process: ChildProcess;
  readline: Interface;
  sessionId: string | null;
  status: 'running' | 'idle' | 'exited';
}

export class ClaudeProcessManager extends EventEmitter {
  private processes: Map<string, ProcessState> = new Map();

  /**
   * Start a new Claude CLI process for an agent
   */
  async startProcess(options: ClaudeProcessOptions): Promise<string> {
    const args = this.buildArgs(options);

    const proc = spawn('claude', args, {
      cwd: options.workingDir,
      env: {
        ...process.env,
        // Force OAuth, not API key
        ANTHROPIC_API_KEY: undefined,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const readline = createInterface({
      input: proc.stdout,
      crlfDelay: Infinity,
    });

    const state: ProcessState = {
      process: proc,
      readline,
      sessionId: options.sessionId || null,
      status: 'running',
    };

    this.processes.set(options.agentId, state);
    this.setupListeners(options.agentId, state);

    return options.agentId;
  }

  private buildArgs(options: ClaudeProcessOptions): string[] {
    const args = [
      '-p',                              // Non-interactive
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--include-partial-messages',
      '--replay-user-messages',
      '--dangerously-skip-permissions',
    ];

    if (options.sessionId) {
      args.push('--resume', options.sessionId);
    } else {
      // Generate a new session ID
      const newSessionId = `${options.agentId}-${Date.now()}`;
      args.push('--session-id', newSessionId);
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

    return args;
  }

  private setupListeners(agentId: string, state: ProcessState): void {
    // Parse NDJSON from stdout
    state.readline.on('line', (line) => {
      try {
        const message = JSON.parse(line);

        // Capture session_id from result messages
        if (message.type === 'result' && message.session_id) {
          state.sessionId = message.session_id;
        }

        this.emit('message', { agentId, message });
      } catch (err) {
        // Non-JSON output (shouldn't happen with stream-json)
        this.emit('raw', { agentId, data: line });
      }
    });

    // Handle stderr (errors, debug info)
    state.process.stderr?.on('data', (data) => {
      this.emit('stderr', { agentId, data: data.toString() });
    });

    // Handle process exit
    state.process.on('exit', (code, signal) => {
      state.status = 'exited';
      this.emit('exit', { agentId, code, signal, sessionId: state.sessionId });
    });

    state.process.on('error', (error) => {
      this.emit('error', { agentId, error });
    });
  }

  /**
   * Send a user message to an agent's Claude process
   */
  sendMessage(agentId: string, text: string): boolean {
    const state = this.processes.get(agentId);
    if (!state || state.status !== 'running') {
      return false;
    }

    const message: UserInput = {
      type: 'user',
      message: {
        content: [{ type: 'text', text }],
      },
    };

    state.process.stdin?.write(JSON.stringify(message) + '\n');
    return true;
  }

  /**
   * Get session ID for an agent (for resuming later)
   */
  getSessionId(agentId: string): string | null {
    return this.processes.get(agentId)?.sessionId || null;
  }

  /**
   * Kill an agent's Claude process
   */
  killProcess(agentId: string): void {
    const state = this.processes.get(agentId);
    if (state) {
      state.process.kill('SIGTERM');
      state.readline.close();
      this.processes.delete(agentId);
    }
  }

  /**
   * Check if an agent has a running process
   */
  isRunning(agentId: string): boolean {
    const state = this.processes.get(agentId);
    return state?.status === 'running';
  }

  /**
   * Cleanup all processes on shutdown
   */
  cleanup(): void {
    for (const [agentId] of this.processes) {
      this.killProcess(agentId);
    }
  }
}
```

### Phase 2: WebSocket Handler

Replace the PTY-based WebSocket handler:

```typescript
// src/backend/websocket/claude-stream.handler.ts

import { WebSocket, WebSocketServer } from 'ws';
import { ClaudeProcessManager } from '../clients/claude-process.client.js';

interface Connection {
  ws: WebSocket;
  agentId: string;
}

export class ClaudeStreamHandler {
  private connections: Map<WebSocket, Connection> = new Map();
  private processManager: ClaudeProcessManager;

  constructor(processManager: ClaudeProcessManager) {
    this.processManager = processManager;

    // Forward process messages to connected clients
    this.processManager.on('message', ({ agentId, message }) => {
      this.broadcast(agentId, { type: 'claude_message', data: message });
    });

    this.processManager.on('exit', ({ agentId, code, sessionId }) => {
      this.broadcast(agentId, {
        type: 'process_exit',
        code,
        sessionId,
      });
    });

    this.processManager.on('error', ({ agentId, error }) => {
      this.broadcast(agentId, {
        type: 'error',
        message: error.message,
      });
    });
  }

  handleConnection(ws: WebSocket, agentId: string): void {
    this.connections.set(ws, { ws, agentId });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleClientMessage(ws, message);
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }
    });

    ws.on('close', () => {
      this.connections.delete(ws);
    });

    // Send current status
    ws.send(JSON.stringify({
      type: 'status',
      running: this.processManager.isRunning(agentId),
      sessionId: this.processManager.getSessionId(agentId),
    }));
  }

  private handleClientMessage(ws: WebSocket, message: any): void {
    const conn = this.connections.get(ws);
    if (!conn) return;

    switch (message.type) {
      case 'user_input':
        // Forward user input to Claude process
        this.processManager.sendMessage(conn.agentId, message.text);
        break;

      case 'start_process':
        // Start a new process (or resume)
        this.processManager.startProcess({
          agentId: conn.agentId,
          sessionId: message.sessionId,
          workingDir: message.workingDir,
          systemPrompt: message.systemPrompt,
          model: message.model,
        });
        break;

      case 'kill_process':
        this.processManager.killProcess(conn.agentId);
        break;
    }
  }

  private broadcast(agentId: string, message: any): void {
    const data = JSON.stringify(message);
    for (const [ws, conn] of this.connections) {
      if (conn.agentId === agentId && ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }
}
```

### Phase 3: Frontend Component

Replace Xterm.js with a custom React component:

```typescript
// src/frontend/components/agent-activity.tsx

'use client';

import { useEffect, useState, useRef } from 'react';

interface Message {
  type: string;
  timestamp: string;
  [key: string]: any;
}

interface AgentActivityProps {
  agentId: string;
  wsUrl: string;
}

export function AgentActivity({ agentId, wsUrl }: AgentActivityProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ws = new WebSocket(`${wsUrl}?agentId=${agentId}`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'claude_message') {
        setMessages((prev) => [...prev, {
          ...data.data,
          timestamp: new Date().toISOString(),
        }]);
      }
    };

    return () => ws.close();
  }, [agentId, wsUrl]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = () => {
    if (input.trim() && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'user_input',
        text: input,
      }));
      setInput('');
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Status bar */}
      <div className="flex items-center gap-2 p-2 border-b">
        <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
        <span className="text-sm text-gray-600">
          {connected ? 'Connected' : 'Disconnected'}
        </span>
      </div>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg, i) => (
          <MessageRenderer key={i} message={msg} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input (only shown if agent accepts input) */}
      <div className="p-4 border-t">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
            className="flex-1 px-3 py-2 border rounded"
            placeholder="Send message to agent..."
          />
          <button
            onClick={sendMessage}
            className="px-4 py-2 bg-blue-500 text-white rounded"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function MessageRenderer({ message }: { message: Message }) {
  switch (message.type) {
    case 'assistant':
      return (
        <div className="p-3 bg-gray-50 rounded">
          <div className="text-sm text-gray-500 mb-1">Assistant</div>
          <div className="prose prose-sm">
            {message.message?.content?.map((c: any, i: number) => (
              <span key={i}>{c.text}</span>
            ))}
          </div>
        </div>
      );

    case 'tool_use':
      return (
        <div className="p-3 bg-blue-50 rounded border border-blue-200">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm font-medium text-blue-700">
              Tool: {message.tool}
            </span>
          </div>
          <pre className="text-xs bg-blue-100 p-2 rounded overflow-x-auto">
            {JSON.stringify(message.input, null, 2)}
          </pre>
        </div>
      );

    case 'tool_result':
      return (
        <div className={`p-3 rounded border ${
          message.is_error
            ? 'bg-red-50 border-red-200'
            : 'bg-green-50 border-green-200'
        }`}>
          <div className="text-sm font-medium mb-1">
            {message.is_error ? 'Tool Error' : 'Tool Result'}
          </div>
          <pre className="text-xs p-2 rounded overflow-x-auto bg-white">
            {typeof message.result === 'string'
              ? message.result
              : JSON.stringify(message.result, null, 2)}
          </pre>
        </div>
      );

    case 'result':
      return (
        <div className="p-3 bg-purple-50 rounded border border-purple-200">
          <div className="text-sm font-medium text-purple-700 mb-2">
            Session Complete
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>Turns: {message.num_turns}</div>
            <div>Duration: {(message.duration_ms / 1000).toFixed(1)}s</div>
            <div>Input tokens: {message.usage?.input_tokens}</div>
            <div>Output tokens: {message.usage?.output_tokens}</div>
            <div className="col-span-2">
              Cost: ${message.total_cost_usd?.toFixed(4)}
            </div>
          </div>
        </div>
      );

    case 'system':
      return (
        <div className="p-2 text-sm text-gray-500 italic">
          {message.message}
        </div>
      );

    case 'error':
      return (
        <div className="p-3 bg-red-50 rounded border border-red-200">
          <div className="text-sm font-medium text-red-700">Error</div>
          <div className="text-sm text-red-600">{message.error}</div>
        </div>
      );

    default:
      return (
        <div className="p-2 text-xs text-gray-400">
          Unknown message type: {message.type}
        </div>
      );
  }
}
```

### Phase 4: Database Schema Updates

Update the Agent model to remove Tmux references:

```prisma
model Agent {
  id                    String               @id @default(cuid())
  type                  AgentType
  currentTaskId         String?              @unique
  executionState        ExecutionState       @default(IDLE)
  desiredExecutionState DesiredExecutionState @default(ACTIVE)

  // Session tracking (replaces tmuxSessionName)
  claudeSessionId       String?              // Claude CLI session ID for --resume
  processStatus         ProcessStatus        @default(STOPPED)

  // Health tracking (unchanged)
  lastHeartbeat         DateTime?
  lastReconcileAt       DateTime?
  reconcileFailures     Json?

  // ... rest unchanged
}

enum ProcessStatus {
  STOPPED
  STARTING
  RUNNING
  EXITED
  ERROR
}
```

### Phase 5: Migration Strategy

1. **Feature flag**: Add `USE_JSON_STREAMING` env var
2. **Parallel implementation**: Keep Tmux code while building JSON streaming
3. **Gradual rollout**: Start with new agents, migrate existing
4. **Cleanup**: Remove Tmux/Xterm code once stable

## Data Flow

### Starting an Agent

```
1. Reconciler detects agent needs to start
2. Reconciler calls ClaudeProcessManager.startProcess({
     agentId: "worker-abc",
     sessionId: null,  // or existing session ID for resume
     workingDir: "/worktrees/task-123",
     systemPrompt: "...",
     model: "sonnet",
   })
3. Process spawns: claude -p --output-format stream-json --input-format stream-json ...
4. Process emits NDJSON on stdout
5. ClaudeProcessManager parses and emits 'message' events
6. ClaudeStreamHandler broadcasts to connected WebSocket clients
7. Frontend renders messages as cards/components
```

### User Interaction (if enabled)

```
1. User types in frontend input box
2. Frontend sends WebSocket message: { type: 'user_input', text: '...' }
3. ClaudeStreamHandler calls processManager.sendMessage(agentId, text)
4. Process stdin receives: {"type":"user","message":{"content":[{"type":"text","text":"..."}]}}
5. Claude processes and emits response on stdout
6. Flow continues as above
```

### Resuming a Session

```
1. Agent DB record has claudeSessionId = "worker-abc-1706123456"
2. Reconciler calls ClaudeProcessManager.startProcess({
     agentId: "worker-abc",
     sessionId: "worker-abc-1706123456",  // Resume this session
     ...
   })
3. Process spawns with: claude --resume worker-abc-1706123456 ...
4. Claude loads previous conversation context
5. Continues where it left off
```

## Testing Strategy

### Unit Tests

1. **Message parsing**: Verify all NDJSON message types are correctly parsed
2. **Process lifecycle**: Start, message, kill, resume
3. **Error handling**: Malformed JSON, process crashes, timeouts

### Integration Tests

1. **End-to-end flow**: Start process → receive messages → send input → receive response
2. **Session resume**: Start → exit → resume → verify context preserved
3. **WebSocket reconnection**: Disconnect → reconnect → receive missed messages (if buffered)

### Manual Testing

1. **UI responsiveness**: Messages render in real-time
2. **Tool visualization**: Tool calls display correctly with input/output
3. **Error states**: Process errors shown appropriately

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Claude CLI JSON format changes | Breaking changes | Pin CLI version, add format versioning |
| Session storage fills disk | Resource exhaustion | Add `--no-session-persistence` for ephemeral agents |
| Process orphaning | Resource leak | Implement proper cleanup on shutdown, track PIDs |
| Backpressure on stdout | Memory growth | Add message buffering limits, drop old messages |
| No offline debugging | Can't replay sessions | Store messages in DB for replay |

## Future Enhancements

1. **Message persistence**: Store all messages in DB for history/replay
2. **Message filtering**: Frontend options to hide/show tool calls, thinking
3. **Cost dashboard**: Aggregate token usage and costs from result messages
4. **Diff viewer**: Rich rendering of Edit tool diffs
5. **File preview**: Inline file content for Read tool results
6. **Search**: Full-text search across agent message history

## Open Questions

1. **Buffering strategy**: How many messages to buffer when no clients connected?
2. **Multi-client sync**: How to handle multiple UIs viewing same agent?
3. **Input restrictions**: Should agents accept user input, or only automated prompts?
4. **Partial messages**: Worth the complexity of `--include-partial-messages`?

## References

- [Claude CLI Help Output](claude --help)
- [Current Tmux Implementation](src/backend/clients/tmux.client.ts)
- [Current PTY Manager](src/backend/websocket/pty-manager.ts)
- [Current Claude Code Client](src/backend/clients/claude-code.client.ts)
