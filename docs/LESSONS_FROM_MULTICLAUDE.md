# Lessons from MultiClaude for FactoryFactory

## Executive Summary

This document analyzes the MultiClaude codebase to extract lessons for implementing FactoryFactory's multi-agent orchestration system. The key insight: **MultiClaude uses a daemon-based architecture with layered abstractions** - a long-running daemon manages state and coordinates agents running in isolated tmux sessions with git worktrees, communicating via Unix sockets (CLI↔daemon) and filesystem messages (agent↔agent).

---

## Architecture Overview

### MultiClaude's Approach

```
CLI (user interface)
    ↕ Unix Socket (JSON-RPC)
Daemon (central coordinator)
    ↕ tmux commands + paste-buffer
    ↕ Filesystem messages (~/.multiclaude/messages/)
    ↕ Git worktree operations
Agents (Claude Code instances in tmux windows)
    ↕ Claude SDK (--append-system-prompt-file, --session-id)
tmux Server + Git Repository
```

### What FactoryFactory Needs

FactoryFactory requires orchestrating multiple agents working on tasks in parallel, with coordination between them. Similar to MultiClaude but with key differences:

**Key differences from MultiClaude:**
- **Web UI instead of CLI** (HTTP/WebSocket vs Unix socket)
- **Database-backed state** (Postgres vs filesystem JSON)
- **Different agent types** (worker/coordinator/reviewer vs supervisor/worker/merge-queue)
- **Task queue system** (Inngest vs manual spawning)
- **API-based coordination** (tRPC/Inngest vs filesystem messages)

---

## Lesson 1: Layered Architecture with Clear Boundaries

### What MultiClaude Does

**Three distinct layers with minimal coupling:**

```go
// Layer 1: Public SDK modules (pkg/*)
pkg/tmux/         // Tmux operations library
pkg/claude/       // Claude runner interface

// Layer 2: Internal daemon (internal/*)
internal/daemon/      // Central coordinator
internal/state/       // Thread-safe state manager
internal/messages/    // Inter-agent IPC
internal/worktree/    // Git operations
internal/socket/      // CLI-daemon communication

// Layer 3: CLI interface (cmd/multiclaude)
cmd/multiclaude/      // User-facing commands
```

**Key architectural patterns:**

1. **Public SDK Modules (`pkg/`):**
   - Reusable, well-documented libraries
   - No dependencies on internal packages
   - Can be imported by other projects
   - Example: `pkg/tmux` provides generic tmux control

2. **Internal Packages (`internal/`):**
   - MultiClaude-specific implementation
   - Encapsulated, not importable externally
   - Heavy use of interfaces for testing

3. **Clear Communication Protocols:**
   - CLI → Daemon: JSON-RPC over Unix socket
   - Daemon → Agent: tmux send-keys (paste-buffer for multiline)
   - Agent → Agent: Filesystem JSON messages
   - Daemon → Git: Direct `git worktree` commands

**File:** `internal/daemon/daemon.go:2312`

```go
type Daemon struct {
    paths        *config.Paths         // File system paths
    state        *state.State          // Thread-safe state manager
    tmux         *tmux.Client          // tmux operations
    logger       *logging.Logger       // Structured logging
    server       *socket.Server        // Unix socket server
    pidFile      *PIDFile              // Process ID management
    claudeRunner *claude.Runner        // Claude CLI runner

    ctx    context.Context             // Graceful shutdown
    cancel context.CancelFunc
    wg     sync.WaitGroup              // Goroutine tracking
}
```

### How FactoryFactory Should Adapt

**Adopt layered architecture with TypeScript:**

```
src/backend/
├── clients/               # Layer 1: External service clients
│   ├── claude.client.ts   # Claude SDK wrapper
│   ├── tmux.client.ts     # Tmux operations
│   └── git.client.ts      # Git worktree operations
├── services/              # Layer 2: Business logic
│   ├── agent.service.ts   # Agent lifecycle management
│   ├── task.service.ts    # Task coordination
│   └── mail.service.ts    # Inter-agent communication
├── routers/               # Layer 3: API endpoints
│   └── api/
│       ├── agent.router.ts
│       ├── task.router.ts
│       └── mail.router.ts
└── workers/               # Layer 4: Background jobs
    └── inngest/
        ├── agent-lifecycle.ts
        └── task-coordination.ts
```

**Key differences:**
- Web API (tRPC) instead of Unix socket
- Database (Postgres) instead of filesystem state
- Inngest workers instead of daemon goroutines
- Mail system (database-backed) instead of filesystem messages

**Benefits of this architecture:**
- Clear separation of concerns
- Easy to test (mock interfaces at boundaries)
- Services can be independently developed
- Clients are reusable across services

---

## Lesson 2: Thread-Safe State Management

### What MultiClaude Does

**Mutex-protected in-memory state with auto-persistence:**

**File:** `internal/state/state.go`

```go
type State struct {
    Repos map[string]*Repository
    mu    sync.RWMutex
    path  string  // Path to state.json
}

// All mutations follow this pattern:
func (s *State) AddAgent(repoName, agentName string, agent Agent) error {
    s.mu.Lock()
    defer s.mu.Unlock()

    repo, exists := s.Repos[repoName]
    if !exists { return error }

    repo.Agents[agentName] = agent
    return s.saveUnlocked()  // Auto-save after mutation
}

// All reads follow this pattern:
func (s *State) GetAllRepos() map[string]*Repository {
    s.mu.RLock()
    defer s.mu.RUnlock()

    // Return DEEP COPY to avoid concurrent iteration issues
    repos := make(map[string]*Repository)
    for name, repo := range s.Repos {
        repoCopy := &Repository{...}  // Copy all fields
        repos[name] = repoCopy
    }
    return repos
}

// Atomic file writes:
func atomicWrite(path string, data []byte) error {
    tmpFile, _ := os.CreateTemp(dir(path), ".state-*.tmp")
    tmpFile.Write(data)
    tmpFile.Close()
    os.Rename(tmpPath, path)  // Atomic!
}
```

**Data model:**

```go
type Repository struct {
    GithubURL        string
    TmuxSession      string
    Agents           map[string]Agent
    TaskHistory      []TaskHistoryEntry
    MergeQueueConfig MergeQueueConfig
}

type Agent struct {
    Type            AgentType  // supervisor | worker | merge-queue | workspace | review
    WorktreePath    string
    TmuxWindow      string
    SessionID       string     // Claude session ID (for resumption)
    PID             int
    Task            string
    CreatedAt       time.Time
    LastNudge       time.Time
    ReadyForCleanup bool
}
```

**Key patterns:**
1. **Deep copies on read:** Prevents concurrent iteration issues
2. **Auto-save after mutation:** State always persisted
3. **Atomic writes:** Uses temp file + rename (filesystem atomic operation)
4. **Read-write locks:** Multiple readers, single writer

