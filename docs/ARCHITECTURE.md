# FactoryFactory Architecture

This document describes the high-level architecture of FactoryFactory, an autonomous multi-agent software development system.

## Table of Contents

1. [System Overview](#system-overview)
2. [Agent Hierarchy](#agent-hierarchy)
3. [Core Components](#core-components)
4. [Event-Driven Architecture](#event-driven-architecture)
5. [Data Flow](#data-flow)
6. [Database Schema](#database-schema)
7. [Technology Stack](#technology-stack)
8. [Key Design Decisions](#key-design-decisions)

## System Overview

FactoryFactory orchestrates multiple AI agents to autonomously implement software features. The system:

1. Accepts high-level feature descriptions (top-level tasks, linked to Linear issues)
2. Breaks them down into implementable subtasks
3. Assigns AI agents to implement each subtask
4. Creates pull requests for review
5. Manages the merge process

```
┌─────────────────────────────────────────────────────────────────┐
│                         FactoryFactory                           │
│                                                                   │
│  ┌─────────┐    ┌─────────────┐    ┌─────────────┐               │
│  │  Human  │───>│   Frontend  │───>│   Backend   │               │
│  │         │<───│   (Next.js) │<───│  (Express)  │               │
│  └─────────┘    └─────────────┘    └──────┬──────┘               │
│                                           │                       │
│                                    ┌──────┴──────┐                │
│                                    │   Inngest   │                │
│                                    │   Events    │                │
│                                    └──────┬──────┘                │
│                                           │                       │
│  ┌────────────────────────────────────────┼────────────────────┐  │
│  │                    Agent Layer          │                    │  │
│  │  ┌────────────┐  ┌─────────────┐  ┌────┴─────┐              │  │
│  │  │Orchestrator│─>│ Supervisor  │─>│  Worker  │              │  │
│  │  │  (System)  │  │(Top-level)  │  │(Subtask) │              │  │
│  │  └────────────┘  └─────────────┘  └──────────┘              │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌────────────┐    ┌────────────┐    ┌────────────┐              │
│  │ PostgreSQL │    │    Git     │    │   Claude   │              │
│  │  Database  │    │ Worktrees  │    │    Code    │              │
│  └────────────┘    └────────────┘    └────────────┘              │
└─────────────────────────────────────────────────────────────────┘
```

## Agent Hierarchy

### Three-Tier Agent Structure

```
                    ┌─────────────────┐
                    │   Orchestrator  │
                    │   (1 per system)│
                    └────────┬────────┘
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
   ┌──────┴──────┐    ┌──────┴──────┐    ┌──────┴──────┐
   │ Supervisor  │    │ Supervisor  │    │ Supervisor  │
   │  (Task A)   │    │  (Task B)   │    │  (Task C)   │
   └──────┬──────┘    └──────┬──────┘    └──────┬──────┘
          │                  │                  │
    ┌─────┼─────┐      ┌─────┼─────┐      ┌─────┼─────┐
    │     │     │      │     │     │      │     │     │
┌───┴┐ ┌──┴─┐ ┌─┴──┐ ┌─┴──┐ ┌┴───┐ ┌─┴──┐ ┌─┴──┐ ┌┴───┐ ┌─┴──┐
│W1  │ │W2  │ │W3  │ │W1  │ │W2  │ │W3  │ │W1  │ │W2  │ │W3  │
└────┘ └────┘ └────┘ └────┘ └────┘ └────┘ └────┘ └────┘ └────┘
```

### Orchestrator Agent

**Responsibilities:**
- System-wide health monitoring
- Supervisor lifecycle management
- Escalation handling for critical issues
- Resource allocation across top-level tasks

**Runs:** One per system
**Model:** Configurable (default: sonnet)
**Permissions:** Strict mode

### Supervisor Agent

**Responsibilities:**
- Top-level task planning and breakdown
- Subtask creation and prioritization
- Worker health monitoring
- PR review coordination
- Merge conflict resolution
- Task completion management

**Runs:** One per active top-level task
**Model:** Configurable (default: sonnet)
**Permissions:** Relaxed mode

### Worker Agent

**Responsibilities:**
- Subtask implementation
- Code writing and testing
- PR creation
- Rebase handling when requested
- Status reporting to supervisor

**Runs:** One per active subtask
**Model:** Configurable (default: sonnet)
**Permissions:** Yolo mode (autonomous execution)

## Core Components

### Frontend (Next.js 16)

All routes are project-scoped under `/projects/[slug]/...`.

> **Note:** The `epics/` directories are a historical naming artifact. The data model now uses a unified "Task" model where top-level tasks (parentId = null) were formerly called "Epics". The UI routes retain the old naming for URL stability.

```
src/app/
├── page.tsx                    # Dashboard
├── projects/
│   ├── page.tsx                # Project list
│   ├── new/page.tsx            # Create project
│   └── [slug]/
│       ├── layout.tsx          # Project layout
│       ├── epics/              # Top-level tasks (historical naming)
│       │   ├── page.tsx        # List top-level tasks
│       │   ├── new/page.tsx    # Create top-level task
│       │   └── [id]/page.tsx   # View top-level task
│       ├── tasks/page.tsx      # Subtasks view
│       ├── mail/               # Project mail
│       │   ├── page.tsx
│       │   └── [id]/page.tsx
│       └── logs/page.tsx       # Project decision logs
└── admin/                      # Admin dashboard
    ├── page.tsx
    ├── agents/page.tsx
    └── system/page.tsx
```

### Backend (Express + tRPC)

```
src/backend/
├── index.ts                    # Express server entry
├── trpc/                       # tRPC routers
│   ├── task.trpc.ts            # Task operations (top-level and subtasks)
│   ├── agent.trpc.ts           # Agent management
│   ├── mail.trpc.ts            # Mail system
│   ├── project.trpc.ts         # Project management
│   ├── admin.trpc.ts           # Admin operations
│   ├── decision-log.trpc.ts    # Decision logging
│   └── procedures/             # Shared procedures
│       ├── project-scoped.ts
│       └── top-level-task-scoped.ts
├── routers/
│   ├── api/                    # REST endpoints
│   └── mcp/                    # MCP tool handlers
├── agents/
│   ├── orchestrator/           # Orchestrator implementation
│   │   ├── orchestrator.agent.ts
│   │   ├── health.ts
│   │   └── lifecycle.ts
│   ├── supervisor/             # Supervisor implementation
│   │   ├── supervisor.agent.ts
│   │   ├── health.ts
│   │   └── lifecycle.ts
│   ├── worker/                 # Worker implementation
│   │   ├── worker.agent.ts
│   │   └── lifecycle.ts
│   └── prompts/                # Agent prompt builders
│       ├── builders/
│       └── sections/
├── services/                   # Business logic services
├── resource_accessors/         # Database access layer
├── clients/                    # External API clients
└── inngest/                    # Event handlers
```

### Services Layer

```
services/
├── logger.service.ts           # Structured logging
├── rate-limiter.service.ts     # API rate limiting
├── config.service.ts           # Configuration management
├── validation.service.ts       # Input validation
├── crash-recovery.service.ts   # Agent crash handling
├── worktree.service.ts         # Git worktree management
├── pr-conflict.service.ts      # PR/merge conflict handling
└── notification.service.ts     # Desktop notifications
```

### Clients Layer

```
clients/
├── claude-code.client.ts       # Claude Code CLI interaction
├── claude-auth.ts              # Claude authentication
├── git.client.ts               # Git operations
├── github.client.ts            # GitHub API
├── tmux.client.ts              # tmux session management
└── terminal.client.ts          # Terminal/PTY handling
```

## Event-Driven Architecture

### Inngest Event System

FactoryFactory uses Inngest for reliable event processing:

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Trigger   │────>│   Inngest   │────>│   Handler   │
│   (Event)   │     │   (Queue)   │     │  (Function) │
└─────────────┘     └─────────────┘     └─────────────┘
```

### Core Events

| Event | Trigger | Handler Action |
|-------|---------|----------------|
| `task.top_level.created` | New top-level task created | Start supervisor agent |
| `task.created` | New subtask created | Start worker agent |
| `mail.sent` | Mail message sent | Deliver to recipient |
| `agent.completed` | Agent finishes | Update state, cleanup |
| `supervisor.check` | Periodic (5 min) | Health check supervisors |
| `orchestrator.check` | Periodic (5 min) | Health check orchestrator |

### Event Flow Example

```
Top-level Task Created
     │
     ▼
┌─────────────────────┐
│ task.top_level      │
│ .created fired      │
└────────┬────────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│ Create          │────>│ Supervisor      │
│ Supervisor      │     │ Analyzes Task   │
└─────────────────┘     └────────┬────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ task.created    │     │ task.created    │     │ task.created    │
│ (Subtask 1)     │     │ (Subtask 2)     │     │ (Subtask 3)     │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ Worker 1        │     │ Worker 2        │     │ Worker 3        │
│ Implements      │     │ Implements      │     │ Implements      │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

## Data Flow

### PR Flow (Sequential Review)

```
Worker 1 completes → PR created → Added to queue
                                        │
                                        ▼
                                  ┌───────────┐
                                  │ PR Queue  │
                                  │ [PR1]     │
                                  └─────┬─────┘
                                        │
Worker 2 completes → PR created ────────┤
                                        ▼
                                  ┌───────────┐
                                  │ PR Queue  │
                                  │ [PR1,PR2] │
                                  └─────┬─────┘
                                        │
                                        ▼
                              ┌─────────────────┐
                              │ Supervisor      │
                              │ Reviews PR1     │
                              │ Merges          │
                              └────────┬────────┘
                                       │
                                       ▼
                              ┌─────────────────┐
                              │ Trigger Rebase  │
                              │ for PR2         │
                              └────────┬────────┘
                                       │
                                       ▼
                              ┌─────────────────┐
                              │ Worker 2        │
                              │ Rebases         │
                              └────────┬────────┘
                                       │
                                       ▼
                              ┌─────────────────┐
                              │ Supervisor      │
                              │ Reviews PR2     │
                              │ Merges          │
                              └─────────────────┘
```

### Communication Flow

```
┌──────────┐    Mail    ┌──────────────┐    Mail    ┌──────────┐
│  Human   │<──────────>│  Supervisor  │<──────────>│  Worker  │
└──────────┘            └──────────────┘            └──────────┘
     │                         │                          │
     │                         │                          │
     └─────────────────────────┼──────────────────────────┘
                               │
                        Decision Logs
                               │
                               ▼
                        ┌──────────────┐
                        │   Database   │
                        └──────────────┘
```

## Database Schema

### Unified Task Model

The system uses a unified Task model where top-level tasks (formerly "Epics") and subtasks are both represented in the same table, differentiated by the `parentId` field:

- **Top-level tasks**: `parentId = null`, linked to Linear issues
- **Subtasks**: `parentId` references parent task

### Entity Relationship Diagram

```
┌─────────────┐
│   Project   │
│             │
│ id          │
│ name        │
│ slug        │
│ repoPath    │
│ worktreePath│
└──────┬──────┘
       │
       │ has many
       ▼
┌─────────────┐         ┌─────────────┐
│    Task     │────────<│    Task     │
│             │ parent  │  (subtask)  │
│ id          │         └─────────────┘
│ projectId   │
│ parentId    │ (null = top-level)
│ title       │
│ description │
│ state       │
│ linearIssue │ (top-level only)
│ assignedId  │
│ branchName  │
│ prUrl       │
│ attempts    │
└──────┬──────┘
       │
       │ assigned to
       ▼
┌─────────────┐
│    Agent    │
│             │
│ id          │
│ type        │         ┌─────────────┐
│ state       │────────>│ DecisionLog │
│ currentTask │         │             │
│ tmuxSession │         │ id          │
│ sessionId   │         │ agentId     │
│ lastActive  │         │ decision    │
└──────┬──────┘         │ reasoning   │
       │                │ context     │
       │                │ timestamp   │
       │                └─────────────┘
       ▼
┌─────────────┐
│    Mail     │
│             │
│ id          │
│ fromAgentId │
│ toAgentId   │
│ isForHuman  │
│ subject     │
│ body        │
│ isRead      │
└─────────────┘

┌─────────────────┐
│ TaskDependency  │
│                 │
│ id              │
│ taskId          │ (the blocked task)
│ dependsOnId     │ (the blocking task)
└─────────────────┘
```

### State Machines

**Task States (Parent/Top-level):**
```
PLANNING → PLANNED → (children execute) → COMPLETED
              ↓                               ↑
           BLOCKED ───────────────────────────┘
              ↓
          CANCELLED
```

**Task States (Leaf/Subtask):**
```
PENDING → ASSIGNED → IN_PROGRESS → REVIEW → COMPLETED
             ↓           ↓            ↓
          BLOCKED     BLOCKED      BLOCKED
             ↓           ↓            ↓
           FAILED      FAILED       FAILED
```

**Agent States:**
```
IDLE ←→ BUSY ←→ WAITING
  ↓       ↓        ↓
        FAILED
```

## Technology Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Frontend | Next.js 16 | React-based UI |
| Styling | Tailwind CSS v4 | Utility-first CSS |
| Components | shadcn/ui | Component library |
| API | tRPC | Type-safe API calls |
| Backend | Express.js | HTTP server |
| Events | Inngest | Event processing |
| Database | PostgreSQL | Persistent storage |
| ORM | Prisma | Database access |
| AI | Claude Code CLI | Agent intelligence |
| Process | tmux | Agent terminals |
| VCS | Git | Version control |

## Key Design Decisions

### 1. Sequential PR Review

**Decision:** PRs are reviewed and merged one at a time, in order.

**Rationale:**
- Prevents complex multi-way merge conflicts
- Ensures each PR is based on the latest main
- Simplifies conflict resolution (only binary: with main)
- Makes rebase cascades predictable

**Trade-off:** Slower task completion, but more reliable.

### 2. Three-Tier Agent Hierarchy

**Decision:** Orchestrator → Supervisor → Worker structure.

**Rationale:**
- Clear separation of concerns
- Supervisors can be specialized per top-level task
- Workers are stateless and replaceable
- Failure isolation (worker crash doesn't affect other tasks)

### 3. Unified Task Model

**Decision:** Use a single Task model with parent-child relationships instead of separate Epic/Task models.

**Rationale:**
- Simpler data model
- Consistent handling of all task types
- Easier to add task nesting in the future
- Cleaner API surface

### 4. Event-Driven Architecture

**Decision:** Use Inngest for all async operations.

**Rationale:**
- Reliable event delivery with retries
- Built-in observability
- Easy to add new event handlers
- Decouples components

### 5. Git Worktrees per Task

**Decision:** Each subtask works in its own git worktree.

**Rationale:**
- Parallel implementation without conflicts
- Independent branch per task
- Clean separation of concerns
- Easy cleanup

### 6. Mail System for Communication

**Decision:** Internal mail for human-agent and agent-agent communication.

**Rationale:**
- Persistent message history
- Async communication (agents don't block)
- Clear audit trail
- Human can participate naturally

### 7. Decision Logging

**Decision:** Log all agent decisions with reasoning.

**Rationale:**
- Debugability (understand why agent did X)
- Accountability (trace decisions)
- Learning (analyze patterns)
- Transparency (humans can review reasoning)

---

For user documentation, see [USER_GUIDE.md](./USER_GUIDE.md).
For deployment instructions, see [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md).
