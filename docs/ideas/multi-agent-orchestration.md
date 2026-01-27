# Multi-Agent Orchestration Design Document

## 1. Executive Summary

This document proposes a multi-agent orchestration system for factory-factory, inspired by Codebuff's approach of specialized sub-agents with controlled spawning and tool permissions. The design builds upon factory-factory's existing Worker/Supervisor/Orchestrator hierarchy while introducing Codebuff-style specialization and programmatic control.

## 2. Current Architecture Analysis

### 2.1 Existing Hierarchy

Factory-factory already has a three-tier agent hierarchy defined in `/prompts/`:

| Level | Role | Responsibility |
|-------|------|----------------|
| **Orchestrator** | Operations layer | Monitor supervisors, trigger recovery, create supervisors for tasks |
| **Supervisor** | Project coordinator | Break down tasks, create workers, review code, merge branches |
| **Worker** | Implementation agent | Execute specific coding tasks, test, commit, submit PRs |

### 2.2 Current Implementation Components

1. **AgentProcessAdapter** (`src/backend/agents/process-adapter.ts`)
   - Maps agentId to ClaudeClient instances
   - Handles MCP tool execution via `executeMcpTool()`
   - Already supports `AgentType: 'worker' | 'supervisor' | 'orchestrator'`
   - Manages process lifecycle events

2. **ClaudeClient** (`src/backend/claude/index.ts`)
   - High-level API for Claude CLI interaction
   - Permission handling via `PermissionHandler` interface
   - Session management and tool result forwarding

3. **ClaudeSession Model** (`prisma/schema.prisma`)
   - Tracks workflow type, model, status
   - Stores `claudeSessionId` for resume functionality
   - Links to Workspace

### 2.3 Gap Analysis

The current system lacks:
- **Specialization**: All agents use the same toolset
- **Spawning mechanism**: No programmatic way for agents to create sub-agents
- **Tool restrictions**: No per-agent tool permission enforcement
- **Agent coordination**: Limited parent-child relationship tracking
- **Programmatic control**: No generator-based step handling

## 3. Proposed Agent Types

Building on Codebuff's model while aligning with factory-factory's coding focus:

### 3.1 Core Agent Types

| Agent Type | Purpose | Spawnable By | Tool Access |
|------------|---------|--------------|-------------|
| **Orchestrator** | System health, supervisor management | System only | Admin tools, monitoring |
| **Supervisor** | Task coordination, code review | Orchestrator | Planning, review, git management |
| **Worker** | Implementation | Supervisor | Full file system, bash, git |
| **Planner** | Task decomposition, architecture | Supervisor | Read-only, research |
| **Reviewer** | Code validation, test verification | Supervisor | Read-only, test runners |
| **Researcher** | Documentation, API exploration | Worker, Supervisor | Web fetch, docs search |
| **Fixer** | Focused bug/issue resolution | Reviewer | Edit, limited bash |

### 3.2 Agent Specialization Rationale

1. **Planner Agent**: Separates planning from execution, uses thinking-heavy prompts, can generate best-of-N plans
2. **Reviewer Agent**: Dedicated validation without modification privileges, prevents accidentally "fixing" issues during review
3. **Researcher Agent**: Web access without file modification, safe for exploring external docs
4. **Fixer Agent**: Limited scope for addressing specific issues flagged by Reviewer

## 4. Spawning Mechanism

### 4.1 SpawnableAgents Configuration

Each agent type declares which sub-agents it can create:

```typescript
// src/backend/agents/spawnable-config.ts
export const SPAWNABLE_AGENTS: Record<AgentType, AgentType[]> = {
  orchestrator: ['supervisor'],
  supervisor: ['worker', 'planner', 'reviewer'],
  worker: ['researcher'],
  planner: [],
  reviewer: ['fixer'],
  researcher: [],
  fixer: [],
};
```

### 4.2 Spawn Tool Integration

Add a new MCP tool that agents can invoke:

```typescript
interface SpawnAgentInput {
  agentType: AgentType;
  task: string;
  context?: Record<string, unknown>;
  model?: string;
  maxTurns?: number;
  awaitResult?: boolean;
}
```