### How FactoryFactory Should Adapt

**Use Postgres with Prisma instead of in-memory state:**

```typescript
// src/backend/db/schema.prisma

model Agent {
  id              String   @id @default(cuid())
  type            AgentType
  state           AgentState
  taskId          String?
  task            Task?    @relation(fields: [taskId], references: [id])
  worktreePath    String
  tmuxSession     String   @unique
  claudeSessionId String   @unique
  pid             Int?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  lastActivityAt  DateTime @default(now())

  // Relations
  sentMail        Mail[]   @relation("SentMail")
  receivedMail    Mail[]   @relation("ReceivedMail")
  decisions       DecisionLog[]

  @@index([state, type])
  @@index([taskId])
}

model Task {
  id              String   @id @default(cuid())
  description     String
  state           TaskState
  assignedAgentId String?
  assignedAgent   Agent?   @relation(fields: [assignedAgentId], references: [id])
  worktreeBranch  String   @unique
  prUrl           String?
  createdAt       DateTime @default(now())
  completedAt     DateTime?

  @@index([state])
}

enum AgentType {
  COORDINATOR
  WORKER
  REVIEWER
}

enum AgentState {
  STARTING
  IDLE
  WORKING
  BLOCKED
  COMPLETED
  FAILED
}
```

**Benefits of database over filesystem:**
- Transactional updates (ACID guarantees)
- Complex queries (find all idle workers, get agent history)
- No need for manual locking (database handles concurrency)
- Easier to scale (can move to distributed DB)
- Built-in indexing for fast lookups

**Service layer for state management:**

```typescript
// src/backend/services/agent.service.ts

import { PrismaClient, AgentType, AgentState } from "@prisma/client";

export class AgentService {
  constructor(private db: PrismaClient) {}

  /**
   * Create a new agent and associated resources
   */
  async createAgent(params: {
    type: AgentType;
    taskId?: string;
    worktreePath: string;
    tmuxSession: string;
    claudeSessionId: string;
  }): Promise<Agent> {
    return this.db.agent.create({
      data: {
        type: params.type,
        state: AgentState.STARTING,
        taskId: params.taskId,
        worktreePath: params.worktreePath,
        tmuxSession: params.tmuxSession,
        claudeSessionId: params.claudeSessionId,
      },
    });
  }

  /**
   * Update agent state (atomic)
   */
  async updateState(
    agentId: string,
    state: AgentState,
    metadata?: { pid?: number }
  ): Promise<Agent> {
    return this.db.agent.update({
      where: { id: agentId },
      data: {
        state,
        pid: metadata?.pid,
        lastActivityAt: new Date(),
      },
    });
  }

  /**
   * Find available worker agents
   */
  async findAvailableWorkers(limit: number = 10): Promise<Agent[]> {
    return this.db.agent.findMany({
      where: {
        type: AgentType.WORKER,
        state: AgentState.IDLE,
      },
      orderBy: { lastActivityAt: "asc" },
      take: limit,
    });
  }

  /**
   * Get all agents with task details
   */
  async getAllWithTasks(): Promise<Agent[]> {
    return this.db.agent.findMany({
      include: {
        task: true,
        sentMail: { take: 5, orderBy: { sentAt: "desc" } },
        receivedMail: { take: 5, orderBy: { sentAt: "desc" } },
      },
      orderBy: { createdAt: "desc" },
    });
  }
}
```

**Key differences from MultiClaude:**
- No manual locking (database handles it)
- Transactions for complex updates
- Relations between entities (agent → task, agent → mail)
- Automatic `updatedAt` timestamps

---

## Lesson 3: Claude SDK Integration

### What MultiClaude Does

**Abstraction layer for spawning Claude Code instances:**

**File:** `pkg/claude/runner.go`

```go
type TerminalRunner interface {
    SendKeys(ctx, session, window, text) error
    SendKeysLiteral(ctx, session, window, text) error
    SendKeysLiteralWithEnter(ctx, session, window, text) error
    SendEnter(ctx, session, window) error
    GetPanePID(ctx, session, window) (int, error)
    StartPipePane(ctx, session, window, outputFile) error
    StopPipePane(ctx, session, window) error
}

type Runner struct {
    BinaryPath      string          // "claude" binary path
    Terminal        TerminalRunner  // Pluggable terminal (tmux.Client)
    StartupDelay    time.Duration   // 500ms default
    MessageDelay    time.Duration   // 1s default
    SkipPermissions bool            // --dangerously-skip-permissions
}

func (r *Runner) Start(ctx context.Context, session, window string, cfg Config) (Result, error) {
    // 1. Build command
    cmd := []string{
        r.BinaryPath,
        "--session-id", cfg.SessionID,
        "--append-system-prompt-file", cfg.SystemPromptFile,
    }
    if r.SkipPermissions {
        cmd = append(cmd, "--dangerously-skip-permissions")
    }

    // 2. Send command to tmux
    r.Terminal.SendKeysLiteralWithEnter(ctx, session, window, strings.Join(cmd, " "))

    // 3. Wait for startup
    time.Sleep(r.StartupDelay)

    // 4. Extract PID
    pid, _ := r.Terminal.GetPanePID(ctx, session, window)

    // 5. Start output capture (optional)
    if cfg.OutputFile != "" {
        r.Terminal.StartPipePane(ctx, session, window, cfg.OutputFile)
    }

    // 6. Send initial message (if provided)
    if cfg.InitialMessage != "" {
        time.Sleep(r.MessageDelay)
        r.Terminal.SendKeysLiteralWithEnter(ctx, session, window, cfg.InitialMessage)
    }

    return Result{PID: pid}, nil
}
```

**Key features:**
- **Session ID persistence:** Same UUID for restart = resume conversation
- **System prompt injection:** `--append-system-prompt-file` for agent-specific instructions
- **Output capture:** `tmux pipe-pane` logs all output to file
- **Startup timing:** Handles quirks (delay before PID extraction)
- **Atomic message delivery:** `SendKeysLiteralWithEnter` prevents race conditions

**Agent-specific prompts:**

**File:** `internal/prompts/supervisor.md` (embedded)

```markdown
# Supervisor Agent

You are the supervisor agent for this repository. Your job is to:

1. Monitor the repository for new issues and pull requests
2. Spawn worker agents to handle tasks
3. Coordinate work between agents
4. Merge completed work when CI passes

## Available Commands

/spawn-worker [task description]
/list-agents
/message [agent] [message]

## Guidelines

- Make forward progress, not perfect progress
- Spawn workers for parallelizable tasks
- Don't block waiting - spawn another worker
- Trust CI to be the quality gate
```

### How FactoryFactory Should Adapt

**Claude SDK client wrapper:**

