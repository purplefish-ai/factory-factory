# Phase 4: Orchestrator & Health Monitoring

> **Note:** This phase document is partially outdated. The orchestrator MCP tools (`mcp__orchestrator__*`)
> have been removed - all supervisor lifecycle management is now handled by the **reconciliation service**.
> See `docs/WORKFLOW.md` and `docs/RECONCILIATION_DESIGN.md` for the current architecture.
>
> The reconciler handles: crash detection, supervisor creation, worker creation, and automatic recovery.

## Overview
Implement the Orchestrator agent to manage multiple supervisors, heartbeat-based health monitoring, crash detection, and automatic recovery (including cascading worker recovery when supervisors crash).

## Goals
- Orchestrator agent implementation
- Orchestrator-specific MCP tools (`mcp__orchestrator__*`)
- Heartbeat monitoring system (track agent liveness)
- Worker crash detection and recovery (recreate after timeout)
- Supervisor crash detection and cascading recovery (kill all workers, recreate supervisor and workers)
- Health check mail system (reactive pings)
- Retry limits (fail after 5 worker attempts)
- Concurrent epic handling (multiple supervisors running simultaneously)

## Dependencies
- Phase 0 complete (foundation)
- Phase 1 complete (MCP infrastructure)
- Phase 2 complete (Worker agents)
- Phase 3 complete (Supervisor agents)

## Implementation Steps

### 1. Orchestrator System Prompt
- [ ] Create `src/backend/agents/orchestrator/` directory
- [ ] Create `src/backend/agents/orchestrator/orchestrator.prompts.ts`:
  - [ ] Define orchestrator system prompt template:
    - [ ] Role: "You are the Orchestrator agent managing all supervisors and epics"
    - [ ] Responsibilities: Monitor supervisors, detect crashes, create new supervisors, notify humans
    - [ ] Available tools: List all orchestrator MCP tools
    - [ ] Workflow: "Periodically check supervisor health, recreate failed supervisors"
    - [ ] Communication: "Use mail to communicate with supervisors and humans"
  - [ ] Define `buildOrchestratorPrompt()` - Build orchestrator prompt
  - [ ] Include examples of health monitoring and crash recovery workflows
- [ ] Test: Review prompt for clarity

### 2. Heartbeat System Infrastructure
- [ ] Update agent resource accessor:
  - [ ] Add `updateHeartbeat(agentId)` - Set lastHeartbeat to now()
  - [ ] Add `getAgentsSinceHeartbeat(minutes)` - Get agents with old heartbeats
  - [ ] Add `getHealthyAgents(type, minutes)` - Get healthy agents of type
  - [ ] Add `getUnhealthyAgents(type, minutes)` - Get unhealthy agents of type
- [ ] Add heartbeat update to MCP tool execution:
  - [ ] In `executeMcpTool`, update agent heartbeat after successful tool call
  - [ ] Specifically update on `mcp__mail__send` calls (primary heartbeat signal)
- [ ] Test: Create agent, send mail, verify heartbeat updates

### 3. Orchestrator MCP Tools - Supervisor Management
- [ ] Create `src/backend/routers/mcp/orchestrator.mcp.ts`
- [ ] Implement `mcp__orchestrator__list_supervisors`:
  - [ ] Get agent ID from context (verify is ORCHESTRATOR)
  - [ ] Query all agents of type SUPERVISOR
  - [ ] Return supervisor list with epic info and health status
  - [ ] Log decision
- [ ] Implement `mcp__orchestrator__check_supervisor_health`:
  - [ ] Get agent ID from context
  - [ ] Input: supervisorId
  - [ ] Get supervisor's lastHeartbeat
  - [ ] Calculate minutes since heartbeat
  - [ ] Return health status (healthy if < 2 minutes)
  - [ ] Log decision
- [ ] Implement `mcp__orchestrator__create_supervisor`:
  - [ ] Get agent ID from context
  - [ ] Input: epicId
  - [ ] Create supervisor agent record
  - [ ] Create tmux session for supervisor
  - [ ] Create epic worktree (branch from main)
  - [ ] Start supervisor agent execution
  - [ ] Log decision
  - [ ] Return supervisor agent ID and tmux session
- [ ] Register orchestrator tools in MCP registry
- [ ] Test: Mock orchestrator lists supervisors, checks health, creates supervisor

