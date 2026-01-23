# Supervisor Agent Documentation

This document describes the Supervisor agent, its responsibilities, workflow, and available tools.

## Overview

The Supervisor agent is responsible for managing an epic from start to finish. It:

1. **Breaks down epics** into atomic, implementable tasks
2. **Creates tasks** for worker agents to execute
3. **Reviews PRs** submitted by workers
4. **Merges approved PRs** into the epic branch
5. **Coordinates rebases** after merging
6. **Completes the epic** by creating a final PR to main

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          EPIC                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    SUPERVISOR                              │  │
│  │  - Creates tasks from epic breakdown                       │  │
│  │  - Reviews PRs sequentially                                │  │
│  │  - Merges approved PRs                                     │  │
│  │  - Creates final PR to main                                │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                   │
│         ┌────────────────────┼────────────────────┐             │
│         ▼                    ▼                    ▼             │
│  ┌─────────────┐      ┌─────────────┐      ┌─────────────┐     │
│  │   WORKER 1  │      │   WORKER 2  │      │   WORKER 3  │     │
│  │   Task A    │      │   Task B    │      │   Task C    │     │
│  │   Branch A  │      │   Branch B  │      │   Branch C  │     │
│  └─────────────┘      └─────────────┘      └─────────────┘     │
│         │                    │                    │             │
│         └────────────────────┴────────────────────┘             │
│                              │                                   │
│                              ▼                                   │
│                     EPIC BRANCH                                  │
│                              │                                   │
│                              ▼                                   │
│                         MAIN BRANCH                              │
└─────────────────────────────────────────────────────────────────┘
```

## Supervisor Lifecycle

### 1. Creation

```bash
# Via API
curl -X POST http://localhost:3001/api/epics/create \
  -H "Content-Type: application/json" \
  -d '{
    "title": "User Profile Feature",
    "description": "Add user profile endpoints and UI"
  }'

# Start supervisor for the epic
curl -X POST http://localhost:3001/api/epics/start-supervisor \
  -H "Content-Type: application/json" \
  -d '{"epicId": "epic-id-here"}'
```

### 2. Epic Breakdown

When started, the supervisor:
1. Reads the epic description
2. Analyzes the requirements
3. Breaks the epic into 2-5 atomic tasks
4. Creates each task using `mcp__epic__create_task`

Example task creation:
```javascript
mcp__epic__create_task({
  title: "Add GET /api/users/:id endpoint",
  description: "Implement a REST endpoint that returns a user by ID."
})
```

### 3. Worker Coordination

For each task created:
1. A `task.created` event is fired
2. A worker agent is automatically assigned
3. The worker creates a PR when done
4. The worker notifies the supervisor via mail

### 4. PR Review

The supervisor:
1. Checks the review queue periodically
2. Reviews PRs one at a time in submission order
3. Reads files from worker worktrees to review code
4. Either approves (and merges) or requests changes

### 5. Rebase Cascade

After merging a PR:
1. The supervisor identifies other pending PRs
2. Sends "Rebase Required" mail to those workers
3. Workers rebase and re-submit their PRs
4. The review cycle continues

### 6. Epic Completion

When all tasks are complete:
1. Supervisor creates a PR from epic branch to main
2. Updates epic state to COMPLETED
3. Sends notification to human inbox

## Available MCP Tools

### Task Management

#### mcp__epic__create_task

Create a new task for workers to execute.

**Input:**
```json
{
  "title": "Add user authentication",
  "description": "Implement JWT-based auth with login/logout endpoints"
}
```

**Output:**
```json
{
  "taskId": "task-123",
  "title": "Add user authentication",
  "worktreeName": "task-abc12345-add-user-authentication",
  "message": "Task created. A worker will be assigned automatically."
}
```

---

#### mcp__epic__list_tasks

List all tasks for the current epic.

**Input:**
```json
{
  "state": "REVIEW"  // Optional filter
}
```

**Output:**
```json
{
  "epicId": "epic-456",
  "tasks": [
    {
      "id": "task-123",
      "title": "Add user authentication",
      "state": "IN_PROGRESS",
      "assignedAgentId": "worker-789",
      "prUrl": null
    }
  ]
}
```

### PR Review Queue

#### mcp__epic__get_review_queue

Get pending PRs ordered by submission time.

**Input:**
```json
{}
```

**Output:**
```json
{
  "epicId": "epic-456",
  "queue": [
    {
      "position": 1,
      "taskId": "task-123",
      "title": "Add user auth",
      "prUrl": "https://github.com/...",
      "worktreePath": "/path/to/worktree",
      "submittedAt": "2026-01-22T..."
    }
  ]
}
```

### PR Review Actions

#### mcp__epic__approve_pr

Approve and merge a PR into the epic branch.

**Input:**
```json
{
  "taskId": "task-123"
}
```

**Output:**
```json
{
  "taskId": "task-123",
  "prUrl": "https://github.com/...",
  "merged": true,
  "message": "PR merged successfully. 2 rebase requests sent."
}
```

**Side Effects:**
- Merges the PR using `gh pr merge --squash --auto`
- Updates task state to COMPLETED
- Sends "Rebase Required" mail to other workers with pending PRs

---

#### mcp__epic__request_changes

Request changes on a PR with feedback.

**Input:**
```json
{
  "taskId": "task-123",
  "feedback": "Please add error handling for invalid input"
}
```

**Output:**
```json
{
  "taskId": "task-123",
  "message": "Feedback sent to worker. Task returned to IN_PROGRESS."
}
```

**Side Effects:**
- Sends "Changes Requested" mail to the worker
- Updates task state to IN_PROGRESS

---

#### mcp__epic__read_file

Read a file from a worker's worktree for code review.

**Input:**
```json
{
  "taskId": "task-123",
  "filePath": "src/routes/auth.ts"
}
```

**Output:**
```json
{
  "taskId": "task-123",
  "filePath": "src/routes/auth.ts",
  "content": "import express from 'express';\n..."
}
```

**Security:**
- Path must be within the task's worktree
- Cannot escape to parent directories

### Epic Completion

#### mcp__epic__create_epic_pr

Create final PR from epic branch to main.

**Input:**
```json
{
  "title": "[Epic] User Profile Feature",  // Optional
  "description": "..."  // Optional
}
```

**Output:**
```json
{
  "epicId": "epic-456",
  "prUrl": "https://github.com/.../pull/123",
  "prNumber": 123,
  "state": "COMPLETED",
  "message": "Epic PR created successfully. Human review requested."
}
```

**Validation:**
- All tasks must be COMPLETED or FAILED
- Cannot create PR while tasks are still in progress

**Side Effects:**
- Creates PR using `gh pr create`
- Updates epic state to COMPLETED
- Sends notification to human inbox

## Workflow States

### Task States

```
PENDING → ASSIGNED → IN_PROGRESS → REVIEW → COMPLETED
                         ↓            ↓
                      BLOCKED      FAILED
                         ↓
                    IN_PROGRESS (after rebase)
