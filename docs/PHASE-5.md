# Phase 5: Event-Driven Automation

## Overview
Complete the event-driven architecture with Inngest, adding automatic epic/task creation workflows, periodic health check cron jobs, and the cross-platform desktop notification system for human alerts.

## Goals
- Inngest event handlers for all lifecycle events
- Automatic supervisor creation when epics are created
- Automatic worker creation when tasks are created
- Periodic health check cron jobs (supervisor check, orchestrator check)
- Desktop notification system (macOS, Linux, Windows)
- Notifications for task completions, epic completions, and failures
- Full end-to-end automation: Epic creation → Completion (no manual intervention)

## Dependencies
- Phase 0 complete (foundation + basic Inngest setup)
- Phase 1 complete (MCP infrastructure)
- Phase 2 complete (Worker agents)
- Phase 3 complete (Supervisor agents)
- Phase 4 complete (Orchestrator + health monitoring)

## Implementation Steps

### 1. Epic Created Event Handler
- [ ] Create `src/backend/inngest/functions/epic-created.ts`
- [ ] Implement `epicCreated` Inngest function:
  - [ ] Trigger: `epic.created` event
  - [ ] Input: epicId, title, description, design
  - [ ] Action: Call `startSupervisor(epicId)` to create supervisor
  - [ ] Log: Log supervisor creation to decision log
  - [ ] Error handling: If supervisor creation fails, send notification to human
  - [ ] Return: Supervisor agent ID
- [ ] Update epic creation flow to fire `epic.created` event:
  - [ ] In epic resource accessor `create()` method
  - [ ] Or in tRPC `createEpic` mutation
  - [ ] Fire event with epic details
- [ ] Register function with Inngest client
- [ ] Test: Create epic, verify supervisor starts automatically

### 2. Task Created Event Handler
- [ ] Update `src/backend/inngest/functions/task-created.ts` (created in Phase 2)
- [ ] Enhance `taskCreated` Inngest function:
  - [ ] Trigger: `task.created` event
  - [ ] Input: taskId, epicId, title, description
  - [ ] Action: Call `startWorker(taskId)` to create worker
  - [ ] Log: Log worker creation to decision log
  - [ ] Error handling: If worker creation fails, notify supervisor and human
  - [ ] Return: Worker agent ID
- [ ] Verify task creation fires event (already done in Phase 2/3)
- [ ] Test: Create task, verify worker starts automatically

### 3. Agent Completed Event Handler
- [ ] Create `src/backend/inngest/functions/agent-completed.ts`
- [ ] Implement `agentCompleted` Inngest function:
  - [ ] Trigger: `agent.completed` event
  - [ ] Input: agentId, agentType, result, message
  - [ ] Action based on agent type:
    - [ ] If WORKER: Log completion, potentially notify supervisor
    - [ ] If SUPERVISOR: Log completion, notify human of epic completion
    - [ ] If ORCHESTRATOR: Log (orchestrator runs indefinitely)
  - [ ] Update agent state to DONE
  - [ ] Clean up resources (optional)
  - [ ] Return: Completion status
- [ ] Update agent lifecycle to fire `agent.completed` event:
  - [ ] When worker finishes task successfully
  - [ ] When supervisor finishes epic successfully
  - [ ] Include result (success/failure) and message
- [ ] Register function with Inngest client
- [ ] Test: Complete task, verify event fires and is handled

### 4. Mail Sent Event Handler Enhancement
- [ ] Update `src/backend/inngest/functions/mail-sent.ts` (created in Phase 1)
- [ ] Enhance `mailSent` Inngest function:
  - [ ] Trigger: `mail.sent` event
  - [ ] Input: mailId, fromAgentId, toAgentId, toHuman, subject
  - [ ] Action:
    - [ ] If toHuman: Trigger desktop notification
    - [ ] Log mail sent event
    - [ ] Future: Could trigger other automation (e.g., webhooks)
  - [ ] Return: Notification status
- [ ] Test: Send mail to human, verify notification appears

