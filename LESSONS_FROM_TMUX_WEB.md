# Lessons from tmux-web for FactoryFactory

## Executive Summary

This document analyzes the tmux-web codebase to extract lessons for implementing FactoryFactory's tmux integration. The key insight: **tmux-web uses a dual-channel architecture** - REST API for session lifecycle management (CRUD) and WebSocket + PTY for real-time terminal I/O.

---

## Architecture Overview

### tmux-web's Approach

```
Browser (xterm.js)
    ↕ WebSocket (terminal I/O)    ← Real-time bidirectional stream
    ↕ REST API (sessions CRUD)    ← Stateless session management
Node.js Backend
    ↕ node-pty (PTY per connection)  ← Each WS connection spawns PTY
    ↕ child_process.execFile()       ← Direct tmux CLI commands
tmux Server
```

### What FactoryFactory Needs

FactoryFactory requires **read-only terminal viewing** for human monitoring of agent sessions. We don't need full interactive terminal control, but we do need real-time output streaming.

**Key differences from tmux-web:**
- **Read-only viewing** (no user input required)
- **Multiple viewers per session** (human + multiple UI tabs)
- **Agent-driven interaction** (agents use Claude SDK, not terminal input)
- **Long-lived sessions** (agents may run for hours)

---

## Lesson 1: Dual-Channel Architecture

### What tmux-web Does

**Session Management (REST API):**
```typescript
GET    /api/sessions          // List all sessions
POST   /api/sessions          // Create new session
DELETE /api/sessions/:name    // Kill session
```

**Terminal I/O (WebSocket):**
```typescript
ws://localhost:3001/terminal?session=<name>&cols=<cols>&rows=<rows>

Client → Server:
  {type: "input", data: string}     // User keyboard input
  {type: "resize", cols, rows}      // Terminal resize

Server → Client:
  {type: "output", data: string}    // Terminal output
  {type: "exit", code: number}      // Session ended
```

### How FactoryFactory Should Adapt

**Use tRPC for session management:**
```typescript
// src/backend/routers/api/tmux.router.ts
export const tmuxRouter = router({
  listSessions: publicProcedure.query(async () => {
    return tmuxClient.listSessions();
  }),

  getSession: publicProcedure
    .input(z.object({ sessionName: z.string() }))
    .query(async ({ input }) => {
      return tmuxClient.getSessionInfo(input.sessionName);
    }),
});
```

**Use WebSocket for terminal streaming:**
```typescript
// Separate WebSocket server (not tRPC)
// Connection: ws://localhost:3001/terminal?session=agent-xyz-abc

Server → Client (read-only):
  {type: "output", data: string}       // Terminal output
  {type: "pane-changed", paneId: number}  // Pane focus changed
  {type: "session-ended"}              // Session terminated
```

**Rationale:**
- REST/tRPC: Perfect for discrete operations (list, create, kill)
- WebSocket: Essential for real-time streaming (low latency, efficient)
- Separation of concerns: Session lifecycle vs. terminal I/O

---

## Lesson 2: PTY-Based Terminal Streaming

### What tmux-web Does

**Each WebSocket connection spawns a dedicated PTY:**
```typescript
// backend/src/pty-manager.ts
const ptyProcess = pty.spawn(TMUX_PATH, ["attach-session", "-t", sessionName], {
  name: "xterm-256color",
  cols: validCols,
  rows: validRows,
  cwd: env.HOME || "/",
  env: env
});

// Forward PTY output to WebSocket
ptyProcess.onData((data) => {
  ws.send(JSON.stringify({ type: "output", data }));
});

// Forward WebSocket input to PTY
ws.on("message", (msg) => {
  if (msg.type === "input") {
    ptyProcess.write(msg.data);
  }
});

// Cleanup on disconnect
ws.on("close", () => {
  ptyProcess.kill();
});
```

**Why this approach:**
- `tmux attach-session` provides **full terminal emulation**
- PTY handles all terminal control sequences (colors, cursor movement, etc.)
- No need to parse or interpret tmux output - just stream it
- Each connection is isolated (different PTY process)

### How FactoryFactory Should Adapt

**Read-only PTY for terminal viewing:**
```typescript
// src/backend/clients/tmux.client.ts

export class TmuxClient {
  private activePtys = new Map<string, ActivePty>();

  /**
   * Attach to a tmux session for read-only viewing.
   * Multiple viewers can attach to the same session.
   */
  attachReadOnly(sessionName: string, ws: WebSocket): void {
    const ptyProcess = pty.spawn(TMUX_PATH, ["attach-session", "-t", sessionName], {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: process.env.HOME || "/",
      env: process.env
    });

    // Forward PTY output to WebSocket (read-only)
    ptyProcess.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "output", data }));
      }
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode }) => {
      ws.send(JSON.stringify({ type: "session-ended", exitCode }));
      ws.close();
    });

    // Cleanup on WebSocket close
    ws.on("close", () => {
      ptyProcess.kill();
    });

    // Handle WebSocket errors
    ws.on("error", (err) => {
      logger.error({ sessionName, err }, "WebSocket error");
      ptyProcess.kill();
    });
  }
}
```

**Key differences from tmux-web:**
- **No input handling** - We don't forward user input to PTY (agents control the session)
- **Multiple PTYs per session** - Multiple viewers can attach simultaneously
- **Fixed dimensions** - No resize events (or use sane defaults)

**Why not use `tmux capture-pane`?**
- Polling-based (inefficient, adds latency)
- Requires parsing tmux output format
- Misses real-time updates between polls
- No terminal control sequence support (colors, cursor)
- PTY approach is simpler and more robust

---

## Lesson 3: Security - Never Interpolate Shell Commands

### What tmux-web Does

