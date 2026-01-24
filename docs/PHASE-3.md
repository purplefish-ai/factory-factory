# Phase 3: Supervisor Agent & Task Coordination

## Overview
Implement the Supervisor agent to coordinate workers, break down epics into tasks, review PRs sequentially, merge approved PRs, and manage the rebase cascade workflow.

## Goals
- Supervisor agent implementation with Claude SDK
- Supervisor-specific MCP tools (`mcp__epic__*`)
- Epic breakdown into tasks (dynamic task creation)
- PR review queue management (ordered by submission time)
- Sequential PR review and automated merge
- Rebase cascade workflow (trigger rebases after merges)
- Epic completion and PR to main branch
- End-to-end: Epic → Supervisor breaks down → Creates tasks → Workers execute → Supervisor reviews → Merges PRs

## Dependencies
- Phase 0 complete (foundation)
- Phase 1 complete (MCP infrastructure)
- Phase 2 complete (Worker agents)

## Implementation Steps

### 1. Supervisor System Prompt
- [ ] Create `src/backend/agents/supervisor/` directory
- [ ] Create `src/backend/agents/supervisor/supervisor.prompts.ts`:
  - [ ] Define supervisor system prompt template:
    - [ ] Role: "You are a Supervisor agent managing an epic with multiple workers"
    - [ ] Responsibilities: Break down epic, create tasks, review PRs, coordinate workers
    - [ ] Available tools: List all supervisor MCP tools
    - [ ] Communication: "Use mail to send task assignments and rebase requests to workers"
    - [ ] Workflow: "Review PRs sequentially, merge approved PRs, request rebases from other workers"
    - [ ] Epic completion: "When all tasks complete, create PR from epic to main"
  - [ ] Define `buildSupervisorPrompt(epicId)` - Build prompt with epic context
  - [ ] Include examples of epic breakdown and PR review workflows
- [ ] Test: Review prompt for clarity and completeness

### 2. Supervisor MCP Tools - Task Management
- [ ] Update `src/backend/routers/mcp/task.mcp.ts` or create supervisor-specific file
- [ ] Implement `mcp__epic__create_task`:
  - [ ] Get agent ID from context
  - [ ] Verify agent is SUPERVISOR
  - [ ] Verify agent has epic assigned
  - [ ] Validate task input (title, description)
  - [ ] Create task record in database
  - [ ] Generate worktree name (task/{taskId}/{sanitized-title})
  - [ ] Fire `task.created` event (triggers worker creation)
  - [ ] Log decision
  - [ ] Return task ID and worktree name
- [ ] Implement `mcp__epic__list_tasks`:
  - [ ] Get agent ID from context
  - [ ] Verify agent is SUPERVISOR
  - [ ] Fetch all tasks for supervisor's epic
  - [ ] Optional: Filter by state
  - [ ] Return task list with details (id, title, state, agentId, prUrl, attempts)
  - [ ] Log decision
- [ ] Register epic tools in MCP registry
- [ ] Test: Mock supervisor creates task, lists tasks

### 3. Supervisor MCP Tools - PR Review Queue
- [ ] Implement `mcp__epic__get_review_queue`:
  - [ ] Get agent ID from context
  - [ ] Verify agent is SUPERVISOR
  - [ ] Fetch all tasks in PENDING_REVIEW state for epic
  - [ ] Sort by task.updatedAt (submission order)
  - [ ] Return ordered queue with PR details
  - [ ] Log decision
- [ ] Test: Mock supervisor gets review queue

### 4. Supervisor MCP Tools - PR Review Actions
- [ ] Implement `mcp__epic__approve_pr`:
  - [ ] Get agent ID from context
  - [ ] Verify agent is SUPERVISOR
  - [ ] Fetch task and validate it's in PENDING_REVIEW state
  - [ ] Update task state to APPROVED
  - [ ] Use GitHub client to merge PR into epic branch
  - [ ] Update task state to COMPLETED
  - [ ] Store merge commit SHA
  - [ ] Find all other tasks in PENDING_REVIEW state
  - [ ] For each pending task:
    - [ ] Update state to NEEDS_REBASE
    - [ ] Send mail to worker: "Please rebase against epic branch"
  - [ ] Log decision
  - [ ] Return merge success and commit SHA