### 5. Supervisor Health Check Cron Job
- [ ] Create `src/backend/inngest/functions/supervisor-check.ts`
- [ ] Implement `supervisorCheck` Inngest function:
  - [ ] Trigger: Cron schedule (every 2 minutes)
  - [ ] Action:
    - [ ] Get all active supervisors from database
    - [ ] For each supervisor:
      - [ ] Check worker health via `checkWorkerHealth(supervisorId)`
      - [ ] Recover any unhealthy workers
      - [ ] Log health check results
  - [ ] Error handling: Log and notify human if health check fails
  - [ ] Return: Health check summary
- [ ] Alternative approach: Supervisor performs own health checks in execution loop
  - [ ] If using this approach, cron job is just a backup/failsafe
- [ ] Register function with Inngest client with cron schedule
- [ ] Test: Start supervisor with workers, kill a worker, wait 2 minutes, verify recovery

### 6. Orchestrator Health Check Cron Job
- [ ] Create `src/backend/inngest/functions/orchestrator-check.ts`
- [ ] Implement `orchestratorCheck` Inngest function:
  - [ ] Trigger: Cron schedule (every 2 minutes)
  - [ ] Action:
    - [ ] Get orchestrator agent from database
    - [ ] Check supervisor health via `checkSupervisorHealth(orchestratorId)`
    - [ ] Recover any unhealthy supervisors (cascading recovery)
    - [ ] Check for new epics and create supervisors
    - [ ] Log health check results
  - [ ] Error handling: Log and notify human if check fails
  - [ ] Return: Health check summary
- [ ] Alternative approach: Orchestrator performs own health checks in execution loop
  - [ ] Cron job acts as backup/failsafe
- [ ] Register function with Inngest client with cron schedule
- [ ] Test: Start supervisor, kill it, wait 2 minutes, verify cascading recovery

### 7. Desktop Notification Service
- [ ] Create `src/backend/services/notification.service.ts`
- [ ] Implement NotificationService class:
  - [ ] `notify(title, message)` - Main notification method:
    - [ ] Check configuration (sound enabled, push enabled)
    - [ ] Play sound if enabled
    - [ ] Send push notification if enabled
    - [ ] Log notification
  - [ ] `sendPushNotification(title, message)` - Platform-specific:
    - [ ] Detect platform (process.platform)
    - [ ] Call platform-specific method
  - [ ] `sendMacOSNotification(title, message)`:
    - [ ] Use osascript to trigger native notification
    - [ ] Command: `osascript -e 'display notification "..." with title "..."'`
    - [ ] Include sound if configured
  - [ ] `sendLinuxNotification(title, message)`:
    - [ ] Use notify-send for notifications
    - [ ] Command: `notify-send "title" "message"`
    - [ ] Fallback to other tools if not available
  - [ ] `sendWindowsNotification(title, message)`:
    - [ ] Use PowerShell toast notifications
    - [ ] Execute PowerShell script for Windows 10+ notifications
  - [ ] `playSound(soundFile)` - Platform-specific sound playback:
    - [ ] macOS: Use afplay command
    - [ ] Linux: Use paplay or aplay command
    - [ ] Windows: Use PowerShell SoundPlayer
  - [ ] `getConfig()` - Get notification configuration from database or env vars
- [ ] Add environment variables:
  - [ ] `NOTIFICATION_SOUND_ENABLED` (default: true)
  - [ ] `NOTIFICATION_PUSH_ENABLED` (default: true)
  - [ ] `NOTIFICATION_SOUND_FILE` (path to sound file)
- [ ] Test: Manually call notification service, verify notifications appear

### 8. Notification Integration Points
- [ ] Add notifications to task completion:
  - [ ] In `mcp__task__create_pr`:
    - [ ] After creating PR, call notification service
    - [ ] Title: "Task Complete: {task.title}"
    - [ ] Message: "PR ready for review\nBranch: {worktreeName}\nPR: {prUrl}"
  - [ ] Test: Complete task, verify notification