**Always uses `execFile()` with argument arrays:**
```typescript
// backend/src/tmux-controller.ts

// ✅ CORRECT - Arguments passed as array
await execFileAsync(TMUX_PATH, ["list-sessions", "-F", format]);
await execFileAsync(TMUX_PATH, ["new-session", "-d", "-s", sessionName]);
await execFileAsync(TMUX_PATH, ["kill-session", "-t", sessionName]);

// ❌ NEVER DO THIS (command injection vulnerability)
await execAsync(`tmux kill-session -t ${sessionName}`);
```

**Why this matters:**
```typescript
// With exec() + interpolation:
const sessionName = "test; rm -rf /";
await exec(`tmux kill-session -t ${sessionName}`);
// Executes: tmux kill-session -t test; rm -rf /
// 💀 DISASTER

// With execFile() + array:
await execFile("tmux", ["kill-session", "-t", "test; rm -rf /"]);
// Attempts: tmux kill-session -t "test; rm -rf /"
// ✅ Safely fails (no such session)
```

### How FactoryFactory Should Implement

**Strict input validation:**
```typescript
// src/backend/clients/tmux.client.ts

const SESSION_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export class TmuxClient {
  private validateSessionName(name: string): void {
    if (!SESSION_NAME_REGEX.test(name)) {
      throw new Error(`Invalid session name: ${name}`);
    }
  }

  async createSession(name: string, worktreePath: string): Promise<void> {
    this.validateSessionName(name);

    // ✅ CORRECT - Array arguments
    await execFileAsync(this.tmuxPath, [
      "new-session",
      "-d",                    // Detached
      "-s", name,             // Session name
      "-c", worktreePath      // Working directory
    ]);
  }

  async killSession(name: string): Promise<void> {
    this.validateSessionName(name);

    await execFileAsync(this.tmuxPath, ["kill-session", "-t", name]);
  }

  async hasSession(name: string): Promise<boolean> {
    this.validateSessionName(name);

    try {
      await execFileAsync(this.tmuxPath, ["has-session", "-t", name]);
      return true;
    } catch {
      return false;
    }
  }
}
```

**Additional security measures:**
- Validate session names match agent naming convention
- Validate worktree paths are within expected base directory
- Use Zod schemas for all inputs (like tmux-web does)
- Never pass user input directly to shell commands

---

## Lesson 4: Input Validation with Zod Schemas

### What tmux-web Does

**Comprehensive runtime validation:**
```typescript
// backend/src/schemas.ts

// Session name validation
export const sessionNameSchema = z
  .string()
  .min(1, "Session name is required")
  .max(64, "Session name too long")
  .regex(/^[a-zA-Z0-9_-]+$/, "Invalid characters in session name");

// Terminal dimensions with safe bounds
export const terminalDimensionsSchema = z.object({
  cols: z.coerce.number().int().min(10).max(500),
  rows: z.coerce.number().int().min(5).max(200),
});

// WebSocket message validation (discriminated union)
export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("input"),
    data: z.string().max(10240), // Prevent memory exhaustion
  }),
  z.object({
    type: z.literal("resize"),
    cols: z.coerce.number().int().min(10).max(500),
    rows: z.coerce.number().int().min(5).max(200),
  }),
]);

// Environment config validation
export const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(["development", "production"]).default("development"),
  ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),
  MAX_CONNECTIONS: z.coerce.number().int().positive().default(100),
  MAX_CONNECTIONS_PER_SESSION: z.coerce.number().int().positive().default(10),
});
```

**Benefits:**
- **Type safety at runtime** - Catches invalid data before processing
- **Automatic type inference** - TypeScript types derived from schemas
- **Clear error messages** - Zod provides detailed validation errors
- **Self-documenting** - Schemas serve as documentation

### How FactoryFactory Should Implement

**Define schemas for all tmux operations:**
```typescript
// src/backend/clients/tmux.schemas.ts

import { z } from "zod";

// Session name validation (matches tmux constraints)
export const tmuxSessionNameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,64}$/, "Invalid tmux session name");

// Session creation request
export const createSessionSchema = z.object({
  name: tmuxSessionNameSchema,
  worktreePath: z.string().min(1),
  initialCommand: z.string().optional(),
});

// WebSocket connection parameters
export const terminalConnectionSchema = z.object({
  session: tmuxSessionNameSchema,
  cols: z.coerce.number().int().min(40).max(300).default(120),
  rows: z.coerce.number().int().min(10).max(100).default(30),
});

// Server message types (sent to client)
export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("output"),
    data: z.string(),
  }),
  z.object({
    type: z.literal("session-ended"),
    exitCode: z.number().int().optional(),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
  }),
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
```

**Use in tRPC routers:**
```typescript
// src/backend/routers/api/tmux.router.ts

export const tmuxRouter = router({
  createSession: publicProcedure
    .input(createSessionSchema)
    .mutation(async ({ input }) => {
      // Input already validated by Zod
      return tmuxClient.createSession(input.name, input.worktreePath);
    }),

  listSessions: publicProcedure
    .query(async () => {
      return tmuxClient.listSessions();
    }),
});
```

**Use in WebSocket handler:**
```typescript
// src/backend/index.ts

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url!, `http://${request.headers.host}`);

  if (url.pathname === "/terminal") {
    // Validate query parameters
    const params = terminalConnectionSchema.safeParse({
      session: url.searchParams.get("session"),
      cols: url.searchParams.get("cols"),
      rows: url.searchParams.get("rows"),
    });

    if (!params.success) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      tmuxClient.attachReadOnly(params.data.session, ws);
    });
  }
});
```

---

## Lesson 5: Resource Management & Connection Pooling

### What tmux-web Does

**Tracks connections globally and per-session:**
```typescript
// backend/src/pty-manager.ts

export class PtyManager {
  private connections = new Map<WebSocket, SessionConnection>();
  private sessionCounts = new Map<string, number>();

