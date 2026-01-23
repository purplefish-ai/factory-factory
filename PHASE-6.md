# Phase 6: Frontend & Human Interface

## Overview
Build a comprehensive Next.js frontend with tRPC integration, allowing humans to create and manage epics, monitor agent activity via live tmux terminals, view decision logs, and interact with the mail system.

## Goals
- tRPC API routers for all backend functionality
- Epic management UI (create, list, view details)
- Task viewer with status tracking
- Agent monitor dashboard with live tmux terminal integration
- Human mail inbox for agent communication
- Decision log viewer for debugging
- Real-time updates via tRPC subscriptions or polling
- Complete UI for all system interactions

## Dependencies
- Phase 0 complete (foundation)
- Phase 1 complete (MCP infrastructure + tmux-web integration)
- Phase 2 complete (Worker agents)
- Phase 3 complete (Supervisor agents)
- Phase 4 complete (Orchestrator)
- Phase 5 complete (Event-driven automation)

## Implementation Steps

### 1. tRPC Server Setup
- [ ] Create `src/backend/routers/api/index.ts` - Root tRPC router
- [ ] Install tRPC dependencies:
  - [ ] `@trpc/server`
  - [ ] `@trpc/client`
  - [ ] `@trpc/react-query`
  - [ ] `@trpc/next`
- [ ] Create tRPC context with auth (future: add user auth)
- [ ] Create base router with example query
- [ ] Add tRPC endpoint to Express server: `/api/trpc`
- [ ] Test: Send test query via curl or Postman

### 2. Epic Management tRPC Router
- [ ] Create `src/backend/routers/api/epic.router.ts`
- [ ] Implement epic router procedures:
  - [ ] `create` mutation:
    - [ ] Input: title, description, design (markdown)
    - [ ] Create epic in database
    - [ ] Fire `epic.created` event (triggers supervisor creation)
    - [ ] Return epic ID
  - [ ] `list` query:
    - [ ] Input: optional filters (state, search)
    - [ ] Return list of epics with summary info
  - [ ] `getById` query:
    - [ ] Input: epicId
    - [ ] Return epic details, tasks, supervisor info
  - [ ] `update` mutation:
    - [ ] Input: epicId, updates (title, description, design, state)
    - [ ] Update epic in database
    - [ ] Return updated epic
  - [ ] `delete` mutation (optional):
    - [ ] Input: epicId
    - [ ] Soft delete or hard delete epic
    - [ ] Clean up related agents and worktrees
- [ ] Register epic router with root router
- [ ] Test: Use tRPC client to create, list, get epic

### 3. Task Management tRPC Router
- [ ] Create `src/backend/routers/api/task.router.ts`
- [ ] Implement task router procedures:
  - [ ] `list` query:
    - [ ] Input: optional filters (epicId, state, search)
    - [ ] Return list of tasks
  - [ ] `getById` query:
    - [ ] Input: taskId
    - [ ] Return task details, worker info, PR info
  - [ ] `listByEpic` query:
    - [ ] Input: epicId
    - [ ] Return all tasks for epic
  - [ ] `update` mutation (optional):
    - [ ] Input: taskId, updates
    - [ ] Update task manually (admin use)
    - [ ] Return updated task
- [ ] Register task router with root router
- [ ] Test: Use tRPC client to list tasks, get task details

### 4. Agent Monitoring tRPC Router
- [ ] Create `src/backend/routers/api/agent.router.ts`
- [ ] Implement agent router procedures:
  - [ ] `list` query:
    - [ ] Input: optional filters (type, state, epicId)
    - [ ] Return list of agents with health status
  - [ ] `getById` query:
    - [ ] Input: agentId
    - [ ] Return agent details, related epic/task, tmux session info
  - [ ] `getTerminalOutput` query:
    - [ ] Input: agentId or tmuxSession
    - [ ] Use terminal client to read tmux session buffer
    - [ ] Return terminal output (last N lines)
  - [ ] `listDecisionLogs` query:
    - [ ] Input: agentId, optional limit
    - [ ] Return recent decision logs for agent
  - [ ] `restart` mutation (optional):
    - [ ] Input: agentId
    - [ ] Manually restart agent (admin use)
    - [ ] Return new agent ID