- [ ] Add notifications to epic completion:
  - [ ] In `mcp__epic__create_epic_pr`:
    - [ ] After creating epic PR, call notification service
    - [ ] Title: "Epic Complete: {epic.title}"
    - [ ] Message: "All tasks finished\nEpic PR: {prUrl}\nReady for your review"
  - [ ] Test: Complete epic, verify notification
- [ ] Add notifications to task failures:
  - [ ] In worker crash recovery (when attempts >= 5):
    - [ ] Call notification service
    - [ ] Title: "Task Failed: {task.title}"
    - [ ] Message: "Failed after 5 attempts\nRequires manual intervention"
  - [ ] Test: Fail task 5 times, verify notification
- [ ] Add notifications to critical errors:
  - [ ] In error escalation logic:
    - [ ] Call notification service for critical errors
    - [ ] Title: "CRITICAL: Agent Error"
    - [ ] Message: "{agentType} crashed\nEpic: {epicTitle}\nCheck logs"
  - [ ] Test: Trigger critical error, verify notification

### 9. Notification Configuration UI (Optional)
- [ ] Create notification settings in database:
  - [ ] Add `NotificationSettings` table or use env vars
  - [ ] Fields: soundEnabled, pushEnabled, soundFile, quietHoursStart, quietHoursEnd
- [ ] Add tRPC endpoints for notification settings:
  - [ ] `getNotificationSettings` query
  - [ ] `updateNotificationSettings` mutation
- [ ] Implement quiet hours logic:
  - [ ] Check current time before sending notification
  - [ ] Skip notifications during quiet hours
  - [ ] Queue notifications for later? Or just skip?
- [ ] Test: Configure quiet hours, verify notifications suppressed

### 10. Full Automation Integration Test
- [ ] Create epic via UI or tRPC (human creates epic)
- [ ] Verify automatic workflow:
  - [ ] `epic.created` event fires
  - [ ] Supervisor automatically created
  - [ ] Supervisor breaks down epic into tasks
  - [ ] `task.created` events fire for each task
  - [ ] Workers automatically created for each task
  - [ ] Workers execute tasks and create PRs
  - [ ] Supervisor reviews and merges PRs sequentially
  - [ ] Workers rebase as needed
  - [ ] All tasks complete
  - [ ] Supervisor creates epic PR to main
  - [ ] Epic marked AWAITING_HUMAN_REVIEW
  - [ ] Notification sent to human
- [ ] Verify notifications:
  - [ ] Desktop notification appears when epic completes
  - [ ] Sound plays (if enabled)
  - [ ] Notification includes PR link
- [ ] Verify no manual intervention needed (except epic creation and final PR review)

### 11. Failure and Recovery Integration Test
- [ ] Create epic with automatic workflow
- [ ] Introduce failures:
  - [ ] Kill worker during task execution
  - [ ] Verify automatic recovery after 2 minutes
  - [ ] Verify notification NOT sent (non-critical failure)
  - [ ] Kill supervisor during epic execution
  - [ ] Verify automatic cascading recovery
  - [ ] Verify notification sent to human about supervisor crash
- [ ] Verify system continues to completion despite failures
- [ ] Verify all recovery actions logged in decision logs