  connect(ws: WebSocket, sessionName: string, cols: number, rows: number): void {
    // Check global limit
    if (this.connections.size >= MAX_CONNECTIONS) {
      ws.send(JSON.stringify({
        type: "error",
        message: "Maximum connections reached"
      }));
      ws.close();
      return;
    }

    // Check per-session limit
    const sessionCount = this.sessionCounts.get(sessionName) || 0;
    if (sessionCount >= MAX_CONNECTIONS_PER_SESSION) {
      ws.send(JSON.stringify({
        type: "error",
        message: "Maximum connections for this session reached"
      }));
      ws.close();
      return;
    }

    // Increment counters
    this.sessionCounts.set(sessionName, sessionCount + 1);

    // Spawn PTY and register connection
    const ptyProcess = this.spawnPty(sessionName, cols, rows);
    this.connections.set(ws, { ptyProcess, sessionName });

    // Cleanup on disconnect
    ws.on("close", () => {
      ptyProcess.kill();
      this.connections.delete(ws);
      const count = this.sessionCounts.get(sessionName)! - 1;
      if (count === 0) {
        this.sessionCounts.delete(sessionName);
      } else {
        this.sessionCounts.set(sessionName, count);
      }
    });
  }
}
```

**Graceful shutdown:**
```typescript
// backend/src/index.ts

process.on("SIGTERM", () => {
  logger.info("SIGTERM received, closing server gracefully");

  // Close HTTP server (stops accepting new connections)
  server.close(() => {
    logger.info("HTTP server closed");

    // Close all WebSocket connections
    ptyManager.closeAll();

    // Exit process
    process.exit(0);
  });
});
```

### How FactoryFactory Should Implement

**Connection tracking with cleanup:**
```typescript
// src/backend/clients/tmux.client.ts

export class TmuxClient {
  private activeConnections = new Map<WebSocket, ConnectionInfo>();
  private sessionViewers = new Map<string, Set<WebSocket>>();

  attachReadOnly(sessionName: string, ws: WebSocket): void {
    const ptyProcess = pty.spawn(this.tmuxPath, ["attach-session", "-t", sessionName], {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
    });

    // Track connection
    this.activeConnections.set(ws, { sessionName, ptyProcess });

    if (!this.sessionViewers.has(sessionName)) {
      this.sessionViewers.set(sessionName, new Set());
    }
    this.sessionViewers.get(sessionName)!.add(ws);

    // Forward output
    ptyProcess.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "output", data }));
      }
    });

    // Cleanup on disconnect
    ws.on("close", () => {
      this.cleanup(ws);
    });

    ws.on("error", () => {
      this.cleanup(ws);
    });

    // Handle PTY exit
    ptyProcess.onExit(() => {
      ws.send(JSON.stringify({ type: "session-ended" }));
      this.cleanup(ws);
    });
  }

  private cleanup(ws: WebSocket): void {
    const info = this.activeConnections.get(ws);
    if (info) {
      info.ptyProcess.kill();
      this.activeConnections.delete(ws);

      const viewers = this.sessionViewers.get(info.sessionName);
      if (viewers) {
        viewers.delete(ws);
        if (viewers.size === 0) {
          this.sessionViewers.delete(info.sessionName);
        }
      }
    }
  }

  /**
   * Graceful shutdown: close all PTY connections
   */
  closeAll(): void {
    logger.info({ count: this.activeConnections.size }, "Closing all PTY connections");

    for (const [ws, info] of this.activeConnections.entries()) {
      try {
        info.ptyProcess.kill();
        ws.close();
      } catch (err) {
        logger.error({ err, sessionName: info.sessionName }, "Error closing connection");
      }
    }

    this.activeConnections.clear();
    this.sessionViewers.clear();
  }

  /**
   * Get viewer count for a session (for monitoring)
   */
  getViewerCount(sessionName: string): number {
    return this.sessionViewers.get(sessionName)?.size || 0;
  }
}
```

**Health monitoring endpoint:**
```typescript
// src/backend/routers/api/tmux.router.ts

export const tmuxRouter = router({
  getSessionStats: publicProcedure
    .input(z.object({ sessionName: tmuxSessionNameSchema }))
    .query(async ({ input }) => {
      return {
        exists: await tmuxClient.hasSession(input.sessionName),
        viewers: tmuxClient.getViewerCount(input.sessionName),
      };
    }),

  getSystemStats: publicProcedure
    .query(async () => {
      return {
        totalConnections: tmuxClient.getTotalConnections(),
        sessions: await tmuxClient.listSessions(),
      };
    }),
});
```

---

## Lesson 6: Frontend Integration with xterm.js

### What tmux-web Does

**Dynamic import to prevent SSR issues:**
```typescript
// frontend/src/components/Terminal.tsx

useEffect(() => {
  let term: Terminal | null = null;
  let fitAddon: FitAddon | null = null;

  const initTerminal = async () => {
    // Dynamic import (client-side only)
    const { Terminal } = await import("@xterm/xterm");
    const { FitAddon } = await import("@xterm/addon-fit");
    const { WebLinksAddon } = await import("@xterm/addon-web-links");

    term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: "#0a0a0a",
        foreground: "#ededed",
        cursor: "#ededed",
        // ... full color palette
      },
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.open(terminalRef.current!);
    fitAddon.fit();

    // Mark as ready (triggers WebSocket connection)
    setTerminalReady(true);
  };

  initTerminal();

  return () => {
    term?.dispose();
  };
}, []);
```

**WebSocket connection after terminal ready:**
```typescript
useEffect(() => {
  if (!terminalReady || !session) return;

  const ws = new WebSocket(
    `ws://localhost:3001/terminal?session=${session}&cols=${term.cols}&rows=${term.rows}`
  );

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "output") {
      term.write(msg.data);
    } else if (msg.type === "exit") {
      term.write("\r\n[Session ended]\r\n");
    }
  };

  ws.onclose = () => {
    term.write("\r\n[Disconnected]\r\n");
  };

  return () => {
    ws.close();
  };
}, [terminalReady, session]);
```

**Responsive terminal sizing:**
```typescript
useEffect(() => {
  if (!terminalReady || !fitAddon) return;

  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();

    // Send new dimensions to backend
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "resize",
        cols: term.cols,
        rows: term.rows,
      }));
    }
  });

  resizeObserver.observe(terminalRef.current!);

  return () => {
    resizeObserver.disconnect();
  };
}, [terminalReady, fitAddon]);
```

### How FactoryFactory Should Implement

**Reusable Terminal component (read-only):**
```typescript
// src/frontend/components/tmux-terminal.tsx