- [ ] Register agent router with root router
- [ ] Test: Use tRPC client to list agents, get terminal output

### 5. Mail System tRPC Router
- [ ] Create `src/backend/routers/api/mail.router.ts`
- [ ] Implement mail router procedures:
  - [ ] `listHumanInbox` query:
    - [ ] Return all mail sent to human (toHuman=true)
    - [ ] Sort by createdAt descending
    - [ ] Include sender agent info
  - [ ] `getById` query:
    - [ ] Input: mailId
    - [ ] Return mail details
    - [ ] Mark as read
  - [ ] `sendToAgent` mutation:
    - [ ] Input: toAgentId, subject, body
    - [ ] Create mail from human to agent
    - [ ] Fire `mail.sent` event
    - [ ] Return mail ID
  - [ ] `reply` mutation:
    - [ ] Input: inReplyToMailId, body
    - [ ] Create reply mail from human to original sender
    - [ ] Return mail ID
- [ ] Register mail router with root router
- [ ] Test: Use tRPC client to list inbox, send mail to agent

### 6. Decision Log tRPC Router
- [ ] Create `src/backend/routers/api/decision-log.router.ts`
- [ ] Implement decision log router procedures:
  - [ ] `listByAgent` query:
    - [ ] Input: agentId, optional limit/offset
    - [ ] Return decision logs for agent
    - [ ] Sort by createdAt descending
  - [ ] `listRecent` query:
    - [ ] Input: optional limit
    - [ ] Return recent logs across all agents
    - [ ] Include agent info
  - [ ] `getById` query:
    - [ ] Input: logId
    - [ ] Return log details
- [ ] Register decision log router with root router
- [ ] Test: Use tRPC client to fetch decision logs

### 7. Frontend tRPC Client Setup
- [ ] Create `src/frontend/lib/trpc.ts` - tRPC client configuration
- [ ] Install frontend dependencies:
  - [ ] `@trpc/client`
  - [ ] `@trpc/react-query`
  - [ ] `@tanstack/react-query`
- [ ] Configure tRPC client with backend URL
- [ ] Create tRPC provider component
- [ ] Wrap Next.js app with tRPC provider in layout
- [ ] Test: Make test query from frontend component

### 8. Epic Management UI
- [ ] Create `src/frontend/app/epics/page.tsx` - Epic list page:
  - [ ] Use `trpc.epic.list.useQuery()` to fetch epics
  - [ ] Display epics in table or card grid
  - [ ] Show epic title, state, task count, created date
  - [ ] Add "Create Epic" button → navigate to create page
  - [ ] Add search/filter controls
  - [ ] Add click to view epic details
- [ ] Create `src/frontend/app/epics/new/page.tsx` - Create epic page:
  - [ ] Form with title, description, design (markdown editor)
  - [ ] Use `trpc.epic.create.useMutation()` to create epic
  - [ ] On success: redirect to epic detail page
  - [ ] Show loading state and error handling
- [ ] Create `src/frontend/app/epics/[id]/page.tsx` - Epic detail page:
  - [ ] Use `trpc.epic.getById.useQuery()` to fetch epic
  - [ ] Display epic details (title, description, design, state)
  - [ ] Display supervisor info (agent ID, tmux session, health)
  - [ ] Display task list with status
  - [ ] Add link to view supervisor terminal
  - [ ] Show epic PR link (if in AWAITING_HUMAN_REVIEW state)
- [ ] Create `src/frontend/components/epic-card.tsx` - Reusable epic card component
- [ ] Test: Create epic via UI, view list, view details

### 9. Task Viewer UI
- [ ] Create `src/frontend/app/tasks/page.tsx` - Task list page:
  - [ ] Use `trpc.task.list.useQuery()` to fetch tasks
  - [ ] Display tasks in table with columns: title, epic, state, worker, PR link
  - [ ] Add filters: by epic, by state
  - [ ] Add search by title
  - [ ] Add click to view task details