### 4. Worker Crash Detection & Recovery
- [ ] Create `src/backend/agents/supervisor/health.ts`:
  - [ ] `checkWorkerHealth(supervisorId)` - Check all workers for supervisor:
    - [ ] Get all workers for supervisor's epic
    - [ ] For each worker:
      - [ ] Check if lastHeartbeat > 2 minutes ago
      - [ ] If unhealthy: initiate recovery
    - [ ] Return list of unhealthy workers
  - [ ] `recoverWorker(workerId, taskId)` - Recover crashed worker:
    - [ ] Increment task attempts counter
    - [ ] If attempts >= 5:
      - [ ] Update task state to FAILED
      - [ ] Send mail to supervisor: "Task failed after 5 attempts"
      - [ ] Send mail to human: "Task permanently failed"
      - [ ] Log decision
      - [ ] Return failure
    - [ ] If attempts < 5:
      - [ ] Update agent state to FAILED
      - [ ] Kill tmux session for old worker
      - [ ] Create new agent record for worker
      - [ ] Create new tmux session
      - [ ] Update task state to IN_PROGRESS
      - [ ] Start new worker agent
      - [ ] Log decision: "Worker crashed and recreated (attempt N/5)"
      - [ ] Return success
- [ ] Test: Kill worker tmux session, wait 2 minutes, verify recovery triggers

### 5. Supervisor Crash Detection & Cascading Recovery
- [ ] Create `src/backend/agents/orchestrator/health.ts`:
  - [ ] `checkSupervisorHealth(orchestratorId)` - Check all supervisors:
    - [ ] Get all supervisors
    - [ ] For each supervisor:
      - [ ] Check if lastHeartbeat > 2 minutes ago
      - [ ] If unhealthy: initiate cascading recovery
    - [ ] Return list of unhealthy supervisors
  - [ ] `recoverSupervisor(supervisorId, epicId)` - Cascading recovery:
    - [ ] **Kill Phase**:
      - [ ] Get all workers for epic
      - [ ] For each worker:
        - [ ] Update agent state to FAILED
        - [ ] Kill worker tmux session
      - [ ] Update supervisor agent state to FAILED
      - [ ] Kill supervisor tmux session
    - [ ] **Task State Reset Phase**:
      - [ ] Get all tasks for epic
      - [ ] For each task:
        - [ ] If state is COMPLETED or FAILED: keep as-is
        - [ ] If state is PENDING_REVIEW, NEEDS_REBASE, IN_PROGRESS, or APPROVED: reset to PENDING
        - [ ] Reset attempts counter to 0 for reset tasks
    - [ ] **Recreate Phase**:
      - [ ] Create new supervisor agent record
      - [ ] Create new tmux session for supervisor
      - [ ] Start new supervisor agent
      - [ ] Supervisor will recreate workers for PENDING tasks
    - [ ] **Notification Phase**:
      - [ ] Send mail to human: "Supervisor crashed and recovered for epic: {title}"
      - [ ] Log decision: "Supervisor crashed, recreated with cascading worker reset"
    - [ ] Return success
- [ ] Test: Kill supervisor tmux session, wait 2 minutes, verify cascading recovery

### 6. Health Check Mail System
- [ ] Add health check mail logic to supervisor:
  - [ ] In supervisor execution loop, periodically check worker heartbeats
  - [ ] If worker hasn't sent mail in 2 minutes:
    - [ ] Send mail: "Health Check - Please confirm you are active"
    - [ ] Wait for response
    - [ ] If response received: heartbeat updated, worker is healthy
    - [ ] If no response after another 2 minutes: trigger recovery
- [ ] Add health check response to worker:
  - [ ] In worker execution loop, check inbox periodically
  - [ ] If "Health Check" mail received:
    - [ ] Reply with status update: "Active, currently working on task"
    - [ ] Include current task state and progress
- [ ] Test: Stop worker from sending mail, verify health check mail sent

### 7. Orchestrator Agent Implementation
- [ ] Create `src/backend/agents/orchestrator/orchestrator.agent.ts`
- [ ] Implement Orchestrator agent class:
  - [ ] `create()` - Create single orchestrator instance:
    - [ ] Create agent record (type: ORCHESTRATOR, no task/epic)
    - [ ] Create tmux session
    - [ ] Initialize Claude SDK agent with orchestrator profile
    - [ ] Set system prompt
    - [ ] Disable `AskUserQuestion` tool
    - [ ] Start execution loop
    - [ ] Return agent ID
  - [ ] `run(agentId)` - Main execution loop:
    - [ ] Send initial message: "Monitor supervisors and manage epic creation"
    - [ ] Periodically check for new epics (via mail or database query)
    - [ ] Periodically check supervisor health
    - [ ] Create supervisors for new epics
    - [ ] Trigger recovery for unhealthy supervisors
    - [ ] Continue running indefinitely
  - [ ] `handleToolCall(agentId, toolCall)` - Process tool calls
  - [ ] `stop(agentId)` - Gracefully stop orchestrator