"use client";

import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

interface TmuxTerminalProps {
  sessionName: string;
  className?: string;
}

export function TmuxTerminal({ sessionName, className }: TmuxTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [isReady, setIsReady] = useState(false);

  // Initialize terminal
  useEffect(() => {
    let term: Terminal;
    let fitAddon: FitAddon;

    const init = async () => {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      const { WebLinksAddon } = await import("@xterm/addon-web-links");

      term = new Terminal({
        cursorBlink: false,  // Read-only, no cursor
        disableStdin: true,   // No input allowed
        fontSize: 13,
        fontFamily: 'ui-monospace, "Cascadia Code", "Courier New", monospace',
        theme: {
          background: "#1e1e1e",
          foreground: "#d4d4d4",
          // VSCode dark theme colors
        },
      });

      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());

      term.open(terminalRef.current!);
      fitAddon.fit();

      termRef.current = term;
      setIsReady(true);
    };

    init();

    return () => {
      term?.dispose();
    };
  }, []);

  // Connect WebSocket
  useEffect(() => {
    if (!isReady || !termRef.current) return;

    const term = termRef.current;
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
    const wsUrl = apiUrl.replace("http", "ws");

    const ws = new WebSocket(
      `${wsUrl}/terminal?session=${encodeURIComponent(sessionName)}&cols=${term.cols}&rows=${term.rows}`
    );

    ws.onopen = () => {
      console.log(`Connected to session: ${sessionName}`);
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === "output") {
        term.write(msg.data);
      } else if (msg.type === "session-ended") {
        term.write("\r\n\r\n[Agent session ended]\r\n");
      } else if (msg.type === "error") {
        term.write(`\r\n\r\n[Error: ${msg.message}]\r\n`);
      }
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
      term.write("\r\n[Connection error]\r\n");
    };

    ws.onclose = () => {
      console.log(`Disconnected from session: ${sessionName}`);
      term.write("\r\n[Disconnected]\r\n");
    };

    wsRef.current = ws;

    return () => {
      ws.close();
    };
  }, [isReady, sessionName]);

  // Auto-reconnect when session changes
  useEffect(() => {
    if (termRef.current) {
      termRef.current.clear();  // Clear terminal on session change
    }
  }, [sessionName]);

  return (
    <div className={className}>
      <div ref={terminalRef} className="h-full w-full" />
    </div>
  );
}
```

**Usage in agent detail page:**
```typescript
// src/frontend/app/agents/[id]/page.tsx

import { TmuxTerminal } from "@/components/tmux-terminal";
import { trpc } from "@/lib/trpc";

export default function AgentPage({ params }: { params: { id: string } }) {
  const { data: agent } = trpc.agent.getById.useQuery({ id: params.id });

  if (!agent) return <div>Loading...</div>;

  return (
    <div className="flex h-screen flex-col">
      <header className="border-b p-4">
        <h1 className="text-2xl font-bold">{agent.type} Agent</h1>
        <p className="text-sm text-gray-600">Session: {agent.tmuxSession}</p>
      </header>

      <main className="flex-1 p-4">
        <TmuxTerminal
          sessionName={agent.tmuxSession}
          className="h-full rounded-lg border bg-[#1e1e1e]"
        />
      </main>
    </div>
  );
}
```

**Key differences for FactoryFactory:**
- `disableStdin: true` - No user input (read-only)
- `cursorBlink: false` - No cursor (read-only)
- Auto-reconnect on session change
- Clear terminal when switching agents
- No resize handling to PTY (fixed dimensions)

---

## Lesson 7: Structured Logging with Pino

### What tmux-web Does

**Logger setup with contextual child loggers:**
```typescript
// backend/src/logger.ts

import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: process.env.NODE_ENV === "development"
    ? { target: "pino-pretty", options: { colorize: true } }
    : undefined,
});

// Create child loggers with context
export function createLogger(module: string) {
  return logger.child({ module });
}
```

**Usage throughout codebase:**
```typescript
// backend/src/pty-manager.ts

const log = createLogger("pty-manager");

export class PtyManager {
  connect(ws: WebSocket, sessionName: string, cols: number, rows: number): void {
    log.info({ sessionName, cols, rows }, "New terminal connection");

    const ptyProcess = pty.spawn(...);
    const pid = ptyProcess.pid;

    log.info({ sessionName, pid }, "PTY process spawned");

    ws.on("close", () => {
      log.info({ sessionName, pid }, "Connection closed, killing PTY");
      ptyProcess.kill();
    });

    ws.on("error", (error) => {
      log.error({ sessionName, pid, error }, "WebSocket error");
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      log.info({ sessionName, pid, exitCode, signal }, "PTY process exited");
    });
  }
}
```

**Benefits of structured logging:**
```json
// Example log output (development)
{
  "level": 30,
  "time": 1706122345678,
  "module": "pty-manager",
  "sessionName": "agent-worker-abc123",
  "pid": 12345,
  "cols": 120,
  "rows": 30,
  "msg": "New terminal connection"
}

// Can be queried in production:
// - Find all logs for sessionName="agent-worker-abc123"
// - Find all PTY exits with non-zero exitCode
// - Trace lifecycle of specific PID
```

### How FactoryFactory Should Implement

**Consistent logger setup:**
```typescript
// src/backend/lib/logger.ts

import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: process.env.NODE_ENV === "development"
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss",
          ignore: "pid,hostname",
        },
      }
    : undefined,
});

export function createLogger(module: string) {
  return logger.child({ module });
}
```

**Use in tmux client:**
```typescript
// src/backend/clients/tmux.client.ts

import { createLogger } from "../lib/logger";

const log = createLogger("tmux-client");