```

### Epic States

```
PLANNING → IN_PROGRESS → COMPLETED
              ↓
           BLOCKED → CANCELLED
```

## API Endpoints

### Create Epic

```bash
POST /api/epics/create
{
  "title": "Epic Title",
  "description": "Epic description with requirements"
}
```

### Start Supervisor

```bash
POST /api/epics/start-supervisor
{
  "epicId": "epic-123"
}
```

### Get Epic Status

```bash
GET /api/epics/status/:epicId
```

Returns:
- Epic details
- Supervisor status (if running)
- Task summary (counts by state)
- List of tasks

### List Epics

```bash
GET /api/epics/list
```

### List Supervisors

```bash
GET /api/epics/supervisors
```

### Stop Supervisor

```bash
POST /api/epics/stop-supervisor
{
  "agentId": "supervisor-123"
}
```

### Kill Supervisor

```bash
POST /api/epics/kill-supervisor
{
  "agentId": "supervisor-123"
}
```

### Recreate Supervisor

```bash
POST /api/epics/recreate-supervisor
{
  "epicId": "epic-123"
}
```

## Observability

### Tmux Session

Each supervisor runs in a dedicated tmux session:
```bash
# List all sessions
tmux list-sessions

# Attach to supervisor session
tmux attach -t supervisor-<agentId>
```

### Decision Logs

All supervisor actions are logged to the DecisionLog table:
- Task creation decisions
- PR review decisions
- Rebase cascade triggers
- Epic completion

Query logs via database or add a REST endpoint.

## Error Handling

### Task Creation Failures

- Logged to decision log
- Can retry via UI or API

### PR Merge Conflicts

- Caught by GitHub client
- Escalated to human via mail
- Requires manual resolution

### Worker Communication Failures

- Mail system handles retries
- Supervisor can resend messages

### Supervisor Crashes

- Use `/api/epics/recreate-supervisor` to restart
- Previous context is available in decision logs

## Example: Full Epic Workflow

1. **Create Epic**
   ```bash
   curl -X POST http://localhost:3001/api/epics/create \
     -d '{"title": "Add User Profile", "description": "..."}'
   ```

2. **Start Supervisor**
   ```bash
   curl -X POST http://localhost:3001/api/epics/start-supervisor \
     -d '{"epicId": "epic-123"}'
   ```

3. **Supervisor Creates Tasks** (automatic)
   - Task 1: "Add GET /users/:id endpoint"
   - Task 2: "Add PUT /users/:id endpoint"
   - Task 3: "Add user profile UI"

4. **Workers Execute** (automatic)
   - Each worker implements their task
   - Creates PR when done
   - Notifies supervisor

5. **Supervisor Reviews** (automatic)
   - Reviews first PR
   - Approves and merges
   - Sends rebase requests

6. **Rebase Cascade** (automatic)
   - Workers 2 and 3 rebase
   - Supervisor reviews remaining PRs

7. **Epic Completion** (automatic)
   - Supervisor creates PR to main
   - Human receives notification
   - Human reviews and merges

## Configuration

### Environment Variables

```bash
# Model for supervisor agent
SUPERVISOR_MODEL=claude-sonnet-4-5-20250929

# Git configuration
GIT_BASE_REPO_PATH=/path/to/repo
GIT_WORKTREE_BASE=/tmp/factoryfactory-worktrees
```

### Timing

- Monitoring interval: 5 seconds
- Inbox check interval: 10 seconds
- These can be adjusted in supervisor.agent.ts

## Troubleshooting

### Supervisor Not Starting

1. Check if epic exists: `GET /api/epics/status/:epicId`
2. Check for existing supervisor: `GET /api/epics/supervisors`
3. Kill existing supervisor if needed: `POST /api/epics/kill-supervisor`

### Workers Not Receiving Rebase Requests

1. Check mail system is working
2. Verify worker inbox check is running
3. Check worker tmux session for errors

### PR Merge Failing

1. Check for merge conflicts
2. Verify branch is up to date
3. Check GitHub authentication: `gh auth status`

### Epic Not Completing

1. Check all tasks are COMPLETED or FAILED
2. Verify supervisor is still running
3. Check for errors in supervisor tmux session