```typescript
// src/backend/clients/claude.client.ts

import Anthropic from "@anthropic-ai/sdk";
import { writeFile } from "fs/promises";
import { join } from "path";

export interface ClaudeConfig {
  systemPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

export class ClaudeClient {
  private client: Anthropic;
  private promptCacheDir: string;

  constructor(apiKey: string, promptCacheDir: string) {
    this.client = new Anthropic({ apiKey });
    this.promptCacheDir = promptCacheDir;
  }

  /**
   * Generate Claude session ID (UUID v4)
   */
  generateSessionId(): string {
    return crypto.randomUUID();
  }

  /**
   * Write system prompt to file for Claude CLI
   */
  async writeSystemPrompt(
    agentId: string,
    promptContent: string
  ): Promise<string> {
    const promptPath = join(this.promptCacheDir, `${agentId}.md`);
    await writeFile(promptPath, promptContent, "utf-8");
    return promptPath;
  }

  /**
   * Build Claude CLI command for tmux execution
   */
  buildClaudeCommand(config: {
    sessionId: string;
    systemPromptFile: string;
    workingDir: string;
    initialMessage?: string;
  }): string {
    const parts = [
      "claude",
      "--session-id", config.sessionId,
      "--append-system-prompt-file", config.systemPromptFile,
      "--dangerously-skip-permissions",
      "--working-directory", config.workingDir,
    ];

    if (config.initialMessage) {
      // Initial message passed via stdin
      return `echo ${JSON.stringify(config.initialMessage)} | ${parts.join(" ")}`;
    }

    return parts.join(" ");
  }

  /**
   * Send message to Claude via tmux
   */
  async sendMessage(
    tmuxSession: string,
    message: string
  ): Promise<void> {
    const tmuxClient = new TmuxClient();

    // Use paste-buffer for multiline messages (atomic delivery)
    await tmuxClient.sendKeysLiteralWithEnter(tmuxSession, message);
  }
}
```

**Agent-specific system prompts:**

```typescript
// src/backend/prompts/worker.prompt.ts

export function getWorkerSystemPrompt(task: Task): string {
  return `
# Worker Agent - ${task.id}

You are a worker agent assigned to complete this task:

**Task:** ${task.description}

## Your Job

1. Analyze the task requirements
2. Implement the solution in your isolated worktree
3. Write tests to verify your implementation
4. Run tests and ensure they pass
5. Create a pull request with your changes
6. Send status updates to the coordinator

## Available Commands (via slash commands)

/mail-send [recipient] [message]  - Send message to another agent
/mail-check                        - Check for new messages
/task-complete                     - Mark task as complete
/task-blocked [reason]             - Mark task as blocked

## Guidelines

- Work independently in your worktree (${task.worktreeBranch})
- Create atomic commits with clear messages
- Run tests before marking task complete
- Ask coordinator for help if blocked
- Report progress regularly

## Environment

- Worktree: ${task.worktreeBranch}
- Base branch: main
- PR will be created when you run /task-complete

Let's get started! Begin by analyzing the task and planning your approach.
`.trim();
}
```

**Key differences from MultiClaude:**
- Generate prompts dynamically (not embedded)
- Include task context in prompt
- API-based commands instead of CLI commands
- Database-backed state visible in prompt

---

## Lesson 4: Git Worktree Isolation

### What MultiClaude Does

**One worktree per agent, complete isolation:**

**File:** `internal/worktree/manager.go`

```go
type Manager struct {
    repoPath string  // Path to main clone
}

func (m *Manager) CreateNewBranch(path, branch, startPoint string) error {
    cmd := exec.Command("git", "worktree", "add", "-b", branch, path, startPoint)
    cmd.Dir = m.repoPath
    return cmd.Run()
}

func (m *Manager) Remove(path string) error {
    cmd := exec.Command("git", "worktree", "remove", path)
    cmd.Dir = m.repoPath
    return cmd.Run()
}

// Layout:
// ~/.multiclaude/wts/<repo>/
// ├── supervisor/           # Main branch checkout
// ├── merge-queue/          # Main branch checkout
// ├── happy-platypus/       # Worker worktree (feature branch)
// └── clever-fox/           # Worker worktree (different feature)
```

**Benefits:**
- No branch switching conflicts
- Parallel work without interference
- Each agent has independent git state
- Clean removal: `git worktree remove`
- Agents can't accidentally break each other's work

### How FactoryFactory Should Adapt

**Git client for worktree operations:**

```typescript
// src/backend/clients/git.client.ts

import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";

const execFileAsync = promisify(execFile);

export class GitClient {
  constructor(
    private repoPath: string,
    private worktreeBase: string
  ) {}

  /**
   * Create a new worktree with feature branch
   */
  async createWorktree(params: {
    agentId: string;
    branchName: string;
    baseBranch?: string;
  }): Promise<string> {
    const worktreePath = join(this.worktreeBase, params.agentId);
    const baseBranch = params.baseBranch || "main";

    try {
      await execFileAsync(
        "git",
        [
          "worktree",
          "add",
          "-b",
          params.branchName,
          worktreePath,
          baseBranch,
        ],
        { cwd: this.repoPath }
      );

      log.info(
        { agentId: params.agentId, branchName: params.branchName },
        "Worktree created"
      );

      return worktreePath;
    } catch (error) {
      log.error({ error, agentId: params.agentId }, "Failed to create worktree");
      throw new GitWorktreeError(
        `Failed to create worktree for agent ${params.agentId}`,
        error as Error
      );
    }
  }

  /**
   * Remove worktree and delete branch
   */
  async removeWorktree(agentId: string, branchName: string): Promise<void> {
    const worktreePath = join(this.worktreeBase, agentId);

    try {
      // Remove worktree
      await execFileAsync("git", ["worktree", "remove", worktreePath], {
        cwd: this.repoPath,
      });

      // Delete branch (if not merged)
      try {
        await execFileAsync("git", ["branch", "-D", branchName], {
          cwd: this.repoPath,
        });
      } catch {
        // Branch might be merged already, ignore error
      }

      log.info({ agentId, branchName }, "Worktree removed");
    } catch (error) {
      log.error({ error, agentId }, "Failed to remove worktree");
      throw new GitWorktreeError(
        `Failed to remove worktree for agent ${agentId}`,
        error as Error
      );
    }
  }

  /**
   * List all worktrees
   */
  async listWorktrees(): Promise<
    Array<{ path: string; branch: string; commit: string }>
  > {
    const { stdout } = await execFileAsync(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: this.repoPath }
    );

    // Parse porcelain output
    const worktrees: Array<{ path: string; branch: string; commit: string }> =
      [];
    const lines = stdout.trim().split("\n");

    let current: Partial<{ path: string; branch: string; commit: string }> = {};
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        current.path = line.slice(9);
      } else if (line.startsWith("branch ")) {
        current.branch = line.slice(7);
      } else if (line.startsWith("HEAD ")) {
        current.commit = line.slice(5);
      } else if (line === "") {
        if (current.path) {
          worktrees.push(current as any);
        }
        current = {};
      }
    }

    return worktrees;
  }

  /**
   * Check if worktree is clean (no uncommitted changes)
   */
  async isWorktreeClean(worktreePath: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
        cwd: worktreePath,
      });
      return stdout.trim() === "";
    } catch (error) {
      log.error({ error, worktreePath }, "Failed to check worktree status");
      return false;
    }
  }
}
```