export class TmuxClient {
  async createSession(name: string, worktreePath: string): Promise<void> {
    log.info({ sessionName: name, worktreePath }, "Creating tmux session");

    try {
      await execFileAsync(this.tmuxPath, [
        "new-session", "-d", "-s", name, "-c", worktreePath
      ]);

      log.info({ sessionName: name }, "Session created successfully");
    } catch (error) {
      log.error({ sessionName: name, error }, "Failed to create session");
      throw error;
    }
  }

  async killSession(name: string): Promise<void> {
    log.info({ sessionName: name }, "Killing tmux session");

    try {
      await execFileAsync(this.tmuxPath, ["kill-session", "-t", name]);
      log.info({ sessionName: name }, "Session killed successfully");
    } catch (error) {
      log.error({ sessionName: name, error }, "Failed to kill session");
      throw error;
    }
  }

  attachReadOnly(sessionName: string, ws: WebSocket): void {
    log.info({ sessionName }, "Attaching read-only viewer");

    const ptyProcess = pty.spawn(...);
    const pid = ptyProcess.pid;

    log.info({ sessionName, pid }, "PTY spawned for viewer");

    ws.on("close", () => {
      log.info({ sessionName, pid }, "Viewer disconnected");
      ptyProcess.kill();
    });

    ptyProcess.onExit(({ exitCode }) => {
      log.info({ sessionName, pid, exitCode }, "PTY exited");
    });
  }
}
```

**Key logging points for FactoryFactory:**
- Agent creation/termination
- Tmux session lifecycle (create, attach, kill)
- PTY spawn/exit events
- WebSocket connections/disconnections
- Git operations (worktree creation, PR creation)
- Mail sent/received
- Task state transitions

---

## Lesson 8: Error Handling Patterns

### What tmux-web Does

**Custom error classes:**
```typescript
// backend/src/errors.ts

export class TmuxError extends Error {
  constructor(message: string, public readonly sessionName?: string) {
    super(message);
    this.name = "TmuxError";
  }
}

export class SessionNotFoundError extends TmuxError {
  constructor(sessionName: string) {
    super(`Session not found: ${sessionName}`, sessionName);
    this.name = "SessionNotFoundError";
  }
}

export class ConnectionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionLimitError";
  }
}
```

**Graceful error handling with logging:**
```typescript
// backend/src/tmux-controller.ts

async killSession(name: string): Promise<void> {
  try {
    await execFileAsync(TMUX_PATH, ["kill-session", "-t", name]);
    logger.info({ sessionName: name }, "Session killed");
  } catch (error) {
    // tmux returns non-zero if session doesn't exist
    if (error instanceof Error && error.message.includes("no such session")) {
      throw new SessionNotFoundError(name);
    }

    logger.error({ sessionName: name, error }, "Failed to kill session");
    throw new TmuxError(`Failed to kill session: ${name}`);
  }
}
```

**API error responses:**
```typescript
// backend/src/routes/sessions.ts

router.delete("/sessions/:name", async (req, res) => {
  try {
    const { name } = sessionNameSchema.parse(req.params);
    await tmuxController.killSession(name);
    res.json({ success: true });
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      res.status(404).json({ error: error.message });
    } else if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.errors });
    } else {
      logger.error({ error }, "Unexpected error in DELETE /sessions/:name");
      res.status(500).json({ error: "Internal server error" });
    }
  }
});
```

### How FactoryFactory Should Implement

**Custom error classes for tmux operations:**
```typescript
// src/backend/clients/tmux.errors.ts

export class TmuxError extends Error {
  constructor(
    message: string,
    public readonly sessionName?: string,
    public readonly code?: string
  ) {
    super(message);
    this.name = "TmuxError";
  }
}

export class SessionNotFoundError extends TmuxError {
  constructor(sessionName: string) {
    super(`Tmux session not found: ${sessionName}`, sessionName, "SESSION_NOT_FOUND");
    this.name = "SessionNotFoundError";
  }
}

export class SessionAlreadyExistsError extends TmuxError {
  constructor(sessionName: string) {
    super(`Tmux session already exists: ${sessionName}`, sessionName, "SESSION_EXISTS");
    this.name = "SessionAlreadyExistsError";
  }
}

export class PtySpawnError extends TmuxError {
  constructor(sessionName: string, cause?: Error) {
    super(`Failed to spawn PTY for session: ${sessionName}`, sessionName, "PTY_SPAWN_FAILED");
    this.name = "PtySpawnError";
    this.cause = cause;
  }
}
```

**Robust error handling in tmux client:**
```typescript
// src/backend/clients/tmux.client.ts

export class TmuxClient {
  async createSession(name: string, worktreePath: string): Promise<void> {
    // Check if session already exists
    const exists = await this.hasSession(name);
    if (exists) {
      throw new SessionAlreadyExistsError(name);
    }

    try {
      await execFileAsync(this.tmuxPath, [
        "new-session", "-d", "-s", name, "-c", worktreePath
      ]);
      log.info({ sessionName: name }, "Session created");
    } catch (error) {
      log.error({ sessionName: name, error }, "Failed to create session");
      throw new TmuxError(`Failed to create session: ${name}`, name);
    }
  }

  async killSession(name: string): Promise<void> {
    try {
      await execFileAsync(this.tmuxPath, ["kill-session", "-t", name]);
      log.info({ sessionName: name }, "Session killed");
    } catch (error) {
      if (error instanceof Error && error.message.includes("no such session")) {
        throw new SessionNotFoundError(name);
      }

      log.error({ sessionName: name, error }, "Failed to kill session");
      throw new TmuxError(`Failed to kill session: ${name}`, name);
    }
  }

