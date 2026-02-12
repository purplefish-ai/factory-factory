# Phase 1: Core Library Extraction

**Goal:** Extract FF's execution primitives into a standalone library so both desktop and cloud can use them.

## 1.1 Monorepo Conversion

Convert the current single-package repo into a pnpm monorepo:

```
factory-factory/
  pnpm-workspace.yaml          # NEW: packages: ['packages/*']
  packages/
    core/                       # NEW: @factory-factory/core
      src/
      package.json
      tsconfig.json
    desktop/                    # MOVED: everything from current src/, electron/
      src/
      electron/
      package.json
      tsconfig.json
  prisma/                       # Stays at root or moves into core
  docs/
  README.md
```

## 1.2 Extract `packages/core/`

Move the following into `packages/core/`:

**All 6 domains** (from `src/backend/domains/`):
- `session/` — Claude CLI process management (`ClaudeClient`, `ClaudeProcess`, protocol, `SessionManager`, lifecycle)
- `workspace/` — Workspace state machine, lifecycle, kanban state derivation, init policy
- `ratchet/` — Auto-fix polling loop, fixer session dispatch, CI/review detection, reconciliation
- `github/` — GitHub CLI wrapper, PR info extraction, CI status computation, review comments
- `terminal/` — Terminal subprocess management, TTY spawning
- `run-script/` — Startup and custom script execution

**Infrastructure services** (from `src/backend/services/`):
- `logger.service` — Structured logging (pino)
- `config.service` — Environment config
- `git-ops.service` — Git operations (clone, push, worktree management)
- `scheduler.service` — Interval-based task scheduling
- `file-lock.service` — File-based locking
- `rate-limiter.service` — GitHub API rate limit coordination

**Data layer:**
- Resource accessors (from `src/backend/resource_accessors/`)
- Prisma schema and migrations (SQLite, single-tenant)

## 1.3 Core Library API

Everything below is exported from `@factory-factory/core`. This is the complete public API surface.

### Session Domain

**Claude CLI Management:**

```typescript
// Classes
export class ClaudeClient {
  sendMessage(content: string): Promise<void>
  interrupt(): Promise<void>
  resume(): Promise<void>
  // Events: message streams, thinking phases, tool execution
}

export class ClaudeProcess {
  // Wraps spawned `claude --init` subprocess
  // Manages stdin/stdout via JSONL protocol
  // Monitors resource usage (CPU, memory)
}

export class ProcessRegistry {
  // Tracks all active Claude processes
}

export class SessionManager {
  // Manages conversation history
}

export class SessionFileLogger {
  // Per-session log files for debugging
}
```

**Session Lifecycle:**

```typescript
// Service instances
export const sessionService: {
  getOrCreateClient(sessionId: string, options: ClaudeClientOptions): Promise<ClaudeClient>
  startClaudeSession(sessionId: string, opts?: SessionStartOptions): Promise<void>
  stopClaudeSession(sessionId: string): Promise<void>
}

export const sessionDataService: {
  findClaudeSessionById(id: string): Promise<ClaudeSession | null>
  // Session history access
}

export const sessionRepository: {
  getSessionById(id: string): Promise<ClaudeSession | null>
  createSession(data: CreateClaudeSessionInput): Promise<ClaudeSession>
  updateSessionStatus(id: string, status: SessionStatus): Promise<ClaudeSession>
}

export const sessionProcessManager: {
  isStopInProgress(sessionId: string): boolean
  // Process lifecycle tracking
}

export const sessionPromptBuilder: {
  // Builds prompts for session initialization
}

export const sessionDomainService: {
  injectCommittedUserMessage(sessionId: string, msg: string): Promise<void>
  // Cross-domain session operations
}
```

**Chat Services:**

```typescript
export const chatConnectionService: {
  // WebSocket connection tracking per session
}

export const chatEventForwarderService: {
  setupClientEvents(client: ClaudeClient, context: EventForwarderContext): void
  configure(bridges: { workspace: SessionWorkspaceBridge }): void
}

export const chatMessageHandlerService: {
  // Dispatches incoming messages to Claude
  configure(bridges: { initPolicy: SessionInitPolicyBridge }): void
}
```

**Session Types:**

