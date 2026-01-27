# GSD UI Brainstorm

This document captures UI concepts for Get Shit Done workflows. The goal is to create visual interfaces that complement the CLI experience.

---

## Core Insights GSD Has Figured Out

These are the key innovations that make GSD work. Any UI should preserve and surface these patterns.

### 1. Context Rot is Predictable

Quality degrades as context fills. This isn't random - it follows a curve:

```
0-30%  → PEAK quality (thorough, comprehensive)
30-50% → GOOD (confident, solid work)
50-70% → DEGRADING (efficiency mode, cutting corners)
70%+   → POOR (rushing, minimal effort)
```

**The fix:** Hard limit of 2-3 tasks per plan. Target 50% context usage. More plans = better quality, not inefficiency. Fresh subagents for heavy lifting.

### 2. Goal-Backward Verification

Don't ask "did you do the tasks?" Ask "are the outcomes TRUE?"

```
Goal: "Users can authenticate"
         ↓
What must be TRUE? (user-observable)
  • User can log in
  • User can log out
  • Session persists
         ↓
What must EXIST? (artifacts)
  • login/route.ts
  • logout/route.ts
  • User model with password
         ↓
What must be WIRED? (key links)
  • LoginForm → fetches → /api/login
  • /api/login → queries → prisma.user
```

This methodology is used in planning (must_haves), plan checking (pre-execution), and verification (post-execution).

### 3. Artifacts Existing ≠ Artifacts Wired

The **key links** concept. Two files can both exist but not be connected. A component and an API endpoint both existing doesn't mean the component calls the API.

Most bugs live in the wiring, not the artifacts.

### 4. Decision State Classification

Not everything is equally known. Explicitly classify each piece of information:

| State | Treatment |
|-------|-----------|
| **Decided** | Locked. Don't revisit. |
| **Ambiguous** | Ask user. Capture answer. |
| **Quick lookup** | Resolve inline, minimal friction |
| **Needs research** | Spawn researcher, wait for findings |
| **Claude's discretion** | User said "you decide" - flexibility granted |

### 5. Plans Are Prompts

PLAN.md IS the prompt that gets executed. Not a document that becomes a prompt. This removes a translation layer where meaning gets lost.

### 6. Fresh Context via Subagents

The orchestrator stays lean (30-40% context). Heavy work happens in spawned agents with fresh 200k tokens each. This is how you beat context rot at scale.

### 7. Dimension Checks (Orthogonal Failure Modes)

Six independent verification dimensions, each catching different failure modes:

| Dimension | What it catches |
|-----------|-----------------|
| **Requirement coverage** | Forgot to build something |
| **Task completeness** | Vague or incomplete instructions |
| **Dependencies** | Circular deps, broken ordering |
| **Key links** | Artifacts exist but aren't wired |
| **Scope sanity** | Plan too big, quality will degrade |
| **Must-haves derivation** | Verification criteria are implementation-focused, not user-observable |

### 8. Gray Areas Are Phase-Specific

Not generic questions ("tell me about the UI"). Phase-specific ambiguities that would change the outcome:

```
Phase: "User authentication"
→ Session handling, Error responses, Multi-device policy, Recovery flow

Phase: "CLI for backups"
→ Output format, Flag design, Progress reporting, Error recovery
```

### 9. Atomic Commits Per Task

Not per plan. Not per phase. Per task. Enables bisecting, reverting, understanding what each commit actually did.

### 10. Wave-Based Parallelization

Pre-compute dependency graph → assign wave numbers → execute waves in parallel. No runtime dependency resolution.

```
Wave 1: [Plan A, Plan B]  ← parallel
Wave 2: [Plan C]          ← waits for wave 1
Wave 3: [Plan D, Plan E]  ← parallel after wave 2
```

### The Meta-Pattern

GSD's core insight: **Make implicit things explicit, then verify them independently.**

- Context budget → explicit (50% target)
- Decision states → explicit (decided/ambiguous/discretion)
- Dependencies → explicit (frontmatter, pre-computed waves)
- Wiring → explicit (key_links in must_haves)
- Verification → explicit (6 dimensions, each independent)