  attachReadOnly(sessionName: string, ws: WebSocket): void {
    try {
      const ptyProcess = pty.spawn(this.tmuxPath, ["attach-session", "-t", sessionName], {
        name: "xterm-256color",
        cols: 120,
        rows: 30,
      });

      // Handle PTY spawn failure
      ptyProcess.onExit(({ exitCode, signal }) => {
        if (exitCode !== 0) {
          log.error({ sessionName, exitCode, signal }, "PTY exited with error");
          ws.send(JSON.stringify({
            type: "error",
            message: `Session exited with code ${exitCode}`,
          }));
        }
        ws.close();
      });

      // ... rest of implementation
    } catch (error) {
      log.error({ sessionName, error }, "Failed to spawn PTY");
      throw new PtySpawnError(sessionName, error as Error);
    }
  }
}
```

**tRPC error handling:**
```typescript
// src/backend/routers/api/tmux.router.ts

import { TRPCError } from "@trpc/server";

export const tmuxRouter = router({
  killSession: publicProcedure
    .input(z.object({ sessionName: tmuxSessionNameSchema }))
    .mutation(async ({ input }) => {
      try {
        await tmuxClient.killSession(input.sessionName);
        return { success: true };
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: error.message,
          });
        }

        log.error({ error }, "Failed to kill session");
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to kill session",
        });
      }
    }),
});
```

---

## Lesson 9: Testing Strategy

### What tmux-web Does

**Unit tests for pure logic:**
```typescript
// backend/src/tmux-controller.test.ts

describe("TmuxController", () => {
  describe("validateSessionName", () => {
    it("accepts valid session names", () => {
      expect(() => validateSessionName("my-session")).not.toThrow();
      expect(() => validateSessionName("session_123")).not.toThrow();
    });

    it("rejects invalid session names", () => {
      expect(() => validateSessionName("")).toThrow();
      expect(() => validateSessionName("a".repeat(65))).toThrow();
      expect(() => validateSessionName("invalid/name")).toThrow();
      expect(() => validateSessionName("test;rm -rf /")).toThrow();
    });
  });
});
```

**Integration tests (skipped by default):**
```typescript
// backend/src/tmux-controller.integration.test.ts

describe.skip("TmuxController integration", () => {
  let controller: TmuxController;

  beforeAll(() => {
    // Requires tmux to be installed
    controller = new TmuxController();
  });

  it("creates and kills a session", async () => {
    const name = "test-session-" + Date.now();

    await controller.createSession(name);
    expect(await controller.hasSession(name)).toBe(true);

    await controller.killSession(name);
    expect(await controller.hasSession(name)).toBe(false);
  });
});
```

### How FactoryFactory Should Implement

**Unit test tmux session name validation:**
```typescript
// src/backend/clients/tmux.client.test.ts

import { describe, it, expect } from "vitest";
import { TmuxClient } from "./tmux.client";
import { SessionAlreadyExistsError } from "./tmux.errors";

describe("TmuxClient", () => {
  describe("validateSessionName", () => {
    it("accepts valid agent session names", () => {
      const client = new TmuxClient();

      expect(() => client["validateSessionName"]("agent-worker-abc123")).not.toThrow();
      expect(() => client["validateSessionName"]("agent-supervisor-xyz789")).not.toThrow();
    });

    it("rejects invalid session names", () => {
      const client = new TmuxClient();

      expect(() => client["validateSessionName"]("")).toThrow();
      expect(() => client["validateSessionName"]("invalid/session")).toThrow();
      expect(() => client["validateSessionName"]("test;rm -rf /")).toThrow();
    });
  });
});
```

**Integration tests for tmux operations:**
```typescript
// src/backend/clients/tmux.client.integration.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TmuxClient } from "./tmux.client";
import { SessionNotFoundError } from "./tmux.errors";

describe.skip("TmuxClient integration", () => {
  let client: TmuxClient;
  const testSessions: string[] = [];

  beforeAll(() => {
    client = new TmuxClient();
  });

  afterAll(async () => {
    // Cleanup test sessions
    for (const session of testSessions) {
      try {
        await client.killSession(session);
      } catch {
        // Ignore errors
      }
    }
  });

  it("creates a session in specified worktree", async () => {
    const name = `test-${Date.now()}`;
    testSessions.push(name);

    await client.createSession(name, "/tmp");

    expect(await client.hasSession(name)).toBe(true);

    const sessions = await client.listSessions();
    expect(sessions.some(s => s.name === name)).toBe(true);
  });

  it("throws error when killing non-existent session", async () => {
    await expect(
      client.killSession("non-existent-session")
    ).rejects.toThrow(SessionNotFoundError);
  });
});
```

---

## Lesson 10: Configuration Management

### What tmux-web Does

**Environment variable validation with Zod:**
```typescript
// backend/src/config.ts

import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(["development", "production"]).default("development"),
  ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),
  MAX_CONNECTIONS: z.coerce.number().int().positive().default(100),
  MAX_CONNECTIONS_PER_SESSION: z.coerce.number().int().positive().default(10),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

// Validate and export config
export const env = envSchema.parse(process.env);
```

**Tmux path auto-detection:**
```typescript
// backend/src/tmux-controller.ts

function findTmuxPath(): string {
  const possiblePaths = [
    "/opt/homebrew/bin/tmux",  // Homebrew on Apple Silicon
    "/usr/local/bin/tmux",      // Homebrew on Intel
    "/usr/bin/tmux",            // System default
  ];

  for (const path of possiblePaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  // Fallback to PATH
  return "tmux";
}

export const TMUX_PATH = process.env.TMUX_PATH || findTmuxPath();
```

### How FactoryFactory Should Implement

**Comprehensive config validation:**
```typescript
// src/backend/config/env.ts

import { z } from "zod";
import { existsSync } from "fs";

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),

  // Claude API
  CLAUDE_API_KEY: z.string().min(1),
  CLAUDE_MODEL: z.string().default("claude-sonnet-4-5-20250929"),

  // Inngest
  INNGEST_EVENT_KEY: z.string().min(1),
  INNGEST_SIGNING_KEY: z.string().min(1),

  // Git
  GIT_BASE_REPO_PATH: z.string().refine(
    (path) => existsSync(path),
    { message: "GIT_BASE_REPO_PATH must exist" }
  ),
  GIT_WORKTREE_BASE: z.string(),

  // Tmux
  TMUX_PATH: z.string().optional(),
  TMUX_SOCKET_PATH: z.string().default("/tmp/tmux-factoryfactory"),

  // Server
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // Frontend
  NEXT_PUBLIC_API_URL: z.string().url().default("http://localhost:3001"),

  // Limits
  MAX_TERMINAL_CONNECTIONS: z.coerce.number().int().positive().default(100),
  MAX_VIEWERS_PER_SESSION: z.coerce.number().int().positive().default(10),
});

