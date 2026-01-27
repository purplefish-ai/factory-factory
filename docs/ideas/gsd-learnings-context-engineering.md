# Learnings from get-shit-done: Context Engineering for Factory Factory

## 1. Executive Summary

This document captures learnings from analyzing [get-shit-done](https://github.com/cyanheads/get-shit-done) (GSD), a meta-prompting and context engineering system for Claude Code. GSD solves "context rot"—the quality degradation that occurs as Claude fills its context window during long development sessions.

While Factory Factory focuses on workspace isolation and parallel sessions, GSD focuses on session quality through specification-driven workflows and atomic execution. These approaches are complementary, and several GSD patterns could enhance Factory Factory's effectiveness.

## 2. What is get-shit-done?

GSD is not a project management tool—it's a **context engineering system** that orchestrates Claude Code through:

| Component | Purpose |
|-----------|---------|
| **Deep Questioning** | Structured discovery before any code |
| **Research Phase** | Domain ecosystem investigation |
| **Atomic Plans** | Executable specs sized to fit 50% of context window |
| **Specialized Subagents** | 11 agents with specific roles (planner, executor, verifier, etc.) |
| **Goal-Backward Verification** | Check deliverables against goals, not just task completion |
| **Living State** | STATE.md tracks position, decisions, blockers across sessions |

### 2.1 The Core Insight: Context Rot

GSD's main thesis: Claude's output quality degrades as the context window fills.

| Context Usage | Quality | GSD Strategy |
|---------------|---------|--------------|
| 0-30% | Peak | Full execution |
| 30-50% | Good | Design decisions, complex work |
| 50-70% | Degrading | Wrap up current plan |
| 70%+ | Poor | STOP, spawn fresh agent |

**Result:** Each executor gets ~200k tokens for 2-3 tasks max, preventing accumulation.

### 2.2 GSD's File Structure

```
.planning/
├── PROJECT.md          # Vision, requirements, constraints
├── REQUIREMENTS.md     # Scoped v1/v2 with traceability
├── ROADMAP.md          # Phase structure with goals
├── STATE.md            # Living memory (position, decisions, blockers)
├── CONFIG.json         # Workflow settings, model profiles
├── research/           # Domain findings (STACK.md, FEATURES.md, etc.)
└── phases/
    └── 01-auth/
        ├── CONTEXT.md      # User's design decisions for this phase
        ├── RESEARCH.md     # Phase-specific technical research
        ├── 01-PLAN.md      # Atomic executable plan
        ├── 01-SUMMARY.md   # What was actually built
        └── VERIFICATION.md # Goal validation results
```

### 2.3 GSD's 11 Specialized Agents

| Agent | Role | Model (quality profile) |
|-------|------|-------------------------|
| gsd-planner | Creates atomic plans with task breakdown | Opus |
| gsd-plan-checker | Validates plans achieve goals | Sonnet |
| gsd-project-researcher | Domain ecosystem investigation | Opus |
| gsd-phase-researcher | Phase-specific technical research | Sonnet |
| gsd-executor | Executes plans with atomic commits | Sonnet |
| gsd-debugger | Systematic debugging with persistent state | Opus |
| gsd-verifier | Goal-backward verification | Sonnet |
| gsd-integration-checker | Cross-phase integration verification | Sonnet |
| gsd-codebase-mapper | Analyzes existing codebases | Haiku |
| gsd-research-synthesizer | Collects and synthesizes findings | Sonnet |
| gsd-roadmapper | Creates ROADMAP.md from requirements | Opus |

## 3. Factory Factory vs. GSD: Complementary Approaches

| Aspect | Factory Factory | GSD |
|--------|----------------|-----|
| **Focus** | Workspace isolation, parallel sessions | Session quality, context engineering |
| **Isolation** | Git worktrees per workspace | Fresh context per subagent |
| **State** | Database (sessions, workspaces) | Markdown files (STATE.md, PLAN.md) |
| **Workflow** | User-driven interactive chat | Specification-driven phases |
| **Parallelism** | Multiple workspaces | Execution waves within workspace |
| **Verification** | Manual PR review | Goal-backward automated verification |

### 3.1 Where They Overlap

- Both spawn Claude Code processes
- Both support session resume
- Both track git state
- Both aim to improve AI-assisted development

### 3.2 Where They Differ

**Factory Factory** assumes:
- User guides each session interactively
- Workspaces are independent units
- Parallelism is at workspace level

**GSD** assumes:
- Specifications guide execution
- Single workspace with phased delivery
- Parallelism is at task level within phases

## 4. Integration Opportunities

### 4.1 Tier 1: Adopt GSD's Methodology (Low Effort)

#### Expanded Workflows

**Current Factory Factory workflows:**
- feature, bugfix, explore, followup

**Proposed additions inspired by GSD:**

| Workflow | Purpose | Creates |
|----------|---------|---------|
| `discover` | Deep questioning about requirements | `.context/PROJECT.md` |
| `research` | Explore codebase/domain | `.context/RESEARCH.md` |
| `plan` | Create implementation plan | `.context/PLAN.md` |
| `implement` | Execute plan with atomic commits | Updates STATE.md |
| `verify` | Check deliverables against plan | `.context/VERIFICATION.md` |

**Implementation:** Update workflow prompts in `src/backend/workflows/` to include GSD-style instructions.

#### .context/ Structure Convention

Adopt a structured `.context/` directory (already gitignored):

```
.context/
├── PROJECT.md      # What this workspace is building
├── PLAN.md         # Current implementation plan
├── STATE.md        # Decisions, blockers, progress
├── RESEARCH.md     # Findings from exploration
├── VERIFICATION.md # Verification results
└── ws-logs/        # (existing) debug logs
```

These files would be:
- Created by specialized workflows
- Loaded automatically by sessions (context injection)
- Persisted across sessions for continuity

#### STATE.md Pattern for Workspace Memory

When session ends, offer to extract key decisions:

```markdown
## Session: 2026-01-27 14:30

### Decisions
- Using JWT with refresh tokens (not session cookies)
- Chose Prisma over Drizzle for ORM
- Rate limiting via sliding window algorithm

### Progress
- Auth endpoints implemented
- Tests passing

### Blockers
- Need API keys for OAuth providers
```

### 4.2 Tier 2: Custom Features (Medium Effort)

#### Context Health Indicator

Show context window usage in chat header:

```
┌─────────────────────────────────────────────────────────────────┐
│ Session: auth-impl │ Model: sonnet │ Context: ████████░░ 78%   │
│                                      ⚠️ Consider fresh session  │
└─────────────────────────────────────────────────────────────────┘
```

**Implementation:**
1. Track message tokens in ClaudeClient
2. Expose via WebSocket `context_health` message
3. Frontend shows color-coded indicator
4. Suggest fresh session when > 70%

#### Verification Workflow

New workflow that:
1. Reads `.context/PLAN.md` (if exists)
2. Checks each success criterion against actual code
3. Reports gaps
4. Creates `.context/VERIFICATION.md`

Uses GSD's goal-backward methodology:
- **Truths**: What must be TRUE for the goal to succeed
- **Artifacts**: What code must EXIST
- **Key Links**: What must be WIRED (integrations)

#### Checkpoint Gates

Add session status: `WAITING_VERIFICATION`

When Claude hits a checkpoint:
1. Session pauses
2. UI shows verification prompt
3. User approves → session resumes
4. User rejects → session gets feedback

**Implementation:**
- Add checkpoint pattern to workflow prompts
- Session status updated in database
- Kanban shows "Waiting" state

### 4.3 Tier 3: Larger Features (Significant Effort)

#### Multi-Session Orchestration

Like GSD's wave-based execution:
1. User creates plan with multiple tasks
2. Factory Factory spawns parallel sessions (one per task)
3. Orchestrator tracks progress
4. Dependencies handled (wave 1 completes before wave 2)

**Database additions:**
```prisma
model WorkspacePlan {
  id          String   @id @default(cuid())
  workspaceId String
  tasks       Json     // Array of task definitions
  currentWave Int      @default(1)
  status      String   @default("pending")
}

model PlanTask {
  id          String   @id @default(cuid())
  planId      String
  wave        Int      // Which wave this task belongs to
  description String
  sessionId   String?  // Claude session executing this task
  status      String   @default("pending")
  dependsOn   String[] // Task IDs that must complete first
}
```

#### Cross-Workspace Context

Share learnings across workspaces in same project:
- Project-level `.context/` in main repo
- Workspaces inherit project context
- Discoveries in one workspace available to others

## 5. Use GSD Directly vs. Build Custom

### 5.1 Use GSD Directly

GSD commands can run inside Factory Factory sessions:

```bash
# Install globally
npx get-shit-done-cc

# In any Factory Factory workspace
/gsd:new-project    # Deep questioning
/gsd:plan-phase 1   # Create plan
/gsd:execute-phase 1 # Execute with atomic commits
/gsd:verify-work 1   # Goal-backward verification
```

**Pros:**
- No development effort
- Battle-tested system
- Comprehensive workflows

**Cons:**
- Two systems to learn
- File structure mismatch (`.planning/` vs `.context/`)
- GSD designed for solo CLI, not web UI

### 5.2 Build Custom

Better for Factory Factory integration:

| Feature | Why Custom |
|---------|-----------|
| Context health indicator | Needs UI integration |
| Checkpoint gates | Session status in database |
| Workspace memory | DB-backed, not just files |
| Kanban integration | PR state + verification state |
| Multi-session orchestration | Leverages existing workspace model |

### 5.3 Recommended Hybrid Approach

| Layer | Approach |
|-------|----------|
| **Methodology** | Adopt GSD's questioning + research + planning pattern |
| **Execution** | Use Factory Factory's workspace isolation |
| **Artifacts** | Create `.context/` structure inspired by `.planning/` |
| **Verification** | Build custom workflow checking against plan |
| **UI** | Custom context health, gates, kanban states |

## 6. Detailed Feature Specs

### 6.1 Context Health Monitoring

**Goal:** Warn users before context rot degrades session quality.

**Protocol addition:**
```typescript
// Server → Client via WebSocket
interface ContextHealthMessage {
  type: 'context_health';
  usage: number;           // 0.0 to 1.0
  estimatedTokens: number;
  maxTokens: number;
  status: 'good' | 'warning' | 'critical';
  suggestion?: string;
}
```

**Thresholds:**
- `good`: 0-50% (green)
- `warning`: 50-70% (yellow)
- `critical`: 70%+ (red, blinking)

**Implementation path:**
1. Track cumulative tokens in ClaudeClient (estimate from message length)
2. Send `context_health` messages periodically
3. Frontend displays indicator in chat header
4. Offer "Start fresh session" action at critical

### 6.2 Structured .context/ Files

**PROJECT.md schema:**
```markdown
# [Workspace Name]

## What This Is
[2-3 sentences describing the workspace goal]

## Core Value
[The ONE thing that matters most]

## Requirements
### Must Have
- [ ] Requirement 1
- [ ] Requirement 2

### Nice to Have
- [ ] Optional 1

### Out of Scope
- Explicitly excluded item 1

## Constraints
- **[Type]**: [What] — [Why]

## Key Decisions
| Decision | Rationale | Date |
|----------|-----------|------|
| Choice A | Because... | 2026-01-27 |
```

**PLAN.md schema:**
```markdown
# Implementation Plan

## Goal
[What success looks like]

## Tasks
1. [ ] Task 1
   - Files: `src/foo.ts`
   - Verify: `npm test`
2. [ ] Task 2
   - Files: `src/bar.ts`
   - Verify: Manual check at /api/bar

## Success Criteria
- [ ] Criterion 1: [What must be TRUE]
- [ ] Criterion 2: [What must EXIST]
- [ ] Criterion 3: [What must be WIRED]

## Dependencies
- Task 2 depends on Task 1
```

**STATE.md schema:**
```markdown
# Workspace State

## Current Position
Plan: PLAN.md
Task: 2 of 4
Status: In progress

## Accumulated Decisions
- [Date] Decision 1 — Rationale
- [Date] Decision 2 — Rationale

## Blockers
- Blocker 1 — Waiting on X

## Progress
| Session | Duration | Tasks Completed |
|---------|----------|-----------------|
| 2026-01-27 10:00 | 25 min | 1-2 |
```

### 6.3 Verification Workflow Prompt

```markdown
You are a verification agent. Your job is to check whether deliverables match the plan.

Read the plan from `.context/PLAN.md` (if it exists).

For each success criterion:
1. Check if the code actually delivers what was promised
2. Run any verification commands specified
3. Mark as PASS or FAIL with evidence

Create `.context/VERIFICATION.md` with your findings:

## Verification Report

**Status:** PASS / PARTIAL / FAIL

### Success Criteria

#### Criterion 1: [Description]
- **Status:** PASS / FAIL
- **Evidence:** [What you found]
- **Gap:** [If FAIL, what's missing]

### Recommendations
- [If gaps found, what should be done]

Do NOT just trust that tasks were completed. Actually verify the code.
```

## 7. Implementation Roadmap

### Phase 1: Methodology Adoption (1 week)
- [ ] Expand workflows: `discover`, `research`, `plan`, `implement`, `verify`
- [ ] Create workflow prompt templates inspired by GSD agents
- [ ] Document `.context/` structure convention
- [ ] Add "Save to workspace memory" action in chat UI

### Phase 2: Context Health (1-2 weeks)
- [ ] Add token tracking to ClaudeClient
- [ ] Implement `context_health` WebSocket message
- [ ] Add context indicator to chat header
- [ ] Add "Start fresh session" suggestion at critical

### Phase 3: Structured Context Files (1 week)
- [ ] Create file templates for PROJECT.md, PLAN.md, STATE.md
- [ ] Inject `.context/` files into session prompts
- [ ] Auto-update STATE.md on session end

### Phase 4: Verification Workflow (1-2 weeks)
- [ ] Implement verification workflow prompt
- [ ] Add VERIFICATION.md generation
- [ ] Integrate verification status with kanban
- [ ] Add checkpoint gates for human verification

### Phase 5: Orchestration (Future)
- [ ] Design WorkspacePlan and PlanTask models
- [ ] Implement multi-session spawning
- [ ] Add wave-based execution
- [ ] Cross-workspace context sharing

## 8. Open Questions

1. **File location:** Should `.context/` be gitignored (ephemeral) or tracked (persistent)?
   - GSD tracks `.planning/` in git
   - Factory Factory currently gitignores `.context/`
   - Recommendation: Keep gitignored, but offer "commit context" action

2. **Model selection:** Should workflows recommend specific models?
   - GSD uses Opus for planning, Sonnet for execution
   - Factory Factory lets user choose
   - Recommendation: Add profile presets (quality/balanced/budget)

3. **GSD coexistence:** If users install GSD, should Factory Factory detect it?
   - Could surface `/gsd:*` commands in workflow selector
   - Could import from `.planning/` to `.context/`

4. **Session continuity:** How to handle context when spawning fresh sessions?
   - GSD uses STATE.md read at session start
   - Factory Factory could inject `.context/STATE.md` automatically

## 9. References

- [get-shit-done repository](https://github.com/cyanheads/get-shit-done)
- [GSD npm package](https://www.npmjs.com/package/get-shit-done-cc)
- Factory Factory docs: `docs/WORKFLOW.md`, `docs/ideas/multi-agent-orchestration.md`

## 10. Conclusion

GSD provides a sophisticated solution to context rot through specification-driven workflows and atomic execution. Factory Factory's workspace isolation complements this by enabling parallel independent sessions.

**Key takeaways:**
1. Context window usage directly impacts output quality
2. Structured planning artifacts improve session continuity
3. Goal-backward verification catches "task completion theater"
4. Living state (STATE.md) enables seamless resume
5. Specialized agents/workflows produce better results than generalists

The recommended path is to adopt GSD's methodology through expanded workflows and structured `.context/` files, while building custom UI features that integrate with Factory Factory's existing architecture.