- [ ] Implement `mcp__epic__request_changes`:
  - [ ] Get agent ID from context
  - [ ] Verify agent is SUPERVISOR
  - [ ] Validate task is in PENDING_REVIEW state
  - [ ] Send detailed feedback mail to worker
  - [ ] Task remains in PENDING_REVIEW (worker will update after fixing)
  - [ ] Log decision
  - [ ] Return confirmation
- [ ] Implement `mcp__epic__read_file`:
  - [ ] Get agent ID from context
  - [ ] Verify agent is SUPERVISOR
  - [ ] Get task's worktree path
  - [ ] Read specified file from worktree
  - [ ] Return file content and path
  - [ ] Log decision
- [ ] Register PR review tools in MCP registry
- [ ] Test: Mock supervisor approves PR, requests changes, reads file

### 5. Supervisor MCP Tools - Epic Completion
- [ ] Implement `mcp__epic__create_epic_pr`:
  - [ ] Get agent ID from context
  - [ ] Verify agent is SUPERVISOR
  - [ ] Verify all tasks are COMPLETED or FAILED
  - [ ] Use GitHub client to create PR (epic branch → main)
  - [ ] Update epic state to AWAITING_HUMAN_REVIEW
  - [ ] Send mail to human inbox with PR details
  - [ ] Log decision
  - [ ] Return PR URL
- [ ] Register epic completion tool in MCP registry
- [ ] Test: Mock supervisor creates epic PR

### 6. Supervisor Agent Implementation
- [ ] Create `src/backend/agents/supervisor/supervisor.agent.ts`
- [ ] Implement Supervisor agent class:
  - [ ] `create(epicId)` - Create new supervisor agent:
    - [ ] Create agent record in database (type: SUPERVISOR)
    - [ ] Create tmux session for supervisor
    - [ ] Get epic details from database
    - [ ] Create epic worktree (branch from main)
    - [ ] Initialize Claude SDK agent with supervisor profile
    - [ ] Set system prompt with epic context
    - [ ] Disable `AskUserQuestion` tool
    - [ ] Start agent execution loop
    - [ ] Return agent ID
  - [ ] `run(agentId)` - Main execution loop:
    - [ ] Send initial message: "Review the epic design and break it down into tasks"
    - [ ] Listen for Claude tool calls (task creation, PR reviews, etc.)
    - [ ] Route tool calls through MCP server
    - [ ] Check inbox periodically for worker messages
    - [ ] Process review queue when PRs are pending
    - [ ] Continue until epic is complete
  - [ ] `handleToolCall(agentId, toolCall)` - Process tool calls
  - [ ] `handleIncomingMail(agentId)` - Check and process mail:
    - [ ] Call `mcp__mail__list_inbox`
    - [ ] Read each unread mail
    - [ ] Process based on subject (PR ready, rebase complete, etc.)
    - [ ] Respond appropriately
  - [ ] `stop(agentId)` - Gracefully stop supervisor
- [ ] Test: Create supervisor manually and verify initialization

### 7. Supervisor Lifecycle Management
- [ ] Create `src/backend/agents/supervisor/lifecycle.ts`:
  - [ ] `startSupervisor(epicId)` - Create and start supervisor for epic
  - [ ] `stopSupervisor(agentId)` - Stop supervisor gracefully
  - [ ] `killSupervisor(agentId)` - Force kill supervisor
  - [ ] `recreateSupervisor(epicId)` - Recreate crashed supervisor