### 12. Inngest Dashboard and Monitoring
- [ ] Access Inngest dev dashboard (usually http://localhost:8288)
- [ ] Verify all functions are registered:
  - [ ] epic-created
  - [ ] task-created
  - [ ] agent-completed
  - [ ] mail-sent
  - [ ] supervisor-check (cron)
  - [ ] orchestrator-check (cron)
- [ ] Verify events are firing and being processed
- [ ] Verify cron jobs are running on schedule
- [ ] Check for failed function executions
- [ ] Review function execution logs
- [ ] Test: Trigger events manually and verify processing

### 13. Error Handling in Inngest Functions
- [ ] Add error handling to all Inngest functions:
  - [ ] Wrap function logic in try-catch
  - [ ] Log errors to decision log
  - [ ] Send notifications to human for critical failures
  - [ ] Return error status
  - [ ] Consider retry strategies for transient errors
- [ ] Add retries for transient failures:
  - [ ] Configure Inngest retry policies
  - [ ] Exponential backoff for network errors
  - [ ] Max retry limits
- [ ] Test: Trigger failures in Inngest functions, verify error handling

### 14. Performance Monitoring
- [ ] Add performance logging:
  - [ ] Log execution time for each Inngest function
  - [ ] Log queue depths (if events are backing up)
  - [ ] Log resource usage (memory, CPU)
- [ ] Add alerts for performance issues:
  - [ ] Notify human if function execution takes too long
  - [ ] Notify if events are backing up
  - [ ] Notify if too many concurrent agents
- [ ] Test: Monitor system under load (multiple epics)

### 15. Documentation
- [ ] Create `docs/EVENT_DRIVEN_ARCHITECTURE.md`:
  - [ ] Document all Inngest events and schemas
  - [ ] Document all event handlers
  - [ ] Document cron job schedules
  - [ ] Document event flow diagrams
  - [ ] Include examples
- [ ] Create `docs/NOTIFICATIONS.md`:
  - [ ] Document notification system
  - [ ] Document platform-specific implementations
  - [ ] Document configuration options
  - [ ] Include setup instructions for each platform
- [ ] Update `README.md` with automation information
- [ ] Add comments to Inngest functions

## Smoke Test Checklist

Run these tests manually to validate Phase 5 completion:

- [ ] **Inngest Dev Server**: Inngest dev server running without errors
- [ ] **Epic Created Event**: Creating epic fires `epic.created` event
- [ ] **Automatic Supervisor**: Supervisor created automatically when epic created
- [ ] **Task Created Event**: Creating task fires `task.created` event
- [ ] **Automatic Worker**: Worker created automatically when task created
- [ ] **Agent Completed Event**: Completing task/epic fires `agent.completed` event
- [ ] **Mail Sent Event**: Sending mail fires `mail.sent` event
- [ ] **Supervisor Health Cron**: Cron job runs every 2 minutes and checks worker health
- [ ] **Orchestrator Health Cron**: Cron job runs every 2 minutes and checks supervisor health
- [ ] **Worker Recovery Automation**: Killed worker automatically recovered by cron job
- [ ] **Supervisor Recovery Automation**: Killed supervisor automatically recovered by cron job
- [ ] **Desktop Notification**: Notifications appear on desktop (test platform-specific)
- [ ] **Notification Sound**: Sound plays when notification sent (if enabled)
- [ ] **Task Complete Notification**: Notification appears when task completes
- [ ] **Epic Complete Notification**: Notification appears when epic completes
- [ ] **Task Failed Notification**: Notification appears when task fails after 5 attempts
- [ ] **Critical Error Notification**: Notification appears for critical errors
- [ ] **Full Automation**: Epic → Completion without manual intervention (except epic creation and final PR merge)
- [ ] **Inngest Dashboard**: All functions visible and executing in dashboard
- [ ] **Event Logs**: All events logged and processed correctly
- [ ] **Cron Execution**: Cron jobs executing on schedule

## Success Criteria

- [ ] All smoke tests pass
- [ ] Full automation from epic creation to completion works
- [ ] All lifecycle events fire and are handled correctly
- [ ] Cron jobs execute on schedule and perform health checks
- [ ] Desktop notifications work on target platform (macOS/Linux/Windows)
- [ ] Notifications sent for all important milestones
- [ ] System fully autonomous except for epic creation and final PR merge
- [ ] No manual intervention needed during epic execution
- [ ] Inngest dashboard shows all functions healthy

## Git Tagging

Once all success criteria are met:
```bash
git add .
git commit -m "Phase 5 complete: Event-driven automation"
git tag phase-5-complete
```

## Notes

- This phase completes the backend automation
- System is now fully event-driven and autonomous
- Cron jobs provide backup/failsafe for health monitoring
- Notifications keep humans informed without requiring constant monitoring
- Focus on reliability and error handling in event handlers

## Next Phase

Phase 6 will build the frontend user interface with tRPC integration, allowing humans to create epics, monitor agents, view decision logs, and interact with the mail system via a web UI.
