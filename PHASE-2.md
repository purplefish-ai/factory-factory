# Phase 2: Worker Agent & Task Execution

## Overview
Implement the Worker agent with Claude SDK integration, worker-specific MCP tools, and the ability to execute tasks autonomously. Workers will write code, create PRs, and communicate via the mail system.

## Goals
- Worker agent implementation with Claude SDK
- Worker-specific MCP tools (`mcp__task__*`, `mcp__git__*`)
- Claude client wrapper with agent execution profiles
- Tmux session management for worker agents
- Manual task creation workflow (no supervisor yet)
- End-to-end: Task → Worker codes mini-feature → Creates PR

## Dependencies
- Phase 0 complete (foundation)
- Phase 1 complete (MCP infrastructure)

## Implementation Steps

### 1. Claude SDK Client
- [ ] Create `src/backend/clients/claude.client.ts`
- [ ] Install Claude SDK dependencies: `@anthropic-ai/sdk`
- [ ] Implement Claude client class:
  - [ ] `initialize(config)` - Initialize SDK with API key and config
  - [ ] `createAgent(systemPrompt, tools, permissions)` - Create agent instance
  - [ ] `sendMessage(agentId, message)` - Send message to agent
  - [ ] `processToolCall(agentId, toolCall)` - Handle tool call from agent
  - [ ] `disableTools(toolNames)` - Disable specific tools (e.g., AskUserQuestion)
- [ ] Implement agent execution profile configuration:
  - [ ] Define `AgentExecutionProfile` type (model, permissions, planMode)
  - [ ] Define `AGENT_PROFILES` constant for each agent type
  - [ ] Implement `getProfileForAgentType(type)` - Get profile by agent type
  - [ ] Support environment variable overrides (WORKER_MODEL, WORKER_PERMISSIONS)
- [ ] Add error handling and retry logic for Claude API calls
- [ ] Test: Create test agent and send test message

### 2. Worker System Prompt
- [ ] Create `src/backend/agents/worker/` directory
- [ ] Create `src/backend/agents/worker/worker.prompts.ts`:
  - [ ] Define worker system prompt template:
    - [ ] Role: "You are a Worker agent in the FactoryFactory system"
    - [ ] Responsibilities: Execute assigned task, write code, create PR
    - [ ] Available tools: List all worker MCP tools
    - [ ] Communication: "Use mail system to communicate with supervisor"
    - [ ] Workflow: "Use mcp__agent__get_task to see assignment, update state as you progress"
    - [ ] Git workflow: "Work in your dedicated worktree, create PR when done"
    - [ ] Testing: "Run tests before creating PR"
  - [ ] Define `buildWorkerPrompt(taskId)` - Build prompt with task context
  - [ ] Include examples of successful task completion workflows
- [ ] Test: Review prompt for clarity and completeness

### 3. Worker MCP Tools - Task Management
- [ ] Create `src/backend/routers/mcp/task.mcp.ts`
- [ ] Implement `mcp__task__update_state`:
  - [ ] Get agent ID from context
  - [ ] Verify agent is a WORKER
  - [ ] Verify agent has a task assigned
  - [ ] Validate state transition is valid
  - [ ] Update task state using task accessor
  - [ ] Log decision
  - [ ] Return new state and timestamp
- [ ] Implement `mcp__task__create_pr`:
  - [ ] Get agent ID from context
  - [ ] Fetch worker's task and epic
  - [ ] Use GitHub client to create PR (from task branch → epic branch)
  - [ ] Update task state to PENDING_REVIEW
  - [ ] Store PR URL in task record
  - [ ] Send mail to supervisor with PR details
  - [ ] Log decision
  - [ ] Return PR URL and task ID
- [ ] Implement `mcp__task__get_pr_status`:
  - [ ] Get agent ID from context
  - [ ] Fetch worker's task PR URL
  - [ ] Use GitHub client to get PR status
  - [ ] Return state and review status
  - [ ] Log decision
- [ ] Register all task tools in MCP registry
- [ ] Test: Mock worker updates task state, creates PR

### 4. Worker MCP Tools - Git Operations
- [ ] Create `src/backend/routers/mcp/git.mcp.ts`
- [ ] Implement `mcp__git__rebase`:
  - [ ] Get agent ID from context
  - [ ] Fetch worker's task and epic
  - [ ] Get task worktree path
  - [ ] Execute git rebase (task branch onto epic branch)
  - [ ] Detect conflicts
  - [ ] If success: Update task state to PENDING_REVIEW, return success
  - [ ] If conflicts: Update task state to FAILED, return conflict details
  - [ ] Log decision
  - [ ] Force-push rebased branch