- [ ] Add supervisor state management:
  - [ ] Track supervisor execution in memory
  - [ ] Handle supervisor completion (epic complete)
  - [ ] Handle supervisor failure (log error, escalate to human)
- [ ] Test: Start supervisor, stop supervisor, verify states

### 8. Worker Rebase Workflow Enhancement
- [ ] Update worker agent to handle rebase requests:
  - [ ] Add mail handling in worker execution loop
  - [ ] Detect "Rebase Required" mail subject
  - [ ] Call `mcp__task__update_state(NEEDS_REBASE)`
  - [ ] Call `mcp__git__rebase` to rebase onto epic branch
  - [ ] Force-push rebased branch
  - [ ] Call `mcp__task__update_state(PENDING_REVIEW)`
  - [ ] Send mail to supervisor: "Rebased and ready for review"
- [ ] Test: Send rebase request mail to worker, verify worker rebases

### 9. Sequential PR Review Logic
- [ ] Implement review queue processing in supervisor:
  - [ ] Periodically check review queue (via `mcp__epic__get_review_queue`)
  - [ ] If queue is not empty:
    - [ ] Review first PR in queue (read files, check tests, verify design alignment)
    - [ ] Decide: approve or request changes
    - [ ] If approved: merge and trigger rebase cascade
    - [ ] If changes needed: send feedback mail to worker
  - [ ] Continue to next PR only after current PR is resolved
- [ ] Test: Create multiple tasks with workers, verify sequential review

### 10. Integration Test - Full Epic Workflow
- [ ] Create test epic:
  - [ ] Title: "Test Epic: Add User Profile Feature"
  - [ ] Description: "Add user profile endpoints and UI components"
  - [ ] Design document: Detailed breakdown of feature requirements
- [ ] Start supervisor for epic:
  - [ ] Supervisor reads epic design
  - [ ] Supervisor breaks down into 3 tasks:
    - [ ] Task 1: "Add GET /user/:id endpoint"
    - [ ] Task 2: "Add PUT /user/:id endpoint"
    - [ ] Task 3: "Add user profile UI component"
  - [ ] Workers start automatically (via task.created events)
- [ ] Verify worker execution:
  - [ ] Each worker completes their task
  - [ ] Each worker creates PR to epic branch
  - [ ] Each worker sends mail to supervisor
- [ ] Verify supervisor review:
  - [ ] Supervisor reviews PRs in order
  - [ ] Supervisor approves and merges first PR
  - [ ] Supervisor sends rebase requests to workers 2 and 3
  - [ ] Workers 2 and 3 rebase successfully
  - [ ] Supervisor reviews and merges remaining PRs
- [ ] Verify epic completion:
  - [ ] All tasks marked COMPLETED
  - [ ] Supervisor creates PR from epic to main
  - [ ] Epic state updated to AWAITING_HUMAN_REVIEW
  - [ ] Mail sent to human inbox
- [ ] Check all decision logs for complete audit trail

### 11. Error Handling - Supervisor
- [ ] Add error handling in supervisor agent:
  - [ ] Handle task creation failures
  - [ ] Handle PR merge conflicts (escalate to human)
  - [ ] Handle worker communication failures
  - [ ] Handle invalid tool calls
  - [ ] Log all errors to decision log
- [ ] Test error scenarios:
  - [ ] Worker sends invalid PR
  - [ ] Merge conflict during PR merge
  - [ ] Worker doesn't respond to rebase request

### 12. Supervisor Observability
- [ ] Add logging to supervisor agent:
  - [ ] Log task creation decisions
  - [ ] Log PR review decisions (approve/reject)
  - [ ] Log rebase cascade triggers
  - [ ] Log epic completion
  - [ ] All logged via decision log
- [ ] Add tmux output capture for supervisor
- [ ] Test: Start supervisor and observe logs in tmux