---

## Context: What GSD Does

**GSD solves "context rot"** - the quality degradation that happens as Claude fills its context window. It does this by:
- Breaking projects into atomic phases/plans/tasks
- Spawning fresh subagents (200k tokens each) for heavy lifting
- Maintaining state across sessions via markdown artifacts

**Core Workflows:**
1. **New Project** → Questions → Research → Requirements → Roadmap
2. **Per-Phase Cycle** → Discuss → Plan → Execute → Verify
3. **Quick Mode** → Ad-hoc tasks without full planning
4. **Brownfield** → Map existing codebase before starting

**Key Data Entities:**
- `PROJECT.md` - Vision, core value, constraints
- `REQUIREMENTS.md` - v1/v2/out-of-scope with IDs
- `ROADMAP.md` - Phases with requirement mappings
- `STATE.md` - Current position, decisions, blockers
- `PLAN.md` - Executable prompts with XML tasks
- `SUMMARY.md` - Completion reports with metadata
- `config.json` - Workflow preferences

---

## 1. Project Dashboard View

The primary landing view showing project state at a glance.

```
┌─────────────────────────────────────────────────────────────────┐
│  🎯 Project: My SaaS App                                        │
│  Core Value: "Enable teams to track tasks collaboratively"      │
├─────────────────────────────────────────────────────────────────┤
│  Progress: ████████░░░░░░ 53%   │  Velocity: 2.3 plans/day     │
│  Phase: 4 of 7                   │  Blockers: 1                 │
├─────────────────────────────────────────────────────────────────┤
│  [▶ Continue Phase 4]  [⚡ Quick Task]  [📊 Full Status]        │
└─────────────────────────────────────────────────────────────────┘
```

**Key elements:**
- One-glance project state
- Progress visualization
- Primary action prominent
- Velocity/metrics at a glance

**Data sources:**
- `PROJECT.md` → name, core value
- `STATE.md` → current position, blockers
- `ROADMAP.md` → phase count, progress calculation
- Computed from `SUMMARY.md` files → velocity metrics

---

## 2. Roadmap Timeline View

Visual representation of the project phases and their status.

```
      Phase 1          Phase 2         Phase 3          Phase 4         Phase 5
    Foundation       User Auth       Dashboard         Reports        Polish
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
       ✓               ✓                ◆              ○               ○
    [3 plans]       [4 plans]       [2/3 plans]    [0/3 plans]     [0/2 plans]
```

**Expanded phase detail:**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Phase 4: Reports                                                           │
│  Goal: Generate PDF and CSV exports of user data                           │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Requirements: REP-01, REP-02, REP-03                                       │
│  Success: Users can download reports in multiple formats                    │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Plans:  ○ 04-01: PDF generation engine                                    │
│          ○ 04-02: Export API endpoints                                     │
│          ○ 04-03: Download UI components                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Interactions:**
- Click phase → expand details
- Click plan → see tasks
- Drag to reorder (updates ROADMAP.md)
- Right-click → insert phase, remove phase

**Data sources:**
- `ROADMAP.md` → phases, goals, success criteria, plan lists
- `REQUIREMENTS.md` → requirement IDs per phase
- `{phase}-{plan}-PLAN.md` → plan details
- `{phase}-{plan}-SUMMARY.md` → completion status

---

## 3. Execution Control Panel

Real-time view of plan execution with agent status.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  EXECUTING: Phase 4 - Reports                                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   Wave 1 (parallel)                   Wave 2 (sequential)                   │
│   ┌──────────────┐ ┌──────────────┐   ┌──────────────┐                     │
│   │ 04-01: PDF   │ │ 04-02: API   │   │ 04-03: UI    │                     │
│   │ ████████░░   │ │ ██████░░░░   │   │ ○ waiting    │                     │
│   │ Task 2/3     │ │ Task 1/2     │   │              │                     │
│   └──────────────┘ └──────────────┘   └──────────────┘                     │
│                                                                             │
│   Agent Status:                                                             │
│   ◆ gsd-executor-04-01: Creating PDF renderer...                           │
│   ◆ gsd-executor-04-02: Implementing export endpoint...                    │
│                                                                             │
│   Recent Commits:                                                           │
│   ✓ feat(04-01): add pdf template engine         abc123f                   │
│   ✓ feat(04-01): implement page layout system    def456a                   │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  [⏸ Pause]  [⏭ Skip to Verify]  [📋 View Plans]                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key features:**
- Wave-based parallel execution visualization
- Real-time agent status updates
- Live commit stream
- Ability to pause/skip/intervene