```typescript
export type AssistantMessage = { /* Claude's response content */ }
export type ClaudeClientOptions = { thinkingEnabled: boolean; permissionMode: PermissionMode; model: string; /* ... */ }
export type ClaudeJson = { /* Raw Claude protocol JSON */ }
export type ControlRequest = { /* Permission/control requests from Claude */ }
export type ExitResult = { /* Session exit information */ }
export type HistoryMessage = { /* Conversation history entry */ }
export type InitializeResponseData = { /* Claude CLI init response */ }
export type PermissionMode = 'plan' | 'auto' | 'default'
export type ProcessStatus = 'starting' | 'running' | 'stopping' | 'stopped'
export type RegisteredProcess = { /* Process registry entry */ }
export type ResourceUsage = { cpu: number; memory: number }
export type ResultMessage = { /* Final result from Claude */ }
export type SessionInfo = { /* Session metadata */ }
export type StreamEventMessage = { /* Streaming event from Claude */ }
export type SystemMessage = { /* System-level message */ }
export type ToolUseContent = { /* Tool use event from Claude */ }
export type UserMessage = { /* User input message */ }
export type ChatMessage = { /* Chat WebSocket message */ }
export type EventForwarderContext = { /* Context for event forwarding setup */ }
export type ConnectionInfo = { /* WebSocket connection metadata */ }
```

**Session Bridge Interfaces (for consumers to implement):**

```typescript
export interface SessionInitPolicyBridge {
  getWorkspaceInitPolicy(input: WorkspaceInitPolicyInput): WorkspaceInitPolicy
}

export interface SessionWorkspaceBridge {
  markSessionRunning(sessionId: string): void
  markSessionIdle(sessionId: string): void
  on(event: string, handler: (...args: any[]) => void): void
}
```

### Workspace Domain

**State Machine & Lifecycle:**

```typescript
export const workspaceStateMachine: {
  // State transitions: NEW → PROVISIONING → READY/FAILED → ARCHIVED
  startProvisioning(id: string, opts: StartProvisioningOptions): Promise<void>
  markReady(id: string): Promise<void>
  markFailed(id: string, error: string): Promise<void>
  archive(id: string): Promise<void>
  retry(id: string): Promise<void>
}

export class WorkspaceStateMachineError extends Error {}

export class WorkspaceCreationService {
  // Creates workspaces from manual input, branch resume, or GitHub issue
  create(source: WorkspaceCreationSource, metadata: any): Promise<WorkspaceCreationResult>
}

export const worktreeLifecycleService: {
  // Creates/deletes git worktrees with path safety validation
}
```

**Query & Data:**

```typescript
export const workspaceDataService: {
  // Query and aggregation over workspaces
}

export const workspaceQueryService: {
  // Complex queries that require bridge dependencies
}

export const workspaceActivityService: {
  // Tracks which sessions are running per workspace
}
```

**State Derivation (Pure Functions):**

```typescript
export function deriveWorkspaceFlowState(input: WorkspaceFlowStateInput): WorkspaceFlowState
export function deriveWorkspaceFlowStateFromWorkspace(workspace: Workspace): WorkspaceFlowState
export function computeKanbanColumn(input: KanbanStateInput): KanbanColumn
export function getWorkspaceInitPolicy(input: WorkspaceInitPolicyInput): WorkspaceInitPolicy
export function assertWorktreePathSafe(path: string): void
export class WorktreePathSafetyError extends Error {}
```

**Kanban:**

```typescript
export const kanbanStateService: {
  configure(bridges: { session: WorkspaceSessionBridge }): void
  // Derives WORKING/WAITING/DONE columns
}
```

**Workspace Types:**

```typescript
export type StartProvisioningOptions = { /* ... */ }
export type TransitionOptions = { /* ... */ }
export type WorkspaceCreationDependencies = { /* ... */ }
export type WorkspaceCreationResult = { /* ... */ }
export type WorkspaceCreationSource = 'MANUAL' | 'RESUME_BRANCH' | 'GITHUB_ISSUE'
export type WorkspaceCiObservation = { /* ... */ }
export type WorkspaceFlowPhase = { /* ... */ }
export type WorkspaceFlowState = { /* ... */ }
export type WorkspaceFlowStateInput = { /* ... */ }
export type WorkspaceFlowStateSource = { /* ... */ }
export type WorkspaceInitPolicy = { /* ... */ }
export type WorkspaceInitPolicyInput = { /* ... */ }
export type KanbanStateInput = { /* ... */ }
export type WorkspaceWithKanbanState = { /* ... */ }
```