**Worktree lifecycle integrated with agent lifecycle:**

```typescript
// src/backend/services/agent.service.ts

export class AgentService {
  async createAgent(params: {
    type: AgentType;
    taskId?: string;
  }): Promise<Agent> {
    const agent = await this.db.agent.create({
      data: {
        type: params.type,
        state: AgentState.STARTING,
        taskId: params.taskId,
      },
    });

    // Generate branch name
    const branchName = `agent/${agent.id}/${Date.now()}`;

    // Create worktree
    const worktreePath = await this.gitClient.createWorktree({
      agentId: agent.id,
      branchName,
    });

    // Create tmux session in worktree
    const tmuxSession = `agent-${agent.id}`;
    await this.tmuxClient.createSession(tmuxSession, worktreePath);

    // Generate Claude session ID
    const claudeSessionId = this.claudeClient.generateSessionId();

    // Write system prompt
    const systemPrompt = await this.getSystemPrompt(agent);
    const promptFile = await this.claudeClient.writeSystemPrompt(
      agent.id,
      systemPrompt
    );

    // Update agent with worktree/tmux info
    return this.db.agent.update({
      where: { id: agent.id },
      data: {
        worktreePath,
        tmuxSession,
        claudeSessionId,
        worktreeBranch: branchName,
      },
    });
  }

  async cleanupAgent(agentId: string): Promise<void> {
    const agent = await this.db.agent.findUnique({
      where: { id: agentId },
    });

    if (!agent) return;

    // Kill tmux session
    try {
      await this.tmuxClient.killSession(agent.tmuxSession);
    } catch (error) {
      log.warn({ agentId, error }, "Failed to kill tmux session");
    }

    // Remove worktree
    try {
      await this.gitClient.removeWorktree(agentId, agent.worktreeBranch);
    } catch (error) {
      log.warn({ agentId, error }, "Failed to remove worktree");
    }

    // Update agent state
    await this.db.agent.update({
      where: { id: agentId },
      data: { state: AgentState.FAILED },
    });
  }
}
```

**Key benefits:**
- Complete isolation between agents
- No git conflicts
- Easy cleanup (remove worktree = delete all agent files)
- Agents work on separate branches simultaneously

---

## Lesson 5: Daemon Coordination with Goroutine Pools

### What MultiClaude Does

**Long-running daemon with multiple concurrent loops:**

**File:** `internal/daemon/daemon.go`

```go
func (d *Daemon) Start() error {
    d.pidFile.CheckAndClaim()
    d.server.Start()
    d.restoreTrackedRepos()

    d.wg.Add(5)
    go d.healthCheckLoop()      // Every 2 min: check PIDs, restore, cleanup
    go d.messageRouterLoop()    // Every 2 min: deliver pending messages
    go d.wakeLoop()             // Every 2 min: nudge idle agents
    go d.serverLoop()           // Continuous: accept socket requests
    go d.worktreeRefreshLoop()  // Background: track worktree state

    return nil
}

func (d *Daemon) Stop() error {
    d.cancel()                  // Signal all loops to stop
    d.wg.Wait()                 // Wait for all goroutines
    d.server.Stop()
    d.state.Save()              // Final save
    d.pidFile.Remove()
}

// Periodic loop pattern:
func (d *Daemon) periodicLoop(name string, interval time.Duration, onStartup, onTick func()) {
    defer d.wg.Done()

    ticker := time.NewTicker(interval)
    defer ticker.Stop()

    if onStartup != nil { onStartup() }

    for {
        select {
        case <-ticker.C:
            onTick()
        case <-d.ctx.Done():
            return
        }
    }
}
```

**Health check loop (auto-recovery):**

```go
func (d *Daemon) healthCheckLoop() {
    // Every 2 minutes:
    // 1. Check if tmux session exists
    // 2. Check if agent windows exist
    // 3. Check if process PIDs are alive
    // 4. Auto-restart persistent agents if dead
    // 5. Mark transient agents for cleanup if dead
    // 6. Clean up orphaned worktrees

    for _, agent := range d.state.GetAllAgents() {
        if agent.IsPersistent() && !agent.IsAlive() {
            // Auto-restart supervisor, merge-queue, workspace agents
            d.restartAgent(agent)
        } else if !agent.IsPersistent() && !agent.IsAlive() {
            // Mark worker/review agents for cleanup
            agent.ReadyForCleanup = true
        }
    }
}
```

**Message router loop (inter-agent IPC):**

```go
func (d *Daemon) messageRouterLoop() {
    // Every 2 minutes:
    // 1. Scan ~/.multiclaude/messages/*/
    // 2. Find pending messages
    // 3. Deliver via tmux paste-buffer
    // 4. Update message status to "delivered"

    for _, msg := range d.messages.GetPending() {
        d.tmux.SendKeysLiteralWithEnter(
            msg.To.TmuxSession,
            msg.To.TmuxWindow,
            fmt.Sprintf("Message from %s: %s", msg.From, msg.Body)
        )
        d.messages.MarkDelivered(msg.ID)
    }
}
```

### How FactoryFactory Should Adapt

**Use Inngest for background job orchestration instead of daemon:**

```typescript
// src/backend/workers/inngest/agent-health.ts

import { inngest } from "./client";
import { AgentService } from "../../services/agent.service";

export const agentHealthCheck = inngest.createFunction(
  { id: "agent-health-check", name: "Agent Health Check" },
  { cron: "*/2 * * * *" }, // Every 2 minutes
  async ({ event, step }) => {
    const agentService = new AgentService(db);

    // Step 1: Get all active agents
    const agents = await step.run("get-active-agents", async () => {
      return agentService.getAllActive();
    });

    // Step 2: Check each agent's health
    for (const agent of agents) {
      await step.run(`check-agent-${agent.id}`, async () => {
        // Check if tmux session exists
        const sessionExists = await tmuxClient.hasSession(agent.tmuxSession);
        if (!sessionExists) {
          log.warn({ agentId: agent.id }, "Tmux session missing, cleaning up");
          await agentService.cleanupAgent(agent.id);
          return;
        }

        // Check if process is alive
        const pid = agent.pid;
        if (pid) {
          const isAlive = await checkProcessAlive(pid);
          if (!isAlive) {
            log.warn({ agentId: agent.id, pid }, "Process dead, cleaning up");
            await agentService.cleanupAgent(agent.id);
            return;
          }
        }

        // Check for timeout (no activity in 30 minutes)
        const inactiveMs = Date.now() - agent.lastActivityAt.getTime();
        if (inactiveMs > 30 * 60 * 1000) {
          log.warn({ agentId: agent.id }, "Agent inactive, nudging");
          await agentService.nudgeAgent(agent.id, "Still working?");
        }
      });
    }

    // Step 3: Clean up orphaned worktrees
    await step.run("cleanup-orphaned-worktrees", async () => {
      const worktrees = await gitClient.listWorktrees();
      const agentIds = new Set(agents.map((a) => a.id));

      for (const wt of worktrees) {
        const agentId = extractAgentIdFromPath(wt.path);
        if (agentId && !agentIds.has(agentId)) {
          log.warn({ agentId, worktree: wt.path }, "Orphaned worktree, removing");
          await gitClient.removeWorktree(agentId, wt.branch);
        }
      }
    });

    return { checked: agents.length };
  }
);
```

