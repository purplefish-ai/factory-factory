# Domain Model Consolidation Plan

## Overview

This document proposes a domain-model refactor to reduce duplicated state management and duplicated operational flows across workspace lifecycle, PR synchronization, automation, and session orchestration.

The current system has strong building blocks (workspace state machine, ratchet engine, accessor/service layering), but key responsibilities are still spread across multiple paths. This causes drift risk, duplicated logic, and higher maintenance cost.

## Problem Statement

We currently have three recurring structural issues:

1. **Too much state on one aggregate (`Workspace`)**
2. **Multiple ways to perform the same domain operation (especially session creation/start)**
3. **Parallel mechanisms for similar PR/automation concerns (legacy monitors + ratchet + scheduler/manual sync)**

## Goals

1. Establish **single writers** for important domain state.
2. Make every core operation have one canonical orchestration path.
3. Remove deprecated automation model surfaces and keep one coherent model.
4. Improve correctness under concurrency and restart conditions.
5. Make behavior easier to reason about and test.

## Non-Goals

1. Rebuilding the UI information architecture.
2. Replacing Prisma or tRPC patterns.
3. Reworking GitHub CLI integration surface area beyond domain consistency needs.

## Current Model and Key Issues

### 1) Workspace is overloaded as a single mutable state bucket

`Workspace` currently carries lifecycle status, initialization logs, run-script runtime state, PR snapshot cache, CI/review tracking, ratchet progression, and kanban cache.

Impact:
- Many services write into the same model via broad updates.
- Invariants are difficult to enforce globally.
- Coupled changes increase regression risk.

## 2) Session creation/start semantics are duplicated

There are multiple paths that replicate similar logic:
- User-created chat sessions
- Default workspace bootstrap session
- CI fixer sessions
- PR review fixer sessions
- Ratchet sessions

Repeated concerns:
- Existing active session checks
- Session limit enforcement
- Model inheritance from recent session
- Create vs restart vs send-message decisions
- Prompt injection/dispatch behavior

## 3) PR state has multiple update pathways

PR fields (`prState`, `prCiStatus`, etc.) are updated from:
- Scheduler sync/discovery
- Manual sync endpoints
- Ratchet (independent fetch for progression decisions)

Impact:
- Potential drift between cached workspace PR fields and ratchet’s live view.
- Multiple implementations of “fetch PR + map + persist + recompute kanban”.

## 4) Legacy automation model still exists beside ratchet model

Deprecated settings and services (`autoFixCiIssues`, `autoFixPrReviewComments`, CI/PR review monitors) remain in code and schema while ratchet is the active progression path.

Impact:
- Competing domain vocabulary.
- Hidden dead paths and migration confusion.

## 5) Backup/import schema drift

Backup/export does not cover all newer workspace and settings fields (ratchet and related tracking fields), causing silent state loss on restore.

## 6) Branch resume intent has multiple storage locations

`useExistingBranch` intent is tracked via in-memory map and sidecar file, instead of canonical persisted domain state.

Impact:
- Split-brain behavior under restart/failure edges.

## Proposed Domain Architecture

### Domain Boundaries

Split responsibility into explicit subdomains:

1. **WorkspaceLifecycleDomain**
- Owns `status` transitions (`NEW -> PROVISIONING -> READY/FAILED -> ARCHIVED`)
- Owns initialization telemetry (`init*` fields)

2. **SessionOrchestrationDomain**
- Owns session allocation/reuse/start rules
- Owns specialized workflow session policies

3. **PRSnapshotDomain**
- Owns PR snapshot fetch/mapping/persistence (`pr*` fields)
- Owns transition hooks (e.g. kanban cache recompute)

4. **AutomationDomain (Ratchet)**
- Owns progression decisions and fixer triggering
- Consumes `PRSnapshotDomain` data and settings

5. **WorkspaceRuntimeDomain**
- Owns run-script runtime/process state
- Uses dedicated runtime status enum

`Workspace` remains the aggregate root but with clearer ownership contracts for each field group.

## Single-Writer Strategy

### A) Workspace lifecycle fields
- **Only** `workspaceStateMachine` (and its lifecycle orchestration service) may update lifecycle fields.

### B) PR snapshot fields
- **Only** `PRSnapshotService` may update `pr*` fields and trigger cache updates.
- Scheduler/manual sync/ratchet all call into this service.

### C) Fixer session lifecycle
- **Only** `FixerSessionService` may acquire/reuse/restart/signal fixer sessions.

### D) Run script runtime fields
- **Only** `RunScriptRuntimeService` may mutate run-script runtime fields.

## Canonical Operations

### 1) `createWorkspace` (single orchestration path)

Introduce `WorkspaceCreationService.create(input)` for all entry points:
- Manual create
- Resume existing branch
- Create from GitHub issue

Responsibilities:
- Validate source-specific constraints
- Apply canonical defaults (e.g. ratchet enabled default)
- Persist workspace + source metadata
- Provision initial session policy (if enabled)
- Kick off background worktree init

Frontend should call one semantic command with a `source` discriminator:
- `MANUAL`
- `RESUME_BRANCH`
- `GITHUB_ISSUE`

### 2) `acquireFixerSession` (single path)

Introduce `FixerSessionService.acquireAndDispatch({workspaceId, fixerType, prompt, policy})`.

Handles uniformly:
- Existing session lookup
- Active vs idle behavior
- Workspace session limits
- Model inheritance
- Session create/restart
- Prompt delivery semantics