- [ ] Create `src/frontend/app/tasks/[id]/page.tsx` - Task detail page:
  - [ ] Use `trpc.task.getById.useQuery()` to fetch task
  - [ ] Display task details (title, description, state, attempts)
  - [ ] Display worker info (agent ID, tmux session, health)
  - [ ] Display PR info (URL, state, review status)
  - [ ] Add link to view worker terminal
  - [ ] Add link to view epic
- [ ] Create `src/frontend/components/task-list.tsx` - Reusable task list component
- [ ] Test: View task list, view task details

### 10. Agent Monitor Dashboard
- [ ] Create `src/frontend/app/agents/page.tsx` - Agent monitor page:
  - [ ] Use `trpc.agent.list.useQuery()` to fetch agents
  - [ ] Display agents grouped by type (Orchestrator, Supervisors, Workers)
  - [ ] Show agent ID, type, state, last heartbeat, health status
  - [ ] Add health indicator (green=healthy, red=unhealthy, gray=inactive)
  - [ ] Add click to view agent details
  - [ ] Add real-time health updates (polling or subscriptions)
- [ ] Create `src/frontend/app/agents/[id]/page.tsx` - Agent detail page:
  - [ ] Use `trpc.agent.getById.useQuery()` to fetch agent
  - [ ] Display agent details (ID, type, state, created, last heartbeat)
  - [ ] Display related epic/task info
  - [ ] Embed tmux terminal viewer (see step 11)
  - [ ] Display recent decision logs for agent
  - [ ] Add refresh button to update terminal output
- [ ] Create `src/frontend/components/agent-status.tsx` - Agent status badge component
- [ ] Test: View agent list, view agent details

### 11. Tmux Terminal Viewer Integration
- [ ] Create `src/frontend/components/tmux-terminal.tsx`:
  - [ ] Use xterm.js (already copied from tmux-web in Phase 1)
  - [ ] Initialize xterm terminal
  - [ ] Fetch terminal output via `trpc.agent.getTerminalOutput.useQuery()`
  - [ ] Display output in terminal
  - [ ] Add auto-refresh (poll every 2-5 seconds for new output)
  - [ ] Add manual refresh button
  - [ ] Add scrollback support
  - [ ] Add resize handling
- [ ] Install xterm.js dependencies (if not already done in Phase 1):
  - [ ] `xterm`
  - [ ] `xterm-addon-fit`
  - [ ] `xterm-addon-web-links`
- [ ] Add WebSocket support for real-time updates (optional):
  - [ ] Create WebSocket endpoint in backend
  - [ ] Stream tmux output to WebSocket clients
  - [ ] Update frontend to use WebSocket for live updates
- [ ] Test: View worker terminal, see code being written in real-time

### 12. Human Mail Inbox UI
- [ ] Create `src/frontend/app/mail/page.tsx` - Mail inbox page:
  - [ ] Use `trpc.mail.listHumanInbox.useQuery()` to fetch mail
  - [ ] Display mail in list/table: sender, subject, preview, date
  - [ ] Show unread indicator (bold or badge)
  - [ ] Add click to view mail details
  - [ ] Add compose button to send mail to agent
  - [ ] Add search/filter by sender or subject
- [ ] Create `src/frontend/app/mail/[id]/page.tsx` - Mail detail page:
  - [ ] Use `trpc.mail.getById.useQuery()` to fetch mail
  - [ ] Display mail content (sender, subject, body, date)
  - [ ] Mark mail as read automatically
  - [ ] Display sender agent info (type, epic/task)
  - [ ] Add reply button → open reply form
  - [ ] Add link to view sender agent details
- [ ] Create `src/frontend/components/mail-inbox.tsx` - Reusable inbox component
- [ ] Create `src/frontend/components/mail-compose.tsx` - Compose mail form:
  - [ ] Input: recipient agent ID or select from list
  - [ ] Input: subject, body (textarea)
  - [ ] Use `trpc.mail.sendToAgent.useMutation()` to send
  - [ ] Show success/error messages