The tool validates:
1. Parent agent is allowed to spawn the requested type
2. Resource limits (max concurrent agents)
3. Task scoping (child inherits parent's workspace context)

### 4.3 Parent-Child Relationship Tracking

Extend the database to track agent hierarchies (see schema in Section 7).

## 5. Tool Permissions System

### 5.1 Per-Agent Tool Allowlists

Define tool access by agent type:

```typescript
// src/backend/agents/tool-permissions.ts
export const AGENT_TOOL_PERMISSIONS: Record<AgentType, ToolPermissionConfig> = {
  orchestrator: {
    allowed: ['mcp__admin__*', 'mcp__monitoring__*'],
    disallowed: ['Bash', 'Write', 'Edit'],
  },
  supervisor: {
    allowed: ['*'],
    disallowed: ['mcp__admin__*'],
  },
  worker: {
    allowed: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'mcp__git__*'],
    disallowed: ['mcp__admin__*', 'mcp__spawn_agent'],
  },
  planner: {
    allowed: ['Read', 'Glob', 'Grep', 'WebFetch', 'TodoWrite', 'Task'],
    disallowed: ['Write', 'Edit', 'Bash'],
  },
  reviewer: {
    allowed: ['Read', 'Glob', 'Grep', 'Bash'], // Bash for running tests only
    disallowed: ['Write', 'Edit'],
  },
  researcher: {
    allowed: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    disallowed: ['Write', 'Edit', 'Bash'],
  },
  fixer: {
    allowed: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
    disallowed: ['Bash', 'mcp__spawn_agent'],
  },
};
```

### 5.2 Permission Enforcement

Extend `AgentProcessAdapter` to filter tool access:

```typescript
// In AgentProcessAdapter.startAgent()
const toolPermissions = getToolPermissionsForAgent(options.agentType);
const clientOptions: ClaudeClientOptions = {
  // ...existing options
  disallowedTools: toolPermissions.disallowed,
  permissionHandler: new AgentTypePermissionHandler(
    options.agentType,
    toolPermissions
  ),
};
```

## 6. Programmatic Control Layer

### 6.1 Agent Controller

Introduce a controller pattern for managing agent execution:

```typescript
// src/backend/agents/agent-controller.ts
export class AgentController {
  private agent: ClaudeClient;
  private steps: AsyncGenerator<AgentStep, AgentResult>;

  constructor(config: AgentConfig) {
    this.steps = this.handleSteps(config);
  }

  async *handleSteps(config: AgentConfig): AsyncGenerator<AgentStep, AgentResult> {
    // Initial prompt
    yield { type: 'prompt', content: config.task };

    // Wait for agent to process
    while (this.agent.isRunning()) {
      const event = await this.waitForEvent();

      if (event.type === 'spawn_request') {
        const subAgent = await this.spawnSubAgent(event.input);
        const subResult = await subAgent.run();
        yield { type: 'sub_agent_complete', result: subResult };
      }

      if (event.type === 'result') {
        return event.result;
      }
    }
  }

  async run(): Promise<AgentResult> {
    for await (const step of this.steps) {
      await this.processStep(step);
    }
  }
}
```

### 6.2 Event-Driven Coordination

Add events for agent lifecycle:

```typescript
interface AgentEvents {
  'agent:spawned': { agentId: string; parentId: string; type: AgentType };
  'agent:completed': { agentId: string; result: AgentResult };
  'agent:failed': { agentId: string; error: Error };
  'agent:message': { agentId: string; message: ClaudeJson };
}
```

## 7. Database Schema Changes

### 7.1 New Models

```prisma
// Add to schema.prisma

enum AgentType {
  ORCHESTRATOR
  SUPERVISOR
  WORKER
  PLANNER
  REVIEWER
  RESEARCHER
  FIXER
}

enum AgentStatus {
  PENDING
  RUNNING
  WAITING_CHILD  // Waiting for sub-agent to complete
  COMPLETED
  FAILED
  CANCELLED
}

model AgentSession {
  id              String        @id @default(cuid())
  workspaceId     String
  workspace       Workspace     @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  // Agent type and hierarchy
  agentType       AgentType
  parentAgentId   String?
  parentAgent     AgentSession? @relation("AgentHierarchy", fields: [parentAgentId], references: [id])
  childAgents     AgentSession[] @relation("AgentHierarchy")

  // Task definition
  task            String        @db.Text
  context         Json?         // Additional context passed from parent

  // Execution state
  status          AgentStatus   @default(PENDING)
  result          Json?         // Structured result
  errorMessage    String?

  // Claude session tracking
  claudeSessionId String?
  claudeProcessPid Int?
  model           String        @default("sonnet")

  // Metrics
  promptTokens    Int           @default(0)
  completionTokens Int          @default(0)
  turnCount       Int           @default(0)

  // Timestamps
  createdAt       DateTime      @default(now())
  startedAt       DateTime?
  completedAt     DateTime?

  @@index([workspaceId])
  @@index([parentAgentId])
  @@index([status])
  @@index([agentType])
}

model AgentMessage {
  id              String        @id @default(cuid())
  agentSessionId  String
  agentSession    AgentSession  @relation(fields: [agentSessionId], references: [id], onDelete: Cascade)

  role            String        // user, assistant
  content         Json          // Full message content

  createdAt       DateTime      @default(now())

  @@index([agentSessionId, createdAt])
}
```

### 7.2 Migration Path

1. Create new `AgentSession` model alongside existing `ClaudeSession`
2. Migrate existing sessions with `agentType: WORKER` (default)
3. Add foreign key for parent-child relationships
4. Deprecate `ClaudeSession` after migration complete

## 8. Integration with Claude CLI

### 8.1 System Prompt Composition

Use the existing `PromptBuilder` pattern to compose agent-specific prompts:

```typescript
// src/backend/agents/prompt-factory.ts
export function buildAgentPrompt(agentType: AgentType, context: AgentContext): string {
  const builder = new PromptBuilder();

  // Base role prompt
  builder.addFile(`${agentType}-role.md`);

  // Tool usage guidelines
  builder.addFile(`${agentType}-tools.md`);

  // Spawning instructions (if applicable)
  if (SPAWNABLE_AGENTS[agentType].length > 0) {
    builder.addFile('spawn-agents.md');
  }

  // Task-specific context
  builder.addRaw(formatTaskContext(context));

  return builder.build();
}
```

### 8.2 Spawn Agent MCP Tool

Register a new MCP tool for agent spawning:

```typescript
// src/backend/routers/mcp/spawn-agent.mcp.ts
registerMcpTool({
  name: 'mcp__agent__spawn',
  description: 'Spawn a specialized sub-agent to handle a specific task',
  handler: async (ctx: McpToolContext, input: SpawnAgentInput) => {
    const { agentId } = ctx;
    const parentAgent = await agentSessionAccessor.findById(agentId);

    // Validate spawn permission
    const allowed = SPAWNABLE_AGENTS[parentAgent.agentType];
    if (!allowed.includes(input.agentType)) {
      return createErrorResponse(
        McpErrorCode.PERMISSION_DENIED,
        `${parentAgent.agentType} cannot spawn ${input.agentType}`
      );
    }

    // Create child agent session
    const childSession = await agentSessionAccessor.create({
      workspaceId: parentAgent.workspaceId,
      parentAgentId: agentId,
      agentType: input.agentType,
      task: input.task,
      context: input.context,
      model: input.model ?? 'sonnet',
    });

    // Spawn the agent process
    if (input.awaitResult) {
      const result = await agentController.runAndWait(childSession.id);
      return createSuccessResponse(result);
    } else {
      agentController.runAsync(childSession.id);
      return createSuccessResponse({ agentId: childSession.id, status: 'spawned' });
    }
  },
});
```

## 9. Phased Implementation Approach

### Phase 1: Foundation (1-2 weeks)
- Create `AgentSession` model and migration
- Create `AgentSessionAccessor` resource accessor
- Define `AgentType` enum and tool permission configs
- Update `AgentProcessAdapter` to use new `AgentType` values

### Phase 2: Permission System (1 week)
- Implement `AgentTypePermissionHandler`
- Add tool filtering based on agent type
- Create agent-specific prompt templates
- Add unit tests for permission enforcement

### Phase 3: Spawning Mechanism (1-2 weeks)
- Implement `mcp__agent__spawn` tool
- Create `AgentController` for lifecycle management
- Add parent-child relationship tracking
- Implement synchronous and asynchronous spawn modes

### Phase 4: Agent Specialization (2 weeks)
- Create prompt files for each agent type
- Implement Planner agent (best-of-N planning)
- Implement Reviewer agent (validation focus)
- Implement Researcher agent (web access)
- Implement Fixer agent (targeted fixes)

### Phase 5: UI Integration (1-2 weeks)
- Add agent hierarchy visualization
- Display child agent status in parent view
- Show tool restriction indicators
- Add agent type badges to session tabs

### Phase 6: Monitoring and Debugging (1 week)
- Add agent hierarchy to DecisionLog
- Create agent tracing for debugging
- Implement cascading failure detection
- Add metrics collection (tokens, turns, spawn depth)

## 10. Example Workflow

### 10.1 Task: "Add user authentication to the API"

```
Supervisor
├── Planner (analyzes, returns 4 subtasks)
├── Worker: User Model
│   └── Researcher: Prisma docs
├── Worker: Register Endpoint
│   └── Researcher: JWT best practices
├── Worker: Login Endpoint
└── Reviewer
    └── Fixer: Test failures
```

### 10.2 Execution Flow

1. **Supervisor** receives task, spawns **Planner**
2. **Planner** analyzes codebase, returns decomposition (4 subtasks)
3. **Supervisor** spawns 3 **Workers** in parallel
4. **Worker 1** spawns **Researcher** for Prisma migration docs
5. All workers complete, notify Supervisor
6. **Supervisor** spawns **Reviewer** to validate changes
7. **Reviewer** finds test failures, spawns **Fixer**
8. **Fixer** resolves issues, returns to Reviewer
9. **Reviewer** approves, Supervisor creates PR

## 11. Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Runaway spawning | Max depth limit (3), max concurrent agents per workspace (10) |
| Token exhaustion | Track tokens per agent tree, set budgets |
| Stuck agents | Health check at all levels, timeout enforcement |
| Conflicting edits | Planner ensures non-overlapping file assignments |
| Context loss | Pass parent session ID for context inheritance |

## 12. Success Metrics

1. **Task completion rate**: % of tasks completed without human intervention
2. **Agent efficiency**: Tokens used per task vs. single-agent baseline
3. **Error reduction**: Fewer review iterations due to specialized validation
4. **Parallelization benefit**: Wall-clock time savings from concurrent workers

## 13. Critical Files for Implementation

- `src/backend/agents/process-adapter.ts` - Core agent process management
- `prisma/schema.prisma` - Database schema for AgentSession model
- `src/backend/claude/permissions.ts` - Permission handler infrastructure
- `src/backend/routers/mcp/server.ts` - MCP tool registration pattern
- `src/backend/prompts/builder.ts` - Prompt composition utility