**Mail delivery worker (replaces message router loop):**

```typescript
// src/backend/workers/inngest/mail-delivery.ts

export const mailDelivery = inngest.createFunction(
  { id: "mail-delivery", name: "Mail Delivery" },
  { cron: "*/1 * * * *" }, // Every minute
  async ({ event, step }) => {
    // Step 1: Get pending mail
    const pendingMail = await step.run("get-pending-mail", async () => {
      return db.mail.findMany({
        where: { deliveredAt: null },
        include: { recipient: true },
      });
    });

    // Step 2: Deliver each message
    for (const mail of pendingMail) {
      await step.run(`deliver-mail-${mail.id}`, async () => {
        const message = `📬 Mail from ${mail.senderName}: ${mail.body}`;

        try {
          await claudeClient.sendMessage(mail.recipient.tmuxSession, message);

          await db.mail.update({
            where: { id: mail.id },
            data: { deliveredAt: new Date() },
          });

          log.info({ mailId: mail.id, recipientId: mail.recipientId }, "Mail delivered");
        } catch (error) {
          log.error(
            { mailId: mail.id, recipientId: mail.recipientId, error },
            "Failed to deliver mail"
          );
        }
      });
    }

    return { delivered: pendingMail.length };
  }
);
```

**Key differences:**
- Inngest replaces daemon goroutines
- Database replaces in-memory state
- Web API (tRPC) replaces Unix socket
- Cron-based scheduling instead of ticker loops
- Inngest handles retries and error handling

**Benefits of Inngest over daemon:**
- Built-in retries and error handling
- Web UI for monitoring
- Easier to scale (distributed workers)
- No need for PID files or daemon management
- Better observability (traces, logs)

---

## Lesson 6: Inter-Agent Communication

### What MultiClaude Does

**Filesystem-based message queue:**

**File:** `internal/messages/messages.go`

```go
type Message struct {
    ID        string  // "msg-<uuid>"
    From      string  // Agent name
    To        string  // Agent name
    Timestamp time.Time
    Body      string
    Status    Status  // pending → delivered → read → acked
    AckedAt   *time.Time
}

// File layout:
// ~/.multiclaude/messages/<repo>/<agent>/msg-abc123.json

// Lifecycle:
// 1. CLI: multiclaude agent send-message supervisor "Fix bug"
//    └─ Writes msg-*.json with Status="pending"
//
// 2. Daemon (message router loop every 2 min):
//    └─ Discovers pending message
//    └─ Uses tmux.SendKeysLiteralWithEnter() to paste into agent's window
//    └─ Updates Status="delivered"
//
// 3. Agent receives message in tmux and acknowledges
//    └─ Status="read" → "acked"
```

**Benefits:**
- Durable (survives daemon restart)
- Debuggable (can inspect JSON files)
- Simple (no message broker required)
- Async (2-minute polling interval)

**Drawbacks:**
- Slow (2-minute delivery latency)
- No push notifications
- File I/O overhead
- No complex routing

### How FactoryFactory Should Adapt

**Database-backed mail system:**

```typescript
// src/backend/db/schema.prisma

model Mail {
  id           String    @id @default(cuid())
  senderId     String
  sender       Agent     @relation("SentMail", fields: [senderId], references: [id])
  recipientId  String
  recipient    Agent     @relation("ReceivedMail", fields: [recipientId], references: [id])
  senderName   String    // Display name (for logging)
  subject      String?
  body         String
  sentAt       DateTime  @default(now())
  deliveredAt  DateTime?
  readAt       DateTime?

  @@index([recipientId, deliveredAt])
  @@index([senderId])
}
```

**Mail service:**

```typescript
// src/backend/services/mail.service.ts

export class MailService {
  constructor(private db: PrismaClient) {}

  /**
   * Send mail from one agent to another
   */
  async sendMail(params: {
    senderId: string;
    recipientId: string;
    subject?: string;
    body: string;
  }): Promise<Mail> {
    const sender = await this.db.agent.findUnique({
      where: { id: params.senderId },
    });

    if (!sender) {
      throw new Error(`Sender agent not found: ${params.senderId}`);
    }

    const mail = await this.db.mail.create({
      data: {
        senderId: params.senderId,
        recipientId: params.recipientId,
        senderName: `${sender.type}-${sender.id.slice(0, 8)}`,
        subject: params.subject,
        body: params.body,
        sentAt: new Date(),
      },
    });

    log.info(
      {
        mailId: mail.id,
        senderId: params.senderId,
        recipientId: params.recipientId,
      },
      "Mail sent"
    );

    // Trigger mail delivery worker (async)
    await inngest.send({
      name: "mail/deliver",
      data: { mailId: mail.id },
    });

    return mail;
  }

  /**
   * Get unread mail for an agent
   */
  async getUnreadMail(agentId: string): Promise<Mail[]> {
    return this.db.mail.findMany({
      where: {
        recipientId: agentId,
        readAt: null,
      },
      orderBy: { sentAt: "asc" },
    });
  }

  /**
   * Mark mail as read
   */
  async markRead(mailId: string): Promise<void> {
    await this.db.mail.update({
      where: { id: mailId },
      data: { readAt: new Date() },
    });
  }
}
```

**Agent slash command for mail:**

```typescript
// In agent system prompt:

## Mail System

Send messages to other agents using the `/mail-send` command:

/mail-send <recipient-id> <message>

Example:
/mail-send coord-abc123 "Task completed, ready for review"

Check for new mail:
/mail-check

Your unread messages will be displayed.
```

**Slash command handler (via tRPC):**

```typescript
// src/backend/routers/api/mail.router.ts

export const mailRouter = router({
  send: publicProcedure
    .input(
      z.object({
        senderId: z.string(),
        recipientId: z.string(),
        body: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      return mailService.sendMail(input);
    }),

  getUnread: publicProcedure
    .input(z.object({ agentId: z.string() }))
    .query(async ({ input }) => {
      return mailService.getUnreadMail(input.agentId);
    }),

  markRead: publicProcedure
    .input(z.object({ mailId: z.string() }))
    .mutation(async ({ input }) => {
      return mailService.markRead(input.mailId);
    }),
});
```