- [ ] Test: View inbox, read mail, reply to agent, send new mail

### 13. Decision Log Viewer UI
- [ ] Create `src/frontend/app/logs/page.tsx` - Decision log page:
  - [ ] Use `trpc.decisionLog.listRecent.useQuery()` to fetch logs
  - [ ] Display logs in table: agent, title, timestamp
  - [ ] Add filters: by agent, by date range
  - [ ] Add search by title or body
  - [ ] Add expandable rows to show full log body
  - [ ] Add pagination or infinite scroll
- [ ] Create `src/frontend/app/agents/[id]/logs/page.tsx` - Agent-specific logs:
  - [ ] Use `trpc.decisionLog.listByAgent.useQuery()` to fetch logs
  - [ ] Display logs for specific agent
  - [ ] Add timeline view option
- [ ] Create `src/frontend/components/decision-log-entry.tsx` - Log entry component
- [ ] Test: View recent logs, filter by agent, search logs

### 14. Dashboard Homepage
- [ ] Create `src/frontend/app/page.tsx` - Dashboard homepage:
  - [ ] Summary cards:
    - [ ] Total epics (with breakdown by state)
    - [ ] Total tasks (with breakdown by state)
    - [ ] Active agents (with health status)
    - [ ] Unread mail count
  - [ ] Recent epics list (last 5)
  - [ ] Recent tasks list (last 5)
  - [ ] Recent mail (last 5)
  - [ ] System health status (orchestrator, supervisors)
  - [ ] Quick actions: Create Epic, View Agents, View Mail
- [ ] Add navigation links to all pages
- [ ] Test: View dashboard, verify all stats and links work

### 15. Real-time Updates
- [ ] Add polling for real-time updates:
  - [ ] Epic list: refetch every 5 seconds
  - [ ] Task list: refetch every 5 seconds
  - [ ] Agent list: refetch every 2 seconds (for health monitoring)
  - [ ] Mail inbox: refetch every 5 seconds
  - [ ] Terminal output: refetch every 2 seconds
- [ ] Or implement tRPC subscriptions (advanced):
  - [ ] Add WebSocket support to tRPC server
  - [ ] Create subscriptions for epics, tasks, agents, mail
  - [ ] Update frontend to use subscriptions
- [ ] Add visual indicator when data is updating
- [ ] Test: Create epic in terminal, verify UI updates automatically

### 16. Navigation and Layout
- [ ] Create `src/frontend/app/layout.tsx` - Root layout:
  - [ ] Add navigation bar with links to all pages
  - [ ] Add FactoryFactory logo/title
  - [ ] Add user info (future: auth)
  - [ ] Add notification indicator (unread mail count)
- [ ] Create `src/frontend/components/ui/` directory for shared UI components:
  - [ ] Button, Card, Table, Badge, Input, Textarea, etc.
  - [ ] Use TailwindCSS for styling
  - [ ] Consider using a UI library (shadcn/ui, Radix, etc.)
- [ ] Add responsive design (mobile-friendly)
- [ ] Test: Navigate between all pages, verify layout consistency

### 17. Error Handling and Loading States
- [ ] Add error boundaries for React errors
- [ ] Add loading skeletons for all data fetching
- [ ] Add error messages for failed queries/mutations
- [ ] Add retry buttons for failed requests
- [ ] Add optimistic updates for mutations (optional)
- [ ] Test: Simulate network errors, verify error handling

### 18. Styling and Polish
- [ ] Apply consistent styling across all pages
- [ ] Add icons for actions and states (e.g., checkmark for completed tasks)
- [ ] Add color coding:
  - [ ] Green for success/completed
  - [ ] Yellow for in-progress/pending
  - [ ] Red for failed/unhealthy
  - [ ] Gray for inactive
- [ ] Add animations for transitions (optional)
- [ ] Add dark mode support (optional)
- [ ] Test: Review all pages for visual consistency

### 19. Integration Testing - Full UI Workflow
- [ ] Open frontend in browser
- [ ] Create new epic via UI:
  - [ ] Fill out form with title, description, design
  - [ ] Submit form
  - [ ] Verify redirect to epic detail page