export type Env = z.infer<typeof envSchema>;

// Validate and export
export const env = envSchema.parse(process.env);
```

**Tmux configuration:**
```typescript
// src/backend/clients/tmux.config.ts

import { existsSync } from "fs";
import { env } from "../config/env";

/**
 * Auto-detect tmux binary path
 */
function findTmuxPath(): string {
  if (env.TMUX_PATH && existsSync(env.TMUX_PATH)) {
    return env.TMUX_PATH;
  }

  const possiblePaths = [
    "/opt/homebrew/bin/tmux",
    "/usr/local/bin/tmux",
    "/usr/bin/tmux",
  ];

  for (const path of possiblePaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  return "tmux"; // Fallback to PATH
}

export const TMUX_PATH = findTmuxPath();
export const TMUX_SOCKET_PATH = env.TMUX_SOCKET_PATH;
export const MAX_TERMINAL_CONNECTIONS = env.MAX_TERMINAL_CONNECTIONS;
export const MAX_VIEWERS_PER_SESSION = env.MAX_VIEWERS_PER_SESSION;
```

---

## Summary: Implementation Checklist for FactoryFactory

### Phase 1: Backend Tmux Client

- [ ] Install dependencies: `node-pty`, `ws`, `zod`, `pino`
- [ ] Create `src/backend/clients/tmux.client.ts`
  - [ ] Session name validation (regex, Zod schema)
  - [ ] `createSession(name, worktreePath)` - use `execFile()`
  - [ ] `killSession(name)` - use `execFile()`
  - [ ] `hasSession(name)` - use `execFile()`
  - [ ] `listSessions()` - parse `tmux list-sessions -F`
  - [ ] `attachReadOnly(sessionName, ws)` - spawn PTY, stream output
  - [ ] Connection tracking (global + per-session)
  - [ ] Graceful cleanup handlers
- [ ] Create `src/backend/clients/tmux.errors.ts`
  - [ ] `TmuxError`, `SessionNotFoundError`, `SessionAlreadyExistsError`, `PtySpawnError`
- [ ] Create `src/backend/clients/tmux.schemas.ts`
  - [ ] Session name schema
  - [ ] Terminal connection schema
  - [ ] Server message schema (discriminated union)
- [ ] Unit tests for validation logic
- [ ] Integration tests (skip by default)

### Phase 2: Backend API Routes

- [ ] Create `src/backend/routers/api/tmux.router.ts`
  - [ ] `listSessions` - return all tmux sessions
  - [ ] `getSession(sessionName)` - return session info
  - [ ] `createSession(name, worktreePath)` - create new session
  - [ ] `killSession(name)` - terminate session
  - [ ] `getSessionStats(sessionName)` - viewer count, status
- [ ] WebSocket upgrade handler in `src/backend/index.ts`
  - [ ] Validate query params (session, cols, rows)
  - [ ] Call `tmuxClient.attachReadOnly()`
  - [ ] Handle errors (send error message, close connection)
- [ ] Health endpoint with connection stats

### Phase 3: Frontend Terminal Component

- [ ] Install dependencies: `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`
- [ ] Create `src/frontend/components/tmux-terminal.tsx`
  - [ ] Dynamic import xterm.js (client-side only)
  - [ ] Initialize Terminal with theme
  - [ ] Load FitAddon and WebLinksAddon
  - [ ] Connect WebSocket after terminal ready
  - [ ] Handle server messages (output, error, session-ended)
  - [ ] Auto-reconnect on session change
  - [ ] Clear terminal when switching sessions
  - [ ] ResizeObserver for responsive sizing (optional)
- [ ] Import xterm.js CSS in `globals.css`
- [ ] Create agent detail page with terminal viewer

### Phase 4: Agent Integration

- [ ] Update agent creation flow to:
  - [ ] Create tmux session when agent starts
  - [ ] Store `tmuxSession` name in agent record
  - [ ] Start Claude SDK agent in tmux session (via `tmux send-keys`)
- [ ] Update agent cleanup flow to:
  - [ ] Kill tmux session when agent terminates
  - [ ] Close all active PTY connections for that session
- [ ] Add tmux session column to agent monitor UI
- [ ] Add "View Terminal" button linking to agent detail page

### Phase 5: Monitoring & Observability

- [ ] Add structured logging for all tmux operations
- [ ] Track PTY connection metrics (total, per-session)
- [ ] Health check endpoint with tmux session status
- [ ] DecisionLog entries for tmux operations
- [ ] Error tracking for PTY spawn failures

### Phase 6: Testing & Documentation

- [ ] Unit tests for session name validation
- [ ] Unit tests for Zod schemas
- [ ] Integration tests (require tmux)
- [ ] Document tmux integration in README
- [ ] Add tmux troubleshooting guide

---

## Key Design Decisions for FactoryFactory

### 1. Read-Only Terminal Viewing

**Decision:** Implement read-only PTY streaming (no user input).

**Rationale:**
- Agents control their sessions via Claude SDK (not terminal input)
- Humans only need to monitor, not interact
- Simpler security model (no command injection risk from UI)
- Multiple viewers can watch without interference

**Implementation:**
```typescript
terminal = new Terminal({
  disableStdin: true,   // No input allowed
  cursorBlink: false,   // No cursor (read-only)
});

// No input handling in WebSocket
// Only output streaming: PTY → WebSocket → Terminal
```

### 2. Multiple Viewers Per Session

**Decision:** Allow multiple humans to view same agent session.

**Rationale:**
- Team collaboration (multiple developers monitoring same agent)
- Multiple browser tabs (same user, different views)
- No conflict since read-only

**Implementation:**
```typescript
// Each viewer gets its own PTY process
// All attach to same tmux session (read-only)
const ptyProcess = pty.spawn(TMUX_PATH, ["attach-session", "-t", sessionName], {
  name: "xterm-256color",
  cols: 120,
  rows: 30,
});
```

### 3. Fixed Terminal Dimensions

**Decision:** Use fixed dimensions (120x30) for all PTY connections.

**Rationale:**
- Agents don't need dynamic resizing
- Simplifies implementation (no resize protocol)
- Consistent view across all viewers
- 120x30 is standard terminal size

**Alternative (if needed later):**
- Allow resize per viewer
- Send resize events to PTY: `ptyProcess.resize(cols, rows)`

### 4. Session Lifecycle Management

**Decision:** Tmux sessions created/destroyed by agent lifecycle, not manually.

**Rationale:**
- 1:1 mapping between agent and tmux session
- Automatic cleanup when agent terminates
- No orphaned sessions
- Simplifies UI (no manual session management)

**Implementation:**
```typescript
// Agent creation
async createAgent(type: AgentType, taskId?: string): Promise<Agent> {
  const agent = await db.agent.create({ ... });
  const sessionName = `agent-${agent.id}`;

  // Create tmux session in task worktree
  await tmuxClient.createSession(sessionName, worktreePath);

  // Start Claude SDK agent in session
  await tmuxClient.sendKeys(sessionName, "npm run agent:start");

  return agent;
}

// Agent cleanup
async killAgent(agentId: string): Promise<void> {
  const agent = await db.agent.findUnique({ where: { id: agentId } });

  // Kill tmux session (terminates Claude SDK agent)
  await tmuxClient.killSession(agent.tmuxSession);

  // Close all PTY connections for this session
  tmuxClient.closeSessionConnections(agent.tmuxSession);

  // Update agent state
  await db.agent.update({
    where: { id: agentId },
    data: { state: "FAILED" },
  });
}
```

### 5. Error Handling Philosophy

**Decision:** Fail fast with clear error messages, log everything.

**Rationale:**
- tmux errors indicate serious issues (session creation failed, PTY spawn failed)
- Better to surface errors immediately than silently fail
- Structured logging enables debugging

**Implementation:**
- Custom error classes (SessionNotFoundError, PtySpawnError)
- Log all tmux operations with context
- Propagate errors to tRPC/WebSocket clients
- DecisionLog for audit trail

---

## Additional Recommendations

### 1. Tmux Configuration

Create a custom tmux config for FactoryFactory sessions:

```bash
# ~/.tmux-factoryfactory.conf

# Increase scrollback buffer (agents may produce lots of output)
set-option -g history-limit 50000

# Enable mouse support (for human viewers)
set-option -g mouse on

# Use 256 colors
set-option -g default-terminal "screen-256color"

# Disable status bar (cleaner UI in web view)
set-option -g status off

# Aggressive resize (for multiple viewers)
set-window-option -g aggressive-resize on
```

Use with: `tmux -f ~/.tmux-factoryfactory.conf new-session ...`

### 2. PTY Performance Optimization

For high-output agents, consider buffering:

```typescript
let buffer = "";
let flushTimeout: NodeJS.Timeout | null = null;

ptyProcess.onData((data) => {
  buffer += data;

  // Flush buffer every 100ms or when it exceeds 10KB
  if (!flushTimeout) {
    flushTimeout = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "output", data: buffer }));
      }
      buffer = "";
      flushTimeout = null;
    }, 100);
  }

  if (buffer.length > 10240) {
    clearTimeout(flushTimeout);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "output", data: buffer }));
    }
    buffer = "";
    flushTimeout = null;
  }
});
```

### 3. Connection Limits

Recommended limits for production:

```env
MAX_TERMINAL_CONNECTIONS=100        # Total PTY processes
MAX_VIEWERS_PER_SESSION=10          # Viewers per agent
```

Monitor with:

```typescript
tmuxRouter.getSystemStats.query(() => ({
  totalConnections: tmuxClient.getTotalConnections(),
  maxConnections: MAX_TERMINAL_CONNECTIONS,
  utilizationPercent: (totalConnections / MAX_TERMINAL_CONNECTIONS) * 100,
}));
```

### 4. Graceful Degradation

If PTY connection fails, show fallback UI:

```typescript
// Frontend: TmuxTerminal component
const [connectionError, setConnectionError] = useState<string | null>(null);