**Key benefits over filesystem messages:**
- Fast delivery (Inngest trigger, not 2-minute polling)
- Queryable (complex queries like "all unread mail from coordinator")
- Relational (mail → sender, mail → recipient)
- Scalable (database handles concurrency)

---

## Lesson 7: Error Handling & Recovery

### What MultiClaude Does

**Structured errors with suggestions:**

**File:** `internal/errors/errors.go`

```go
type CLIError struct {
    Category   Category  // Usage | Config | Runtime | Connection | NotFound
    Message    string    // What went wrong
    Suggestion string    // How to fix it
    Cause      error     // Wrapped error for debugging
}

// Example error constructors:
func DaemonNotRunning() CLIError {
    return CLIError{
        Category:   CategoryConnection,
        Message:    "Daemon is not running",
        Suggestion: "Try: multiclaude start",
    }
}

func WorktreeCreationFailed(err error) CLIError {
    // Detect "branch already exists" pattern
    if strings.Contains(err.Error(), "already exists") {
        return CLIError{
            Category:   CategoryRuntime,
            Message:    "Branch already exists",
            Suggestion: "Use a different branch name or delete the existing branch",
            Cause:      err,
        }
    }

    return CLIError{
        Category:   CategoryRuntime,
        Message:    "Failed to create worktree",
        Suggestion: "Check git status and logs",
        Cause:      err,
    }
}
```

**Health check auto-recovery:**

```go
func (d *Daemon) healthCheckLoop() {
    // Check if agent process is alive
    if agent.IsPersistent() && !isProcessAlive(agent.PID) {
        log.Warn("Persistent agent died, auto-restarting", "agent", agent.Name)

        // Restart with same session ID (resume conversation)
        d.claudeRunner.Start(ctx, agent.TmuxSession, agent.TmuxWindow, claude.Config{
            SessionID:        agent.SessionID,  // Same UUID = resume
            SystemPromptFile: agent.PromptFile,
            Resume:           true,
        })
    }
}
```

### How FactoryFactory Should Adapt

**Custom error classes:**

```typescript
// src/backend/lib/errors.ts

export class FactoryFactoryError extends Error {
  constructor(
    message: string,
    public code: string,
    public category: "user" | "system" | "external",
    public cause?: Error
  ) {
    super(message);
    this.name = "FactoryFactoryError";
  }
}

export class AgentError extends FactoryFactoryError {
  constructor(message: string, public agentId: string, cause?: Error) {
    super(message, "AGENT_ERROR", "system", cause);
    this.name = "AgentError";
  }
}

export class WorktreeError extends FactoryFactoryError {
  constructor(message: string, cause?: Error) {
    super(message, "WORKTREE_ERROR", "system", cause);
    this.name = "WorktreeError";
  }
}

export class TmuxError extends FactoryFactoryError {
  constructor(message: string, public sessionName: string, cause?: Error) {
    super(message, "TMUX_ERROR", "system", cause);
    this.name = "TmuxError";
  }
}
```

**Health monitoring with auto-recovery:**

```typescript
// src/backend/workers/inngest/agent-health.ts

export const agentHealthCheck = inngest.createFunction(
  { id: "agent-health-check" },
  { cron: "*/2 * * * *" },
  async ({ step }) => {
    const agents = await step.run("get-agents", async () => {
      return db.agent.findMany({
        where: {
          state: {
            in: [AgentState.WORKING, AgentState.IDLE, AgentState.BLOCKED],
          },
        },
      });
    });

    for (const agent of agents) {
      await step.run(`check-${agent.id}`, async () => {
        try {
          // Check if tmux session exists
          const sessionExists = await tmuxClient.hasSession(agent.tmuxSession);
          if (!sessionExists) {
            throw new TmuxError(
              "Tmux session not found",
              agent.tmuxSession
            );
          }

          // Check if process is alive
          if (agent.pid) {
            const isAlive = await isProcessAlive(agent.pid);
            if (!isAlive) {
              throw new AgentError("Agent process died", agent.id);
            }
          }

          // Update last activity
          await db.agent.update({
            where: { id: agent.id },
            data: { lastActivityAt: new Date() },
          });
        } catch (error) {
          log.error({ agent, error }, "Agent health check failed");

          // Attempt recovery or cleanup
          if (agent.type === AgentType.COORDINATOR) {
            // Auto-restart coordinator (critical)
            await agentService.restartAgent(agent.id);
          } else {
            // Mark worker as failed
            await agentService.markFailed(agent.id, error);
          }
        }
      });
    }
  }
);
```

**Graceful degradation:**

```typescript
// If agent fails, reassign task to another agent
async function handleAgentFailure(agentId: string, error: Error) {
  const agent = await db.agent.findUnique({
    where: { id: agentId },
    include: { task: true },
  });

  if (!agent) return;

  // Mark agent as failed
  await db.agent.update({
    where: { id: agentId },
    data: {
      state: AgentState.FAILED,
      failureReason: error.message,
    },
  });

  // Log decision
  await db.decisionLog.create({
    data: {
      agentId: agent.id,
      decision: `Agent failed: ${error.message}`,
      reasoning: `Reassigning task ${agent.taskId} to new agent`,
    },
  });

  // Reassign task if it was working on one
  if (agent.task) {
    await taskService.reassignTask(agent.task.id);
  }

  // Cleanup resources
  await agentService.cleanupAgent(agentId);
}
```

---

## Lesson 8: Atomic Text Delivery (Issue #63 Fix)

### What MultiClaude Does

**Problem:** Race condition between `SendKeysLiteral` + `SendEnter`

**File:** `pkg/tmux/client.go`

```go
// ❌ BROKEN - Race condition
func SendMessage(session, window, text string) {
    // Step 1: Send multiline text via paste-buffer
    SendKeysLiteral(session, window, text)

    // Step 2: Send Enter key
    // ⚠️ Between step 1 and 2, tmux might process intermediate Enter,
    //    causing the final Enter to be lost
    SendEnter(session, window)
}

// ✅ FIXED - Atomic operation
func (c *Client) SendKeysLiteralWithEnter(ctx context.Context, session, window, text string) error {
    // Combine into single tmux command to prevent race
    // Uses paste-buffer + send-keys Enter in one atomic operation

    cmd := exec.CommandContext(ctx, c.tmuxPath,
        "set-buffer", text, ";",
        "paste-buffer", "-t", target, ";",
        "send-keys", "-t", target, "Enter",
    )
    return cmd.Run()
}
```

**Why this matters:**
- Multiline messages need to be delivered atomically
- Without atomicity, Enter key can be lost between operations
- Claude might not process the message

### How FactoryFactory Should Adapt

**Implement atomic message delivery:**

