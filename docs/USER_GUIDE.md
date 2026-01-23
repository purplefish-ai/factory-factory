# FactoryFactory User Guide

Welcome to FactoryFactory, an autonomous multi-agent software development system. This guide will help you get started and make the most of the system.

## Table of Contents

1. [Getting Started](#getting-started)
2. [Creating an Epic](#creating-an-epic)
3. [Monitoring Progress](#monitoring-progress)
4. [Interacting with Agents](#interacting-with-agents)
5. [Reviewing and Merging](#reviewing-and-merging)
6. [Troubleshooting](#troubleshooting)
7. [FAQ](#faq)

## Getting Started

### Prerequisites

Before using FactoryFactory, ensure you have:

- A running FactoryFactory instance (see [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md))
- Access to the web UI (default: http://localhost:3000)
- A git repository that agents can work on

### Accessing the Dashboard

1. Open your browser and navigate to `http://localhost:3000`
2. You'll see the main dashboard with:
   - Summary statistics (epics, tasks, agents, mail)
   - Status breakdowns for epics and tasks
   - Agent health indicators
   - Quick action buttons

## Creating an Epic

An **Epic** is a high-level work item that will be broken down into tasks by the supervisor agent.

### Steps to Create an Epic

1. Click **"Create Epic"** from the dashboard or navigate to `/epics/new`
2. Fill in the form:
   - **Title**: A concise name for the epic (e.g., "Add User Authentication")
   - **Description**: Detailed requirements and specifications
3. Click **"Create"**

### Writing Good Epic Descriptions

The quality of your epic description directly affects how well agents understand and implement your requirements. A good description should include:

- **Clear objectives**: What should be accomplished?
- **Technical requirements**: Specific technologies, patterns, or constraints
- **Acceptance criteria**: How will we know it's complete?
- **Edge cases**: Any special scenarios to handle

**Example of a Good Epic Description:**

```
Add user authentication to the application.

Requirements:
- Implement JWT-based authentication
- Create login and registration endpoints
- Add password hashing with bcrypt
- Include email verification flow
- Add "forgot password" functionality

Technical Notes:
- Use existing User model from Prisma schema
- Store sessions in Redis
- Rate limit login attempts (5 per minute)

Acceptance Criteria:
- Users can register with email/password
- Users can log in and receive a JWT
- Protected routes require valid JWT
- All tests pass
```

### What Happens After Creation

1. The system creates a **Supervisor Agent** for your epic
2. The supervisor analyzes your description
3. The supervisor creates individual **Tasks** based on your requirements
4. **Worker Agents** are assigned to each task
5. Workers implement the code and create pull requests

## Monitoring Progress

### Dashboard View

The main dashboard provides a quick overview of system activity:

- **Total Epics/Tasks/Agents**: Current counts
- **Status Breakdowns**: See what's pending, in progress, completed, etc.
- **Agent Health**: Green = healthy, Red = issues

### Epic Detail View

Navigate to an epic to see:

- Epic status and metadata
- List of all tasks with their states
- Supervisor activity
- Timeline of events

### Task Detail View

Click on any task to see:

- Task description and requirements
- Assigned worker agent
- Git branch and PR information
- Decision logs (agent reasoning)

### Agent Monitoring

The `/agents` page shows all active agents:

- Agent type (Orchestrator, Supervisor, Worker)
- Current state (Idle, Busy, Waiting, Failed)
- Last activity timestamp
- Tmux session information

### Decision Logs

The `/logs` page shows the reasoning behind agent decisions. Use this to:

- Understand why an agent took a particular action
- Debug unexpected behavior
- Monitor agent progress

## Interacting with Agents

### The Mail System

FactoryFactory includes an internal mail system for human-agent communication.

**Checking Mail:**
1. Click the **Mail** icon in the sidebar
2. Unread messages are highlighted
3. Click a message to read it

**Responding to Agents:**
Agents may send you mail asking for:
- Clarification on requirements
- Approval to proceed with a design decision
- Help with a blocked task
- Notification of completion

To respond, use the mail interface in the UI.

### Common Agent Requests

1. **Clarification Needed**: The agent needs more information about requirements
2. **Design Decision**: The agent wants approval before implementing something
3. **Blocked Task**: Something prevents the agent from continuing
4. **PR Ready**: A pull request is ready for your review

## Reviewing and Merging

### Task Pull Requests

Each completed task creates a pull request:

1. Navigate to the task detail page
2. Click the PR link to view it on GitHub
3. Review the code changes
4. Approve or request changes
5. Once approved, the supervisor will merge the PR

### Epic Completion

When all tasks are complete:

1. The supervisor creates a final "epic PR" combining all changes
2. You'll receive a notification
3. Review the epic PR
4. Merge manually or let the system handle it

### Merge Conflicts

If conflicts occur during the sequential merge process:

1. The affected task will be marked as **BLOCKED**
2. The supervisor will notify you
3. Options:
   - Let the worker attempt auto-resolution
   - Manually resolve conflicts
   - Reset the task for a fresh attempt

## Troubleshooting

### Agent Not Responding

If an agent appears stuck:

1. Check the agent's state in `/agents`
2. View the agent's decision logs
3. Check if there are pending mail messages
4. Use the Admin panel to restart the agent if needed

### Task Failed

If a task fails:

1. Check the task's failure reason
2. Review the decision logs
3. Options:
   - Reset the task (`/admin` > Reset Task)
   - Modify the task description and retry
   - Mark as not needed and continue

### Crash Loops

If an agent keeps crashing:

1. The system will automatically detect this
2. After 3 rapid crashes, the agent is marked as "crash loop"
3. You'll receive a notification
4. Use Admin > Clear Crash Records to reset
5. Investigate the underlying issue

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Epic stuck in PLANNING | Supervisor hasn't finished | Wait or check logs |
| Task stuck in IN_PROGRESS | Worker may be waiting | Check for pending mail |
| PR creation failed | GitHub API issues | Check worker logs, retry |
| Agent shows FAILED | Crash or error | Use Admin to restart |

## FAQ

### Q: How long does an epic take to complete?

A: It depends on complexity. A small epic (3 tasks) typically completes in 30-60 minutes. Larger epics may take several hours.

### Q: Can I modify a task after it's created?

A: Currently, you should reset the task and let it be recreated. Direct editing is not supported.

### Q: How do I stop all agents?

A: Go to Admin > Agents and kill each agent individually, or restart the system.

### Q: Can I run multiple epics at once?

A: Yes! The system supports concurrent epics (default limit: 5). Each epic has its own supervisor and workers.

### Q: How do I customize which AI model is used?

A: Set environment variables:
- `WORKER_MODEL=haiku` (for faster, cheaper workers)
- `SUPERVISOR_MODEL=opus` (for more capable supervisors)

### Q: What happens if I close the browser?

A: Agents continue running in the background. You can return later to check progress.

### Q: How do I see what an agent is doing right now?

A: Click on the agent in `/agents` to see its decision logs, or connect to its tmux session for live output.

### Q: Can agents access external services?

A: Yes, workers can make API calls, install packages, and interact with external services as needed for implementation.

---

For deployment and configuration, see [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md).
For technical architecture details, see [ARCHITECTURE.md](./ARCHITECTURE.md).