**Workspace Bridge Interfaces:**

```typescript
export interface WorkspaceSessionBridge {
  isAnySessionWorking(sessionIds: string[]): boolean
  getAllPendingRequests(): any[]
}

export interface WorkspaceGitHubBridge {
  checkHealth(): Promise<GitHubCLIHealthStatus>
  listReviewRequests(): Promise<ReviewRequestedPR[]>
}

export interface WorkspacePRSnapshotBridge {
  refreshWorkspace(id: string, url: string): Promise<PRSnapshotRefreshResult>
}
```

### GitHub Domain

**GitHub CLI:**

```typescript
export const githubCLIService: {
  // Wraps `gh` CLI for all GitHub operations
  // PR info, CI status, review comments, issue fetching
}

export const prSnapshotService: {
  configure(bridges: { kanban: GitHubKanbanBridge }): void
  // Attaches PR to workspace, refreshes PR state from GitHub
}

export const prReviewFixerService: {
  // Dispatches fixes for review comments
}

export const prReviewMonitorService: {
  // Monitors PRs for new review activity
}
```

**GitHub Types:**

```typescript
export type GitHubCLIErrorType = { /* ... */ }
export type GitHubCLIHealthStatus = { /* ... */ }
export type GitHubIssue = { /* ... */ }
export type PRInfo = { owner: string; repo: string; number: number }
export type PRStatusFromGitHub = { /* ... */ }
export type ReviewRequestedPR = { /* ... */ }
export type PRReviewFixResult = { /* ... */ }
export type ReviewCommentDetails = { /* ... */ }
export type AttachAndRefreshResult = { /* ... */ }
export type PRSnapshotRefreshResult = { /* ... */ }
```

**GitHub Bridge Interfaces:**

```typescript
export interface GitHubSessionBridge {
  isSessionWorking(id: string): boolean
  getClient(id: string): ClaudeClient | null
}

export interface GitHubFixerBridge {
  acquireAndDispatch(input: GitHubFixerAcquireInput): Promise<GitHubFixerAcquireResult>
  getActiveSession(workspaceId: string, workflow: string): Promise<ClaudeSession | null>
}

export interface GitHubKanbanBridge {
  updateCachedKanbanColumn(id: string): Promise<void>
}

export type GitHubFixerAcquireInput = { /* ... */ }
export type GitHubFixerAcquireResult = { /* ... */ }
```

### Ratchet Domain

**Ratchet Service:**

```typescript
export const ratchetService: {
  configure(bridges: { session: RatchetSessionBridge; github: RatchetGitHubBridge }): void
  // Polling loop: checks workspaces with PRs, dispatches fixers on state changes
}

export const fixerSessionService: {
  // Acquires idle session, dispatches fix prompt to Claude
  acquireAndDispatch(input: AcquireAndDispatchInput): Promise<AcquireAndDispatchResult>
}

export const ciFixerService: {
  // Fixes CI failures specifically
}

export const ciMonitorService: {
  // Legacy CI monitoring
}

export const reconciliationService: {
  // Cleans up orphaned sessions/workspaces
}
```

**Ratchet Types:**

```typescript
export type RatchetAction = { /* ... */ }
export type RatchetCheckResult = { /* ... */ }
export type WorkspaceRatchetResult = { /* ... */ }
export type AcquireAndDispatchInput = { /* ... */ }
export type AcquireAndDispatchResult = { /* ... */ }
export type RunningIdleSessionAction = { /* ... */ }
export type CIFailureDetails = { /* ... */ }
export type CIFixResult = { /* ... */ }
```

**Ratchet Bridge Interfaces:**

```typescript
export interface RatchetSessionBridge {
  isSessionRunning(id: string): boolean
  isSessionWorking(id: string): boolean
  stopClaudeSession(id: string): Promise<void>
  startClaudeSession(id: string, opts?: SessionStartOptions): Promise<void>
  getClient(id: string): ClaudeClient | null
  injectCommittedUserMessage(id: string, msg: string): Promise<void>
}

export interface RatchetGitHubBridge {
  extractPRInfo(url: string): PRInfo
  getPRFullDetails(repo: string, pr: number): Promise<RatchetPRFullDetails>
  getReviewComments(repo: string, pr: number): Promise<RatchetReviewComment[]>
  computeCIStatus(checks: any): CIStatus
  getAuthenticatedUsername(): Promise<string>
  fetchAndComputePRState(prUrl: string): Promise<RatchetPRStateSnapshot>
}

export interface RatchetWorkspaceBridge {
  markFailed(id: string, reason: string): Promise<void>
}

export type RatchetPRFullDetails = { /* ... */ }
export type RatchetPRStateSnapshot = { /* ... */ }
export type RatchetReviewComment = { /* ... */ }
export type RatchetStatusCheckInput = { /* ... */ }
```