- [ ] Test: Create orchestrator and verify it runs continuously

### 8. Orchestrator Lifecycle Management
- [ ] Create `src/backend/agents/orchestrator/lifecycle.ts`:
  - [ ] `startOrchestrator()` - Create and start orchestrator:
    - [ ] Check if orchestrator already exists
    - [ ] If exists and healthy: return existing
    - [ ] If exists and unhealthy: kill and recreate
    - [ ] If not exists: create new
    - [ ] Return orchestrator agent ID
  - [ ] `stopOrchestrator(agentId)` - Stop orchestrator gracefully
  - [ ] `getOrchestrator()` - Get current orchestrator instance
- [ ] Add orchestrator startup to system initialization
- [ ] Test: Start orchestrator, verify single instance

### 9. Integration with Supervisor Health Checks
- [ ] Update supervisor agent to perform worker health checks:
  - [ ] Add periodic health check in supervisor execution loop
  - [ ] Call `checkWorkerHealth(supervisorId)` every 2 minutes
  - [ ] For each unhealthy worker: call `recoverWorker(workerId, taskId)`
  - [ ] Log all health check actions
- [ ] Test: Create supervisor with workers, kill a worker, verify recovery

### 10. Integration with Orchestrator Health Checks
- [ ] Update orchestrator agent to perform supervisor health checks:
  - [ ] Add periodic health check in orchestrator execution loop
  - [ ] Call `checkSupervisorHealth(orchestratorId)` every 2 minutes
  - [ ] For each unhealthy supervisor: call `recoverSupervisor(supervisorId, epicId)`
  - [ ] Log all health check actions
- [ ] Test: Create supervisor, kill it, verify cascading recovery

### 11. Concurrent Epic Handling
- [ ] Test concurrent epic execution:
  - [ ] Create Epic 1 via tRPC
  - [ ] Create Epic 2 via tRPC
  - [ ] Verify orchestrator creates 2 supervisors
  - [ ] Verify both supervisors run simultaneously
  - [ ] Verify workers for both epics run simultaneously
  - [ ] Verify no interference between epics
- [ ] Add resource management:
  - [ ] Monitor total number of active agents
  - [ ] Log warnings if too many agents (potential rate limit issues)
  - [ ] Future: Add rate limiting or queueing
- [ ] Test: Create 3+ epics simultaneously, verify system handles load

### 12. Error Handling - Orchestrator
- [ ] Add error handling in orchestrator:
  - [ ] Handle supervisor creation failures
  - [ ] Handle crash recovery failures (escalate to human)
  - [ ] Handle tool call errors
  - [ ] Log all errors
- [ ] Add error escalation:
  - [ ] If orchestrator encounters critical error: send mail to human
  - [ ] Include error details and suggested actions
- [ ] Test error scenarios:
  - [ ] Supervisor creation fails (e.g., git error)
  - [ ] Cascading recovery fails

### 13. Integration Test - Full System with Crashes
- [ ] Create test scenario:
  - [ ] Create epic with 3 tasks
  - [ ] Supervisor creates 3 workers
  - [ ] Kill worker 1 during execution
  - [ ] Verify worker 1 recovers and continues
  - [ ] Kill worker 2 during execution
  - [ ] Verify worker 2 recovers and continues
  - [ ] Let all workers complete
  - [ ] Verify supervisor reviews and merges all PRs
  - [ ] Verify epic completes successfully
- [ ] Create cascading failure scenario:
  - [ ] Create epic with 3 tasks
  - [ ] Supervisor creates 3 workers
  - [ ] All workers start executing
  - [ ] Kill supervisor
  - [ ] Verify orchestrator detects supervisor crash
  - [ ] Verify orchestrator kills all workers
  - [ ] Verify orchestrator recreates supervisor
  - [ ] Verify supervisor recreates workers for PENDING tasks
  - [ ] Verify system continues to completion