- [ ] Implement `mcp__git__get_diff`:
  - [ ] Get agent ID from context
  - [ ] Fetch worker's task and epic
  - [ ] Get diff between task branch and epic branch
  - [ ] Return diff content, files changed, insertions, deletions
  - [ ] Log decision
- [ ] Register git tools in MCP registry
- [ ] Test: Mock worker gets diff, performs rebase

### 5. Worker Agent Implementation
- [ ] Create `src/backend/agents/worker/worker.agent.ts`
- [ ] Implement Worker agent class:
  - [ ] `create(taskId)` - Create new worker agent:
    - [ ] Create agent record in database (type: WORKER)
    - [ ] Create tmux session for worker
    - [ ] Get task details from database
    - [ ] Get epic details from database
    - [ ] Create git worktree for task (branch from epic worktree)
    - [ ] Initialize Claude SDK agent with worker profile
    - [ ] Set system prompt with task context
    - [ ] Disable `AskUserQuestion` tool
    - [ ] Start agent execution loop
    - [ ] Return agent ID
  - [ ] `run(agentId)` - Main execution loop:
    - [ ] Send initial message: "Check your task assignment and begin work"
    - [ ] Listen for Claude tool calls
    - [ ] Route tool calls through MCP server
    - [ ] Return tool responses to Claude
    - [ ] Continue until agent sends completion message or fails
  - [ ] `handleToolCall(agentId, toolCall)` - Process tool calls:
    - [ ] Extract tool name and input
    - [ ] Call `executeMcpTool(agentId, toolName, input)`
    - [ ] Return tool response to Claude
  - [ ] `stop(agentId)` - Gracefully stop agent:
    - [ ] Update agent state to DONE
    - [ ] Keep tmux session alive for inspection
    - [ ] Log completion
- [ ] Test: Create worker manually and verify it initializes correctly

### 6. Worker Lifecycle Management
- [ ] Create `src/backend/agents/worker/lifecycle.ts`:
  - [ ] `startWorker(taskId)` - Create and start worker for task
  - [ ] `stopWorker(agentId)` - Stop worker gracefully
  - [ ] `killWorker(agentId)` - Force kill worker (cleanup)
  - [ ] `recreateWorker(taskId)` - Recreate crashed worker
- [ ] Add worker state management:
  - [ ] Track worker execution in memory (agent ID → execution context)
  - [ ] Handle worker completion (update task state, agent state)
  - [ ] Handle worker failure (log error, update states)
- [ ] Test: Start worker, stop worker, verify states update correctly

### 7. Manual Task Creation Interface
- [ ] Create `src/backend/routers/api/manual-task.router.ts` (tRPC router):
  - [ ] `createTask` mutation:
    - [ ] Input: epicId, title, description
    - [ ] Create task record in database
    - [ ] Generate worktree name
    - [ ] Return task ID
  - [ ] `startWorker` mutation:
    - [ ] Input: taskId
    - [ ] Call `startWorker(taskId)` lifecycle function
    - [ ] Return agent ID and tmux session name
  - [ ] `getTaskStatus` query:
    - [ ] Input: taskId
    - [ ] Return task details including state, PR URL, agent info
- [ ] Register router with tRPC server
- [ ] Test: Use tRPC client or Postman to manually create task and start worker

### 8. Worker Testing Scenario
- [ ] Create test epic in database:
  - [ ] Title: "Test Epic: Add Hello World Feature"
  - [ ] Description: "Add a simple hello world endpoint to test worker functionality"
  - [ ] Create epic worktree from main branch in `~/Programming/monorepo`
- [ ] Create test task:
  - [ ] Title: "Add GET /hello endpoint"
  - [ ] Description: "Create a simple GET endpoint at /hello that returns {message: 'Hello World'}"
  - [ ] Epic: Test epic created above
- [ ] Start worker for test task:
  - [ ] Worker should read task via `mcp__agent__get_task`
  - [ ] Worker should write code in task worktree
  - [ ] Worker should run any existing tests
  - [ ] Worker should create PR to epic branch
  - [ ] Worker should send completion mail (to supervisor - will fail gracefully since no supervisor exists yet)
- [ ] Verify worker behavior:
  - [ ] Check tmux session shows worker activity
  - [ ] Check task worktree has new code
  - [ ] Check PR was created on GitHub
  - [ ] Check task state updated to PENDING_REVIEW
  - [ ] Check decision logs show all tool calls