### Terminal Domain

```typescript
export class TerminalService {
  create(options: CreateTerminalOptions): Promise<CreateTerminalResult>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  kill(id: string): void
}

export const terminalService: TerminalService

export type CreateTerminalOptions = { workspaceId: string; name?: string; cols?: number; rows?: number }
export type CreateTerminalResult = { id: string; pid: number }
export type TerminalInstance = { /* ... */ }
export type TerminalOutput = { /* ... */ }
export type TerminalResourceUsage = { /* ... */ }
```

### Run-Script Domain

```typescript
export class RunScriptService {
  // Executes run scripts (dev servers, etc.) for workspaces
}

export const runScriptService: RunScriptService

export const runScriptStateMachine: {
  // State: IDLE → STARTING → RUNNING → STOPPING → COMPLETED/FAILED
}

export class RunScriptStateMachineError extends Error {}

export const startupScriptService: {
  // Runs startup scripts during workspace provisioning
  configure(bridges: { workspace: RunScriptWorkspaceBridge }): void
}

export type StartupScriptResult = { /* ... */ }
export type TransitionOptions = { /* ... */ }
```

**Run-Script Bridge Interface:**

```typescript
export interface RunScriptWorkspaceBridge {
  markReady(id: string): Promise<void>
  markFailed(id: string, message: string): Promise<void>
}
```

### Infrastructure Services

```typescript
// Logging
export function createLogger(name: string): Logger

// Configuration
export const configService: {
  get databasePath(): string
  get port(): number
  get env(): string
  get debug(): boolean
  // ... environment config
}
export type SessionProfile = { /* ... */ }

// Git operations
export const gitOpsService: {
  clone(url: string, dest: string): Promise<void>
  createWorktree(repoPath: string, branch: string, dest: string): Promise<void>
  removeWorktree(repoPath: string, dest: string): Promise<void>
  push(repoPath: string, branch: string): Promise<void>
  // ... other git operations
}

// Scheduling
export const schedulerService: {
  scheduleInterval(name: string, fn: () => Promise<void>, intervalMs: number): void
  stop(name: string): void
  stopAll(): void
}

// Rate limiting
export const rateLimiter: {
  // GitHub API rate limit coordination
}

// Port management
export function findAvailablePort(preferred?: number): Promise<number>
export function isPortAvailable(port: number): Promise<boolean>

// CLI health
export const cliHealthService: {
  check(): Promise<CLIHealthStatus>
}
export type CLIHealthStatus = { /* ... */ }

// Data backup
export const dataBackupService: {
  export(): Promise<ExportData>
  import(data: ExportData): Promise<ImportResults>
}
export type ExportData = { /* ... */ }
export type ImportResults = { /* ... */ }
export type ImportCounter = { /* ... */ }
export const exportDataSchema: ZodSchema

// Notifications
export const notificationService: {
  send(title: string, body: string): void
}

// Server instance management
export const serverInstanceService: {
  // Server lifecycle tracking
}
```

### Resource Accessors