```typescript
// src/backend/clients/tmux.client.ts

export class TmuxClient {
  /**
   * Send multiline text with Enter (atomic operation)
   */
  async sendKeysLiteralWithEnter(
    sessionName: string,
    text: string
  ): Promise<void> {
    const target = `${sessionName}:0`; // Window 0

    // Atomic: set-buffer + paste-buffer + send-keys Enter
    // All in one tmux command to prevent race condition
    await execFileAsync(this.tmuxPath, [
      "set-buffer",
      text,
      ";",
      "paste-buffer",
      "-t",
      target,
      ";",
      "send-keys",
      "-t",
      target,
      "Enter",
    ]);

    log.debug({ sessionName, textLength: text.length }, "Message sent (atomic)");
  }

  /**
   * Send single-line text (no Enter)
   */
  async sendKeys(sessionName: string, text: string): Promise<void> {
    const target = `${sessionName}:0`;

    await execFileAsync(this.tmuxPath, [
      "send-keys",
      "-t",
      target,
      text,
    ]);
  }
}
```

**Use in mail delivery:**

```typescript
// src/backend/workers/inngest/mail-delivery.ts

async function deliverMail(mail: Mail, recipient: Agent) {
  const message = `
📬 New mail from ${mail.senderName}

${mail.body}

---
Reply with: /mail-send ${mail.senderId} "your response"
`.trim();

  // Use atomic delivery to prevent race condition
  await tmuxClient.sendKeysLiteralWithEnter(recipient.tmuxSession, message);

  await db.mail.update({
    where: { id: mail.id },
    data: { deliveredAt: new Date() },
  });
}
```

**Key takeaway:**
- Always use atomic operations for multiline text
- Don't split paste-buffer and Enter into separate commands
- This is critical for reliable agent communication

---

## Lesson 9: Session ID Persistence for Resumption

### What MultiClaude Does

**Claude session IDs allow resuming conversation after crash:**

```go
type Agent struct {
    SessionID string  // UUID v4, persisted in state.json
}

// On agent crash, auto-restart with same session ID
func (d *Daemon) restartAgent(agent Agent) error {
    return d.claudeRunner.Start(ctx, agent.TmuxSession, agent.TmuxWindow, claude.Config{
        SessionID:        agent.SessionID,  // Same UUID = resume context
        SystemPromptFile: agent.PromptFile,
        Resume:           true,
    })
}
```

**Benefits:**
- Agent "remembers" conversation history
- No need to re-explain context after crash
- Seamless recovery from transient failures

### How FactoryFactory Should Adapt

**Store Claude session IDs in database:**

```typescript
// Already in schema.prisma:
model Agent {
  claudeSessionId String   @unique
  // ...
}
```

**Generate on agent creation:**

```typescript
// src/backend/services/agent.service.ts

async createAgent(params: CreateAgentParams): Promise<Agent> {
  // Generate Claude session ID
  const claudeSessionId = crypto.randomUUID();

  const agent = await this.db.agent.create({
    data: {
      type: params.type,
      claudeSessionId,
      state: AgentState.STARTING,
      // ...
    },
  });

  // Start Claude with session ID
  const command = claudeClient.buildClaudeCommand({
    sessionId: claudeSessionId,
    systemPromptFile: promptPath,
    workingDir: worktreePath,
  });

  await tmuxClient.sendKeys(agent.tmuxSession, command);

  return agent;
}
```

**Resume on restart:**

```typescript
async restartAgent(agentId: string): Promise<Agent> {
  const agent = await this.db.agent.findUnique({
    where: { id: agentId },
  });

  if (!agent) {
    throw new AgentError("Agent not found", agentId);
  }

  // Reuse same Claude session ID to resume context
  const command = claudeClient.buildClaudeCommand({
    sessionId: agent.claudeSessionId, // Same UUID
    systemPromptFile: await getSystemPromptPath(agent),
    workingDir: agent.worktreePath,
  });

  // Kill old tmux session
  await tmuxClient.killSession(agent.tmuxSession);

  // Create new tmux session
  await tmuxClient.createSession(agent.tmuxSession, agent.worktreePath);

  // Start Claude (will resume conversation)
  await tmuxClient.sendKeys(agent.tmuxSession, command);

  // Update agent state
  return this.db.agent.update({
    where: { id: agentId },
    data: {
      state: AgentState.STARTING,
      pid: null,
      lastActivityAt: new Date(),
    },
  });
}
```

**Key benefit:**
- Agent crashes don't lose conversation context
- Coordinator can resume coordinating after restart
- Workers remember their task context

---

## Lesson 10: Agent-Specific System Prompts

### What MultiClaude Does

**Embedded prompts with per-agent customization:**

**File:** `internal/prompts/supervisor.md`

```markdown
# Supervisor Agent

You are the supervisor for this repository. Your responsibilities:

1. Monitor for new work (issues, PRs)
2. Spawn worker agents for parallelizable tasks
3. Coordinate between agents
4. Merge completed work when CI passes

## Your Powers

/spawn-worker [task]  - Create a worker agent
/list-agents          - Show all agents
/message [agent] [msg] - Send message to agent

## Philosophy

Make forward progress, not perfect progress. Spawn workers liberally.
Don't wait for perfection - CI is the quality gate.
```

**Custom repo prompts:**

```bash
# .multiclaude/supervisor.md (optional, appended to default)

## Project-Specific Context

This is a React + TypeScript project. All new components must:
- Use functional components with hooks
- Include PropTypes
- Have unit tests (Vitest)
```

**Slash command docs auto-generated:**

```markdown
## Available Commands

/mail-send [recipient] [message]
/task-complete
/task-blocked [reason]
```

### How FactoryFactory Should Adapt

**Dynamic prompt generation:**

```typescript
// src/backend/prompts/coordinator.prompt.ts

export function getCoordinatorPrompt(
  repo: Repository,
  tasks: Task[]
): string {
  return `
# Coordinator Agent

You are the coordinator agent for ${repo.name}. Your job is to:

1. Review incoming tasks in the queue
2. Assign tasks to available worker agents
3. Monitor worker progress
4. Review completed work
5. Create pull requests for merged work

## Current State

**Active Workers:** ${tasks.filter((t) => t.state === "ASSIGNED").length}
**Pending Tasks:** ${tasks.filter((t) => t.state === "PENDING").length}
**Completed Tasks:** ${tasks.filter((t) => t.state === "COMPLETED").length}

## Your Powers

Use these slash commands to manage the team:

\`\`\`
/task-list                     - List all tasks
/task-assign <task-id> <worker-id> - Assign task to worker
/mail-send <agent-id> <message>    - Send message to agent
/pr-create <branch>            - Create PR from branch
\`\`\`

## Guidelines

- Assign tasks to idle workers immediately
- Check on workers if they haven't reported progress in 15 minutes
- Don't assign multiple tasks to same worker
- Create PRs as soon as tests pass

## Philosophy

You are the orchestrator. Your job is to keep everyone moving forward.
Don't do the work yourself - delegate to workers.

Trust your workers to do good work. Focus on coordination.
`.trim();
}
```

**Worker prompts with task context:**

```typescript
// src/backend/prompts/worker.prompt.ts