Used by ratchet and any fallback/manual fixer triggers.

### 3) `refreshPRSnapshot` (single path)

Introduce `PRSnapshotService.refreshWorkspace(workspaceId)` and batch variants.

Handles uniformly:
- Fetch from GitHub
- Map status/check/review fields
- Persist snapshot
- Recompute cached kanban column
- Return typed result for callers

Used by:
- Scheduler periodic sync
- Manual sync endpoints
- Ratchet pre-check data refresh (or shared fetch/mapping pipeline)

## Data Model Changes

### 1) Add explicit source metadata for workspace creation

Add fields similar to:
- `creationSource` enum (`MANUAL`, `RESUME_BRANCH`, `GITHUB_ISSUE`)
- `creationMetadata` JSON nullable

Purpose:
- Replace ad hoc source inference.
- Remove external sidecar/in-memory “resume mode” dependency for core semantics.

### 2) Introduce `RunScriptStatus` enum

Replace `workspace.runScriptStatus: SessionStatus` with a dedicated enum:
- `IDLE`, `STARTING`, `RUNNING`, `STOPPING`, `COMPLETED`, `FAILED`

Purpose:
- Avoid semantic coupling with Claude/terminal session lifecycle.

### 3) Remove deprecated automation settings and legacy monitor dependencies

After migration:
- Remove deprecated settings fields from `UserSettings`.
- Remove legacy monitor services from active domain flow.

## API Shape Changes

### Workspace Create

Current behavior allows many optional fields without explicit intent.

Proposed:

```ts
type CreateWorkspaceInput =
  | { source: 'MANUAL'; projectId: string; name: string; description?: string; branchName?: string }
  | { source: 'RESUME_BRANCH'; projectId: string; name?: string; branchName: string }
  | {
      source: 'GITHUB_ISSUE';
      projectId: string;
      issueNumber: number;
      issueUrl: string;
      name?: string;
      ratchetEnabled?: boolean;
    };
```

Benefits:
- Validation follows operation intent.
- One entry point with well-defined semantics.

## Migration Plan

## Phase 1: Service Consolidation (no schema breaking)

1. Implement `FixerSessionService` and route `ci-fixer`, `pr-review-fixer`, and `ratchet` through it.
2. Implement `PRSnapshotService` and route scheduler/manual sync through it.
3. Update ratchet to consume shared PR snapshot mapping pipeline.
4. Add regression tests around:
- Session acquisition behavior under concurrency
- PR snapshot update consistency
- Kanban cache update correctness

## Phase 2: Workspace creation unification

1. Introduce `WorkspaceCreationService` with `source` discriminator input.
2. Route all UI paths through this API:
- Quick create
- Resume branch
- Start from issue card
3. Keep old create input as compatibility adapter temporarily.

## Phase 3: Schema cleanup and removal of legacy surfaces

1. Add schema fields for explicit creation source metadata.
2. Add `RunScriptStatus` enum and migrate runtime field.
3. Deprecate/remove legacy monitor settings and services from domain path.
4. Migrate and remove resume sidecar/in-memory split storage for branch-init intent.

## Phase 4: Backup/import hardening

1. Bump backup schema version.
2. Include all current workspace/settings fields in export/import.
3. Add compatibility adapter for older backup versions.
4. Add round-trip tests for full domain state.

## Testing Strategy

### Domain Invariant Tests

1. Lifecycle transitions only via state machine.
2. PR snapshot fields are only mutated by `PRSnapshotService`.
3. Fixer session acquisition is idempotent under concurrent calls.
4. Session limits enforced uniformly for all specialized workflows.

### Integration Tests

1. Create workspace from each source type.
2. Ratchet progression updates state + triggers fixers via shared services.
3. Scheduler/manual sync and ratchet produce consistent PR field outcomes.

### Migration Tests

1. Existing workspaces remain functional across migration.
2. Backup v1 import still succeeds into newer schema.
3. Backup v2 round-trip preserves ratchet and runtime fields.

## Risks and Mitigations

1. **Risk:** Behavior change in edge-case session reuse logic.
- **Mitigation:** Golden tests for existing behavior before consolidation.

2. **Risk:** Migration complexity around legacy settings and backup compatibility.
- **Mitigation:** Versioned adapters and staged removal.

3. **Risk:** Ratchet throughput regressions if PR snapshot calls are serialized poorly.
- **Mitigation:** Keep bounded concurrency and shared caching where safe.

4. **Risk:** UI dependency on implicit create defaults.
- **Mitigation:** Backward-compatible API adapter during Phase 2.

## Success Criteria

1. One canonical service per core state domain (lifecycle, PR snapshot, fixer sessions, runtime).
2. One canonical create workspace command with explicit source semantics.
3. Legacy monitor model and deprecated settings removed from active domain flow.
4. Backup/import round-trip preserves all domain-critical state.
5. Reduction in duplicated code paths for create/start/fix operations.

## Suggested Ticket Breakdown

1. Build `FixerSessionService` and migrate `ci-fixer`.
2. Migrate `pr-review-fixer` and ratchet fixer logic to `FixerSessionService`.
3. Build `PRSnapshotService` and migrate scheduler/manual sync.
4. Ratchet integration with shared PR snapshot pipeline.
5. Introduce `WorkspaceCreationService` and new create input union.
6. Migrate frontend create/resume/issue-start flows.
7. Add `RunScriptStatus` enum migration.
8. Remove deprecated settings/services from active path.
9. Backup schema v2 + compatibility + tests.