### 13. Manual Epic Creation Interface
- [ ] Create `src/backend/routers/api/manual-epic.router.ts` (tRPC router):
  - [ ] `createEpic` mutation:
    - [ ] Input: title, description, design
    - [ ] Create epic record in database
    - [ ] Generate worktree name
    - [ ] Fire `epic.created` event
    - [ ] Return epic ID
  - [ ] `startSupervisor` mutation:
    - [ ] Input: epicId
    - [ ] Call `startSupervisor(epicId)` lifecycle function
    - [ ] Return agent ID and tmux session name
  - [ ] `getEpicStatus` query:
    - [ ] Input: epicId
    - [ ] Return epic details including state, tasks, supervisor info
- [ ] Register router with tRPC server
- [ ] Test: Create epic and start supervisor via tRPC

### 14. Documentation
- [ ] Create `docs/SUPERVISOR_AGENT.md`:
  - [ ] Document supervisor responsibilities
  - [ ] Document supervisor system prompt
  - [ ] Document supervisor MCP tools
  - [ ] Document PR review workflow
  - [ ] Document rebase cascade logic
  - [ ] Include example epic completion workflow
- [ ] Update `docs/MCP_TOOLS.md` with supervisor-specific tools
- [ ] Add comments to supervisor agent code

## Smoke Test Checklist

Run these tests manually to validate Phase 3 completion:

- [ ] **Epic Creation**: Can create epic via tRPC mutation
- [ ] **Supervisor Start**: Can start supervisor for epic
- [ ] **Epic Breakdown**: Supervisor reads epic design and creates tasks
- [ ] **Task Creation Tool**: Supervisor creates tasks via `mcp__epic__create_task`
- [ ] **Worker Creation**: Workers start automatically when tasks created
- [ ] **Worker Execution**: Workers complete tasks and create PRs
- [ ] **Mail Notification**: Workers send "PR ready" mail to supervisor
- [ ] **Review Queue**: Supervisor gets review queue with pending PRs
- [ ] **PR Review**: Supervisor reviews first PR in queue
- [ ] **File Reading**: Supervisor reads files from worker worktree for code review
- [ ] **PR Approval**: Supervisor approves and merges PR
- [ ] **Rebase Cascade**: Supervisor sends rebase requests to other workers
- [ ] **Worker Rebase**: Workers receive mail, rebase, and notify supervisor
- [ ] **Sequential Review**: Supervisor only reviews one PR at a time
- [ ] **All PRs Merged**: All worker PRs eventually merged into epic branch
- [ ] **Epic Completion**: Supervisor creates PR from epic to main
- [ ] **Human Notification**: Mail sent to human inbox with epic PR
- [ ] **Epic State**: Epic state updated to AWAITING_HUMAN_REVIEW
- [ ] **Decision Logs**: All supervisor actions logged
- [ ] **Tmux Session**: Can observe supervisor activity in tmux

## Success Criteria

- [ ] All smoke tests pass
- [ ] Supervisor can break down epic into multiple tasks autonomously
- [ ] Workers execute tasks and create PRs correctly
- [ ] Supervisor reviews PRs sequentially (one at a time)
- [ ] Supervisor merges approved PRs and triggers rebase cascade
- [ ] Workers respond to rebase requests correctly
- [ ] Epic completes with PR to main when all tasks done
- [ ] Complete audit trail in decision logs
- [ ] Can observe all agent activity in tmux sessions

## Git Tagging

Once all success criteria are met:
```bash
git add .
git commit -m "Phase 3 complete: Supervisor agent and task coordination"
git tag phase-3-complete
```

## Notes

- This phase brings the core workflow together: epic → tasks → workers → review → merge
- Sequential PR review ensures clean merges but may be slow (optimization in future phases)
- Supervisor has full authority to merge worker PRs automatically
- Human only reviews final epic PR to main
- Focus on getting the coordination workflow correct

## Next Phase

Phase 4 will implement the Orchestrator agent and health monitoring system to detect and recover from agent crashes, enabling fully autonomous multi-epic operation.