```typescript
export const claudeSessionAccessor: {
  create(data: CreateClaudeSessionInput): Promise<ClaudeSession>
  findById(id: string): Promise<ClaudeSessionWithWorkspace | null>
  findByWorkspaceId(wsId: string, filters?: FindByWorkspaceIdFilters): Promise<ClaudeSession[]>
  update(id: string, data: UpdateClaudeSessionInput): Promise<ClaudeSession>
  delete(id: string): Promise<ClaudeSession>
  findWithPid(): Promise<ClaudeSession[]>
  acquireFixerSession(input: AcquireFixerSessionInput): Promise<FixerSessionAcquisition>
}

export const workspaceAccessor: {
  create(data: CreateWorkspaceInput): Promise<Workspace>
  findById(id: string): Promise<WorkspaceWithSessions | null>
  findRawById(id: string): Promise<Workspace | null>
  findRawByIdOrThrow(id: string): Promise<Workspace>
  findByProjectId(projectId: string, filters?: FindByProjectIdFilters): Promise<Workspace[]>
  findByProjectIdWithSessions(projectId: string, filters?: FindByProjectIdFilters): Promise<WorkspaceWithSessions[]>
  update(id: string, data: UpdateWorkspaceInput): Promise<Workspace>
  transitionWithCas(id: string, fromStatus: WorkspaceStatus, data: UpdateWorkspaceInput): Promise<{ count: number }>
  delete(id: string): Promise<Workspace>
  findNeedingWorktree(): Promise<WorkspaceWithProject[]>
  findByIdWithProject(id: string): Promise<WorkspaceWithProject | null>
  findWithPRsForRatchet(): Promise<WorkspaceWithPR[]>
  markHasHadSessions(id: string): Promise<void>
  clearRatchetActiveSession(wsId: string, sessionId: string): Promise<void>
  // ... additional query methods for PR sync, CI monitoring, review monitoring
}

export const projectAccessor: {
  create(data: CreateProjectInput, context: ProjectAccessorContext): Promise<Project>
  findById(id: string): Promise<ProjectWithWorkspaces | null>
  findBySlug(slug: string): Promise<ProjectWithWorkspaces | null>
  update(id: string, data: UpdateProjectInput): Promise<Project>
  list(filters?: ListProjectsFilters): Promise<Project[]>
  archive(id: string): Promise<Project>
  delete(id: string): Promise<Project>
  validateRepoPath(repoPath: string): Promise<{ valid: boolean; error?: string }>
}
export function parseGitHubRemoteUrl(url: string): { owner: string; repo: string } | null

export const terminalSessionAccessor: {
  create(data: CreateTerminalSessionInput): Promise<TerminalSession>
  findById(id: string): Promise<TerminalSessionWithWorkspace | null>
  findByWorkspaceId(wsId: string, filters?: FindByWorkspaceIdFilters): Promise<TerminalSession[]>
  update(id: string, data: UpdateTerminalSessionInput): Promise<TerminalSession>
  delete(id: string): Promise<TerminalSession>
  findWithPid(): Promise<TerminalSession[]>
}

export const userSettingsAccessor: {
  get(): Promise<UserSettings>
  update(data: UpdateUserSettingsInput): Promise<UserSettings>
  getWorkspaceOrder(projectId: string): Promise<string[]>
  updateWorkspaceOrder(projectId: string, ids: string[]): Promise<UserSettings>
}

export const decisionLogAccessor: {
  create(data: CreateDecisionLogInput): Promise<DecisionLog>
  findById(id: string): Promise<DecisionLog | null>
  findByAgentId(agentId: string, limit?: number): Promise<DecisionLog[]>
  findRecent(limit?: number): Promise<DecisionLog[]>
  list(options: any): Promise<DecisionLog[]>
}

export const healthAccessor: {
  checkDatabaseConnection(): Promise<void>
}

export const dataBackupAccessor: {
  getSnapshotForExport(): Promise<DataBackupSnapshot>
  runInTransaction<T>(callback: (tx: any) => Promise<T>): Promise<T>
}
```

### Orchestration Entry Point

```typescript
// The single function that wires all cross-domain bridges
export function configureDomainBridges(): void
```

This is called once at startup. It wires:
- Ratchet ↔ Session bridge (process lifecycle)
- Ratchet ↔ GitHub bridge (PR data retrieval)
- Workspace ↔ Session bridge (activity checks)
- Workspace ↔ GitHub bridge (health/review requests)
- GitHub ↔ Kanban bridge (column updates)
- Session ↔ Workspace bridge (event forwarding)
- Session ↔ Init Policy bridge (workspace init policy)
- Run-Script ↔ Workspace bridge (provisioning callbacks)

### Data Model (Prisma)

The core library includes the full Prisma schema (SQLite):

**Enums:**

```typescript
export enum WorkspaceStatus { NEW, PROVISIONING, READY, FAILED, ARCHIVED }
export enum SessionStatus { IDLE, RUNNING, PAUSED, COMPLETED, FAILED }
export enum PRState { NONE, DRAFT, OPEN, CHANGES_REQUESTED, APPROVED, MERGED, CLOSED }
export enum CIStatus { UNKNOWN, PENDING, SUCCESS, FAILURE }
export enum KanbanColumn { WORKING, WAITING, DONE }
export enum RatchetState { IDLE, CI_RUNNING, CI_FAILED, REVIEW_PENDING, READY, MERGED }
export enum WorkspaceCreationSource { MANUAL, RESUME_BRANCH, GITHUB_ISSUE }
export enum RunScriptStatus { IDLE, STARTING, RUNNING, STOPPING, COMPLETED, FAILED }
```