### 9. Worker Error Handling
- [ ] Add error handling in worker agent:
  - [ ] Handle Claude API errors (rate limits, timeouts)
  - [ ] Handle tool call failures (return error to Claude)
  - [ ] Handle git operation failures (rebase conflicts)
  - [ ] Handle PR creation failures (GitHub API errors)
  - [ ] Log all errors to decision log
- [ ] Test error scenarios:
  - [ ] Invalid git operation
  - [ ] PR creation failure
  - [ ] Tool permission denied

### 10. Worker Observability
- [ ] Add logging to worker agent:
  - [ ] Log worker initialization
  - [ ] Log tool calls (via MCP automatic logging)
  - [ ] Log Claude responses
  - [ ] Log state transitions
  - [ ] Log errors and exceptions
- [ ] Add tmux output capture:
  - [ ] Write worker logs to tmux session
  - [ ] Allow viewing logs via terminal component
- [ ] Test: Start worker and observe logs in tmux session

### 11. Integration with Inngest
- [ ] Create `src/backend/inngest/functions/task-created.ts`:
  - [ ] Handle `task.created` event
  - [ ] Call `startWorker(taskId)` to create worker
  - [ ] Log worker creation
  - [ ] Handle errors (e.g., worker creation failure)
- [ ] Update manual task creation to fire `task.created` event
- [ ] Test: Create task → event fires → worker starts automatically

### 12. Documentation
- [ ] Create `docs/WORKER_AGENT.md`:
  - [ ] Document worker responsibilities
  - [ ] Document worker system prompt
  - [ ] Document worker MCP tools
  - [ ] Document worker lifecycle
  - [ ] Document worker error handling
  - [ ] Include example task completion workflow
- [ ] Update `docs/MCP_TOOLS.md` with worker-specific tools
- [ ] Add comments to worker agent code

## Smoke Test Checklist

Run these tests manually to validate Phase 2 completion:

- [ ] **Claude Client**: Can initialize Claude SDK and create agent
- [ ] **Worker Profile**: Worker uses correct model and permissions (from config)
- [ ] **Epic Creation**: Can create test epic in database with worktree
- [ ] **Task Creation**: Can create task via tRPC mutation
- [ ] **Worker Start**: Can start worker for task via tRPC mutation
- [ ] **Agent Initialization**: Worker agent initializes with correct system prompt
- [ ] **Task Introspection**: Worker calls `mcp__agent__get_task` and gets task details
- [ ] **Epic Introspection**: Worker calls `mcp__agent__get_epic` and gets epic details
- [ ] **Code Writing**: Worker writes code in task worktree (visible in git status)
- [ ] **State Update**: Worker updates task state via `mcp__task__update_state`
- [ ] **PR Creation**: Worker creates PR via `mcp__task__create_pr`
- [ ] **PR Verification**: PR appears on GitHub with correct source/target branches
- [ ] **Mail Sending**: Worker sends completion mail to supervisor (no supervisor exists, but mail created)
- [ ] **Decision Logs**: All worker tool calls appear in decision logs
- [ ] **Tmux Session**: Can view worker activity in tmux session via terminal component
- [ ] **Task State**: Task state updates to PENDING_REVIEW after PR creation
- [ ] **Inngest Event**: `task.created` event triggers worker creation
- [ ] **Error Handling**: Worker handles tool errors gracefully (e.g., permission denied)

## Success Criteria

- [ ] All smoke tests pass
- [ ] Worker can autonomously complete a simple coding task
- [ ] Worker creates valid PR to epic branch
- [ ] Worker communicates progress via task state updates
- [ ] Worker logs all actions to decision log
- [ ] Worker runs in dedicated tmux session (observable)
- [ ] Worker handles errors without crashing
- [ ] Can manually create tasks and start workers via tRPC

## Git Tagging

Once all success criteria are met:
```bash
git add .
git commit -m "Phase 2 complete: Worker agent and task execution"
git tag phase-2-complete
```

## Notes

- Workers operate independently without supervisor review in this phase
- Mail to supervisor will be created but not received (no supervisor yet)
- Focus on getting the worker agent loop working correctly
- Use simple coding tasks for validation (e.g., add endpoint, create function)
- Worker should be able to complete tasks end-to-end autonomously

## Next Phase

Phase 3 will implement the Supervisor agent to coordinate workers, review PRs, manage task assignment, and handle the rebase cascade workflow.