ws.onerror = (error) => {
  setConnectionError("Failed to connect to agent terminal");
};

if (connectionError) {
  return (
    <div className="flex h-full items-center justify-center bg-gray-900 text-gray-400">
      <div className="text-center">
        <p className="text-lg">{connectionError}</p>
        <button onClick={reconnect} className="mt-4 btn">
          Retry Connection
        </button>
      </div>
    </div>
  );
}
```

### 5. Future Enhancements

- **Tmux pane support:** Agents use split panes (code + tests + logs)
- **Session recording:** Record tmux sessions for playback (`tmux pipe-pane`)
- **Terminal search:** Add xterm.js search addon
- **Copy/paste:** Enable text selection and copy (read-only)
- **Full-screen mode:** Maximize terminal for debugging

---

## Conclusion

The tmux-web codebase provides an excellent foundation for FactoryFactory's tmux integration. The key lessons are:

1. **Dual-channel architecture** (REST for CRUD, WebSocket for streaming)
2. **PTY-based streaming** (don't reinvent terminal emulation)
3. **Security first** (never interpolate shell commands, validate everything)
4. **Structured logging** (essential for debugging distributed agents)
5. **Graceful resource management** (connection limits, cleanup handlers)

By following these patterns, FactoryFactory will have a robust, secure, and performant tmux integration for monitoring multi-agent software development.