export function getWorkerPrompt(task: Task): string {
  return `
# Worker Agent - Task ${task.id}

You have been assigned this task:

**Description:** ${task.description}

## Your Job

1. Analyze the task requirements
2. Implement the solution
3. Write tests
4. Run tests and ensure they pass
5. Report completion to coordinator

## Your Environment

- Working in: ${task.worktreeBranch}
- Base branch: main
- Tests: \`npm test\`
- Build: \`npm run build\`

## Your Powers

\`\`\`
/mail-send coord-<id> <message>  - Report to coordinator
/task-complete                    - Mark task complete
/task-blocked <reason>            - Report blocker
\`\`\`

## Guidelines

- Work independently in your worktree
- Commit frequently with clear messages
- Run tests before marking complete
- Ask coordinator if blocked

## Philosophy

Focus on making progress. Done is better than perfect.
If you're stuck for more than 10 minutes, ask for help.

Let's build something! Start by analyzing the task requirements.
`.trim();
}
```

**Benefits:**
- Prompts include current state (task counts, environment)
- Agent-specific powers and guidelines
- Task context embedded in prompt
- Dynamic slash commands based on agent type

---

## Summary: Key Takeaways for FactoryFactory

### Architecture

| Aspect | MultiClaude | FactoryFactory Adaptation |
|--------|-------------|---------------------------|
| **State Management** | In-memory + JSON file | Postgres + Prisma |
| **Coordination** | Daemon with goroutines | Inngest workers (cron) |
| **CLI ↔ Daemon** | Unix socket (JSON-RPC) | tRPC (HTTP/WebSocket) |
| **Agent ↔ Agent** | Filesystem messages | Database mail + Inngest |
| **Agent Isolation** | tmux windows + git worktrees | Same |
| **Claude Integration** | CLI with --session-id | Same |
| **Error Recovery** | Health check loop | Inngest health worker |

### Critical Implementation Details

1. **Atomic Message Delivery**
   - Use `tmux set-buffer ; paste-buffer ; send-keys Enter` in one command
   - Prevents race conditions with multiline messages

2. **Session ID Persistence**
   - Store Claude session IDs in database
   - Reuse on restart to resume conversation context

3. **Git Worktree Isolation**
   - One worktree per agent
   - Clean separation, no conflicts
   - Easy cleanup (remove worktree = delete agent files)

4. **Health Monitoring**
   - Check tmux session existence
   - Check process PID liveness
   - Auto-cleanup dead agents
   - Orphaned worktree detection

5. **Inter-Agent Communication**
   - Database-backed mail system
   - Fast delivery via Inngest (not 2-min polling)
   - Queryable message history

### Recommended Implementation Order

**Phase 1: Core Infrastructure**
1. Postgres schema (agents, tasks, mail)
2. Git client (worktree operations)
3. Tmux client (session management, atomic delivery)
4. Claude client (command building, session IDs)

**Phase 2: Agent Lifecycle**
1. Agent service (create, cleanup, health)
2. Inngest health worker (monitoring)
3. Agent creation flow (worktree → tmux → claude)
4. Agent cleanup flow (kill tmux → remove worktree)

**Phase 3: Communication**
1. Mail service (send, receive, mark read)
2. Mail delivery worker (Inngest)
3. Slash command handlers (tRPC)
4. System prompt generation

**Phase 4: Orchestration**
1. Task service (queue, assign, complete)
2. Task assignment worker (Inngest)
3. Coordinator agent prompts
4. Worker agent prompts

**Phase 5: Monitoring**
1. Web UI for agent status
2. Terminal viewer (tmux PTY streaming)
3. Decision logs
4. Mail inbox UI

---

## Additional Recommendations

### 1. Brownian Ratchet Philosophy

MultiClaude embraces "forward progress over perfection":

- Multiple agents work in parallel (redundancy acceptable)
- CI is the quality gate (only passing work merges)
- Partial progress better than no progress
- Coordinator nudges idle agents

**Apply to FactoryFactory:**
- Don't block on perfect task decomposition
- Spawn multiple workers if uncertain
- Trust tests to catch errors
- Coordinator should be proactive, not reactive

### 2. Agent Types

MultiClaude has:
- **Supervisor:** Long-lived coordinator
- **Worker:** Short-lived task executor
- **Merge Queue:** Handles PR merging
- **Workspace:** Interactive development
- **Review:** PR review agent

**For FactoryFactory:**
- **Coordinator:** Long-lived orchestrator
- **Worker:** Task executor (transient)
- **Reviewer:** PR review before merge

### 3. Persistence Strategy

MultiClaude persists:
- Agent state (type, worktree, tmux, session ID)
- Task history (completed tasks)
- Messages (pending/delivered/read)

**FactoryFactory should persist:**
- All of the above PLUS:
- Decision logs (why coordinator made decisions)
- Task queue state
- PR URLs and CI status
- Agent activity timeline

### 4. Failure Modes & Recovery

| Failure | MultiClaude | FactoryFactory |
|---------|-------------|----------------|
| Agent crash | Auto-restart persistent agents | Health worker restarts coordinator |
| Tmux died | Detect + cleanup | Health worker detects + cleans up |
| Git conflict | Manual intervention | Worker reports blocker to coordinator |
| Claude timeout | Nudge agent | Health worker nudges after 30min |
| Orphaned worktree | Health check removes | Health worker removes |

### 5. Observability

MultiClaude provides:
- Structured logging (Pino-style)
- CLI commands to inspect state
- tmux sessions (human-viewable)

**FactoryFactory should add:**
- Web dashboard for all agents
- Real-time terminal streaming (tmux PTY)
- Decision log viewer
- Task timeline visualization
- Mail inbox/outbox UI

---

## Conclusion

MultiClaude provides a battle-tested architecture for multi-agent orchestration. The key lessons:

1. **Layered architecture** - Clear boundaries between clients, services, and APIs
2. **Database-backed state** - Postgres handles concurrency, queryability, scaling
3. **Atomic operations** - Critical for reliable message delivery
4. **Session ID persistence** - Enables conversation resumption after crashes
5. **Git worktree isolation** - True parallel work without conflicts
6. **Health monitoring** - Auto-recovery from transient failures
7. **Structured communication** - Database mail > filesystem messages
8. **Dynamic prompts** - Context-aware system prompts per agent
9. **Forward progress philosophy** - CI as quality gate, not perfection blocker

By adapting these patterns to a web-first architecture (Postgres + Inngest + tRPC), FactoryFactory can achieve robust multi-agent coordination with better observability and scalability than MultiClaude's daemon-based approach.
