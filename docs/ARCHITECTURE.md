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

1. Accepts high-level feature descriptions ("epics")
2. Breaks them down into implementable tasks
3. Assigns AI agents to implement each task
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
│  │  │  (System)  │  │   (Epic)    │  │  (Task)  │              │  │
│  │  └────────────┘  └─────────────┘  └──────────┘              │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌────────────┐    ┌────────────┐    ┌────────────┐              │
│  │ PostgreSQL │    │    Git     │    │   Claude   │              │
│  │  Database  │    │ Worktrees  │    │    API     │              │
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
   │  (Epic A)   │    │  (Epic B)   │    │  (Epic C)   │
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
- Resource allocation across epics

**Runs:** One per system
**Model:** Configurable (default: sonnet)
**Permissions:** Strict mode

### Supervisor Agent

**Responsibilities:**
- Epic-level planning and breakdown
- Task creation and prioritization
- Worker health monitoring
- PR review coordination
- Merge conflict resolution
- Epic completion management

**Runs:** One per active epic
**Model:** Configurable (default: sonnet)
**Permissions:** Relaxed mode

### Worker Agent

**Responsibilities:**
- Task implementation
- Code writing and testing
- PR creation
- Rebase handling when requested
- Status reporting to supervisor

**Runs:** One per active task
**Model:** Configurable (default: sonnet)
**Permissions:** Yolo mode (autonomous execution)

## Core Components

### Frontend (Next.js 14)

```
src/app/
├── page.tsx              # Dashboard
├── epics/                # Epic management UI
├── tasks/                # Task views
├── agents/               # Agent monitoring
├── mail/                 # Agent communication
├── logs/                 # Decision log viewer
└── admin/                # Admin dashboard
```

### Backend (Express + tRPC)

```
src/backend/
├── index.ts              # Express server entry
├── trpc/                 # tRPC routers
│   ├── epic.trpc.ts
│   ├── task.trpc.ts
│   ├── agent.trpc.ts
│   ├── mail.trpc.ts
│   ├── admin.trpc.ts
│   └── decision-log.trpc.ts
├── routers/
│   ├── api/              # REST endpoints
│   └── mcp/              # MCP tool handlers
├── agents/
│   ├── orchestrator/     # Orchestrator implementation
│   ├── supervisor/       # Supervisor implementation
│   └── worker/           # Worker implementation
├── services/             # Business logic services
├── resource_accessors/   # Database access layer
├── clients/              # External API clients
└── inngest/              # Event handlers
```

### Services Layer

```
services/
├── logger.service.ts         # Structured logging
├── rate-limiter.service.ts   # API rate limiting
├── config.service.ts         # Configuration management
├── validation.service.ts     # Input validation
├── crash-recovery.service.ts # Agent crash handling
├── worktree.service.ts       # Git worktree management
├── pr-conflict.service.ts    # PR/merge conflict handling
└── notification.service.ts   # Desktop notifications
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
| `epic.created` | New epic created | Start supervisor agent |
| `task.created` | New task created | Start worker agent |
| `mail.sent` | Mail message sent | Deliver to recipient |
| `agent.completed` | Agent finishes | Update state, cleanup |
| `supervisor.check` | Periodic (5 min) | Health check supervisors |
| `orchestrator.check` | Periodic (5 min) | Health check orchestrator |

### Event Flow Example

```
Epic Created
     │
     ▼
┌─────────────────┐
│ epic.created    │
│ event fired     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│ Create          │────>│ Supervisor      │
│ Supervisor      │     │ Analyzes Epic   │
└─────────────────┘     └────────┬────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ task.created    │     │ task.created    │     │ task.created    │
│ (Task 1)        │     │ (Task 2)        │     │ (Task 3)        │
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

### Entity Relationship Diagram

```
┌─────────────┐         ┌─────────────┐
│    Epic     │────────<│    Task     │
│             │         │             │
│ id          │         │ id          │
│ title       │         │ title       │
│ description │         │ description │
│ state       │         │ state       │
│ linearIssue │         │ epicId      │
└──────┬──────┘         │ assignedId  │
       │                │ branchName  │
       │                │ prUrl       │
       │                │ attempts    │
       │                └──────┬──────┘
       │                       │
       ▼                       ▼
┌─────────────┐         ┌─────────────┐
│    Agent    │<────────│  (assigned) │
│             │         └─────────────┘
│ id          │
│ type        │         ┌─────────────┐
│ state       │────────>│ DecisionLog │
│ currentEpic │         │             │
│ currentTask │         │ id          │
│ tmuxSession │         │ agentId     │
│ lastActive  │         │ decision    │
└──────┬──────┘         │ reasoning   │
       │                │ context     │
       │                │ timestamp   │
       │                └─────────────┘
       │
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
```

### State Machines

**Epic States:**
```
PLANNING → IN_PROGRESS → COMPLETED
              ↓              ↑
           BLOCKED ──────────┘
              ↓
          CANCELLED
```

**Task States:**
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
| Frontend | Next.js 14 | React-based UI |
| Styling | Tailwind CSS | Utility-first CSS |
| API | tRPC | Type-safe API calls |
| Backend | Express.js | HTTP server |
| Events | Inngest | Event processing |
| Database | PostgreSQL | Persistent storage |
| ORM | Prisma | Database access |
| AI | Claude (Anthropic) | Agent intelligence |
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

**Trade-off:** Slower epic completion, but more reliable.

### 2. Three-Tier Agent Hierarchy

**Decision:** Orchestrator → Supervisor → Worker structure.

**Rationale:**
- Clear separation of concerns
- Supervisors can be specialized per epic
- Workers are stateless and replaceable
- Failure isolation (worker crash doesn't affect other epics)

### 3. Event-Driven Architecture

**Decision:** Use Inngest for all async operations.

**Rationale:**
- Reliable event delivery with retries
- Built-in observability
- Easy to add new event handlers
- Decouples components

### 4. Git Worktrees per Task

**Decision:** Each task works in its own git worktree.

**Rationale:**
- Parallel implementation without conflicts
- Independent branch per task
- Clean separation of concerns
- Easy cleanup

### 5. Mail System for Communication

**Decision:** Internal mail for human-agent and agent-agent communication.

**Rationale:**
- Persistent message history
- Async communication (agents don't block)
- Clear audit trail
- Human can participate naturally

### 6. Decision Logging

**Decision:** Log all agent decisions with reasoning.

**Rationale:**
- Debugability (understand why agent did X)
- Accountability (trace decisions)
- Learning (analyze patterns)
- Transparency (humans can review reasoning)

---

For user documentation, see [USER_GUIDE.md](./USER_GUIDE.md).
For deployment instructions, see [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md).