**Data sources:**
- `{phase}-{plan}-PLAN.md` frontmatter → wave grouping, dependencies
- Live agent output → status messages
- Git log → recent commits
- Task XML in PLAN.md → task count and progress

---

## 4. Requirements Traceability Matrix

Track requirements from definition through verification.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  REQUIREMENTS TRACEABILITY                                          [Filter] │
├──────────┬──────────┬─────────────────────────────────┬──────────┬──────────┤
│ ID       │ Status   │ Description                     │ Phase    │ Verified │
├──────────┼──────────┼─────────────────────────────────┼──────────┼──────────┤
│ AUTH-01  │ ✓ Done   │ User signup with email          │ Phase 2  │ ✓        │
│ AUTH-02  │ ✓ Done   │ User login with session         │ Phase 2  │ ✓        │
│ AUTH-03  │ ✓ Done   │ Password reset flow             │ Phase 2  │ ✓        │
│ DASH-01  │ ◆ Active │ Display user's projects         │ Phase 3  │ -        │
│ DASH-02  │ ○ Pend   │ Real-time updates               │ Phase 3  │ -        │
│ REP-01   │ ○ Pend   │ Export data as PDF              │ Phase 4  │ -        │
│ REP-02   │ ○ Pend   │ Export data as CSV              │ Phase 4  │ -        │
└──────────┴──────────┴─────────────────────────────────┴──────────┴──────────┘