- [ ] Verify all decision logs show complete recovery audit trail

### 14. Orchestrator Observability
- [ ] Add logging to orchestrator:
  - [ ] Log supervisor health checks
  - [ ] Log supervisor creation
  - [ ] Log crash detections
  - [ ] Log recovery actions
  - [ ] All via decision log
- [ ] Add tmux output for orchestrator
- [ ] Test: Observe orchestrator activity in tmux

### 15. Manual Orchestrator Control Interface
- [ ] Create `src/backend/routers/api/orchestrator.router.ts` (tRPC router):
  - [ ] `startOrchestrator` mutation:
    - [ ] Call `startOrchestrator()` lifecycle function
    - [ ] Return orchestrator agent ID
  - [ ] `getOrchestratorStatus` query:
    - [ ] Return orchestrator status (agent info, health)
  - [ ] `listSupervisors` query:
    - [ ] List all supervisors with health status
  - [ ] `triggerHealthCheck` mutation:
    - [ ] Manually trigger health check for testing
    - [ ] Return unhealthy agents
- [ ] Register router with tRPC server
- [ ] Test: Control orchestrator via tRPC

### 16. Documentation
- [ ] Create `docs/ORCHESTRATOR_AGENT.md`:
  - [ ] Document orchestrator responsibilities
  - [ ] Document health monitoring system
  - [ ] Document crash recovery workflows
  - [ ] Document cascading recovery logic
  - [ ] Include examples and flowcharts
- [ ] Create `docs/HEALTH_MONITORING.md`:
  - [ ] Document heartbeat system
  - [ ] Document health check intervals
  - [ ] Document recovery protocols
  - [ ] Document retry limits
- [ ] Update `docs/MCP_TOOLS.md` with orchestrator tools
- [ ] Add comments to orchestrator code

## Smoke Test Checklist

Run these tests manually to validate Phase 4 completion:

- [ ] **Orchestrator Start**: Can start orchestrator via tRPC
- [ ] **Orchestrator Execution**: Orchestrator runs continuously
- [ ] **Supervisor Creation**: Orchestrator creates supervisors for new epics
- [ ] **Concurrent Epics**: Can run 2+ epics simultaneously
- [ ] **Worker Heartbeat**: Worker heartbeat updates when sending mail
- [ ] **Worker Health Check**: Worker responds to health check mail
- [ ] **Worker Crash Detection**: Unhealthy worker detected after 2 minutes
- [ ] **Worker Recovery**: Crashed worker recreated with new session
- [ ] **Worker Retry Limit**: Worker fails after 5 recovery attempts
- [ ] **Supervisor Heartbeat**: Supervisor heartbeat updates correctly
- [ ] **Supervisor Crash Detection**: Unhealthy supervisor detected after 2 minutes
- [ ] **Cascading Kill**: All workers killed when supervisor crashes
- [ ] **Task Reset**: Task states reset correctly during cascading recovery
- [ ] **Supervisor Recreation**: New supervisor created after crash
- [ ] **Worker Recreation**: New workers created by new supervisor
- [ ] **Epic Continuation**: Epic continues to completion after supervisor recovery
- [ ] **Human Notification**: Human notified of crashes and failures
- [ ] **Decision Logs**: All health checks and recoveries logged
- [ ] **Tmux Sessions**: Can observe orchestrator activity in tmux

## Success Criteria

- [ ] All smoke tests pass
- [ ] Orchestrator runs as single instance
- [ ] Orchestrator manages multiple supervisors concurrently
- [ ] Worker crashes detected and recovered automatically
- [ ] Supervisor crashes trigger cascading recovery
- [ ] Retry limits prevent infinite recovery loops
- [ ] System continues to make progress despite crashes
- [ ] Complete audit trail of all health monitoring and recovery actions
- [ ] Can manually trigger health checks for testing

## Git Tagging

Once all success criteria are met:
```bash
git add .
git commit -m "Phase 4 complete: Orchestrator and health monitoring"
git tag phase-4-complete
```

## Notes

- Health monitoring is critical for production reliability
- Cascading recovery ensures consistency when supervisors fail
- Heartbeat-based monitoring is simple and effective
- Retry limits prevent wasting resources on permanently broken tasks
- This phase makes the system truly autonomous and resilient

## Next Phase

Phase 5 will add full event-driven automation with Inngest, including automatic epic creation triggers, periodic health check cron jobs, and the desktop notification system.