**Models:**

```
Project
  id, name, slug, repoPath, worktreeBasePath, defaultBranch
  githubOwner?, githubRepo?
  startupScriptCommand?, startupScriptPath?, startupScriptTimeout?
  → workspaces[]

Workspace
  id, projectId → Project
  name, description?, status, worktreePath?, branchName?, isAutoGeneratedBranch
  creationSource, creationMetadata?
  initErrorMessage?, initOutput?, initStartedAt?, initCompletedAt?, initRetryCount
  runScriptCommand?, runScriptCleanupCommand?, runScriptPid?, runScriptPort?, runScriptStartedAt?, runScriptStatus
  prUrl?, prNumber?, prState, prReviewState?, prCiStatus, prUpdatedAt?
  prCiFailedAt?, prCiLastNotifiedAt?
  prReviewLastCheckedAt?, prReviewLastCommentId?
  ratchetEnabled, ratchetState, ratchetLastCheckedAt?, ratchetLastPushAt?, ratchetActiveSessionId?, ratchetLastCiRunId?, ratchetLastNotifiedState?
  hasHadSessions, cachedKanbanColumn?, stateComputedAt?
  githubIssueNumber?, githubIssueUrl?
  → claudeSessions[], terminalSessions[]

ClaudeSession
  id, workspaceId → Workspace
  name?, workflow?, model?, status, claudeSessionId?, claudeProjectPath?, claudeProcessPid?

TerminalSession
  id, workspaceId → Workspace
  name?, status, pid?

DecisionLog
  id, agentId, decision, reasoning, context?, timestamp

UserSettings
  id, userId, preferredIde?, customIdeCommand?
  playSoundOnComplete?, notificationSoundPath?
  workspaceOrder?, cachedSlashCommands?
  ratchetEnabled
```

## 1.3 Refactor `packages/desktop/`

Move everything that isn't core into `packages/desktop/`:
- Server (`server.ts`, `app-context.ts`)
- tRPC routers (`workspace`, `session`, `project`, `github`, `prReview`, `admin`, `userSettings`, `decisionLog`)
- WebSocket handlers (`/chat`, `/terminal`, `/dev-logs`)
- Orchestration layer (bridge wiring — same logic, new import paths)
- Electron wrapper
- React UI
- CLI entrypoint

Update all imports:
```typescript
// Before
import { ClaudeClient } from '@/backend/domains/session/claude';

// After
import { ClaudeClient } from '@factory-factory/core';
```

Desktop's orchestration layer calls `configureDomainBridges()` from core at startup — same wiring as today, just imported from the library.

## 1.4 Verify and Publish

- All existing tests pass
- Desktop app works identically (same commands: `pnpm dev`, `pnpm build`, `pnpm dev:electron`)
- Publish `@factory-factory/core` to npm with semantic versioning

## How to test manually

1. **Install core from npm in a fresh project:**
   ```bash
   mkdir /tmp/test-core && cd /tmp/test-core && npm init -y
   npm install @factory-factory/core
   node -e "const core = require('@factory-factory/core'); console.log(Object.keys(core))"
   ```
   Verify the exported API matches the spec in section 1.3.

2. **Run the desktop app end-to-end:**
   ```bash
   pnpm dev:electron
   ```
   Create a project, create a workspace from a GitHub issue, start a Claude session, send a message, verify streaming responses. This should work identically to before the refactor.

3. **Run the full test suite:**
   ```bash
   pnpm test && pnpm typecheck && pnpm check:fix
   ```
   All tests pass, no type errors, no lint errors.

4. **Verify domain isolation:**
   ```bash
   pnpm exec dependency-cruiser -- packages/core/src
   ```
   No cross-domain imports within core. All bridge interfaces are used correctly.

5. **Verify desktop imports core (not internal paths):**
   ```bash
   grep -r "from '@/backend/domains/" packages/desktop/src/ | head -20
   ```
   Should return zero results — all domain imports should be from `@factory-factory/core`.

## Done when

Desktop FF works exactly as before, but internally uses the extracted core library. `@factory-factory/core` is published to npm and installable by any consumer.