- [ ] Monitor epic progress:
  - [ ] Verify supervisor appears in agent monitor
  - [ ] Verify tasks appear in task list
  - [ ] Verify workers appear in agent monitor
  - [ ] View worker terminal and see code being written
- [ ] Check mail inbox:
  - [ ] Verify mail from workers/supervisor appears
  - [ ] Read mail and reply
  - [ ] Verify reply sent successfully
- [ ] View decision logs:
  - [ ] Verify all agent actions logged
  - [ ] Filter logs by specific agent
  - [ ] Search logs for specific tool calls
- [ ] Monitor epic completion:
  - [ ] Verify tasks move to COMPLETED state
  - [ ] Verify epic moves to AWAITING_HUMAN_REVIEW
  - [ ] Verify epic PR link appears
  - [ ] Verify notification received (from Phase 5)
- [ ] Review epic PR on GitHub:
  - [ ] Open epic PR link
  - [ ] Review changes
  - [ ] Merge PR manually
  - [ ] Mark epic as COMPLETED in UI

### 20. Documentation
- [ ] Create `docs/FRONTEND_GUIDE.md`:
  - [ ] Document all UI pages and their purposes
  - [ ] Document navigation structure
  - [ ] Document how to create and manage epics
  - [ ] Document how to monitor agents
  - [ ] Document how to use mail system
  - [ ] Include screenshots
- [ ] Update `README.md` with frontend setup instructions
- [ ] Add code comments to all UI components
- [ ] Create user manual (optional)

## Smoke Test Checklist

Run these tests manually to validate Phase 6 completion:

- [ ] **Frontend Server**: Next.js dev server starts without errors
- [ ] **tRPC Connection**: Frontend can connect to backend tRPC server
- [ ] **Epic List**: Can view list of epics
- [ ] **Epic Creation**: Can create new epic via UI form
- [ ] **Epic Details**: Can view epic details page
- [ ] **Task List**: Can view list of tasks
- [ ] **Task Details**: Can view task details page
- [ ] **Agent Monitor**: Can view list of all agents
- [ ] **Agent Details**: Can view agent details page
- [ ] **Tmux Terminal**: Can view agent terminal output in UI
- [ ] **Terminal Updates**: Terminal output updates automatically (polling)
- [ ] **Mail Inbox**: Can view human mail inbox
- [ ] **Mail Details**: Can read mail from agents
- [ ] **Send Mail**: Can send mail to agent via UI
- [ ] **Reply Mail**: Can reply to agent mail
- [ ] **Decision Logs**: Can view recent decision logs
- [ ] **Agent Logs**: Can view logs for specific agent
- [ ] **Dashboard**: Dashboard shows summary stats and recent items
- [ ] **Navigation**: Can navigate between all pages via nav bar
- [ ] **Real-time Updates**: Data updates automatically via polling
- [ ] **Loading States**: Loading skeletons appear during data fetching
- [ ] **Error Handling**: Error messages appear for failed requests
- [ ] **Responsive Design**: UI works on mobile and desktop (basic check)

## Success Criteria

- [ ] All smoke tests pass
- [ ] Can create and manage epics entirely via UI
- [ ] Can monitor all agent activity in real-time
- [ ] Can view live terminal output from agents
- [ ] Can communicate with agents via mail system
- [ ] Can debug agent behavior via decision logs
- [ ] UI is responsive and user-friendly
- [ ] No need to use terminal/database tools for normal operations
- [ ] Complete end-to-end workflow via UI

## Git Tagging

Once all success criteria are met:
```bash
git add .
git commit -m "Phase 6 complete: Frontend and human interface"
git tag phase-6-complete
```

## Notes

- This phase makes FactoryFactory fully usable via web UI
- Focus on usability and real-time monitoring
- Terminal viewer is critical for observing agent work
- Mail system provides human-agent communication channel
- Decision logs provide debugging and audit trail
- Polling is simpler than WebSockets; can optimize later

## Next Phase

Phase 7 will focus on polish, production readiness, edge case handling, and final optimizations.