Coverage: 3/7 requirements complete (43%)
```

**Interactions:**
- Click requirement → see linked phase/plan/summary
- Filter by status, phase, category
- Click "Verified" → see verification details

**Data sources:**
- `REQUIREMENTS.md` → requirement IDs, descriptions, status
- `ROADMAP.md` → phase mappings
- `{phase}-VERIFICATION.md` → verification status
- `{phase}-UAT.md` → user acceptance results

---

## 5. UAT/Verification Interface

One-test-at-a-time user acceptance testing flow.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  USER ACCEPTANCE TESTING: Phase 3 - Dashboard                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Test 2 of 5:                                                               │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  "When you log in and navigate to /dashboard, do you see                   │
│   a list of your projects with their current status?"                      │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│      ┌───────────────┐    ┌───────────────┐    ┌───────────────┐           │
│      │   ✓ Pass      │    │   ✗ Fail      │    │   ⏭ Skip     │           │
│      └───────────────┘    └───────────────┘    └───────────────┘           │
│                                                                             │
│  [Optional: Describe the issue...]                                         │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │                                                                       │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Progress: ██░░░ 1/5 tested   │   Issues found: 0                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Flow:**
1. Present one test at a time (reduces cognitive load)
2. Pass/Fail/Skip buttons
3. Optional issue description field on Fail
4. Auto-advance to next test
5. Summary at end with fix plan generation

**Data sources:**
- `{phase}-{plan}-SUMMARY.md` → testable deliverables
- Output → `{phase}-UAT.md`

---

## 6. Session State / Resume Panel

Recovery interface for returning to work.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  SESSION RECOVERY                                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Last Session: 2 hours ago                                                  │
│  Stopped at: Phase 3, Plan 02, Task 2 (implementing data fetching)         │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  📋 Context to restore:                                                     │
│  • PROJECT.md (core vision)                                                │
│  • STATE.md (decisions, blockers)                                          │
│  • 03-02-PLAN.md (current plan)                                            │
│  • Recent summaries (03-01-SUMMARY.md)                                     │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  Recent Decisions:                                                          │
│  • Using React Query for data fetching (Phase 3)                           │
│  • PostgreSQL with Prisma ORM (Phase 1)                                    │
│                                                                             │
│  Active Blockers:                                                           │
│  ⚠ Need API key for email service (affects Phase 5)                        │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│         [▶ Resume Work]          [📊 View Full State]                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Data sources:**
- `STATE.md` → position, decisions, blockers
- `.continue-here.md` → pause point details
- `PROJECT.md` → key decisions log
- File timestamps → last session time

---

## 7. Quick Task Panel

Streamlined interface for ad-hoc tasks.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ⚡ QUICK TASK                                                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  What do you need done?                                                     │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │ Add dark mode toggle to settings page                                 │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Recent quick tasks:                                                        │
│  ✓ 003: Fix mobile nav overflow                     12 min ago             │
│  ✓ 002: Add loading spinner to login                yesterday              │
│  ✓ 001: Update footer copyright year                2 days ago             │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                              [⚡ Execute]                                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Data sources:**
- `.planning/quick/` directory → recent tasks
- `{task}-SUMMARY.md` → completion status and timing

---

## 8. Plan Detail View

Detailed view of a single plan with task breakdown.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  PLAN: 04-01 - PDF Generation Engine                                        │
│  Wave: 1  │  Status: In Progress  │  Dependencies: None                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Objective:                                                                 │
│  Create a PDF generation system that can render user data into             │
│  downloadable PDF reports with configurable templates.                      │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  Tasks:                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ ✓ Task 1: Install and configure PDF library (feat)                  │   │
│  │   └─ Commit: abc123f                                                │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │ ◆ Task 2: Create PDF template engine (feat)                         │   │
│  │   ├─ [ ] Set up template directory structure                        │   │
│  │   ├─ [✓] Create base template class                                 │   │
│  │   └─ [ ] Implement variable substitution                            │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │ ○ Task 3: Add report generation service (feat)                      │   │
│  │   └─ Waiting...                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  Must-Haves (for verification):                                            │
│  • PDF files can be generated from templates                               │
│  • Variables are correctly substituted in output                           │
│  • Generated PDFs are valid and openable                                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Data sources:**
- `{phase}-{plan}-PLAN.md` → objective, tasks, must_haves, frontmatter
- Git log → task commits
- Live execution → current subtask progress

---

## 9. Decisions Log View

Searchable history of project decisions.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  DECISIONS LOG                                              [Search: _____ ]│
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Phase 3 - Dashboard                                                        │
│  ├─ Use React Query for server state (not Redux)                           │
│  │  Rationale: Simpler API, better caching, less boilerplate               │
│  │  Source: 03-RESEARCH.md                                                 │
│  │                                                                         │
│  └─ Implement optimistic updates for better UX                             │
│     Rationale: Dashboard feels snappier with immediate feedback            │
│     Source: 03-01-SUMMARY.md                                               │
│                                                                             │
│  Phase 2 - User Auth                                                        │
│  ├─ Use httpOnly cookies for session (not localStorage)                    │
│  │  Rationale: Security best practice, XSS protection                      │
│  │  Source: 02-CONTEXT.md                                                  │
│  │                                                                         │
│  └─ Defer OAuth to v2 (email/password only for v1)                         │
│     Rationale: Reduce scope, ship faster                                   │
│     Source: REQUIREMENTS.md                                                │
│                                                                             │
│  Phase 1 - Foundation                                                       │
│  └─ PostgreSQL with Prisma ORM                                             │
│     Rationale: Type safety, migrations, familiar to team                   │
│     Source: 01-RESEARCH.md                                                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Data sources:**
- `PROJECT.md` → Key Decisions section
- `STATE.md` → Accumulated decisions
- `{phase}-CONTEXT.md` → Phase-specific decisions
- `{phase}-RESEARCH.md` → Research-driven decisions
- `{phase}-{plan}-SUMMARY.md` → Implementation decisions

---

## 10. Codebase Map View (Brownfield)

Visualization for existing codebase analysis.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  CODEBASE MAP                                                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Tech Stack                          Architecture                           │
│  ┌─────────────────────────┐        ┌─────────────────────────┐            │
│  │ Frontend: React 18      │        │     ┌─────────┐         │            │
│  │ Backend: Node/Express   │        │     │   API   │         │            │
│  │ Database: PostgreSQL    │        │     └────┬────┘         │            │
│  │ ORM: Prisma            │        │          │              │            │
│  │ Auth: Passport.js      │        │   ┌──────┴──────┐       │            │
│  └─────────────────────────┘        │   │            │       │            │
│                                     │ ┌─┴──┐     ┌──┴─┐     │            │
│  Conventions                        │ │ DB │     │Auth│     │            │
│  ┌─────────────────────────┐        │ └────┘     └────┘     │            │
│  │ • camelCase variables   │        └─────────────────────────┘            │
│  │ • PascalCase components │                                               │
│  │ • Barrel exports        │        Concerns                               │
│  │ • Co-located tests      │        ┌─────────────────────────┐            │
│  └─────────────────────────┘        │ ⚠ No error boundaries   │            │
│                                     │ ⚠ Missing input valid.  │            │
│                                     │ ⚠ No rate limiting      │            │
│                                     └─────────────────────────┘            │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  [View Full Stack]  [View Structure]  [View Integrations]  [View Tests]    │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Data sources:**
- `.planning/codebase/STACK.md`
- `.planning/codebase/ARCHITECTURE.md`
- `.planning/codebase/CONVENTIONS.md`
- `.planning/codebase/CONCERNS.md`
- `.planning/codebase/STRUCTURE.md`
- `.planning/codebase/INTEGRATIONS.md`
- `.planning/codebase/TESTING.md`

---

## Platform Considerations

| Platform | Primary Use Case | Key Features |
|----------|-----------------|--------------|
| **Web Dashboard** | Full project management | All views, real-time updates, team visibility |
| **VS Code Extension** | In-IDE workflow | Sidebar status, quick actions, plan preview |
| **Terminal TUI** | Power users | Rich text boxes, keyboard-driven, minimal mouse |
| **Mobile Companion** | On-the-go UAT | Push notifications for tests, pass/fail buttons |
| **CLI Enhancement** | Current users | Better formatting of existing output |

---

## Open Questions

1. **Real-time vs Polling**: How do we get live updates from agent execution?
2. **Edit vs View**: Should users be able to edit plans/requirements in the UI?
3. **Multi-project**: Support for switching between projects?
4. **Collaboration**: Any multi-user scenarios to consider?
5. **Offline**: Should the UI work without Claude running?

---

---

## 11. Planning Flow UI (Deep Dive)

Planning is the most interactive workflow in GSD. It involves multiple decision states and validation loops. Here's a detailed UI design for the planning experience.

### Decision States in Planning

During planning, information exists in one of four states:

| State | Description | UI Treatment |
|-------|-------------|--------------|
| **Decided** | Locked in from CONTEXT.md or prior phases | Read-only display, visual lock icon |
| **Ambiguous** | Gray areas needing user input | Interactive question cards |
| **Quick Answer** | Can be resolved with existing knowledge | Inline resolution, minimal friction |
| **Needs Research** | Requires investigation before deciding | Research trigger, progress indicator |

### Planning Flow Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  PLANNING: Phase 4 - User Authentication                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐     │
│  │  1. DISCUSS │──▶│ 2. RESEARCH │──▶│  3. PLAN    │──▶│  4. VERIFY  │     │
│  │   (scope)   │   │  (discover) │   │  (create)   │   │  (validate) │     │
│  │     ✓       │   │     ✓       │   │     ◆       │   │     ○       │     │
│  └─────────────┘   └─────────────┘   └─────────────┘   └─────────────┘     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### Stage 1: Discuss (Scope & Decisions)

**Purpose:** Identify gray areas and lock in implementation decisions before planning.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  DISCUSS: Phase 4 - User Authentication                                     │
│  ───────────────────────────────────────────────────────────────────────── │
│                                                                             │
│  Phase Boundary:                                                            │
│  "Users can create accounts, log in, and maintain sessions"                │
│  (New capabilities like OAuth belong in other phases)                       │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Which areas do you want to discuss?                                        │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ ☑ Session handling                                                   │   │
│  │   How long do sessions last? Cookie vs localStorage?                 │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │ ☑ Error responses                                                    │   │
│  │   What happens on wrong password? Rate limiting?                     │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │ ☐ Multi-device policy                                                │   │
│  │   Can users be logged in on multiple devices?                        │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │ ☐ Recovery flow                                                      │   │
│  │   Password reset? Email verification?                                │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│                              [Start Discussion]                             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Discussion Deep-Dive (for each selected area):**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  DISCUSS: Session Handling                                      [1/2 areas] │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Question 1 of 4:                                                           │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  How should sessions be stored?                                             │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ ○ httpOnly cookies (Recommended)                                     │   │
│  │   More secure against XSS, automatic with requests                   │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │ ○ localStorage + Bearer token                                        │   │
│  │   More control, works across subdomains                              │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │ ○ You decide                                                         │   │
│  │   Claude picks based on codebase patterns                            │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │ ○ Other...                                                           │   │
│  │   [Text input for custom answer]                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Progress: ●○○○ Question 1/4                                               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Decisions Summary (end of discuss):**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  DECISIONS CAPTURED                                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ✓ LOCKED DECISIONS                                                         │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  Session Handling:                                                          │
│  • httpOnly cookies with 15-minute access tokens                           │
│  • Refresh tokens in database (7-day expiry)                               │
│  • Automatic refresh on API calls                                          │
│                                                                             │
│  Error Responses:                                                           │
│  • Generic "Invalid credentials" (no email enumeration)                    │
│  • Rate limit: 5 attempts per 15 minutes                                   │
│  • Lockout after 10 failed attempts (30 min cooldown)                      │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  ◆ CLAUDE'S DISCRETION                                                      │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Password hashing algorithm (bcrypt vs argon2)                           │
│  • JWT library choice                                                       │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  📋 DEFERRED IDEAS (noted for future phases)                                │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • OAuth/social login → Phase 7                                            │
│  • 2FA/MFA → Phase 8                                                       │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  [Edit Decisions]              [Save & Continue to Research]                │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### Stage 2: Research (Discovery)

**Purpose:** Investigate unknowns before planning. Only triggered when needed.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  RESEARCH: Phase 4 - User Authentication                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Discovery Assessment:                                                      │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │  ◆ JWT library for Edge runtime                       Level 1: Quick  │ │
│  │    Need to confirm jose vs jsonwebtoken for Next.js Edge              │ │
│  │    [Auto-researching...]                                              │ │
│  ├───────────────────────────────────────────────────────────────────────┤ │
│  │  ✓ Password hashing                                   Level 0: Skip   │ │
│  │    bcrypt already in package.json, pattern established                │ │
│  ├───────────────────────────────────────────────────────────────────────┤ │
│  │  ○ Rate limiting approach                             Level 2: Research│ │
│  │    Need to evaluate: upstash vs in-memory vs redis                    │ │
│  │    [Start Research]                                                   │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  Research Progress:                                                         │
│  ████████░░░░░░░░ 1/2 topics complete                                      │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  Findings So Far:                                                           │
│                                                                             │
│  JWT Library:                                                               │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │ Recommendation: jose                                                  │ │
│  │ Reason: Native ESM, Edge-compatible, actively maintained              │ │
│  │ Source: package comparison, Next.js docs                              │ │
│  │ Confidence: HIGH                                                      │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### Stage 3: Plan (Create Executable Plans)

**Purpose:** Break down the phase into atomic, executable plans with proper dependency ordering.

**Plan Builder Overview:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  PLAN BUILDER: Phase 4 - User Authentication                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Context Loaded:                                                            │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐                           │
│  │PROJECT  │ │ROADMAP  │ │CONTEXT  │ │RESEARCH │                           │
│  │   ✓     │ │   ✓     │ │   ✓     │ │   ✓     │                           │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘                           │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  Wave Structure:                                                            │
│                                                                             │
│  WAVE 1 (parallel)              WAVE 2 (after wave 1)                       │
│  ┌──────────────────────┐       ┌──────────────────────┐                   │
│  │ Plan 04-01           │       │ Plan 04-03           │                   │
│  │ Auth Schema & Types  │       │ Protected Routes     │                   │
│  │ ─────────────────    │       │ ─────────────────    │                   │
│  │ Tasks: 2             │       │ Tasks: 2             │                   │
│  │ Files: 3             │       │ Files: 4             │                   │
│  │ Wave: 1              │       │ Wave: 2              │                   │
│  │ Depends: none        │──────▶│ Depends: 01, 02      │                   │
│  └──────────────────────┘       └──────────────────────┘                   │
│  ┌──────────────────────┐                                                  │
│  │ Plan 04-02           │                                                  │
│  │ Login/Logout API     │                                                  │
│  │ ─────────────────    │                                                  │
│  │ Tasks: 3             │                                                  │
│  │ Files: 4             │                                                  │
│  │ Wave: 1              │                                                  │
│  │ Depends: none        │───────────────────────────────▶                  │
│  └──────────────────────┘                                                  │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Scope Check: 7 tasks across 3 plans ✓   Est. context: ~45% per plan ✓    │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  [View Plan Details]  [Edit Wave Structure]  [Continue to Verify]          │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Plan Detail View (expandable):**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  PLAN 04-02: Login/Logout API                                    [Collapse] │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Objective:                                                                 │
│  Create authentication endpoints with JWT tokens in httpOnly cookies        │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  TASKS                                                                      │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Task 1: Login Endpoint                                    [feat]    │   │
│  │ ─────────────────────────────────────────────────────────────────── │   │
│  │ Files: src/app/api/auth/login/route.ts                              │   │
│  │                                                                     │   │
│  │ Action:                                                             │   │
│  │ POST endpoint accepting {email, password}. Validate against User    │   │
│  │ table using bcrypt. Return JWT in httpOnly cookie (15min access,    │   │
│  │ 7day refresh). Use jose library for Edge compatibility.             │   │
│  │                                                                     │   │
│  │ Verify: curl -X POST /api/auth/login returns 200 + Set-Cookie       │   │
│  │ Done: Valid credentials return JWT, invalid returns 401             │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Task 2: Logout Endpoint                                   [feat]    │   │
│  │ ─────────────────────────────────────────────────────────────────── │   │
│  │ Files: src/app/api/auth/logout/route.ts                             │   │
│  │                                                                     │   │
│  │ Action:                                                             │   │
│  │ POST endpoint that clears auth cookies and invalidates refresh      │   │
│  │ token in database.                                                  │   │
│  │                                                                     │   │
│  │ Verify: curl -X POST /api/auth/logout clears cookies                │   │
│  │ Done: Session ended, cookies cleared, refresh token revoked         │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Task 3: Rate Limiting Middleware                          [feat]    │   │
│  │ ─────────────────────────────────────────────────────────────────── │   │
│  │ Files: src/lib/rate-limit.ts, src/app/api/auth/login/route.ts       │   │
│  │                                                                     │   │
│  │ Action:                                                             │   │
│  │ Implement in-memory rate limiting: 5 attempts per 15 min per IP.    │   │
│  │ Return 429 when exceeded. (Decision: in-memory ok for MVP,          │   │
│  │ upgrade to Redis in Phase 9)                                        │   │
│  │                                                                     │   │
│  │ Verify: 6th login attempt within 15min returns 429                  │   │
│  │ Done: Rate limiting active on login endpoint                        │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  MUST-HAVES (Goal-Backward Verification)                                    │
│                                                                             │
│  Truths (user-observable):                                                  │
│  • User can log in with valid email/password                               │
│  • User can log out and session ends                                       │
│  • Invalid credentials are rejected with 401                               │
│  • Repeated failures trigger rate limiting                                 │
│                                                                             │
│  Artifacts:                                                                 │
│  • src/app/api/auth/login/route.ts (exports POST)                          │
│  • src/app/api/auth/logout/route.ts (exports POST)                         │
│  • src/lib/rate-limit.ts (exports rateLimiter)                             │
│                                                                             │
│  Key Links:                                                                 │
│  • login/route.ts → prisma.user (bcrypt.compare)                           │
│  • login/route.ts → jose (JWT signing)                                     │
│  • login/route.ts → rate-limit.ts (middleware)                             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### Stage 4: Verify (Plan Validation)

**Purpose:** Check plans will achieve the phase goal before execution.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  PLAN VERIFICATION: Phase 4 - User Authentication                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Checking 3 plans against 6 dimensions...                                   │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  DIMENSION CHECKS                                                           │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │ ✓ Requirement Coverage                                                │ │
│  │   All phase requirements have covering tasks                          │ │
│  │   AUTH-01 → 04-02 Task 1   AUTH-02 → 04-02 Task 2                    │ │
│  │   AUTH-03 → 04-01 Task 1   AUTH-04 → 04-02 Task 3                    │ │
│  ├───────────────────────────────────────────────────────────────────────┤ │
│  │ ✓ Task Completeness                                                   │ │
│  │   All tasks have: files, action, verify, done                         │ │
│  ├───────────────────────────────────────────────────────────────────────┤ │
│  │ ✓ Dependency Correctness                                              │ │
│  │   No circular dependencies, waves computed correctly                  │ │
│  ├───────────────────────────────────────────────────────────────────────┤ │
│  │ ⚠ Key Links Planned                                      [1 warning]  │ │
│  │   Plan 04-03 creates LoginForm but doesn't wire to /api/auth/login   │ │
│  │   → Fix: Add fetch call in LoginForm action                          │ │
│  ├───────────────────────────────────────────────────────────────────────┤ │
│  │ ✓ Scope Sanity                                                        │ │
│  │   All plans: 2-3 tasks, <10 files, ~45% context estimate             │ │
│  ├───────────────────────────────────────────────────────────────────────┤ │
│  │ ✓ Must-Haves Derivation                                               │ │
│  │   Truths are user-observable, artifacts map to truths                │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  ISSUES FOUND: 0 blockers, 1 warning                                        │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │ ⚠ WARNING: Key link missing                                           │ │
│  │ Plan: 04-03  │  Dimension: key_links_planned                          │ │
│  │ ─────────────────────────────────────────────────────────────────────│ │
│  │ LoginForm.tsx created but no fetch to /api/auth/login in action      │ │
│  │                                                                       │ │
│  │ Fix: Add "fetch('/api/auth/login', {...})" to LoginForm onSubmit     │ │
│  │                                                                       │ │
│  │           [Auto-Fix]     [Ignore]     [Edit Manually]                │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  Status: PASSED WITH WARNINGS                                               │
│  [Fix Warnings & Re-verify]           [Proceed to Execution →]             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### Planning UI Summary

**Key Interactions:**

| Stage | User Actions | System Actions |
|-------|--------------|----------------|
| **Discuss** | Select gray areas, answer questions, mark "you decide" | Identify gray areas, ask 4 questions per area, capture decisions |
| **Research** | Trigger research for unknowns, review findings | Auto-research Level 1, spawn researcher for Level 2+ |
| **Plan** | Review wave structure, edit task details, adjust dependencies | Generate plans from context, compute waves, estimate scope |
| **Verify** | Fix issues, approve warnings, trigger re-verification | Check 6 dimensions, report issues, suggest fixes |

**Visual Language:**

| Element | Meaning |
|---------|---------|
| 🔒 Lock icon | Decision is locked, cannot be changed |
| ◆ Diamond | Claude's discretion, flexible |
| ⚠ Warning | Should fix, but can proceed |
| ✗ Blocker | Must fix before proceeding |
| Wave lines | Parallel execution grouping |

---

## Next Steps

- [ ] Prioritize which views to build first
- [ ] Choose target platform(s)
- [ ] Define technical architecture
- [ ] Create higher-fidelity mockups
- [ ] Identify integration points with existing CLI
